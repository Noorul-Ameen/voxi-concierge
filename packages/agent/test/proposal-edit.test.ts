import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { describe, expect, it } from "vitest";
import { buildProposalEditSuite } from "../src/proposal-edit-simulations.js";
import { type SimulationMock, materializeSimulations } from "../src/simulations.js";

const common = {
  filmTitle: "Spider-Man: Brand New Day",
  hoCode: "HO00013065",
  cinemaId: "0002",
  cinemaName: "Mall of the Emirates",
  date: "2026-09-15",
  tickets: 1,
  childTickets: 1,
};
const initial = {
  ...common,
  sessionKey: "0002-628865",
  showtime: "2026-09-15T23:00:00",
  experience: "KIDS",
  seats: [
    { row: "E", number: "9" },
    { row: "E", number: "10" },
  ],
  totalCents: 7550,
  total: "AED 75.50",
};
const revised = {
  ...common,
  sessionKey: "0002-629100",
  showtime: "2026-09-15T18:30:00",
  experience: "Premier",
  seats: [
    { row: "E", number: "6" },
    { row: "E", number: "7" },
  ],
  totalCents: 10850,
  total: "AED 108.50",
};
const tools = [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => ({
  name,
  id: `fixture_${name}`,
}));
const tests = materializeSimulations(
  buildProposalEditSuite("2026-09-14T12:00:00+04:00", initial, revised),
  tools,
);
function resolve(mocks: SimulationMock[], args: Record<string, unknown>) {
  const match = mocks.find((mock) =>
    mock.parameter_conditions.every(({ path, eval: rule }) => {
      const value = args[path];
      if (value === undefined) return false;
      return rule.type === "exact"
        ? String(value) === rule.expected_value
        : new RegExp(rule.pattern).test(String(value));
    }),
  );
  if (!match) throw new Error("Materialized fixture must fail closed on unmatched calls");
  return { ...JSON.parse(match.mock_result), transportError: match.is_error };
}

describe("named-film proposal fixture grounding", () => {
  it("rejects the exact V8 invented recommendation parameters before a broad success mock", () => {
    for (const { body } of tests) {
      const mocks = body.tool_mock_overrides.fixture_get_recommendations;
      for (const args of [
        { withChildren: true, title: "Spider-Man", date: "tomorrow" },
        { kind: "movies", withChildren: true, query: "سبايدرمان", date: "tomorrow" },
      ]) {
        expect(resolve(mocks, args)).toMatchObject({
          ok: false,
          transportError: true,
          error: { code: "UNEXPECTED_SIMULATION_PARAMETER" },
        });
      }
      const broad = resolve(mocks, { date: "tomorrow", withChildren: true });
      expect(broad.ok).toBe(true);
      expect(broad.data.proposalToken).toBeUndefined();
      expect(broad.data.proposal).toBeUndefined();
    }
  });

  it.each(["Spider-Man", "Spider-Man: Brand New Day", "سبايدرمان", "سبايدر مان"])(
    "supports exact %s lookup, actual rating and a complete unheld first proposal",
    (title) => {
      for (const { body } of tests) {
        const mocks = body.tool_mock_overrides;
        const one = resolve(mocks.fixture_get_film, { title });
        const many = resolve(mocks.fixture_search_films, { query: title });
        expect(one.data.film).toEqual(many.data.films[0]);
        expect(one.data.film).toMatchObject({
          hoCode: common.hoCode,
          title: common.filmTitle,
          rating: "PG13",
        });
        expect(one.ui).toMatchObject({ type: "movie", items: [one.data.film] });
        expect(many.ui).toMatchObject({ type: "movie", items: [one.data.film] });
        const age = resolve(mocks.fixture_get_age_rules, { rating: one.data.film.rating, childAge: 7 });
        expect(age.data.allowed).toBe(true);
        const proposal = resolve(mocks.fixture_propose_booking, {
          title,
          date: "tomorrow",
          tickets: 1,
          childTickets: 1,
        });
        expect(proposal.data).toMatchObject({
          proposalToken: "fixture_initial_proposal",
          needs: "proposal_acceptance",
          proposal: {
            ...initial,
            adultTickets: 1,
            ticketQuantity: 2,
            selectedSeats: initial.seats,
            held: false,
          },
        });
        expect(proposal.ui.items[0]).toEqual(proposal.data.proposal);
      }
    },
  );

  it("does not turn a missing, invented or contradictory film lookup into the captured film", () => {
    for (const { body } of tests) {
      const mocks = body.tool_mock_overrides;
      for (const args of [
        {},
        { title: "Invented Family Fun" },
        { query: "Spider-Man" },
        { hoCode: "invented" },
        { hoCode: common.hoCode, title: "Invented Family Fun" },
      ])
        expect(resolve(mocks.fixture_get_film, args).ok).toBe(false);
      for (const args of [{}, { query: "Invented Family Fun" }, { title: "Spider-Man" }])
        expect(resolve(mocks.fixture_search_films, args).ok).toBe(false);
      expect(resolve(mocks.fixture_get_film, { hoCode: common.hoCode }).data.film.hoCode).toBe(common.hoCode);
      expect(resolve(mocks.fixture_get_age_rules, { rating: "PG", childAge: 7 }).ok).toBe(false);
    }
  });

  it("keeps the edited price/time and composition exact, refusing other titles or quantity", () => {
    for (const { body } of tests) {
      const mocks = body.tool_mock_overrides.fixture_propose_booking;
      const args = { title: "سبايدرمان", tickets: 1, childTickets: 1, date: "tomorrow", time: "19:00" };
      const result = resolve(mocks, args);
      expect(result.data).toMatchObject({
        proposalToken: "fixture_edited_proposal",
        proposal: {
          ...revised,
          adultTickets: 1,
          ticketQuantity: 2,
          held: false,
          requested: { time: "19:00" },
        },
      });
      for (const invalid of [
        { ...args, title: "Invented Family Fun" },
        { ...args, tickets: 2 },
        { ...args, childTickets: 0 },
        { ...args, cinemaId: "other" },
        { ...args, experience: "Standard" },
      ])
        expect(resolve(mocks, invalid).ok).toBe(false);
    }
  });

  it("requires the first complete proposal before acceptance while every financial action stays denied", () => {
    for (const { body } of tests) {
      expect(body.success_conditions[0]).toContain("Before the FIRST request to accept/book/hold");
      expect(body.success_conditions[0]).toContain("recommendation or age result alone is insufficient");
      expect(body.success_conditions.at(-1)).toContain(
        "No quick_book, hold, food, offer application, payment",
      );
      expect(body.tool_mock_config).toMatchObject({
        mocking_strategy: "all",
        fallback_strategy: "raise_error",
      });
      for (const name of [
        "quick_book",
        "start_order",
        "add_tickets",
        "select_seats",
        "recover_order",
        "apply_offer",
        "prepare_payment",
        "pay_order",
        "order_fnb",
      ])
        expect(
          resolve(body.tool_mock_overrides[`fixture_${name}`], {
            proposalToken: "fixture_initial_proposal",
            confirmed: true,
          }).ok,
        ).toBe(false);
    }
  });
});
