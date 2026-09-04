import type { MockConfig } from "./app.js";

export function loadConfig(env = process.env): MockConfig & { port: number; databaseUrl: string } {
  return {
    port: Number(env.VISTA_MOCK_PORT ?? 4010),
    databaseUrl: env.DATABASE_URL ?? "postgres://voxi:voxi@localhost:5432/voxi",
    auth: {
      apiKey: env.VISTA_MOCK_API_KEY ?? "demo-api-key",
      basicSecret: env.VISTA_MOCK_BASIC_SECRET ?? "ZGVtby1hcGkta2V5OmRlbW8tc2VjcmV0",
      tokenTtlSeconds: Number(env.VISTA_MOCK_TOKEN_TTL_SECONDS ?? 3600),
      signingSecret: env.VISTA_MOCK_SIGNING_SECRET ?? "vista-mock-signing-secret",
    },
    order: {
      expiryMinutes: Number(env.VISTA_MOCK_ORDER_EXPIRY_MINUTES ?? 10),
      bookingFeeCentsPerTicket: Number(env.VISTA_MOCK_BOOKING_FEE_CENTS ?? 0), // uae.voxcinemas.com shows no online booking fee
      taxRate: 0.05, // 5% UAE VAT, included in displayed prices (46.00 = 43.81 + 2.19 VAT)
    },
    logging: env.NODE_ENV !== "test",
  };
}
