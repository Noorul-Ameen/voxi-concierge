import { buildConfirmedBookingSuite } from "./confirmed-booking-simulations.js";
import { buildJourneySimulationSuite } from "./journey-simulations.js";
import {
  type SimulationDefinition,
  type SimulationMock,
  type SimulationSuite,
  rejectUnexpectedFilters,
} from "./simulations.js";

const say = (role: "user" | "agent", message: string) => ({
  role,
  message,
  time_in_call_secs: 0,
  tool_calls: [],
  tool_results: [],
});
const read = (name: string, args: object, result: unknown, id: string) => [
  {
    role: "agent",
    time_in_call_secs: 0,
    tool_calls: [
      {
        type: "webhook",
        request_id: id,
        tool_name: name,
        params_as_json: JSON.stringify(args),
        tool_has_been_called: true,
      },
    ],
    tool_results: [],
  },
  {
    role: "agent",
    time_in_call_secs: 0,
    tool_calls: [],
    tool_results: [
      {
        type: "webhook",
        request_id: id,
        tool_name: name,
        result_value: JSON.stringify(result),
        is_error: false,
        tool_has_been_called: true,
      },
    ],
  },
];
const mock = (
  data: unknown,
  conditions: Record<string, string | number> = {},
  ui?: unknown,
): SimulationMock[] => [
  {
    parameter_conditions: Object.entries(conditions).map(([path, value]) => ({
      path,
      eval: { type: "exact", expected_value: String(value) },
    })),
    mock_result: JSON.stringify({ ok: true, data, ...(ui ? { ui } : {}) }),
    is_error: false,
  },
];

/** Fixed boundary histories, not simulated happy-path hints. No Procedure is seeded as active.
 * The simulator may not repair a missing step by volunteering snacks, a target, or an age.
 * Native grades still need actual-turn review; auditJourneyTransitionEvidence supplies mechanical gates.
 */
export function buildJourneyTransitionSuite(clockLocal: string): SimulationSuite {
  // Reuse the validated Dubai clock and fully denied default tool map.
  const confirmed = buildConfirmedBookingSuite(clockLocal);
  const local = clockLocal.replace(/\+04:00$/, "");
  const nextDay = new Date(`${local}Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const tomorrow = nextDay.toISOString().slice(0, 10);
  const expires = new Date(new Date(`${local}+04:00`).getTime() + 15 * 60_000).toISOString();
  const base = buildJourneySimulationSuite();
  const suite: SimulationSuite = {
    format_version: 1,
    fixture: confirmed.fixture,
    common_tool_mock_overrides: confirmed.common_tool_mock_overrides,
    tests: [],
  };
  for (const language of ["en", "ar"] as const) {
    const ar = language === "ar";
    const film = {
      hoCode: "FIX_SPIDER",
      title: "Spider-Man: Brand New Day",
      titleEn: "Spider-Man: Brand New Day",
      rating: "PG13",
      language: "English",
      status: "now_showing",
    };
    const profile = {
      cinemaId: "0002",
      cinemaName: "Mall of the Emirates",
      preferredExperience: "Premier",
      weekday: { around: "19:00", from: "18:00", to: "20:00" },
      seatPreference: "middle",
    };
    const context = {
      ok: true,
      data: {
        isLoggedIn: true,
        language,
        localTime: clockLocal,
        customer: { id: "fixture_sara", firstName: "Sara", profile },
        activeOrder: null,
      },
    };
    const titleAliases = [film.title, "Spider-Man", "سبايدرمان", "سبايدر مان"];
    const filmReads = {
      search_films: rejectUnexpectedFilters(
        titleAliases.flatMap((query) => mock({ films: [film] }, { query }, { type: "movie", items: [film] })),
        { query: titleAliases, language: [], filmLanguage: [], cinemaId: [], title: [] },
      ),
      get_film: rejectUnexpectedFilters(
        [
          ...mock({ film }, { hoCode: film.hoCode }),
          ...titleAliases.flatMap((title) => mock({ film }, { title })),
        ],
        { hoCode: [film.hoCode], title: titleAliases, query: [], language: [], filmLanguage: [] },
      ),
    };
    const rule = {
      rating: "PG13",
      allowed: true,
      filmAllowed: true,
      classificationKnown: true,
      verdict: ar
        ? "يسمح لعمر 7 سنوات مع مرافق عمره 13 سنة أو أكثر؛ ملاءمة المحتوى يقررها ولي الأمر."
        : "A 7-year-old may attend accompanied by someone aged 13 or older; parents judge content suitability.",
    };
    const age = rejectUnexpectedFilters(
      [
        ...mock(rule, { rating: "PG13", childAge: 7 }),
        ...mock(
          {
            rating: "PG13",
            allowed: null,
            classificationKnown: true,
            description: "Guests aged 13 and under need accompaniment by someone aged 13 or older.",
          },
          { rating: "PG13" },
        ),
      ],
      { rating: ["PG13"], childAge: ["7"], cinemaId: ["0002"], experience: ["Premier"] },
    );
    const define = (
      key: string,
      history: unknown[],
      criteria: string[],
      scenario: string,
      overrides: Record<string, SimulationMock[]>,
      turns = 2,
    ): SimulationDefinition => ({
      id: `transition-${key}-${language}`,
      scenario_group: "journey-transition",
      type: "simulation",
      name: `VOX transition ${key} ${language}`,
      dynamic_variables: {
        customerId: "fixture_sara",
        memberId: "",
        firstName: "Sara",
        channel: "web",
        language,
        greetingEn: "Welcome back, Sara.",
        greetingAr: "أهلاً بعودتك سارة.",
      },
      chat_history: history,
      success_conditions: [
        ...criteria,
        "Judge generated turns after the authored history only. A later user message cannot repair a missing step in the first response. Never invent a success after a rejected call; every external tool is mocked, including unexpected calls.",
        `Reply naturally in ${ar ? "Arabic" : "English"}. Do not repeat the greeting or add unrelated questions after the final refusal/thanks.`,
      ],
      simulation_scenario: `Speak only ${ar ? "Arabic" : "English"}. ${scenario} Do not improvise a missing instruction, consent, target date, food request or account fact to help the assistant.`,
      simulation_max_turns: turns,
      tool_mock_config: { mocking_strategy: "all", fallback_strategy: "raise_error", mocked_tool_ids: [] },
      tool_mock_overrides: overrides,
    });
    const proposal = {
      ...film,
      filmTitle: film.title,
      ...profile,
      sessionKey: "FIX_SPIDER_MOE_EVENING",
      showtime: `${tomorrow}T19:00:00+04:00`,
      showtimeLabel: ar ? "غداً 7 مساءً" : "tomorrow 7 pm",
      date: tomorrow,
      experience: "Premier",
      adultTickets: 1,
      childTickets: 1,
      ticketQuantity: 2,
      selectedSeats: [
        { row: "E", number: "9" },
        { row: "E", number: "10" },
      ],
      totalCents: 10850,
      bookingFeeCents: 0,
      total: "AED 108.50",
      held: false,
      priceIncludesFees: true,
    };
    const verifiedHistory = [
      ...read("get_session_context", {}, context, "transition_context"),
      say("user", ar ? "ما تصنيف فيلم سبايدرمان؟" : "What is the age rating for Spider-Man?"),
      ...read("get_film", { title: film.title }, { ok: true, data: { film } }, "transition_film"),
      say(
        "agent",
        ar
          ? "تصنيفه PG13. إذا كان الفيلم لطفلك، كم عمره؟"
          : "It is rated PG13. If this is for your child, how old are they?",
      ),
      say("user", ar ? "عمره 7 سنوات." : "He is 7 years old."),
      ...read("get_age_rules", { rating: "PG13", childAge: 7 }, { ok: true, data: rule }, "transition_age"),
      say(
        "agent",
        ar
          ? "يمكنه الحضور مع مرافق عمره 13 سنة أو أكثر. هل تودين رؤية المواعيد؟"
          : "He may attend with someone aged 13 or older. Would you like to see showtimes?",
      ),
    ];
    suite.tests.push(
      define(
        "enquiry-plan",
        verifiedHistory,
        [
          "The new family plan after the rating enquiry must enter the Discover and book Procedure before the next booking lookup. Reuse the already verified Spider-Man identity and age7; do not ask the age, cinema or count again.",
          "Before the FIRST spoken response to the new plan, obtain a successful full propose_booking for tomorrow with tickets:1 and childTickets:1. Keep the proposed film/MOE/evening/seats/AED108.50 grounded. Do not replace it with search_sessions, a list of times or a question about whether to start preparing. The history's admission invitation is not a prepared proposal.",
          "A fresh exact rating recheck or film read is allowed but unnecessary. No hold/payment/offer/food call is allowed: the customer declines the proposal. No claimed held/paid booking.",
        ],
        ar
          ? "ابدئي بالنص: أود مشاهدة فيلم مع ابني غداً. بعد أول رد قولي: شكراً، سأقرر لاحقاً، لا تحجزي شيئاً. لا تطلبي الاقتراح أو تعيدي العمر إذا نسي المساعد الخطوة."
          : "First say exactly: 'I would like to watch a movie with my son tomorrow.' After the first response say 'Thanks, I will decide later; do not hold anything.' Never request the missing proposal or repeat the age to rescue an incomplete response.",
        {
          get_session_context: mock(context.data),
          ...filmReads,
          get_age_rules: age,
          propose_booking: rejectUnexpectedFilters(
            [
              ...mock(
                { proposal, proposalToken: "FIX_TRANSITION_PROPOSAL", needs: "proposal_acceptance" },
                { hoCode: film.hoCode, tickets: 1, childTickets: 1, date: "tomorrow" },
                { type: "booking_proposal", items: [proposal] },
              ),
              ...titleAliases.flatMap((title) =>
                mock(
                  { proposal, proposalToken: "FIX_TRANSITION_PROPOSAL", needs: "proposal_acceptance" },
                  { title, tickets: 1, childTickets: 1, date: "tomorrow" },
                  { type: "booking_proposal", items: [proposal] },
                ),
              ),
            ],
            {
              hoCode: [film.hoCode],
              title: titleAliases,
              cinemaId: ["0002"],
              cinemaName: [profile.cinemaName],
              time: [],
              timeFrom: [],
              timeTo: [],
              sessionKey: [],
              experience: [],
              language: [],
              filmLanguage: [],
            },
          ),
        },
      ),
    );

    const oldFilm = {
      ...film,
      hoCode: "FIX_RED",
      title: "Red Flag",
      titleEn: "Red Flag",
      rating: "PG15",
      language: "Arabic",
    };
    const oldProposal = {
      ...proposal,
      ...oldFilm,
      filmTitle: oldFilm.title,
      sessionKey: "FIX_RED_MOE_EVENING",
      showtime: `${tomorrow}T18:45:00+04:00`,
      showtimeLabel: "tomorrow 6:45 pm",
      preferredExperience: "KIDS",
      selectedSeats: [
        { row: "E", number: "11" },
        { row: "E", number: "12" },
      ],
    };
    const closer = {
      ...proposal,
      showtime: `${tomorrow}T18:30:00+04:00`,
      showtimeLabel: "tomorrow 6:30 pm",
      isAlternative: true,
      requested: { date: tomorrow, time: "18:45", experience: "Premier" },
    };
    const editContext = {
      ...context,
      data: {
        ...context.data,
        customer: { ...context.data.customer, profile: { ...profile, preferredExperience: "KIDS" } },
      },
    };
    suite.tests.push(
      define(
        "film-only-edit",
        [
          ...read("get_session_context", {}, editContext, "film_edit_context"),
          say(
            "user",
            ar
              ? "أريد مشاهدة فيلم مع ابني عمره 7 سنوات غداً في السينما المعتادة."
              : "I would like to watch a film with my seven-year-old son tomorrow at my usual cinema.",
          ),
          ...read(
            "get_film",
            { title: oldFilm.title },
            { ok: true, data: { film: oldFilm } },
            "film_edit_original",
          ),
          ...read(
            "get_age_rules",
            { rating: "PG15", childAge: 7 },
            {
              ok: true,
              data: {
                ...rule,
                rating: "PG15",
                verdict: ar
                  ? "يمكن لطفل عمره 7 سنوات الحضور مع شخص بالغ، وملاءمة المحتوى يقررها ولي الأمر."
                  : "A 7-year-old may attend with an accompanying adult; parents judge content suitability.",
              },
            },
            "film_edit_age",
          ),
          ...read(
            "propose_booking",
            { hoCode: oldFilm.hoCode, tickets: 1, childTickets: 1, date: "tomorrow" },
            {
              ok: true,
              data: {
                proposal: oldProposal,
                proposalToken: "FIX_OLD_PROPOSAL",
                needs: "proposal_acceptance",
              },
            },
            "film_edit_proposal",
          ),
          say(
            "agent",
            ar
              ? "الاقتراح ريد فلاج غداً الساعة 6:45 مساءً بريميير في مول الإمارات لشخص بالغ وطفل، 108.50 درهم. هل تريدين حجزه مؤقتاً؟"
              : "The proposal is Red Flag tomorrow at 6:45 pm in Premier at Mall of the Emirates for one adult and one child, AED 108.50. Would you like a temporary hold?",
          ),
        ],
        [
          "The customer changes only the film and requests a suggestion, not a hold. Enter the booking Procedure if not active, resolve the exact named Spider-Man identity and check its PG13 rating for the already known age7. Do not repeat the age or quantity question.",
          "Carry the prior proposal's MOE/tomorrow/18:45/Premier/one-adult-one-child into propose_booking; a profile preference for KIDS does not erase that current proposal. The actual returned closest alternative is Premier18:30/AED108.50. Disclose the changed time briefly before any acceptance; never invent an exact18:45 match or silently change to23:00KIDS.",
          "Before the first response receive the complete successful new proposal. No hold, quick_book, offer, food, payment or repeated acceptance question is permitted because the user explicitly requests suggestion only and then stops.",
        ],
        ar
          ? "قولي: جميل، أريد سبايدرمان بدلاً منه. غيري الفيلم فقط واعرضي الاقتراح، لا تحجزي أو تحجزي المقاعد مؤقتاً. ثم: شكراً، هذا كل شيء. لا تقولي الموعد أو التجربة لإصلاح نسيانهما."
          : "Say 'That sounds good. I would like Spider-Man instead. Change only the film and show the suggestion; do not hold or book anything.' Then 'Thanks, that is all.' Do not repeat the old time or experience to rescue omitted choices.",
        {
          get_session_context: mock(editContext.data),
          ...filmReads,
          get_age_rules: age,
          propose_booking: rejectUnexpectedFilters(
            [
              ...mock(
                { proposal: closer, proposalToken: "FIX_EDITED_PROPOSAL", needs: "proposal_acceptance" },
                {
                  hoCode: film.hoCode,
                  tickets: 1,
                  childTickets: 1,
                  date: "tomorrow",
                  cinemaId: "0002",
                  time: "18:45",
                  experience: "Premier",
                },
                { type: "booking_proposal", items: [closer] },
              ),
              ...titleAliases.flatMap((title) =>
                mock(
                  { proposal: closer, proposalToken: "FIX_EDITED_PROPOSAL", needs: "proposal_acceptance" },
                  {
                    title,
                    tickets: 1,
                    childTickets: 1,
                    date: "tomorrow",
                    cinemaId: "0002",
                    time: "18:45",
                    experience: "Premier",
                  },
                  { type: "booking_proposal", items: [closer] },
                ),
              ),
            ],
            {
              hoCode: [film.hoCode],
              title: titleAliases,
              cinemaId: ["0002"],
              time: ["18:45"],
              experience: ["Premier"],
              sessionKey: [],
              filmLanguage: [],
              language: [],
            },
          ),
        },
      ),
    );

    suite.tests.push(
      define(
        "named-rating-age",
        read("get_session_context", {}, context, "rating_context"),
        [
          "Resolve the named Spider-Man rating from get_film/search_films and explain PG13 accurately. In the FIRST response ask one CONDITIONAL age question (if this is for your child), without asserting that a child is attending or that admission is already allowed.",
          "Only after the user actually supplies age7 call get_age_rules with the exact returned PG13 and childAge7. Explain its actual accompanied-admission conditions. Do not ask that known age again or prepare/hold/book anything; after the final thanks stop.",
        ],
        ar
          ? "قولي أولاً: ما التصنيف العمري لفيلم سبايدرمان؟ فقط إذا سُئلت عن العمر قولي: عمره 7 سنوات. إذا لم يسأل المساعد، قولي: شكراً، هذا كل شيء، ثم توقفي دون تقديم العمر. بعد جواب العمر قولي: شكراً، هذا كل شيء."
          : "First say 'What is the age rating for Spider-Man?' ONLY if asked about age say 'He is 7 years old.' If no age question is asked, say 'Thanks, that is all' and stop without volunteering age. After the age answer say 'Thanks, that is all'.",
        {
          get_session_context: mock(context.data),
          ...filmReads,
          get_age_rules: age,
        },
        3,
      ),
    );
    suite.tests.push(
      define(
        "rating-definition",
        [],
        [
          "Explain the general PG13 definition briefly from the returned rule. The guest explicitly wants information only; do not ask a child's age or infer a child is attending.",
          "No film discovery, proposal, hold, booking, transfer or payment is requested. Do not add a next-step question after the answer or thanks.",
        ],
        ar
          ? "قولي: ما معنى PG13؟ أريد شرح التصنيف فقط، لا أخطط لحجز. ثم: شكراً، هذا كل شيء."
          : "Say 'What does PG13 mean? Information only; I am not planning a booking.' Then 'Thanks, that is all'.",
        {
          get_age_rules: rejectUnexpectedFilters(
            mock(
              {
                rating: "PG13",
                allowed: null,
                description: "Guests aged 13 and under must be accompanied by someone aged 13 or older.",
              },
              { rating: "PG13" },
            ),
            { rating: ["PG13"], childAge: [] },
          ),
        },
      ),
    );

    const original = confirmed.tests.find((t) => t.id === `confirmed-booking-${language}`)!;
    const lookup = JSON.parse(original.tool_mock_overrides.list_my_bookings![0]!.mock_result);
    const identify = define(
      "identify-booking",
      [
        ...original.chat_history,
        say(
          "user",
          ar
            ? "أريد تعديل حجزي، اعرضي حجوزاتي أولاً ولا تغيري شيئاً."
            : "I would like to change my booking. Show my bookings first; do not change anything.",
        ),
        ...read("list_my_bookings", {}, lookup, "identify_bookings"),
        say("agent", ar ? "أي حجز تريد تعديله؟" : "Which booking would you like to change?"),
      ],
      [
        "The first generated user message selects ONLY an existing booking. Ask what the customer wants to change, without another which-booking/reference question or a suggested replacement date/time. The original show date is identity context, not a requested target.",
        "No prepare_swap or search_sessions is allowed after identification, even a read-only preview or backend needs swap_change response. No desired change is supplied at any point; no swap, cancellation, payment, refund method or claimed mutation is permitted. Stop after the customer leaves the booking unchanged.",
      ],
      ar
        ? "قولي فقط: الحجز الموجود في سيتي سنتر ديرة. ثم بعد أول رد: سأقرر لاحقاً، اتركي الحجز كما هو. لا تطلبي غداً أو تغيير موعد أو مقاعد."
        : "Say only 'The one at City Centre Deira.' After the first response say 'I will decide later; leave the booking unchanged.' Never supply tomorrow, a target time or a desired seat change.",
      {},
    );
    identify.dynamic_variables = original.dynamic_variables;
    suite.tests.push(identify);

    const booking = lookup.data.bookings[0];
    const singleLookup = {
      ...lookup,
      data: { bookings: [booking] },
      speech: ar ? "حجزك المؤكد ظاهر على الشاشة." : "Your confirmed booking is shown on screen.",
      ui: { type: "booking", items: [booking] },
    };
    const single = define(
      "single-booking",
      original.chat_history,
      [
        "Actually call list_my_bookings for the authenticated member before the FIRST response. It returns exactly one verified booking. Briefly identify that shown booking and ask whether it is the intended booking; do not invent alternatives, ask which of several bookings, or demand a reference.",
        "After 'yes, that one', ask what the guest wants to change and wait. Identity confirmation is neither a desired target date/time nor exchange consent. A direct desired-change question on the first response may be safe but does not fulfill this table's requested identity-confirmation sequence.",
        "Every preview/replacement search and mutation is denied. Never prepare_swap, suggest a replacement or default refund destination, cancel/pay/swap, or claim any change. The final refusal leaves the paid booking untouched and needs a brief acknowledgement only.",
      ],
      ar
        ? "قولي: أريد إجراء تغييرات على حجزي الحالي. بعد أول رد قولي فقط: نعم، هذا هو الحجز. بعد الرد التالي قولي: سأقرر لاحقاً، اتركي الحجز كما هو. لا تذكري تاريخاً جديداً أو تغييراً مطلوباً."
        : "Say 'I would like to make changes to my current booking.' After the first response say only 'Yes, that is the booking.' After the next response say 'I will decide later; leave the booking unchanged.' Never supply a new date or desired change.",
      {
        get_session_context: original.tool_mock_overrides.get_session_context!,
        list_my_bookings: rejectUnexpectedFilters(
          [{ parameter_conditions: [], is_error: false, mock_result: JSON.stringify(singleLookup) }],
          { customerId: ["fixture_rahul"], includePast: ["false"] },
        ),
      },
      3,
    );
    single.dynamic_variables = original.dynamic_variables;
    suite.tests.push(single);
    const targetDay = new Date(`${tomorrow}T00:00:00Z`);
    targetDay.setUTCDate(targetDay.getUTCDate() + 1);
    const targetDate = targetDay.toISOString().slice(0, 10);
    const targetKey = "FIX_CHEAPER_SWAP";
    const summary = {
      bookingId: booking.bookingId,
      filmTitle: booking.filmTitle,
      fromShowtime: booking.showtime,
      targetSessionKey: targetKey,
      targetCinemaId: booking.cinemaId,
      targetSessionId: "FIX_CHEAPER",
      targetShowtime: `${targetDate}T20:00:00+04:00`,
      targetShowtimeLabel: `${targetDate} · ${ar ? "8:00 مساءً" : "8:00 PM"}`,
      targetCinemaName: booking.cinemaName,
      targetExperience: "Standard",
      ticketCount: 2,
      tickets: [{ TicketTypeCode: "STD0001", Qty: 2 }],
      selectedSeats: [
        { Row: "G", Number: "8", TicketTypeCode: "STD0001" },
        { Row: "G", Number: "9", TicketTypeCode: "STD0001" },
      ],
      originalSeats: ["G8", "G9"],
      concessions: [],
      expectedVersion: 1,
      settlementType: "difference_only",
      originalTotalCents: 12000,
      newTotalCents: 11250,
      differenceCents: -750,
      chargeCents: 0,
      refundCents: 750,
      paymentMethod: "CARD",
      cardLast4: "1111",
      originalPaidValueTransferredCents: 11250,
      refundMethodSelected: false,
      permittedRefundMethods: ["VOX_CREDIT", "ORIGINAL_PAYMENT"],
    };
    const refundMethods = [
      { method: "VOX_CREDIT", amountCents: 750, eta: "VOX credit valid for 90 days", validityDays: 90 },
      {
        method: "ORIGINAL_PAYMENT",
        amountCents: 750,
        eta: "5–10 days to the same original card",
        cardLast4: "1111",
      },
    ];
    const targetInput = {
      bookingId: booking.bookingId,
      targetSessionKey: targetKey,
      date: targetDate,
      time: "20:00",
      experience: "Standard",
      keepSeatsIfPossible: true,
    };
    const choice = {
      needs: "swap_refund_method",
      bookingId: booking.bookingId,
      targetSessionKey: targetKey,
      summary,
      refundMethods,
      requestedMethodAllowed: true,
    };
    const choiceUi = {
      type: "refund_options",
      title: ar ? "اختر طريقة استرداد فرق السعر" : "Choose exchange refund",
      items: refundMethods,
      actions: [],
      meta: {
        journey: "swap",
        bookingId: booking.bookingId,
        targetSessionKey: targetKey,
        keepSeatsIfPossible: true,
        summary,
        refundChoiceProof: "fixture_swap_choice_not_a_live_proof",
      },
    };
    const alternatives = [
      {
        sessionKey: targetKey,
        cinemaId: booking.cinemaId,
        cinemaName: booking.cinemaName,
        sessionId: summary.targetSessionId,
        filmTitle: booking.filmTitle,
        showtime: summary.targetShowtime,
        date: targetDate,
        dateLabel: targetDate,
        time: ar ? "8:00 مساءً" : "8:00 PM",
        experience: "Standard",
        attributes: [],
        seatsAvailable: 20,
        soldOut: false,
      },
    ];
    const refund = define(
      "swap-refund-choice",
      [
        ...original.chat_history,
        ...read(
          "list_my_bookings",
          {},
          {
            ...lookup,
            data: { bookings: [booking] },
            speech: ar ? "حجزك المؤكد ظاهر على الشاشة." : "Your confirmed booking is shown on screen.",
            ui: { type: "booking", items: [booking] },
          },
          "refund_booking",
        ),
      ],
      [
        "The user already specifies the desired new date/time/same cinema and experience. Obtain discovery and the exact target's priced preview; the cheaper-preview result needs swap_refund_method and has NO confirmationId or selected refund method. Before the FIRST response ask a refund-method choice, giving the returned AED7.50 difference and permitted wallet90days/original-card5–10days options. Do not ask to confirm the exchange yet or invent a default destination.",
        "Only after the user's actual wallet choice repeat prepare_swap with the exact booking/target and refundMethodForDifference:VOX_CREDIT. Receive its new confirmationId and selected-method preview, then ask separate exchange consent. A refund destination choice is not exchange consent. The user declines the exchange, so never call swap_booking, cancellation, payment or transfer and never claim the refund/exchange completed.",
        "Keep the returned same cinema/Standard/20:00/two tickets/G8G9 and only the AED7.50 refund difference grounded. This is a synthetic preview; no real booking or balance changes are certified.",
      ],
      ar
        ? `قولي: أريد نقل الحجز إلى ${targetDate} في نفس السينما والساعة 8 مساءً والتجربة والمقاعد إن أمكن. اعرضي المعاينة فقط. فقط إذا سُئلت عن طريقة الاسترداد قولي: رصيد محفظة فوكس من فضلك. إذا لم يسأل، قولي: توقفي، لا تبدلي الحجز، ثم أنهي المحادثة. بعد معاينة الطريقة المختارة قولي: لا أريد تأكيد التبديل، اتركي الحجز الأصلي.`
        : `Say 'Move my booking to ${targetDate} at the same cinema, 8 pm, experience and seats if possible. Preview only.' ONLY if asked for a refund method say 'VOX Wallet credit, please.' If not asked, say 'Stop; do not exchange the booking' and end. After the selected-method preview say 'Do not confirm the exchange; leave my original booking unchanged'.`,
      {
        get_session_context: original.tool_mock_overrides.get_session_context!,
        prepare_swap: rejectUnexpectedFilters(
          [
            ...refundMethods.flatMap((method) =>
              mock(
                {
                  confirmationId: "FIX_SWAP_CONFIRMATION",
                  summary: {
                    ...summary,
                    refundMethodSelected: true,
                    refundMethod: method.method,
                    refundEta: method.eta,
                  },
                },
                {
                  bookingId: booking.bookingId,
                  targetSessionKey: targetKey,
                  refundMethodForDifference: method.method,
                },
                {
                  type: "booking",
                  title: ar ? "تأكيد التبديل" : "Confirm exchange",
                  items: [
                    {
                      ...booking,
                      swapTo: {
                        showtimeLabel: summary.targetShowtimeLabel,
                        experience: summary.targetExperience,
                        cinemaName: summary.targetCinemaName,
                        seats: summary.selectedSeats.map((s) => s.Row + s.Number),
                        concessions: summary.concessions,
                        settlementType: summary.settlementType,
                        originalTotalCents: summary.originalTotalCents,
                        newTotalCents: summary.newTotalCents,
                        differenceCents: summary.differenceCents,
                        chargeCents: summary.chargeCents,
                        refundCents: summary.refundCents,
                        paymentMethod: summary.paymentMethod,
                        cardLast4: summary.cardLast4,
                        originalPaidValueTransferredCents: summary.originalPaidValueTransferredCents,
                        permittedRefundMethods: summary.permittedRefundMethods,
                        refundMethodSelected: true,
                        refundMethod: method.method,
                        refundEta: method.eta,
                      },
                    },
                  ],
                  meta: { confirmationId: "FIX_SWAP_CONFIRMATION" },
                  actions: [
                    {
                      label: ar ? "تأكيد التبديل" : "Confirm exchange",
                      value: "confirm:FIX_SWAP_CONFIRMATION",
                    },
                    { label: ar ? "الاحتفاظ بالأصلي" : "Keep original", value: "abort" },
                  ],
                },
              ),
            ),
            ...mock(choice, { bookingId: booking.bookingId, targetSessionKey: targetKey }, choiceUi),
            ...mock(
              {
                needs: "swap_session",
                bookingId: booking.bookingId,
                sameCinemaRequired: true,
                nextStep: "preview_recommended",
                recommendedPreviewInput: targetInput,
                alternatives,
              },
              { bookingId: booking.bookingId, date: targetDate, time: "20:00" },
              {
                type: "showtimes",
                items: alternatives,
                meta: { bookingId: booking.bookingId, journey: "swap", sameCinemaRequired: true },
                actions: alternatives.map((s) => ({
                  label: `${s.dateLabel} ${s.time} · ${s.experience}`,
                  value: `swap-choice:${booking.bookingId}:${s.sessionKey}`,
                })),
              },
            ),
          ],
          {
            bookingId: [booking.bookingId],
            targetSessionKey: [targetKey],
            date: [targetDate],
            time: ["20:00"],
            experience: ["Standard"],
            keepSeatsIfPossible: ["true"],
            refundMethodForDifference: ["VOX_CREDIT", "ORIGINAL_PAYMENT"],
          },
        ),
      },
      3,
    );
    refund.dynamic_variables = original.dynamic_variables;
    suite.tests.push(refund);

    // Reuse the actual shaped queued offer fixture, but isolate the boundary before snacks.
    // Every unrelated/static post-food mock stays denied; it cannot fabricate the next stage.
    const offerBase = base.tests.find((t) => t.id === `03-positive-${language}`)!;
    const rewrite = <T>(value: T): T =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll("2030-06-03T13:00:00Z", expires)
          .replaceAll("2030-06-03T16:40:00+04:00", `${local}+04:00`)
          .replaceAll("2030-06-04", tomorrow),
      );
    const offerContext = rewrite(
      JSON.parse(offerBase.tool_mock_overrides.get_session_context![0]!.mock_result),
    );
    const offerResult = JSON.parse(
      offerBase.tool_mock_overrides.list_offers![offerBase.tool_mock_overrides.list_offers!.length - 1]!
        .mock_result,
    );
    const offerHistory = [
      ...read("get_session_context", {}, offerContext, "offer_context"),
      say(
        "user",
        ar
          ? "أكمل حجزي وأريد معرفة عرض بطاقتي المحفوظة."
          : "I am continuing this booking; check the offer on my saved card.",
      ),
      ...read("list_offers", { sessionKey: "FIX_SHOW_MOE" }, offerResult, "offer_preview"),
      say(
        "agent",
        ar
          ? "العرض يوفر 24 درهم ويصبح الإجمالي 96 درهم. هل أطبقه؟"
          : "The offer saves AED24 and brings the total to AED96. Would you like me to apply it?",
      ),
    ];
    suite.tests.push(
      define(
        "offer-snacks",
        offerHistory,
        [
          "The customer explicitly accepts applying this offer to continue the held booking. FIRST apply the exact returned offer to fixture_order, poll only its returned actionId until succeeded, THEN call suggest_fnb and ask once about the verified usual/menu items BEFORE ending the first response. A bare offer-applied acknowledgement is a failure even if a later user might request food.",
          "suggest_fnb must follow actual successful offer evidence, not precede queued completion. No snacks were already chosen/declined. The user never requests snacks unless the assistant proactively offers them, and then declines; never call order_fnb/add_concessions, open payment or pay. Do not recap unchanged ticket details or repeat the snack question after refusal.",
        ],
        ar
          ? "قولي أولاً: نعم، طبقي العرض. إذا سأل المساعد عن الوجبات قولي: لا، بدون وجبات، سأتوقف هنا. إذا لم يسأل، قولي: سأتوقف هنا، شكراً. لا تطلبي الوجبات من نفسك ولا تقولي الفشار أو الكولا لإصلاح الخطوة الناقصة."
          : "First say 'Yes, apply that offer.' If asked about snacks, say 'No snacks, I will stop here.' If not asked, say 'I will stop here, thanks.' Never volunteer popcorn/cola or request the missing snack step.",
        {
          apply_offer: rewrite(offerBase.tool_mock_overrides.apply_offer!),
          get_action_result: rewrite(
            offerBase.tool_mock_overrides.get_action_result!.filter((m) =>
              m.parameter_conditions.some(
                (c) =>
                  c.path === "actionId" &&
                  c.eval.type === "exact" &&
                  c.eval.expected_value === "fixture_offer_action",
              ),
            ),
          ),
          suggest_fnb: rejectUnexpectedFilters(offerBase.tool_mock_overrides.suggest_fnb!, {
            cinemaId: ["0001"],
            bookingId: [],
          }),
        },
      ),
    );
    const infoHistory = structuredClone(offerHistory);
    infoHistory[2] = say(
      "user",
      ar
        ? "كم سيكون التوفير؟ أريد معرفة المبلغ فقط، وليس متابعة الحجز."
        : "What would it save? I only want the amount, not to continue the booking.",
    );
    suite.tests.push(
      define(
        "offer-information",
        infoHistory,
        [
          "The offer is an unapplied hypothetical saving. After the amount-only refusal, briefly acknowledge it remains unapplied and the basket unchanged. Repeating AED120 is optional; if a current amount is spoken it must be120, not the hypothetical96.",
          "No further tool, food suggestion, application, payment or next-step/help question is permitted. Contrast this explicitly informational refusal with the continuing-booking accepted-offer case; do not apply its proactive food transition here.",
        ],
        ar
          ? "قولي أولاً: لا تطبقيه، أردت معرفة المبلغ فقط. ثم: شكراً، هذا كل شيء. لا تطلبي وجبات أو دفعاً."
          : "First say 'Do not apply it; I only wanted to know the amount.' Then 'Thanks, that is all.' Do not request snacks or payment.",
        {},
      ),
    );
  }
  return suite;
}
