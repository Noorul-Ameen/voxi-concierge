/**
 * Apigee-style authentication as documented for the VOX partner API:
 *   GET /v1/oauth/generate?grant_type=client_credentials  (Authorization: Basic {secret})
 *   → { access_token, token_type, expires_in, issued_at, ... }
 *   Every other call: x-api-key + Authorization: Bearer {token}
 * Failures use the Apigee "fault" envelope. Tokens are stateless HMAC tokens so the mock scales horizontally.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

export type AuthConfig = { apiKey: string; basicSecret: string; tokenTtlSeconds: number; signingSecret: string };

export function fault(c: Context, status: 401 | 403 | 400, faultstring: string, errorcode: string) {
  return c.json({ fault: { faultstring, detail: { errorcode } } }, status);
}

export function issueToken(cfg: AuthConfig, now = Date.now()) {
  const exp = Math.floor(now / 1000) + cfg.tokenTtlSeconds;
  const payload = Buffer.from(JSON.stringify({ exp, iat: Math.floor(now / 1000), cid: "voxi-demo" })).toString("base64url");
  const sig = createHmac("sha256", cfg.signingSecret).update(payload).digest("base64url");
  return {
    access_token: `${payload}.${sig}`,
    token_type: "BearerToken",
    expires_in: String(cfg.tokenTtlSeconds),
    issued_at: String(now),
    scope: "",
    status: "approved",
    api_product_list: "[VistaTickets]",
    client_id: "voxi-demo",
  };
}

export function verifyToken(cfg: AuthConfig, token: string, now = Date.now()): "ok" | "expired" | "invalid" {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return "invalid";
  const expect = createHmac("sha256", cfg.signingSecret).update(payload).digest("base64url");
  if (expect.length !== sig.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return "invalid";
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return exp * 1000 < now ? "expired" : "ok";
  } catch {
    return "invalid";
  }
}

export function oauthHandler(cfg: AuthConfig) {
  return (c: Context) => {
    const grant = c.req.query("grant_type");
    if (grant !== "client_credentials") return fault(c, 400, "Unsupported grant type", "oauth.v2.InvalidGrantType");
    const auth = c.req.header("authorization") ?? "";
    const m = auth.match(/^Basic\s+(.+)$/i);
    if (!m) return fault(c, 401, "Invalid Basic auth header", "oauth.v2.InvalidBasicAuthHeader");
    const provided = m[1]!.trim();
    // accept the raw secret or base64(apikey:secret)
    const ok = provided === cfg.basicSecret || Buffer.from(provided, "base64").toString() === `${cfg.apiKey}:${Buffer.from(cfg.basicSecret, "base64").toString().split(":")[1] ?? ""}`;
    if (!ok) return fault(c, 401, "Invalid client identifier", "oauth.v2.InvalidClientIdentifier");
    return c.json(issueToken(cfg));
  };
}

export function requireAuth(cfg: AuthConfig) {
  return async (c: Context, next: Next) => {
    const key = c.req.header("x-api-key");
    if (!key) return fault(c, 401, "Failed to resolve API Key variable request.header.x-api-key", "steps.oauth.v2.FailedToResolveAPIKey");
    if (key !== cfg.apiKey) return fault(c, 401, "Invalid ApiKey", "oauth.v2.InvalidApiKey");
    const auth = c.req.header("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return fault(c, 401, "Invalid access token", "keymanagement.service.invalid_access_token");
    const v = verifyToken(cfg, m[1]!.trim());
    if (v === "expired") return fault(c, 401, "Access Token expired", "keymanagement.service.access_token_expired");
    if (v === "invalid") return fault(c, 401, "Invalid access token", "keymanagement.service.invalid_access_token");
    await next();
  };
}
