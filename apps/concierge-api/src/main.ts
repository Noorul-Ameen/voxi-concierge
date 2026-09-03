process.env.TZ = "UTC";
import { serve } from "@hono/node-server";
import { createContext } from "@voxi/concierge-core";
import { createDb } from "@voxi/db";
import { createApp } from "./app.js";

const { db, sql, close } = createDb();
const ctx = createContext(db, { sql });
const app = createApp(ctx, { logging: process.env.NODE_ENV !== "test" });
const port = Number(process.env.CONCIERGE_PORT ?? 4020);
/** Bind dual-stack ("::") where available, falling back to IPv4 on hosts without IPv6. */
function listen(port: number, onListen: (info: { port: number }) => void) {
  const host = process.env.HOST;
  const hosts = host ? [host] : ["::", "0.0.0.0"];
  const tryHost = (i: number): ReturnType<typeof serve> => {
    const s = serve({ fetch: app.fetch, port, hostname: hosts[i] }, onListen);
    s.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EAFNOSUPPORT" && i + 1 < hosts.length) tryHost(i + 1);
      else throw err;
    });
    return s;
  };
  return tryHost(0);
}
const server = listen(port, (i) =>
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
