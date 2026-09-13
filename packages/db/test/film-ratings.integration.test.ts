import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";
import { createDb } from "../src/client.js";
import * as S from "../src/schema/index.js";
import {
  filmClassificationConflictSet,
  readCapturedFilmSnapshot,
  syncCapturedFilmRatings,
} from "../src/seed/film-ratings.js";

const enabled = process.env.DEMO_SCHEDULE_TEST === "true";
const database = enabled ? createDb(assertLocalTestDatabase(), { max: 2 }) : null;
afterAll(async () => {
  await database?.close();
});
const rollback = new Error("rollback isolated classification test");

describe.skipIf(!enabled)("bounded captured classification sync against PostgreSQL", () => {
  it("corrects captured ratings idempotently without changing other film fields, bookings, holds, balances or history", async () => {
    assertLocalTestDatabase();
    const snapshot = await readCapturedFilmSnapshot();
    await expect(
      database!.db.transaction(
        async (tx) => {
          await tx
            .update(S.films)
            .set({ rating: "18TC", ratingDescription: "Previous provisional classification" })
            .where(eq(S.films.hoCode, "HO00013575"));
          const beforeFilms = await tx.select().from(S.films).orderBy(S.films.hoCode);
          const customers = await tx.select().from(S.customers).orderBy(S.customers.id);
          const bookings = await tx.select().from(S.bookings).orderBy(S.bookings.vistaBookingId);
          const history = await tx.select().from(S.purchaseHistory).orderBy(S.purchaseHistory.id);
          const orders = await tx.select().from(S.orders).orderBy(S.orders.userSessionId);
          const seats = await tx
            .select()
            .from(S.sessionSeatState)
            .orderBy(S.sessionSeatState.cinemaId, S.sessionSeatState.sessionId);
          const result = await syncCapturedFilmRatings(tx, snapshot);
          expect(result.updated).toBeGreaterThanOrEqual(1);
          expect((await syncCapturedFilmRatings(tx, snapshot)).updated).toBe(0);
          const afterFilms = await tx.select().from(S.films).orderBy(S.films.hoCode);
          expect(afterFilms.find((row) => row.hoCode === "HO00013575")).toMatchObject({
            rating: "PG15",
            ratingDescription: expect.stringContaining("15"),
          });
          const omitClassification = ({
            rating: _rating,
            ratingDescription: _description,
            ...rest
          }: typeof S.films.$inferSelect) => rest;
          expect(afterFilms.map(omitClassification)).toEqual(beforeFilms.map(omitClassification));
          expect(await tx.select().from(S.customers).orderBy(S.customers.id)).toEqual(customers);
          expect(await tx.select().from(S.bookings).orderBy(S.bookings.vistaBookingId)).toEqual(bookings);
          expect(await tx.select().from(S.purchaseHistory).orderBy(S.purchaseHistory.id)).toEqual(history);
          expect(await tx.select().from(S.orders).orderBy(S.orders.userSessionId)).toEqual(orders);
          expect(
            await tx
              .select()
              .from(S.sessionSeatState)
              .orderBy(S.sessionSeatState.cinemaId, S.sessionSeatState.sessionId),
          ).toEqual(seats);
          throw rollback;
        },
        { isolationLevel: "repeatable read" },
      ),
    ).rejects.toBe(rollback);
  }, 60_000);

  it("skips mismatched identities and invalid captures, and protects a known rating during normal seed upserts", async () => {
    assertLocalTestDatabase();
    await expect(
      database!.db.transaction(
        async (tx) => {
          const [existing] = await tx.select().from(S.films).where(eq(S.films.hoCode, "HO00013575"));
          expect(existing).toBeDefined();
          const record = {
            hoCode: existing!.hoCode,
            title: existing!.title,
            slug: existing!.slug,
            websiteUrl: existing!.websiteUrl,
            rating: "PG15",
          };
          for (const change of [
            { title: "A different movie" },
            { slug: "different-film", websiteUrl: "https://uae.voxcinemas.com/movies/different-film" },
            { rating: "" },
            { rating: "TBC" },
          ]) {
            expect(
              (
                await syncCapturedFilmRatings(tx, {
                  capturedAt: "2026-09-13T19:25:13.655Z",
                  films: [{ ...record, ...change }],
                })
              ).updated,
            ).toBe(0);
          }
          const [unchanged] = await tx.select().from(S.films).where(eq(S.films.hoCode, existing!.hoCode));
          expect(unchanged).toEqual(existing);
          for (const rating of ["", "TBC"]) {
            await tx
              .insert(S.films)
              .values({ ...existing!, rating, ratingDescription: "" })
              .onConflictDoUpdate({ target: S.films.hoCode, set: filmClassificationConflictSet });
            expect((await tx.select().from(S.films).where(eq(S.films.hoCode, existing!.hoCode)))[0]).toEqual(
              existing,
            );
          }
          await tx
            .insert(S.films)
            .values({ ...existing!, rating: "PG15", ratingDescription: "Verified captured description" })
            .onConflictDoUpdate({ target: S.films.hoCode, set: filmClassificationConflictSet });
          expect((await tx.select().from(S.films).where(eq(S.films.hoCode, existing!.hoCode)))[0]).toEqual({
            ...existing,
            rating: "PG15",
            ratingDescription: "Verified captured description",
          });
          throw rollback;
        },
        { isolationLevel: "repeatable read" },
      ),
    ).rejects.toBe(rollback);
  });
});
