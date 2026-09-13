import { randomUUID } from "node:crypto";
import { schema as S } from "@voxi/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHarness } from "./harness.js";

let harness: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness?.stop();
});
const command = (token: string, body: unknown) =>
  harness.api.request("/widget/command", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
async function transfer(conversationId: string) {
  const id = `end_${randomUUID().slice(0, 20)}`;
  await harness.db.insert(S.transfers).values({
    id,
    conversationId,
    reason: "customer_request",
    summary: "Private support context",
    adapter: "simulated",
    externalConversationId: `sim_${id}`,
    status: "connected",
  });
  await harness.db
    .update(S.conversations)
    .set({ mode: "human" })
    .where(eq(S.conversations.id, conversationId));
  return id;
}

describe("ending the widget support conversation", () => {
  it("ends the owned transfer idempotently while preserving the signed-in session", async () => {
    const initial = await harness.session();
    const login = await harness.login(initial.conversationId, "SARA");
    expect(login.ok).toBe(true);
    const session = await harness.session(initial.conversationId);
    const id = await transfer(session.conversationId);
    const [before] = await harness.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, session.conversationId));
    const end = vi.spyOn(harness.ctx.handover, "end");
    try {
      for (let retry = 0; retry < 2; retry++) {
        const response = await command(session.token, { type: "human.end", transferId: id });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
      }
      expect(end).toHaveBeenCalledTimes(1);
      const [closed] = await harness.db.select().from(S.transfers).where(eq(S.transfers.id, id));
      expect(closed).toMatchObject({ status: "ended", summary: "Private support context" });
      expect(closed?.endedAt).toBeInstanceOf(Date);
      const [after] = await harness.db
        .select()
        .from(S.conversations)
        .where(eq(S.conversations.id, session.conversationId));
      expect(after).toEqual({ ...before, mode: "bot" });
      const profile = await harness.widget("profile", session.token);
      expect(profile.customer.id).toBe("cust_sara");
      const events = await harness.db
        .select()
        .from(S.conversationEvents)
        .where(
          and(
            eq(S.conversationEvents.conversationId, session.conversationId),
            eq(S.conversationEvents.type, "transfer.status"),
          ),
        );
      expect(
        events.filter((event) => event.payload.transferId === id && event.payload.status === "ended"),
      ).toHaveLength(1);
    } finally {
      end.mockRestore();
    }
  });

  it("rejects another session's transfer and a revoked session token", async () => {
    const owner = await harness.session();
    const stranger = await harness.session();
    const id = await transfer(owner.conversationId);
    const end = vi.spyOn(harness.ctx.handover, "end");
    try {
      expect((await command(stranger.token, { type: "human.end", transferId: id })).status).toBe(409);
      expect(end).not.toHaveBeenCalled();
      expect((await harness.db.select().from(S.transfers).where(eq(S.transfers.id, id)))[0]?.status).toBe(
        "connected",
      );
      await harness.widget("logout", owner.token, {});
      expect((await command(owner.token, { type: "human.end", transferId: id })).status).toBe(401);
    } finally {
      end.mockRestore();
    }
  });

  it("rejects further customer messages after a support conversation ends", async () => {
    const session = await harness.session();
    const id = await transfer(session.conversationId);
    expect((await command(session.token, { type: "human.end", transferId: id })).status).toBe(200);
    const send = vi.spyOn(harness.ctx.handover, "sendCustomerMessage");
    try {
      expect(
        (await command(session.token, { type: "human.message", transferId: id, text: "Late message" }))
          .status,
      ).toBe(409);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  it("does not reset a newer active handover while an earlier adapter end is pending", async () => {
    const session = await harness.session();
    const originalId = await transfer(session.conversationId);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const end = vi.spyOn(harness.ctx.handover, "end").mockImplementationOnce(async () => {
      entered();
      await blocked;
    });
    try {
      const ending = command(session.token, { type: "human.end", transferId: originalId });
      await started;
      const newId = await transfer(session.conversationId);
      release();
      expect((await ending).status).toBe(200);
      expect(
        (await harness.db.select().from(S.transfers).where(eq(S.transfers.id, originalId)))[0]?.status,
      ).toBe("ended");
      expect((await harness.db.select().from(S.transfers).where(eq(S.transfers.id, newId)))[0]?.status).toBe(
        "connected",
      );
      expect(
        (
          await harness.db
            .select()
            .from(S.conversations)
            .where(eq(S.conversations.id, session.conversationId))
        )[0]?.mode,
      ).toBe("human");
    } finally {
      release();
      end.mockRestore();
    }
  });

  it("does not publish an old end event into an account generation changed during adapter await", async () => {
    const session = await harness.session();
    const id = await transfer(session.conversationId);
    const [before] = await harness.db
      .select()
      .from(S.conversations)
      .where(eq(S.conversations.id, session.conversationId));
    const end = vi.spyOn(harness.ctx.handover, "end").mockImplementationOnce(async () => {
      // The boundary commits while the external adapter request is in flight.
      await harness.db
        .update(S.conversations)
        .set({
          metadata: {
            ...before!.metadata,
            widgetSessionKey: "new-session",
            widgetAuthGeneration: Number(before!.metadata?.widgetAuthGeneration ?? 0) + 1,
          },
        })
        .where(eq(S.conversations.id, session.conversationId));
    });
    try {
      expect((await command(session.token, { type: "human.end", transferId: id })).status).toBe(200);
      const [current] = await harness.db
        .select()
        .from(S.conversations)
        .where(eq(S.conversations.id, session.conversationId));
      expect(current?.mode).toBe("human");
      const events = await harness.db
        .select()
        .from(S.conversationEvents)
        .where(eq(S.conversationEvents.conversationId, session.conversationId));
      expect(events.filter((event) => event.type === "transfer.status")).toHaveLength(0);
      expect(events.find((event) => event.type === "audit.stale_ui")?.payload).toMatchObject({
        transferId: id,
        originalType: "transfer.status",
      });
    } finally {
      end.mockRestore();
    }
  });
});
