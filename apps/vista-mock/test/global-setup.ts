import { execFileSync } from "node:child_process";
import path from "node:path";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
export default function setup() {
  assertLocalTestDatabase();
  // fresh, deterministic demo data before the suite
  const root = path.resolve(__dirname, "../../..");
  execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/migrate.ts"], {
    cwd: path.join(root, "packages/db"),
    stdio: "inherit",
    env: process.env,
  });
  execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/seed/index.ts"], {
    cwd: path.join(root, "packages/db"),
    stdio: "inherit",
    env: { ...process.env, TZ: "UTC" },
  });
}
