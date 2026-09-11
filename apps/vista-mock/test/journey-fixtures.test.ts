import { schema as S } from "@voxi/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { refreshDemoJourneyFixtures } from "../../../packages/db/src/seed/journey-fixtures.js";
import { testApp } from "./helpers.js";
const app = testApp();
afterAll(async () => {
  await app.close();
});
it("creates tagged persona journeys once, archives only untouched named seed examples and never resets a changed fixture", async () => {
  const disabled = await refreshDemoJourneyFixtures(app.db, {
    DEMO_SCHEDULE_REFRESH: "true",
    VISTA_PROVIDER: "live",
  });
  expect(disabled).toMatchObject({ enabled: false, inserted: 0 });
  const [protectedBooking] = await app.db
    .update(S.bookings)
    .set({ version: 2 })
    .where(eq(S.bookings.vistaBookingId, "WMB6GQ2"))
    .returning();
  const history = await app.db.select().from(S.purchaseHistory);
  const env = { DEMO_SCHEDULE_REFRESH: "true", VISTA_PROVIDER: "mock" };
  const created = await refreshDemoJourneyFixtures(app.db, env);
  expect(created.inserted).toBe(4);
  const fixtures = await app.db.select().from(S.bookings).where(eq(S.bookings.source, "demo-journey-v1"));
  expect(fixtures).toHaveLength(4);
  const sara = fixtures.find((b) => b.customerId === "cust_sara")!;
  expect(sara.tickets).toHaveLength(2);
  expect(sara.tickets.filter((t) => /child/i.test(t.Description))).toHaveLength(1);
  expect(sara.concessions.map((c) => c.ItemId).sort()).toEqual(["7747", "9540"]);
  expect(fixtures.filter((b) => b.customerId === "cust_rahul")).toHaveLength(1);
  expect(
    fixtures
      .filter((b) => b.customerId === "cust_james")
      .map((b) => b.appliedOffers.length)
      .sort(),
  ).toEqual([0, 1]);
  const [protectedAfter] = await app.db
    .select()
    .from(S.bookings)
    .where(eq(S.bookings.vistaBookingId, "WMB6GQ2"));
  expect(protectedAfter).toEqual(protectedBooking);
  expect(await app.db.select().from(S.purchaseHistory)).toEqual(history);
  const [changed] = await app.db
    .update(S.bookings)
    .set({ status: "refunded", version: 2, refundedValueCents: sara.totalValueCents })
    .where(eq(S.bookings.vistaBookingId, sara.vistaBookingId))
    .returning();
  const repeated = await refreshDemoJourneyFixtures(app.db, env);
  expect(repeated.inserted).toBe(0);
  const [after] = await app.db
    .select()
    .from(S.bookings)
    .where(eq(S.bookings.vistaBookingId, sara.vistaBookingId));
  expect(after).toEqual(changed);
});
