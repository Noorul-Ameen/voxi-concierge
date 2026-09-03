/**
 * Deployment bootstrap: apply migrations, then seed when the reference catalogue is empty
 * (or when SEED_FORCE=true). Safe to run on every deploy — it never wipes demo data unless forced.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const { sql, db, close } = createDb(undefined, { max: 1 });
await migrate(db, { migrationsFolder: dir });
console.log("bootstrap: migrations applied");
const rows = await sql<{ n: string }[]>`select count(*)::text as n from films`;
const n = rows[0]?.n ?? "0";
const hist = await sql<{ n: string }[]>`select count(*)::text as n from conversations where id like 'demo_%'`;
const h = hist[0]?.n ?? "0";
await close();
const force = /^(1|true|yes)$/i.test(process.env.SEED_FORCE ?? "");
if (Number(n) === 0 || force) {
  console.log(`bootstrap: seeding (films=${n}, force=${force})`);
  await import("./seed/index.js");
} else {
  console.log(`bootstrap: catalogue present (films=${n}); skipping seed`);
}
// Synthetic reporting history (dashboard demo data) — generated once, or when SEED_HISTORY=force.
const histMode = (process.env.SEED_HISTORY ?? "auto").toLowerCase();
if (histMode !== "off" && (histMode === "force" || Number(h) === 0)) {
  console.log(`bootstrap: generating synthetic conversation history (existing=${h})`);
  await import("./seed/history.js");
} else {
  console.log(`bootstrap: synthetic history present (${h} conversations); skipping`);
}
