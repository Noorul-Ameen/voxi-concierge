process.env.TZ = "UTC";
/**
 * Worker: executes ledger actions (serialised per conversation), reclaims expired leases, sweeps
 * abandoned Vista orders, drains simulated human-agent replies and rolls up daily metrics.
 */
import { hostname } from "node:os";
import {
  Catalog,
  SimulatedHandover,
  appendEvent,
  createContext,
  executeAction,
  ledger,
} from "@voxi/concierge-core";
import { createDb, waitForCommerceSchema } from "@voxi/db";
import { schema as S } from "@voxi/db";
import { eq } from "drizzle-orm";

const { db, sql, close } = createDb();
try {
  await waitForCommerceSchema(db);
} catch (error) {
  console.error((error as Error).message);
  await close();
  process.exit(1);
}
const ctx = createContext(db, { sql });
const catalog = new Catalog(ctx.vista);
const workerId = `${hostname()}-${process.pid}`;
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
let running = true;
let inFlight = 0;

async function loop(slot: number) {
  while (running) {
    try {
      const action = await ledger.claimNext(db, `${workerId}#${slot}`);
      if (!action) {
        await sleep(150);
        continue;
      }
      inFlight++;
      let renewing = false;
      const renewal = setInterval(async () => {
        if (renewing) return;
        renewing = true;
        try {
          if (!(await ledger.renewLease(db, action)))
            ctx.log.warn({ actionId: action.id }, "action lease ownership lost");
        } catch (err) {
          ctx.log.error({ err, actionId: action.id }, "action lease renewal failed");
        } finally {
          renewing = false;
        }
      }, 30000);
      renewal.unref();
      try {
        await executeAction(ctx, catalog, action);
      } finally {
        clearInterval(renewal);
        inFlight--;
      }
    } catch (e) {
      ctx.log.error({ err: e, slot }, "worker loop error");
      await sleep(1000);
    }
  }
}

async function housekeeping() {
  while (running) {
    try {
      const reclaimed = await ledger.reclaimExpiredLeases(db);
      if (reclaimed) ctx.log.warn({ reclaimed }, "reclaimed expired action leases");
      if (ctx.handover instanceof SimulatedHandover) {
        for (const reply of ctx.handover.pending()) {
          const tr = (await db.select().from(S.transfers).where(eq(S.transfers.id, reply.transferId)))[0];
          if (tr && tr.status !== "connected") {
            await db
              .update(S.transfers)
              .set({ status: "connected", connectedAt: new Date(), agentName: reply.agentName })
              .where(eq(S.transfers.id, tr.id));
            await appendEvent(
              db,
              ctx.events,
              reply.conversationId,
              "transfer.status",
              { transferId: tr.id, status: "connected", agentName: reply.agentName },
              "system",
            );
          }
          await appendEvent(
            db,
            ctx.events,
            reply.conversationId,
            "human.message",
            { transferId: reply.transferId, text: reply.text, agentName: reply.agentName },
            "human_agent",
          );
        }
      }
    } catch (e) {
      ctx.log.error({ err: e }, "housekeeping error");
    }
    await sleep(1000);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

ctx.log.info({ workerId, concurrency, handover: ctx.handover.name }, "worker started");
const loops = [...Array.from({ length: concurrency }, (_, i) => loop(i)), housekeeping()];
const shutdown = async () => {
  running = false;
  const deadline = Date.now() + 20000;
  while (inFlight > 0 && Date.now() < deadline) await sleep(100);
  await Promise.race([Promise.all(loops), sleep(2000)]);
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
