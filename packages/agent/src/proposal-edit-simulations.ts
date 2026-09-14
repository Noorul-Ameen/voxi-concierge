import { guardProposalAges, proposalEvidence } from "./proposal-fixtures.js";
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
  const titleAliases = [...new Set([initial.filmTitle, "Spider-Man", "سبايدرمان", "سبايدر مان"])];
  // Only captured identity/classification facts; no recommendation or showtime is implied by a film read.
  const film = {
    title: initial.filmTitle,
    titleEn: initial.filmTitle,
    hoCode: initial.hoCode,
    rating: "PG13",
    language: "English",
    status: "now_showing",
  };
  const ok = (
    data: unknown,
    conditions: Record<string, string | number | number[]> = {},
    ui?: unknown,
  ): SimulationMock => ({
    parameter_conditions: Object.entries(conditions).map(([path, value]) => ({
      path,
      eval: Array.isArray(value)
        ? { type: "regex" as const, pattern: `^\\[\\s*${value.join("\\s*,\\s*")}\\s*\\]$` }
        : { type: "exact" as const, expected_value: String(value) },
    })),
    is_error: false,
    mock_result: JSON.stringify({ ok: true, data, ...(ui ? { ui } : {}) }),
  });
  const first = {
    ...initial,
    rating: "PG13",
    adultTickets: initial.tickets,
    ticketQuantity: initial.tickets + initial.childTickets,
    selectedSeats: initial.seats,
    showtimeLabel: "tomorrow at 11:00 pm",
    preferredExperience: "KIDS",
    held: false,
  };
  const next = {
    ...revised,
    rating: "PG13",
    adultTickets: revised.tickets,
    ticketQuantity: revised.tickets + revised.childTickets,
    selectedSeats: revised.seats,
    showtimeLabel: "tomorrow at 6:30 pm",
    isAlternative: true,
    requested: { time: "19:00" },
    preferredExperience: "KIDS",
    held: false,
  };
  const firstEvidence = proposalEvidence(first, "fixture_initial_ref", [7], "fixture_initial_proposal");
  const nextEvidence = proposalEvidence(next, "fixture_edited_ref", [7], "fixture_edited_proposal");
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
        "Resolve the guest's named Spider-Man film using a supported title lookup (get_film or search_films), then use intent:initial and supplied childAges:[7]; the successful current proposal's verified PG13/experience admission with child allowed is authoritative before stating suitability, without a duplicate age lookup. A general get_recommendations call is not a named-film lookup: title and query are undeclared for that tool. Before the FIRST request to accept/book/hold, call propose_booking and receive the complete successful unheld proposal (film, cinema, showtime, experience, one adult plus one child, seats, total and proposalToken). A recommendation or age result alone is insufficient. Do not invent a usual cinema, price, seats or token.",
        "The first KIDS23:00 option is outside the returned usual18:00–20:00 window. Never call it the usual time or conceal the late alternative.",
        "After the guest explicitly requests Premier around19:00, use intent:edit with the exact current baseProposalRef and the requested time and experience changes only; receive new verified admission and propose the returned Premier18:30 show. Explain the changed experience/time and exact new total AED108.50 briefly, without repeating unchanged film/cinema/ticket count or calculating a price difference. Keep both proposals unheld until accepted.",
        "The guest declines to reserve after the edit. No quick_book, hold, food, offer application, payment or new booking is permitted; no repeated next-step question after refusal.",
      ],
      simulation_scenario:
        language === "ar"
          ? "تحدثي بالعربية فقط. قولي بالنص: اقترحي خطة لفيلم سبايدرمان غداً لي ولابني عمره سبع سنوات في السينما التي أزورها عادةً. لا تقولي السينما العادية ولا تطلبي تجربة ستاندرد. بعد العرض: أريد تجربة بريميير حوالي السابعة مساءً. بعد الاقتراح المعدل: شكراً، سأقرر لاحقاً، لا تحجزي شيئاً. لا تقبلي أي اقتراح."
          : "Say 'Suggest a Spider-Man plan tomorrow for me and my seven-year-old son at my usual cinema.' After the first proposal say 'Change to Premier around seven in the evening.' After the revised proposal say 'Thanks, I will decide later; do not hold anything.' Never accept either proposal.",
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
            title: [],
            query: [],
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
        search_films: rejectUnexpectedFilters(
          titleAliases.map((query) => ok({ films: [film] }, { query }, { type: "movie", items: [film] })),
          { query: titleAliases, title: [], hoCode: [], filmLanguage: ["English"], language: [] },
        ),
        get_film: rejectUnexpectedFilters(
          [
            ok({ film }, { hoCode: initial.hoCode }, { type: "movie", items: [film] }),
            ...titleAliases.map((title) => ok({ film }, { title }, { type: "movie", items: [film] })),
          ],
          {
            title: titleAliases,
            query: [],
            hoCode: [initial.hoCode],
            filmLanguage: ["English"],
            language: [],
          },
        ),
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
        search_sessions: rejectUnexpectedFilters(
          [
            ok({ sessions: [revised] }, { cinemaId: revised.cinemaId }),
            ok({ sessions: [revised] }, { cinemaName: revised.cinemaName }),
          ],
          {
            cinemaId: [revised.cinemaId],
            cinemaName: [revised.cinemaName, "MOE"],
            hoCode: [initial.hoCode],
            filmLanguage: ["English"],
            language: [],
          },
        ),
        propose_booking: guardProposalAges(
          rejectUnexpectedFilters(
            [
              // These initial-result facts cannot satisfy the edited Premier/time constraints.
              // This checks mock data fidelity, not the intent of a natural-language request.
              ...["experience", "time", "timeTo"].map(
                (path): SimulationMock => ({
                  parameter_conditions: [
                    { path: "intent", eval: { type: "exact", expected_value: "initial" } },
                    {
                      path,
                      eval: {
                        type: "regex",
                        pattern: path === "experience" ? "^(?!KIDS$).+" : ".+",
                      },
                    },
                  ],
                  is_error: true,
                  mock_result: JSON.stringify({
                    ok: false,
                    error: {
                      code: "UNEXPECTED_SIMULATION_PARAMETER",
                      message:
                        "The initial KIDS 23:00 fixture does not satisfy the supplied time or experience constraint.",
                      retryable: false,
                    },
                  }),
                }),
              ),
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
                nextEvidence.data,
                {
                  intent: "edit",
                  baseProposalRef: "fixture_initial_ref",
                  time: "19:00",
                  experience: "Premier",
                },
                nextEvidence.ui,
              ),
              ok(
                nextEvidence.data,
                {
                  intent: "edit",
                  baseProposalRef: "fixture_initial_ref",
                  sessionKey: revised.sessionKey,
                  experience: "Premier",
                },
                nextEvidence.ui,
              ),
              ok(
                nextEvidence.data,
                {
                  intent: "edit",
                  baseProposalRef: "fixture_initial_ref",
                  timeFrom: "18:00",
                  timeTo: "20:00",
                  experience: "Premier",
                },
                nextEvidence.ui,
              ),
              ok(
                firstEvidence.data,
                {
                  intent: "initial",
                  sessionKey: initial.sessionKey,
                  tickets: 1,
                  childTickets: 1,
                  childAges: [7],
                },
                firstEvidence.ui,
              ),
              ...(
                [...titleAliases.map((title) => ({ title })), { hoCode: initial.hoCode }] as Record<
                  string,
                  string
                >[]
              ).map((selected) =>
                ok(
                  firstEvidence.data,
                  { intent: "initial", ...selected, tickets: 1, childTickets: 1, childAges: [7] },
                  firstEvidence.ui,
                ),
              ),
            ],
            {
              title: titleAliases,
              query: [],
              hoCode: [initial.hoCode],
              cinemaId: [initial.cinemaId],
              cinemaName: [initial.cinemaName, "MOE"],
              sessionKey: [initial.sessionKey, revised.sessionKey],
              intent: ["initial", "edit"],
              baseProposalRef: ["fixture_initial_ref"],
              tickets: ["1"],
              childTickets: ["1"],
              date: ["tomorrow", initial.date],
              time: ["19:00"],
              timeFrom: ["18:00"],
              timeTo: ["20:00"],
              experience: ["KIDS", "Premier"],
              filmLanguage: ["English"],
              language: [],
            },
          ),
          [7],
        ),
      },
    })),
  };
}
