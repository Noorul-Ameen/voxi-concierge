import { randomUUID } from "node:crypto";
import { schema as S, createDb } from "@voxi/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { appendEvent, createEventBus } from "../src/events.js";
import { ensureConversation, updateConversation } from "../src/services/conversation.js";
import { beginInlineBasketMutation, finishInlineBasketMutation } from "../src/services/inline-mutation.js";
import {
  beginProposal,
  currentProposal,
  mergeProposalEdit,
  saveProposal,
} from "../src/services/proposal-draft.js";
import { quickTools } from "../src/tools/quick.js";
import type { ToolCtx } from "../src/tools/types.js";

let connection: ReturnType<typeof createDb>;
const ids: string[] = [];
beforeAll(() => {
  connection = createDb(process.env.DATABASE_URL!, { max: 8 });
});
afterEach(async () => {
  for (const id of ids.splice(0))
    await connection.db.delete(S.conversations).where(eq(S.conversations.id, id));
});
afterAll(async () => {
  await connection.close();
});

async function fixture(lang: "en" | "ar" = "en") {
  const id = `draft_${randomUUID()}`;
  ids.push(id);
  const conversation = await ensureConversation(connection.db, { conversationId: id });
  const films = ["old", "new"].map((hoCode) => ({
    hoCode,
    title: hoCode,
    rating: "PG13",
    language: "English",
    genres: [],
  }));
  const shows = [
    {
      key: "0002-old",
      sessionId: "old",
      hoCode: "old",
      showtime: "2070-09-15T18:30:00",
      experience: "Premier",
    },
    {
      key: "0002-new",
      sessionId: "new",
      hoCode: "new",
      showtime: "2070-09-15T18:30:00",
      experience: "Premier",
    },
    {
      key: "0002-late",
      sessionId: "late",
      hoCode: "new",
      showtime: "2070-09-15T23:00:00",
      experience: "KIDS",
    },
  ].map((s) => ({
    ...s,
    cinemaId: "0002",
    filmTitle: s.hoCode,
    soldOut: false,
    allowTicketSales: true,
    seatsAvailable: 10,
  }));
  const cinema = { id: "0002", name: "Mall of the Emirates" };
  const ctx = {
    db: connection.db,
    conversation,
    lang,
    nowLocal: "2070-09-14T12:00:00",
    toolCallId: "proposal-test",
    events: createEventBus(),
    cfg: { widgetJwtSecret: "local-proposal-test", orderExpiryMinutes: 6 },
    catalog: {
      cinemas: async () => [cinema],
      cinema: async () => cinema,
      films: async () => films,
      film: async (id: string) => films.find((f) => f.hoCode === id),
      resolveFilms: async (title: string) =>
        films.filter((f) => f.title === title).map((film) => ({ film, score: 1 })),
      sessionByKey: async (key: string) => shows.find((s) => s.key === key),
      sessions: async () => shows,
    },
    vista: {
      seatPlan: vi.fn(async () => ({
        SeatLayoutData: {
          ColumnCount: 8,
          Areas: [
            {
              AreaCategoryCode: "STD",
              Rows: [
                {
                  PhysicalName: "C",
                  RowIndexZeroBased: 2,
                  Seats: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
                    Id: String(n),
                    Status: 0,
                    SeatStyle: 0,
                    Position: { ColumnIndex: n - 1 },
                  })),
                },
              ],
            },
          ],
        },
      })),
      ticketTypes: vi.fn(async () => ({
        BookingFeeCentsPerTicket: 250,
        Tickets: [
          { TicketTypeCode: "ADULT", AreaCategoryCode: "STD", PriceInCents: 5000 },
          { TicketTypeCode: "CHILD", AreaCategoryCode: "STD", IsChildOnlyTicket: true, PriceInCents: 3000 },
        ],
      })),
      addTickets: vi.fn(),
      getOrder: vi.fn(async () => ({ Order: null })),
    },
  } as unknown as ToolCtx;
  return { ctx, films, shows };
}
const initial = {
  intent: "initial" as const,
  hoCode: "old",
  cinemaId: "0002",
  date: "tomorrow",
  time: "18:30",
  experience: "Premier" as const,
  tickets: 1,
  childTickets: 1,
  childAges: [7],
};

it.each(["en", "ar"] as const)(
  "preserves calendar day, time, experience and party on a film-only edit (%s)",
  async (lang) => {
    const { ctx } = await fixture(lang);
    const first = await quickTools.propose_booking(ctx, initial);
    expect(first.ok).toBe(true);
    ctx.nowLocal = "2070-09-15T00:05:00";
    const next = await quickTools.propose_booking(ctx, {
      intent: "edit",
      baseProposalRef: first.data!.proposalRef as string,
      title: "new",
    });
    expect(next.data).toMatchObject({
      needs: "proposal_acceptance",
      proposal: {
        sessionKey: "0002-new",
        experience: "Premier",
        showtime: "2070-09-15T18:30:00",
        adultTickets: 1,
        childTickets: 1,
        totalCents: 8500,
        held: false,
      },
      admission: {
        verified: true,
        childAges: [7],
        children: [{ allowed: true, guidanceAge: 13, filmAccompanimentRequired: true }],
      },
    });
    expect(next.data!.proposalRef).not.toBe(first.data!.proposalRef);
    expect(ctx.vista.addTickets).not.toHaveBeenCalled();
  },
);
it("keeps unknown adults unpriced and completes quantity using the same referenced choices", async () => {
  const { ctx } = await fixture();
  const first = await quickTools.propose_booking(ctx, { ...initial, tickets: undefined });
  expect(first.data).toMatchObject({
    needs: "tickets",
    proposal: { ticketQuantity: null, totalCents: null, selectedSeats: [] },
  });
  expect(first.data!.proposalToken).toBeUndefined();
  const next = await quickTools.propose_booking(ctx, {
    intent: "edit",
    baseProposalRef: first.data!.proposalRef as string,
    tickets: 2,
  });
  expect(next.data).toMatchObject({
    proposal: { adultTickets: 2, childTickets: 1, sessionKey: "0002-old", totalCents: 13750 },
  });
});
it("does not certify missing ages or inherit ages after changing the child count", async () => {
  const { ctx } = await fixture();
  const missing = await quickTools.propose_booking(ctx, { ...initial, childAges: undefined });
  expect(missing.data).toMatchObject({ needs: "child_age", admission: { verified: false } });
  expect(missing.data!.proposalToken).toBeUndefined();
  expect(missing.ui!.actions).not.toContainEqual(expect.objectContaining({ value: "proposal:accept" }));
  const first = await quickTools.propose_booking(ctx, initial);
  const changed = await quickTools.propose_booking(ctx, {
    intent: "edit",
    baseProposalRef: first.data!.proposalRef as string,
    childTickets: 2,
  });
  expect(changed.data).toMatchObject({ needs: "child_age", admission: { childAges: [], verified: false } });
});
it.each(["TBC", "18TC", "15TC"])(
  "does not promote a new %s film to an acceptable family draft",
  async (rating) => {
    const { ctx, films } = await fixture();
    const first = await quickTools.propose_booking(ctx, initial);
    films[1]!.rating = rating;
    const failed = await quickTools.propose_booking(ctx, {
      intent: "edit",
      baseProposalRef: first.data!.proposalRef as string,
      title: "new",
    });
    expect(failed.ok).toBe(false);
    expect(currentProposal(ctx.conversation)?.ref).toBe(first.data!.proposalRef);
    expect(ctx.vista.addTickets).not.toHaveBeenCalled();
  },
);
it.each(["GOLD", "THEATRE"] as const)("rechecks the selected %s admission boundary", async (experience) => {
  const { ctx, shows } = await fixture();
  shows[0]!.experience = experience;
  expect(
    (await quickTools.propose_booking(ctx, { ...initial, experience, childAges: [4] })).data,
  ).toMatchObject({ needs: "child_admission" });
  expect(
    (await quickTools.propose_booking(ctx, { ...initial, experience, childAges: [5] })).data,
  ).toMatchObject({
    admission: { verified: true, children: [{ experienceAdmission: { parentOrGuardianRequired: true } }] },
  });
});
it("rejects an exact new session that discards inherited experience and time", async () => {
  const { ctx } = await fixture();
  const first = await quickTools.propose_booking(ctx, initial);
  const next = await quickTools.propose_booking(ctx, {
    intent: "edit",
    baseProposalRef: first.data!.proposalRef as string,
    sessionKey: "0002-late",
    hoCode: "new",
  });
  expect(next.ok).toBe(false);
  expect(next.data?.needs).toBe("proposal_refresh");
  expect(currentProposal(ctx.conversation)?.ref).toBe(first.data!.proposalRef);
});
it("permits an explicit change of time and experience, without carrying seats from the former show", () => {
  const next = mergeProposalEdit(
    { ...initial, sessionKey: "old", seats: [{ row: "C", number: "1" }] },
    { intent: "edit", baseProposalRef: "base", time: "23:00", experience: "KIDS", title: "new" },
  );
  expect(next).toMatchObject({
    date: "tomorrow",
    time: "23:00",
    experience: "KIDS",
    tickets: 1,
    childAges: [7],
  });
  expect(next.sessionKey).toBeUndefined();
  expect(next.hoCode).toBeUndefined();
  expect(next.seats).toBeUndefined();
});
it("CAS admits only one concurrent revision and suppresses obsolete proposal UI", async () => {
  const { ctx } = await fixture();
  const first = await quickTools.propose_booking(ctx, initial);
  const base = first.data!.proposalRef as string;
  const left = await beginProposal(ctx, { intent: "edit", baseProposalRef: base, tickets: 2 });
  const right = await beginProposal(ctx, { intent: "edit", baseProposalRef: base, tickets: 3 });
  const results = await Promise.allSettled([
    saveProposal(ctx, left.expectedRef, left.input),
    saveProposal(ctx, right.expectedRef, right.input),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const delivery = await appendEvent(ctx.db, ctx.events, ctx.conversation.id, "ui.render", { ui: first.ui });
  expect(delivery.suppressed).toBe(true);
  expect(
    (
      await ctx.db
        .select()
        .from(S.conversationEvents)
        .where(eq(S.conversationEvents.conversationId, ctx.conversation.id))
    )[0]!.type,
  ).toBe("audit.stale_ui");
});
it("does not let generic metadata updates restore an obsolete draft", async () => {
  const { ctx } = await fixture();
  await quickTools.propose_booking(ctx, initial);
  const old = structuredClone(ctx.conversation.metadata);
  const next = await quickTools.propose_booking(ctx, { intent: "initial", ...initial, tickets: 2 });
  await updateConversation(ctx.db, ctx.conversation.id, { metadata: { ...old, usualFnb: [] } });
  const row = (
    await ctx.db.select().from(S.conversations).where(eq(S.conversations.id, ctx.conversation.id))
  )[0]!;
  expect(currentProposal(row)?.ref).toBe(next.data!.proposalRef);
});
it("can reprice an expired quote by explicit edit, but cannot edit across an auth generation", async () => {
  const { ctx } = await fixture();
  const first = await quickTools.propose_booking(ctx, initial);
  const expired = { ...currentProposal(ctx.conversation)!, quoteExpiresAt: new Date(0).toISOString() };
  await ctx.db
    .update(S.conversations)
    .set({ metadata: { ...ctx.conversation.metadata, bookingProposalDraft: expired } })
    .where(eq(S.conversations.id, ctx.conversation.id));
  expect(
    (
      await quickTools.propose_booking(ctx, {
        intent: "edit",
        baseProposalRef: first.data!.proposalRef as string,
      })
    ).ok,
  ).toBe(true);
  const ref = currentProposal(ctx.conversation)!.ref;
  await ctx.db
    .update(S.conversations)
    .set({ metadata: { ...ctx.conversation.metadata, widgetAuthGeneration: 1 } })
    .where(eq(S.conversations.id, ctx.conversation.id));
  expect((await quickTools.propose_booking(ctx, { intent: "edit", baseProposalRef: ref })).ok).toBe(false);
});
it("does not save an in-flight edit after the base acceptance finishes", async () => {
  const { ctx } = await fixture();
  const first = await quickTools.propose_booking(ctx, initial);
  const request = await beginProposal(ctx, {
    intent: "edit",
    baseProposalRef: first.data!.proposalRef as string,
    tickets: 2,
  });
  const started = await beginInlineBasketMutation(ctx.db, {
    conversationId: ctx.conversation.id,
    type: "quick_book",
    idempotencyKey: randomUUID(),
    payload: {},
    toolCallId: "hold",
    authGeneration: 0,
    proposalToken: true,
    proposalRef: first.data!.proposalRef as string,
  });
  await expect(saveProposal(ctx, request.expectedRef, request.input)).rejects.toThrow();
  expect(await finishInlineBasketMutation(ctx.db, started.action, { ok: true })).toBe(true);
  await expect(saveProposal(ctx, request.expectedRef, request.input)).rejects.toThrow();
  const row = (
    await ctx.db.select().from(S.conversations).where(eq(S.conversations.id, ctx.conversation.id))
  )[0]!;
  expect(currentProposal(row)).toMatchObject({
    ref: first.data!.proposalRef,
    acceptedActionId: started.action.id,
  });
});
it.each(["title", "cinemaName", "filmLanguage", "titleWithId", "cinemaNameWithId"])(
  "an exact session cannot bypass an explicit %s constraint",
  async (field) => {
    const { ctx } = await fixture();
    const first = await quickTools.propose_booking(ctx, initial);
    ctx.catalog.resolveCinema = vi.fn(async () => ({ cinema: { id: "other" }, score: 1 })) as any;
    const request = {
      title: { title: "new" },
      cinemaName: { cinemaName: "Other cinema" },
      filmLanguage: { filmLanguage: "Arabic" },
      titleWithId: { hoCode: "old", title: "new" },
      cinemaNameWithId: { cinemaId: "0002", cinemaName: "Other cinema" },
    }[field]!;
    const result = await quickTools.propose_booking(ctx, {
      intent: "edit",
      baseProposalRef: first.data!.proposalRef as string,
      sessionKey: "0002-old",
      ...request,
    });
    expect(result.ok).toBe(false);
    expect(result.data?.needs).toBe("proposal_refresh");
    expect(currentProposal(ctx.conversation)?.ref).toBe(first.data!.proposalRef);
  },
);
it("rejects ages supplied for zero child tickets in both initial and edit requests", async () => {
  const { ctx } = await fixture();
  expect((await quickTools.propose_booking(ctx, { ...initial, childTickets: 0 })).data?.needs).toBe(
    "child_tickets",
  );
  const adult = await quickTools.propose_booking(ctx, { ...initial, childTickets: 0, childAges: undefined });
  const edit = await quickTools.propose_booking(ctx, {
    intent: "edit",
    baseProposalRef: adult.data!.proposalRef as string,
    childAges: [7],
  });
  expect(edit.ok).toBe(false);
  expect(edit.data?.needs).toBe("child_tickets");
});
it.each([2, 13, 17])("does not use child-ticket prices for the supplied age %i", async (age) => {
  const { ctx } = await fixture();
  const result = await quickTools.propose_booking(ctx, { ...initial, childAges: [age] });
  expect(result.ok).toBe(false);
  expect(result.data?.needs).toBe("child_tickets");
  expect(result.data?.proposalToken).toBeUndefined();
  expect(ctx.vista.addTickets).not.toHaveBeenCalled();
});
it("rejects changed child admission before starting an action or invalidating checkout consent", async () => {
  const { ctx, films } = await fixture();
  const first = await quickTools.propose_booking(ctx, initial);
  films[0]!.rating = "18TC";
  const result = await quickTools.quick_book(ctx, { proposalToken: first.data!.proposalToken as string });
  expect(result.ok).toBe(false);
  expect(result.data?.needs).toBe("child_admission");
  expect(
    await ctx.db.select().from(S.actions).where(eq(S.actions.conversationId, ctx.conversation.id)),
  ).toHaveLength(0);
  expect(ctx.vista.addTickets).not.toHaveBeenCalled();
});
it("rejects an expired acceptance without creating an action", async () => {
  const { ctx } = await fixture();
  const first = await quickTools.propose_booking(ctx, initial);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 181_000);
  try {
    expect(
      (await quickTools.quick_book(ctx, { proposalToken: first.data!.proposalToken as string })).ok,
    ).toBe(false);
  } finally {
    now.mockRestore();
  }
  expect(
    await ctx.db.select().from(S.actions).where(eq(S.actions.conversationId, ctx.conversation.id)),
  ).toHaveLength(0);
});
it("does not let another conversation edit or accept the draft", async () => {
  const { ctx } = await fixture();
  const first = await quickTools.propose_booking(ctx, initial);
  const { ctx: stranger } = await fixture();
  expect(
    (
      await quickTools.propose_booking(stranger, {
        intent: "edit",
        baseProposalRef: first.data!.proposalRef as string,
      })
    ).ok,
  ).toBe(false);
  expect(
    (await quickTools.quick_book(stranger, { proposalToken: first.data!.proposalToken as string })).ok,
  ).toBe(false);
  expect(stranger.vista.addTickets).not.toHaveBeenCalled();
});
it("rejects mismatched intent/reference combinations instead of silently taking a legacy initial path", async () => {
  const { ctx } = await fixture();
  for (const request of [
    { baseProposalRef: "made-up" },
    { intent: "edit" },
    { intent: "initial", baseProposalRef: "made-up" },
  ]) {
    const result = await quickTools.propose_booking(
      ctx,
      request as Parameters<typeof quickTools.propose_booking>[1],
    );
    expect(result.ok).toBe(false);
  }
  expect(currentProposal(ctx.conversation)).toBeUndefined();
});
it("fences proposal save and acceptance after a different basket becomes current", async () => {
  const { ctx } = await fixture();
  const first = await quickTools.propose_booking(ctx, initial);
  const request = await beginProposal(ctx, {
    intent: "edit",
    baseProposalRef: first.data!.proposalRef as string,
  });
  await ctx.db
    .update(S.conversations)
    .set({ metadata: { ...ctx.conversation.metadata, activeOrder: "another-order" } })
    .where(eq(S.conversations.id, ctx.conversation.id));
  await expect(saveProposal(ctx, request.expectedRef, request.input)).rejects.toThrow();
  expect((await quickTools.quick_book(ctx, { proposalToken: first.data!.proposalToken as string })).ok).toBe(
    false,
  );
  expect(ctx.vista.addTickets).not.toHaveBeenCalled();
  expect(
    await ctx.db.select().from(S.actions).where(eq(S.actions.conversationId, ctx.conversation.id)),
  ).toHaveLength(0);
});
