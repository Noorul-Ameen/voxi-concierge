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
afterAll(async () => {
  await database?.close();
});

describe.skipIf(!enabled)("retained Rahul booking across bootstrap journey refresh", () => {
  it("keeps both Rahul bookings visible even when WKGRP33 is an untouched seed, while other obsolete seeds still archive", async () => {
    await expect(
      database!.db.transaction(async (tx) => {
        const named = ["JYSARA1", "JYRAHL1", "JYJAMB1", "JYJAMN1", "WKGRP33", "WXA7K2M"];
        expect(
          await tx.select().from(S.bookings).where(inArray(S.bookings.vistaBookingId, named)),
        ).toHaveLength(named.length);
        // Remove every incidental exclusion inside a rolled-back local transaction.
        // The retained booking must survive even with seed source, version 1 and no action history.
        await tx
          .update(S.bookings)
          .set({ source: "seed", version: 1, refundedValueCents: 0 })
          .where(inArray(S.bookings.vistaBookingId, ["WKGRP33", "WXA7K2M"]));
        await tx
          .delete(S.actions)
          .where(inArray(S.actions.resourceKey, ["booking:WKGRP33", "booking:WXA7K2M"]));
        const rahulBefore = await tx
          .select()
          .from(S.bookings)
          .where(inArray(S.bookings.vistaBookingId, ["WKGRP33", "JYRAHL1"]))
          .orderBy(S.bookings.vistaBookingId);
        const accountsBefore = await tx.select().from(S.loyaltyAccounts).orderBy(S.loyaltyAccounts.memberId);
        const seatsBefore = await tx
          .select()
          .from(S.sessionSeatState)
          .orderBy(S.sessionSeatState.cinemaId, S.sessionSeatState.sessionId);
        const historyBefore = await tx.select().from(S.purchaseHistory).orderBy(S.purchaseHistory.id);
        const env = { DEMO_SCHEDULE_REFRESH: "true", VISTA_PROVIDER: "mock" };
        const first = await refreshDemoJourneyFixtures(tx, env);
        expect(first.enabled).toBe(true);
        expect(first.inserted).toBe(0);
        expect(first.archived).toBeGreaterThanOrEqual(1);
        const rahulAfter = await tx
          .select()
          .from(S.bookings)
          .where(inArray(S.bookings.vistaBookingId, ["WKGRP33", "JYRAHL1"]))
          .orderBy(S.bookings.vistaBookingId);
        expect(rahulAfter.find((row) => row.vistaBookingId === "WKGRP33")?.source).toBe("seed");
        expect(digest(rahulAfter)).toBe(digest(rahulBefore));
        // The provider's normal upcoming search excludes demo-archived source records.
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
        expect(visible.map((row) => row.id).sort()).toEqual(["JYRAHL1", "WKGRP33"]);
        expect(
          (await tx.select().from(S.bookings).where(eq(S.bookings.vistaBookingId, "WXA7K2M")))[0]?.source,
        ).toBe("demo-archived");
        expect((await refreshDemoJourneyFixtures(tx, env)).archived).toBe(0);
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
