import { execSync } from "node:child_process";
import path from "node:path";
export default function setup() {
  // fresh, deterministic demo data before the suite
  execSync("pnpm --filter @voxi/db seed", {
    cwd: path.resolve(__dirname, "../../.."),
    stdio: "inherit",
    env: { ...process.env, TZ: "UTC" },
  });
}
