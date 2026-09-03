import { createDb } from "@voxi/db";
import { afterAll, describe, expect, it } from "vitest";
import { appendEvent, createPgEventBus } from "../src/events.js";

const a = createDb(undefined, { max: 2 });
const b = createDb(undefined, { max: 2 });
afterAll(async () => {
  await a.close();
  await b.close();
});

describe("Postgres event bus", () => {
  it("delivers events published from another connection/process", async () => {
    const busA = createPgEventBus(a.sql, a.db);
    const busB = createPgEventBus(b.sql, b.db);
    const conv = `conv_bus_${Date.now()}`;
    const got: unknown[] = [];
    const off = busB.subscribe(conv, (e) => got.push(e));
    await new Promise((r) => setTimeout(r, 300)); // LISTEN registration
    await appendEvent(a.db, busA, conv, "ui.render", { ui: { type: "movie", items: [] } }, "agent");
    await new Promise((r) => setTimeout(r, 500));
    expect(got).toHaveLength(1);
    expect((got[0] as { type: string }).type).toBe("ui.render");
    off();
    await busA.close();
    await busB.close();
  });
});
