import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/client.js";
import { commerceSchemaReady, waitForCommerceSchema } from "../src/schema-readiness.js";

afterEach(() => vi.useRealTimers());
describe("commerce schema startup readiness", () => {
  it("uses a read-only inspection of both refund columns and the expanded reference width", async () => {
    const execute = vi.fn(async (_query: unknown) => [{ ready: true }]);
    const db = { execute } as unknown as Db;
    expect(await commerceSchemaReady(db)).toBe(true);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as never).sql;
    expect(query).toContain("information_schema.columns");
    for (const field of [
      "expires_at",
      "remaining_value_cents",
      "reference",
      "character_maximum_length >= 64",
    ])
      expect(query).toContain(field);
    expect(query).not.toMatch(/\b(?:alter|insert|update|delete|create)\b/i);
  });
  it("waits through incomplete migrations and resolves only after the required schema is committed", async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ ready: false }])
      .mockResolvedValueOnce([{ ready: false }])
      .mockResolvedValue([{ ready: true }]);
    let started = false;
    const result = waitForCommerceSchema({ execute } as unknown as Db, { pollIntervalMs: 2000 }).then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(3999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(started).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("fails closed at the deadline when migration 0005 is still missing", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue([{ ready: false }]);
    const result = waitForCommerceSchema({ execute } as unknown as Db, { timeoutMs: 5000 });
    const failure = expect(result).rejects.toThrow("0005_ledger_order_reference");
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("does not expose connection errors and caps even a stalled query at 120 seconds", async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("private database connection details"))
      .mockImplementation(() => new Promise(() => {}));
    const result = waitForCommerceSchema({ execute } as unknown as Db, { timeoutMs: 999_999 });
    const failure = expect(result).rejects.toSatisfy(
      (error: Error) => error.message.includes("startup deadline") && !error.message.includes("private"),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await failure;
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
