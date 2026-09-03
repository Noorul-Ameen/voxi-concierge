import type { Db } from "@voxi/db";
import { DEFAULT_POLICY, type PolicyConfig } from "@voxi/domain";
import { VistaClient, loadVistaConfig } from "@voxi/vista-client";
import pino from "pino";
import type { EventBus } from "./events.js";
import { createEventBus } from "./events.js";
import { GenesysHandover } from "./handover/genesys.js";
import type { HandoverPort } from "./handover/port.js";
import { SimulatedHandover } from "./handover/simulated.js";

export type ConciergeConfig = {
  publicUrl: string;
  toolHmacSecret: string;
  widgetJwtSecret: string;
  elevenLabsWebhookSecret: string;
  elevenLabsApiKey: string;
  elevenLabsAgentId: string;
  market: string;
  currency: string;
  timeZone: string;
  voxWebBaseUrl: string;
  policy: PolicyConfig;
  handoverAdapter: "simulated" | "genesys";
  genesys: {
    region: string;
    clientId: string;
    clientSecret: string;
    integrationId: string;
    webhookSecret: string;
  };
  paymentAdapter: "simulated";
  confirmationTtlSeconds: number;
  orderExpiryMinutes: number;
};

export function loadConciergeConfig(env = process.env): ConciergeConfig {
  return {
    publicUrl: env.CONCIERGE_PUBLIC_URL ?? "http://localhost:4020",
    toolHmacSecret: env.TOOL_HMAC_SECRET ?? "change-me-tool-secret",
    widgetJwtSecret: env.WIDGET_JWT_SECRET ?? "change-me-widget-secret",
    elevenLabsWebhookSecret: env.ELEVENLABS_WEBHOOK_SECRET ?? "",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY ?? "",
    elevenLabsAgentId: env.ELEVENLABS_AGENT_ID ?? "",
    market: env.DEFAULT_MARKET ?? "AE",
    currency: env.DEFAULT_CURRENCY ?? "AED",
    timeZone: env.DEFAULT_TIMEZONE ?? "Asia/Dubai",
    voxWebBaseUrl: env.VOX_WEB_BASE_URL ?? "https://uae.voxcinemas.com",
    policy: {
      ...DEFAULT_POLICY,
      cutoffMinutes: Number(env.CANCELLATION_CUTOFF_MINUTES ?? DEFAULT_POLICY.cutoffMinutes),
      refundMethods: (env.REFUND_METHODS ?? DEFAULT_POLICY.refundMethods.join(","))
        .split(",")
        .map((s) => s.trim()) as PolicyConfig["refundMethods"],
    },
    handoverAdapter: (env.HANDOVER_ADAPTER as "simulated" | "genesys") ?? "simulated",
    genesys: {
      region: env.GENESYS_REGION ?? "mypurecloud.de",
      clientId: env.GENESYS_CLIENT_ID ?? "",
      clientSecret: env.GENESYS_CLIENT_SECRET ?? "",
      integrationId: env.GENESYS_OPEN_MESSAGING_INTEGRATION_ID ?? "",
      webhookSecret: env.GENESYS_WEBHOOK_SECRET ?? "",
    },
    paymentAdapter: "simulated",
    confirmationTtlSeconds: Number(env.CONFIRMATION_TTL_SECONDS ?? 300),
    orderExpiryMinutes: Number(env.VISTA_MOCK_ORDER_EXPIRY_MINUTES ?? 10),
  };
}

export type Logger = pino.Logger;

export type AppContext = {
  db: Db;
  vista: VistaClient;
  cfg: ConciergeConfig;
  events: EventBus;
  handover: HandoverPort;
  log: Logger;
};

export function createContext(
  db: Db,
  overrides: Partial<Omit<AppContext, "db">> & { env?: NodeJS.ProcessEnv } = {},
): AppContext {
  const cfg = overrides.cfg ?? loadConciergeConfig(overrides.env);
  const log =
    overrides.log ??
    pino.default({
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["*.email", "*.phone", "*.Email", "*.Phone"],
    });
  const events = overrides.events ?? createEventBus();
  const vista = overrides.vista ?? new VistaClient(loadVistaConfig(overrides.env));
  const handover =
    overrides.handover ??
    (cfg.handoverAdapter === "genesys" && cfg.genesys.clientId
      ? new GenesysHandover(cfg.genesys, log)
      : new SimulatedHandover());
  return { db, vista, cfg, events, handover, log };
}
