process.env.TZ = "UTC";
import { serve } from "@hono/node-server";
import { createContext } from "@voxi/concierge-core";
import { createDb } from "@voxi/db";
import { createApp } from "./app.js";

const { db, sql, close } = createDb();
const ctx = createContext(db, { sql });
const app = createApp(ctx, { logging: process.env.NODE_ENV !== "test" });
const port = Number(process.env.CONCIERGE_PORT ?? 4020);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "::" }, (i) =>
  ctx.log.info(
    `concierge-api listening on http://localhost:${i.port} (vista: ${process.env.VISTA_BASE_URL ?? "local mock"}, handover: ${ctx.handover.name})`,
  ),
);
const shutdown = async () => {
  server.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
