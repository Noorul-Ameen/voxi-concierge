import { execFileSync } from "node:child_process";
import path from "node:path";
import { schema as S, createDb } from "@voxi/db";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
export default async function setup() {
  const databaseUrl = assertLocalTestDatabase();
  // fresh, deterministic demo data before the suite
  const root = path.resolve(__dirname, "../../..");
  execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/migrate.ts"], {
    cwd: path.join(root, "packages/db"),
    stdio: "inherit",
    env: process.env,
  });
  // Paid orders now retain verified customer references; clear only guarded local
  // test orders before the existing seeder recreates those fixture customers.
  const fixtures = createDb(databaseUrl, { max: 1 });
  try {
    await fixtures.db.delete(S.orders);
  } finally {
    await fixtures.close();
  }
  execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/seed/index.ts"], {
    cwd: path.join(root, "packages/db"),
    stdio: "inherit",
    env: { ...process.env, TZ: "UTC" },
  });
}
