import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createDb } from "@voxi/db";
import { sql } from "drizzle-orm";

export default async function setup() {
  for (const persona of ["SARA", "RAHUL", "JAMES"]) {
    const key = `DEMO_${persona}_PASSWORD`;
    if (!process.env[key]) process.env[key] = randomBytes(32).toString("base64url");
  }
  const source = new URL(
    process.env.VOX_TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgres://voxi:voxi@localhost:55432/voxi",
  );
  if (!["localhost", "127.0.0.1", "[::1]"].includes(source.hostname))
    throw new Error("API tests require a local isolated test database; refusing to seed a remote database.");
  const databaseName = process.env.VOX_TEST_DATABASE_URL ? source.pathname.slice(1) : "voxi_test";
  if (!/^[a-zA-Z][a-zA-Z0-9_]*_test$/.test(databaseName))
    throw new Error("The test database name must end with _test.");
  const admin = new URL(source);
  admin.pathname = "/postgres";
  const connection = createDb(admin.toString(), { max: 1 });
  try {
    const existing = await connection.db.execute(
      sql`select 1 from pg_database where datname = ${databaseName}`,
    );
    if (!existing.length) await connection.db.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
  } finally {
    await connection.close();
  }
  source.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = source.toString();
  // Completed mock orders reference their verified customer. Remove only this
  // guarded local test database's orders before recreating the fixture customers.
  const fixtures = createDb(source.toString(), { max: 1 });
  try {
    const existingOrders = await fixtures.db.execute(sql`select to_regclass('public.orders') as name`);
    if (existingOrders[0]?.name) await fixtures.db.execute(sql`delete from orders`);
  } finally {
    await fixtures.close();
  }
  const root = path.resolve(__dirname, "../../..");
  const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
  // Only the isolated local *_test database is reset. No package-manager install is needed.
  for (const script of ["src/migrate.ts", "src/seed/index.ts"])
    execFileSync(process.execPath, [tsx, script], {
      cwd: path.join(root, "packages/db"),
      stdio: "inherit",
      // Recommendation journeys need regular shows on every test date, including
      // weekdays missing from the captured catalogue. This is local mock data only.
      env: { ...process.env, TZ: "UTC", VISTA_PROVIDER: "mock", DEMO_SCHEDULE_REFRESH: "true" },
    });
}
