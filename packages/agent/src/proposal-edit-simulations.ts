import { type SimulationMock, type SimulationSuite, rejectUnexpectedFilters } from "./simulations.js";
import { buildUiAcknowledgementSuite } from "./ui-acknowledgement-simulations.js";

type CapturedProposal = {
  sessionKey: string;
  filmTitle: string;
  hoCode: string;
  cinemaId: string;
  cinemaName: string;
  showtime: string;
  date: string;
  experience: string;
  tickets: number;
  childTickets: number;
  seats: { row: string; number: string }[];
  totalCents: number;
  total: string;
};
export function buildProposalEditSuite(
  clockLocal: string,
  initial: CapturedProposal,
  revised: CapturedProposal,
): SimulationSuite {
  if (
    initial.hoCode !== revised.hoCode ||
    initial.cinemaId !== revised.cinemaId ||
    initial.tickets !== 1 ||
    initial.childTickets !== 1 ||
    revised.tickets !== 1 ||
    revised.childTickets !== 1
  )
    throw new Error("Use captured same-film/site one-adult one-child proposals");
  const { common_tool_mock_overrides, fixture } = buildUiAcknowledgementSuite(clockLocal);
  const ok = (
    data: unknown,
    conditions: Record<string, string | number> = {},
    ui?: unknown,
  ): SimulationMock => ({
    parameter_conditions: Object.entries(conditions).map(([path, value]) => ({
      path,
      eval: { type: "exact", expected_value: String(value) },
    })),
    is_error: false,
    mock_result: JSON.stringify({ ok: true, data, ...(ui ? { ui } : {}) }),
  });
  const first = {
    ...initial,
    showtimeLabel: "tomorrow at 11:00 pm",
    preferredExperience: "KIDS",
    held: false,
  };
  const next = {
    ...revised,
    showtimeLabel: "tomorrow at 6:30 pm",
    isAlternative: true,
    requested: { time: "19:00" },
    preferredExperience: "KIDS",
    held: false,
  };
  return {
    format_version: 1,
    fixture,
    common_tool_mock_overrides,
    tests: (["en", "ar"] as const).map((language) => ({
      id: `proposal-edit-${language}`,
      scenario_group: "proposal-edit",
      type: "simulation",
      name: `VOX Current family proposal edit ${language}`,
      dynamic_variables: {
        customerId: "fixture_sara",
        memberId: "",
        firstName: "Sara",
        channel: "web",
        language,
        greetingEn: "Welcome back, Sara.",
        greetingAr: "أهلاً بعودتك سارة.",
      },
      chat_history: [],
      success_conditions: [
        "Read the actual recommended show and produce an unheld proposal for one adult and one seven-year-old; obtain the real PG13 age rule before suitability. Do not invent a usual cinema, exact price or available seats.",
        "The first KIDS23:00 option is outside the returned usual18:00–20:00 window. Never call it the usual time or conceal the late alternative.",
        "After the guest requests around19:00, propose the returned Premier18:30 show. Explain the changed experience/time and exact new total AED108.50 briefly, without repeating unchanged film/cinema/ticket count or calculating a price difference. Keep both proposals unheld until accepted.",
        "The guest declines to reserve after the edit. No quick_book, hold, food, offer application, payment or new booking is permitted; no repeated next-step question after refusal.",
      ],
      simulation_scenario:
        language === "ar"
          ? "تحدثي بالعربية فقط. قولي بالنص: اقترحي خطة لفيلم سبايدرمان غداً لي ولابني عمره سبع سنوات في السينما التي أزورها عادةً. لا تقولي السينما العادية ولا تطلبي تجربة ستاندرد. بعد العرض: أفضل حوالي السابعة مساءً. بعد الاقتراح المعدل: شكراً، سأقرر لاحقاً، لا تحجزي شيئاً. لا تقبلي أي اقتراح."
          : "Say 'Suggest a Spider-Man plan tomorrow for me and my seven-year-old son at my usual cinema.' After the first proposal say 'I prefer around seven in the evening.' After the revised proposal say 'Thanks, I will decide later; do not hold anything.' Never accept either proposal.",
      simulation_max_turns: 5,
      tool_mock_config: { mocking_strategy: "all", fallback_strategy: "raise_error", mocked_tool_ids: [] },
      tool_mock_overrides: {
        get_session_context: [
          ok({
            isLoggedIn: true,
            language,
            localTime: clockLocal,
            customer: {
              id: "fixture_sara",
              firstName: "Sara",
              profile: {
                cinemaId: initial.cinemaId,
                cinemaName: initial.cinemaName,
                preferredExperience: "KIDS",
                weekday: { from: "18:00", to: "20:00", around: "19:00" },
                seatPreference: "middle",
              },
            },
            activeOrder: null,
          }),
        ],
        get_recommendations: rejectUnexpectedFilters(
          [
            ok({
              movies: [
                {
                  title: initial.filmTitle,
                  hoCode: initial.hoCode,
                  rating: "PG13",
                  family: true,
                  suggestedSession: initial,
                  why: ["preferred KIDS experience; the only KIDS showing is late"],
                },
              ],
              profile: {
                inferred: {
                  preferredExperience: "KIDS",
                  weekday: { from: "18:00", to: "20:00", around: "19:00" },
                },
              },
              date: initial.date,
            }),
          ],
          {
            cinemaId: [initial.cinemaId],
            cinemaName: [initial.cinemaName, "MOE"],
            time: [],
            timeFrom: [],
            timeTo: [],
            experience: [],
            filmLanguage: ["English"],
            language: [],
          },
        ),
        search_films: [ok({ films: [{ title: initial.filmTitle, hoCode: initial.hoCode, rating: "PG13" }] })],
        get_film: [ok({ film: { title: initial.filmTitle, hoCode: initial.hoCode, rating: "PG13" } })],
        get_age_rules: [
          ok(
            {
              allowed: true,
              minimumAge: 0,
              classificationKnown: true,
              provisional: false,
              verdict:
                "PG13 permits a7-year-old accompanied by someone aged13 or older; parents should judge content suitability.",
            },
            { rating: "PG13", childAge: 7 },
          ),
        ],
        search_sessions: [
          ok({ sessions: [revised] }, { cinemaId: revised.cinemaId }),
          ok({ sessions: [revised] }, { cinemaName: revised.cinemaName }),
        ],
        propose_booking: [
          {
            parameter_conditions: [
              { path: "experience", eval: { type: "exact", expected_value: "Standard" } },
            ],
            is_error: true,
            mock_result: JSON.stringify({
              ok: false,
              error: {
                code: "NO_MATCH",
                message:
                  "No Standard show matches this request; the supplied experience cannot silently return KIDS or Premier.",
                retryable: false,
              },
            }),
          },
          ok(
            { proposal: next, proposalToken: "fixture_edited_proposal", needs: "proposal_acceptance" },
            { time: "19:00", tickets: 1, childTickets: 1 },
            { type: "booking_proposal", items: [next] },
          ),
          ok(
            { proposal: next, proposalToken: "fixture_edited_proposal", needs: "proposal_acceptance" },
            { sessionKey: revised.sessionKey, tickets: 1, childTickets: 1 },
            { type: "booking_proposal", items: [next] },
          ),
          ok(
            { proposal: next, proposalToken: "fixture_edited_proposal", needs: "proposal_acceptance" },
            { timeFrom: "18:00", timeTo: "20:00", tickets: 1, childTickets: 1 },
            { type: "booking_proposal", items: [next] },
          ),
          ok(
            { proposal: first, proposalToken: "fixture_initial_proposal", needs: "proposal_acceptance" },
            { sessionKey: initial.sessionKey, tickets: 1, childTickets: 1 },
            { type: "booking_proposal", items: [first] },
          ),
          ...(
            [{ title: initial.filmTitle }, { title: "Spider-Man" }, { hoCode: initial.hoCode }] as Record<
              string,
              string
            >[]
          ).map((selected) =>
            ok(
              { proposal: first, proposalToken: "fixture_initial_proposal", needs: "proposal_acceptance" },
              { ...selected, tickets: 1, childTickets: 1 },
              { type: "booking_proposal", items: [first] },
            ),
          ),
        ],
      },
    })),
  };
}
