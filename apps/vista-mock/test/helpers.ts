process.env.TZ = "UTC";
import { createDb } from "@voxi/db";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

export function testApp() {
  const cfg = loadConfig({ ...process.env, NODE_ENV: "test", VISTA_MOCK_TOKEN_TTL_SECONDS: "3600" });
  const { db, close } = createDb(cfg.databaseUrl, { max: 5 });
  const app = createApp(db, cfg);
  const BASE = "/vistatickets/vista/v2";
  let token = "";
  const auth = async () => {
    const res = await app.request("/v1/oauth/generate?grant_type=client_credentials", { headers: { authorization: `Basic ${cfg.auth.basicSecret}` } });
    const j = (await res.json()) as { access_token: string };
    token = j.access_token;
    return j;
  };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`${BASE}${path}`, {
      method,
      headers: { "x-api-key": cfg.auth.apiKey, authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { app, db, close, cfg, auth, call, get: (p: string) => call("GET", p), post: (p: string, b?: unknown) => call("POST", p, b) };
}
