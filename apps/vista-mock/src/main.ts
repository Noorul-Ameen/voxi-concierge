process.env.TZ = "UTC"; // timestamps without time zone are read as UTC wall-clock; keep every service consistent
import { serve } from "@hono/node-server";
import { createDb } from "@voxi/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { expireAbandonedOrders } from "./services/orders.js";

const cfg = loadConfig();
const { db, close } = createDb(cfg.databaseUrl);
const app = createApp(db, cfg);
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
const server = listen(cfg.port, (info) =>
  console.log(`vista-mock listening on http://localhost:${info.port}`),
);
const sweep = setInterval(
  () => expireAbandonedOrders(db).catch((e) => console.error("expiry sweep failed", e)),
  60_000,
);
const shutdown = async () => {
  clearInterval(sweep);
  server.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
