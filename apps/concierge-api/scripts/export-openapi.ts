import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildOpenApi } from "../src/openapi.js";

const target = fileURLToPath(new URL("../../../infra/openapi.json", import.meta.url));
const document = buildOpenApi(
  process.env.OPENAPI_SERVER_URL ?? "https://concierge-api-production-3d90.up.railway.app",
);
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Exported ${Object.keys(document.paths ?? {}).length} tool paths.`);
