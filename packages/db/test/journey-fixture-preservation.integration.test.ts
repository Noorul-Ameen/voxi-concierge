import { createHash } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { createDb } from "../src/client.js";
import * as S from "../src/schema/index.js";
import { refreshDemoJourneyFixtures } from "../src/seed/journey-fixtures.js";

const enabled = process.env.DEMO_SCHEDULE_TEST === "true";
const database = enabled ? createDb(assertLocalTestDatabase(), { max: 2 }) : null;
const rollback = new Error("rollback isolated journey preservation test");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const env = { DEMO_SCHEDULE_REFRESH: "true", VISTA_PROVIDER: "mock" };
afterAll(async () => {
  await database?.close();
});

describe.skipIf(!enabled)("Rahul demo bookings across bootstrap journey refresh", () => {
  it("archives a pristine WKGRP33 seed so Rahul keeps exactly one live booking, while a used WKGRP33 and every other record are left alone", async () => {
    await expect(
      database!.db.transaction(async (tx) => {
        // The plain seed does not enable the demo refresh; insert the journey fixtures here so the
        // test is self-contained. Nothing escapes the rolled-back transaction.
        expect((await refreshDemoJourneyFixtures(tx, env)).enabled).toBe(true);
        const named = ["JYSARA1", "JYRAHL1", "JYJAMB1", "JYJAMN1", "WKGRP33", "WXA7K2M"];
        expect(
          await tx.select().from(S.bookings).where(inArray(S.bookings.vistaBookingId, named)),
        ).toHaveLength(named.length);
        // Reset both obsolete seeds to their pristine state: seed source, version 1, no refund, no action history.
        await tx
          .update(S.bookings)
          .set({ source: "seed", version: 1, refundedValueCents: 0 })
          .where(inArray(S.bookings.vistaBookingId, ["WKGRP33", "WXA7K2M"]));
        await tx
          .delete(S.actions)
          .where(inArray(S.actions.resourceKey, ["booking:WKGRP33", "booking:WXA7K2M"]));
        const jyrahlBefore = await tx
          .select()
          .from(S.bookings)
          .where(eq(S.bookings.vistaBookingId, "JYRAHL1"));
        const accountsBefore = await tx.select().from(S.loyaltyAccounts).orderBy(S.loyaltyAccounts.memberId);
        const seatsBefore = await tx
          .select()
          .from(S.sessionSeatState)
          .orderBy(S.sessionSeatState.cinemaId, S.sessionSeatState.sessionId);
        const historyBefore = await tx.select().from(S.purchaseHistory).orderBy(S.purchaseHistory.id);
        const first = await refreshDemoJourneyFixtures(tx, env);
        expect(first.enabled).toBe(true);
        expect(first.inserted).toBe(0);
        expect(first.archived).toBeGreaterThanOrEqual(2);
        // Brief (Sep 2026): the pristine WKGRP33 seed is archived like the other obsolete seeds.
        for (const id of ["WKGRP33", "WXA7K2M"])
          expect(
            (await tx.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, id)))[0]?.source,
          ).toBe("demo-archived");
        // Rahul's journey booking is untouched, and the provider's normal upcoming search sees only it.
        expect(
          digest(await tx.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, "JYRAHL1"))),
        ).toBe(digest(jyrahlBefore));
        const visible = await tx
          .select({ id: S.bookings.vistaBookingId })
          .from(S.bookings)
          .where(
            and(
              eq(S.bookings.customerId, "cust_rahul"),
              inArray(S.bookings.vistaBookingId, ["WKGRP33", "JYRAHL1"]),
              ne(S.bookings.source, "demo-archived"),
            ),
          );
        expect(visible.map((row) => row.id)).toEqual(["JYRAHL1"]);
        expect((await refreshDemoJourneyFixtures(tx, env)).archived).toBe(0);
        // A WKGRP33 that has been acted on (action history) is never archived, even in pristine seed shape.
        await tx
          .update(S.bookings)
          .set({ source: "seed", version: 1, refundedValueCents: 0 })
          .where(eq(S.bookings.vistaBookingId, "WKGRP33"));
        await tx.insert(S.actions).values({
          id: "jfp-test-wkgrp33-used",
          conversationId: "jfp-test",
          idempotencyKey: "jfp-test-wkgrp33-used",
          type: "swap_booking",
          resourceKey: "booking:WKGRP33",
          input: {},
          status: "succeeded",
        });
        expect((await refreshDemoJourneyFixtures(tx, env)).archived).toBe(0);
        expect(
          (await tx.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, "WKGRP33")))[0]?.source,
        ).toBe("seed");
        expect(digest(await tx.select().from(S.loyaltyAccounts).orderBy(S.loyaltyAccounts.memberId))).toBe(
          digest(accountsBefore),
        );
        expect(
          digest(
            await tx
              .select()
              .from(S.sessionSeatState)
              .orderBy(S.sessionSeatState.cinemaId, S.sessionSeatState.sessionId),
          ),
        ).toBe(digest(seatsBefore));
        expect(digest(await tx.select().from(S.purchaseHistory).orderBy(S.purchaseHistory.id))).toBe(
          digest(historyBefore),
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }, 60000);
});
