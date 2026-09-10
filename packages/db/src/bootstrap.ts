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
// A bounded profile upgrade, not the destructive catalogue seed. Passwords are provisioned through environment secrets.
const profileDb = createDb(undefined, { max: 1 });
try {
  const { updateDemoProfiles } = await import("./seed/profile-update.js");
  await updateDemoProfiles(profileDb.db);
  const { refreshDemoSchedule } = await import("./seed/refresh-demo-schedule.js");
  const schedule = await refreshDemoSchedule(profileDb.db);
  const { refreshDemoJourneyFixtures } = await import("./seed/journey-fixtures.js");
  const journeys = await refreshDemoJourneyFixtures(profileDb.db);
  if (journeys.enabled)
    console.log(
      `bootstrap: added ${journeys.inserted} tagged journey fixtures; archived ${journeys.archived} untouched seed examples`,
    );
  if (schedule.enabled)
    console.log(
      `bootstrap: synthetic demo schedule added ${schedule.inserted} sessions for the next ${schedule.days} days`,
    );
} finally {
  await profileDb.close();
}
