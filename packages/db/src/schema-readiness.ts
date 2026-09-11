import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/** Inspect committed schema only. API bootstrap remains the sole migration writer. */
export async function commerceSchemaReady(db: Db): Promise<boolean> {
  const rows = await db.execute<{ ready: boolean }>(sql`
    select (
      exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name = 'loyalty_ledger' and column_name = 'expires_at' and data_type = 'timestamp with time zone')
      and exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name = 'loyalty_ledger' and column_name = 'remaining_value_cents' and data_type = 'integer')
      and exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name = 'loyalty_ledger' and column_name = 'reference' and data_type = 'character varying'
        and character_maximum_length >= 64)
    ) as ready
  `);
  return rows[0]?.ready === true;
}

/** Do not bind HTTP or claim jobs until migrations 0004/0005 are visible. */
export async function waitForCommerceSchema(
  db: Db,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 120_000, 120_000));
  const interval = Math.max(1, Math.min(options.pollIntervalMs ?? 2_000, timeout));
  const deadline = Date.now() + timeout;
  const fail = () =>
    new Error(
      "Database schema is not ready: required migrations 0004_refund_credit_expiry and 0005_ledger_order_reference were not visible before the startup deadline. Check API bootstrap migration status.",
    );
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A stalled connection/query must not defeat the overall startup deadline.
      const ready = await Promise.race([
        commerceSchemaReady(db).catch(() => false),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now()));
        }),
      ]);
      if (ready) return;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
  }
  throw fail();
}
