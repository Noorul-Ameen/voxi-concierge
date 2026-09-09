/**
 * Agent tool contracts — the single source of truth for:
 *  - ElevenLabs server-tool definitions (generated from these schemas)
 *  - concierge-api route validation
 *  - widget typing
 *
 * Naming: verbs for reads (`search_*`, `get_*`, `list_*`, `check_*`), and `request_*` / explicit
 * action names for writes. Every write tool returns an ActionRef and is executed asynchronously
 * by the worker (see docs/01-solution-architecture.md §7).
 */
import { z } from "zod";
import { Experience, Language, PaymentMethod, RefundMethod } from "./common.js";

/** YYYY-MM-DD, or a natural word the server resolves in cinema-local time: today, tomorrow, day after tomorrow, weekday names (next occurrence), weekend. */
const dateStr = z
  .string()
  .regex(
    /^(\d{4}-\d{2}-\d{2}|today|tonight|tomorrow|day after tomorrow|weekend|this weekend|next weekend|(next )?(mon|tues|wednes|thurs|fri|satur|sun)day)$/i,
    "YYYY-MM-DD or today/tomorrow/weekday",
  );
const timeStr = z.string().regex(/^\d{2}:\d{2}$/, "HH:mm");

// ---------- Phase 1: movies, cinemas, information ----------

export const SearchFilmsInput = z.object({
  query: z.string().optional().describe("Free-text title, actor, keyword. Fuzzy matched."),
  status: z.enum(["now_showing", "coming_soon", "advance", "any"]).default("now_showing"),
  genre: z.string().optional(),
  language: z.string().optional().describe("Film language, e.g. English, Hindi, Arabic, Malayalam"),
  rating: z.string().optional().describe("Classification such as G, PG, PG13, PG15, 15+, 18+"),
  maxAge: z.number().int().optional().describe("Customer's child age; filters to suitable ratings"),
  cinemaId: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(8),
});

export const GetFilmInput = z
  .object({ hoCode: z.string().optional(), title: z.string().optional() })
  .refine((v) => v.hoCode || v.title, "hoCode or title required");

export const SearchSessionsInput = z.object({
  hoCode: z.string().optional(),
  title: z.string().optional(),
  cinemaId: z.string().optional(),
  cinemaName: z
    .string()
    .optional()
    .describe(
      "Cinema or mall name, fuzzy matched, e.g. 'Mall of the Emirates', 'MOE', 'Deira' — or an emirate ('Dubai', 'Abu Dhabi', 'Sharjah') to search every cinema there",
    ),
  date: dateStr
    .optional()
    .describe(
      "YYYY-MM-DD or a word: today, tomorrow, friday, weekend. Defaults to today (Dubai time). Do not compute dates yourself — pass the word.",
    ),
  dateTo: dateStr.optional(),
  timeFrom: timeStr.optional(),
  timeTo: timeStr.optional(),
  experience: Experience.optional(),
  language: z.string().optional(),
  nearMe: z
    .boolean()
    .optional()
    .describe(
      "Search the cinemas nearest to the location the guest shared/picked in the widget (never invent coordinates)",
    ),
  limit: z.number().int().min(1).max(60).default(30),
  suggestAlternatives: z
    .boolean()
    .default(true)
    .describe("If nothing matches, relax filters and return alternatives"),
});

export const ListCinemasInput = z.object({
  emirate: z.string().optional(),
  experience: Experience.optional(),
  query: z.string().optional(),
});
export const GetCinemaInput = z.object({ cinemaId: z.string().optional(), name: z.string().optional() });
export const NearestCinemasInput = z.object({
  limit: z.number().int().min(1).max(5).default(3),
  experience: Experience.optional(),
});

export const GetAgeRulesInput = z.object({
  experience: Experience.optional(),
  cinemaId: z.string().optional(),
  rating: z.string().optional(),
  childAge: z.number().int().optional(),
});

export const ListOffersInput = z.object({
  cinemaId: z.string().optional(),
  sessionKey: z.string().optional().describe("'{cinemaId}-{sessionId}'"),
  experience: Experience.optional(),
  type: z.enum(["bank", "promo", "loyalty", "member", "partner", "any"]).default("any"),
  bank: z
    .string()
    .optional()
    .describe(
      "Only offers for this bank/card when the guest names one, e.g. 'ENBD', 'Emirates NBD', 'HSBC', 'ADCB'",
    ),
  cardBin: z
    .string()
    .optional()
    .describe("First 6 digits of a card the guest mentioned — filters to offers that card qualifies for"),
  memberId: z.string().optional(),
  limit: z.number().int().min(1).max(12).default(6),
});
export const CheckOfferEligibilityInput = z.object({
  offerId: z.string(),
  sessionKey: z.string().optional(),
  memberId: z.string().optional(),
  cardBin: z.string().optional(),
  ticketCount: z.number().int().optional(),
});

export const HowToBookInput = z.object({
  hoCode: z.string().optional(),
  cinemaId: z.string().optional(),
  sessionKey: z.string().optional(),
});

// ---------- Phase 1: bookings, cancellation, refunds, swaps ----------

export const FindBookingInput = z
  .object({
    bookingId: z.string().optional().describe("Vista booking id / reference, e.g. WL59LFJ"),
    email: z.string().optional(),
    phone: z.string().optional(),
    memberId: z.string().optional(),
    customerId: z.string().optional().describe("Logged-in customer id from context"),
    upcomingOnly: z.boolean().default(true),
  })
  .refine(
    (v) => v.bookingId || v.email || v.phone || v.memberId || v.customerId,
    "at least one identifier is required",
  );

export const CheckCancellationEligibilityInput = z.object({
  bookingId: z.string(),
  ticketIds: z.array(z.string()).optional().describe("Subset for partial cancellation"),
});

export const Verification = z
  .object({ phoneLast4: z.string().length(4).optional(), email: z.string().optional() })
  .describe(
    "Identity check for guests: last 4 digits of the phone on the booking, or the booking email. Not needed when the logged-in customer owns the booking.",
  );

export const PrepareCancellationInput = z.object({
  bookingId: z.string(),
  ticketIds: z.array(z.string()).optional(),
  refundMethod: RefundMethod.default("VOX_CREDIT"),
  reason: z.string().optional(),
  verification: Verification.optional(),
});

export const CancelBookingInput = z.object({
  bookingId: z.string(),
  confirmationId: z
    .string()
    .describe("From prepare_cancellation; proves the summary was read to the customer"),
  confirmed: z.literal(true),
  idempotencyKey: z.string().optional(),
});

export const PrepareSwapInput = z.object({
  bookingId: z.string(),
  targetSessionKey: z.string().describe("'{cinemaId}-{sessionId}' of the new session"),
  keepSeatsIfPossible: z.boolean().default(true),
  paymentMethodForDifference: PaymentMethod.optional(),
  verification: Verification.optional(),
});
export const SwapBookingInput = z.object({
  bookingId: z.string(),
  confirmationId: z.string(),
  confirmed: z.literal(true),
  idempotencyKey: z.string().optional(),
});

export const GetActionResultInput = z.object({
  actionId: z.string(),
  waitMs: z.number().int().min(0).max(8000).default(3000),
});

// ---------- Phase 2: F&B, guided booking, offers, payment ----------

export const BrowseMenuInput = z.object({
  cinemaId: z.string().optional(),
  experience: Experience.optional(),
  tab: z
    .string()
    .optional()
    .describe("Combos | Popcorn | Drinks | Snacks | Hot Food | Desserts | Kids | GOLD Menu"),
  dietary: z.array(z.string()).optional().describe("vegetarian | vegan | gluten_free | nut_free"),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});

export const GetTicketTypesInput = z.object({ sessionKey: z.string() });
export const GetSeatPlanInput = z.object({ sessionKey: z.string(), userSessionId: z.string().optional() });

export const StartOrderInput = z.object({ sessionKey: z.string(), idempotencyKey: z.string().optional() });
export const AddTicketsInput = z.object({
  userSessionId: z.string(),
  tickets: z.array(z.object({ ticketTypeCode: z.string(), qty: z.number().int().min(1).max(10) })).min(1),
  idempotencyKey: z.string().optional(),
});
export const SelectSeatsInput = z.object({
  userSessionId: z.string(),
  seats: z
    .array(z.object({ row: z.string(), number: z.string() }))
    .min(1)
    .describe("Seat labels, e.g. row 'F' number '7'"),
  autoAllocate: z
    .boolean()
    .default(false)
    .describe("If true, ignore `seats` and let the system pick best available adjacent seats"),
  preference: z.enum(["front", "middle", "back", "aisle"]).optional(),
  idempotencyKey: z.string().optional(),
});
export const AddConcessionsInput = z.object({
  userSessionId: z.string(),
  items: z
    .array(
      z.object({
        itemId: z.string(),
        quantity: z
          .number()
          .int()
          .min(0)
          .max(10)
          .describe(
            "Quantity to have in the order for this item; 0 removes the item (use it to swap a drink the guest rejected)",
          ),
        modifierIds: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  idempotencyKey: z.string().optional(),
});
export const ApplyOfferInput = z.object({
  userSessionId: z.string(),
  offerId: z.string().optional(),
  promoCode: z.string().optional(),
  cardBin: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export const RedeemPointsInput = z.object({
  userSessionId: z.string(),
  memberId: z.string().optional(),
  points: z.number().int().positive().optional().describe("Omit to redeem max"),
  idempotencyKey: z.string().optional(),
});
export const GetOrderInput = z.object({ userSessionId: z.string() });
export const PreparePaymentInput = z.object({
  userSessionId: z.string(),
  method: PaymentMethod.describe(
    "SAVED_CARD when the guest names a card they already have on file ('my saved Mastercard', 'the Visa ending 2211', 'my usual card'); CARD only for a new card; APPLE_PAY / SAMSUNG_PAY for wallets; VOX_CREDIT / SHARE_POINTS for members' balances.",
  ),
  customer: z.object({ name: z.string(), email: z.string().email(), phone: z.string() }).optional(),
});
export const PayOrderInput = z.object({
  userSessionId: z.string(),
  confirmationId: z.string(),
  confirmed: z.literal(true),
  paymentToken: z
    .string()
    .optional()
    .describe("Token from the widget payment sheet (simulated Checkout). Never a PAN."),
  idempotencyKey: z.string().optional(),
});
export const CancelOrderInput = z.object({
  userSessionId: z.string(),
  idempotencyKey: z.string().optional(),
});

// ---------- Booking v2: one-shot booking, recovery, quick F&B ----------

export const QuickBookInput = z.object({
  title: z.string().optional().describe("Movie title as the guest said it (fuzzy matched)"),
  hoCode: z.string().optional(),
  cinemaName: z
    .string()
    .optional()
    .describe(
      "Cinema/mall the guest named ('MOE', 'Deira', 'Yas Mall'). Omit when not stated — the tool uses the member's usual cinema or the shared location.",
    ),
  cinemaId: z.string().optional(),
  useUsualCinema: z
    .boolean()
    .optional()
    .describe(
      "true once the guest agreed to their usual cinema ('MOE as usual?' → yes). Omit on the first call so the tool can ask.",
    ),
  date: dateStr
    .optional()
    .describe("today (default), tonight, tomorrow, weekday or YYYY-MM-DD — pass the word, never compute"),
  time: timeStr
    .optional()
    .describe(
      "Target time HH:mm in 24h for 'around 8', 'at 9 pm', 'evening' (use 19:30) — a ±30 min window is searched, nearest first",
    ),
  timeFrom: timeStr.optional(),
  timeTo: timeStr.optional(),
  experience: Experience.optional().describe(
    "Only when the guest asked for it (IMAX, MAX, GOLD…). Default Standard unless the profile prefers otherwise.",
  ),
  language: z.string().optional().describe("Film language when the guest specified one"),
  tickets: z.number().int().min(1).max(10).default(1).describe("Adult tickets; default 1 when not stated"),
  childTickets: z.number().int().min(0).max(10).default(0),
  seatPreference: z.enum(["front", "middle", "back", "aisle", "any"]).optional(),
  sessionKey: z
    .string()
    .optional()
    .describe(
      "Book this exact showtime (from a showtimes/alternatives card) — skips film/cinema/time resolution",
    ),
});

export const RecoverOrderInput = z.object({
  userSessionId: z
    .string()
    .optional()
    .describe("The expired/active order; defaults to the conversation's order"),
});

export const ResumeOrderInput = z.object({});

export const SuggestFnbInput = z.object({
  cinemaId: z.string().optional(),
  bookingId: z
    .string()
    .optional()
    .describe("Booking the food is for (after tickets are paid) — defaults to the booking just made"),
});

export const OrderFnbInput = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string(),
        quantity: z.number().int().min(1).max(10),
        modifierIds: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  bookingId: z
    .string()
    .optional()
    .describe("Booking the food is for; defaults to the booking just made in this conversation"),
  repeatUsual: z
    .boolean()
    .optional()
    .describe("true when the guest said 'the same as last time' — items may then be omitted"),
});

export const GetLoyaltyBalanceInput = z.object({
  memberId: z.string().optional(),
  customerId: z.string().optional(),
});

// ---------- Phase 2: status, feedback, complaints, personalisation, transfer ----------

export const GetSessionContextInput = z.object({});
export const LoginCustomerInput = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
  memberId: z.string().optional(),
  pin: z.string().optional(),
});
export const ListMyBookingsInput = z.object({
  customerId: z.string().optional(),
  includePast: z.boolean().default(false),
});

export const SubmitFeedbackInput = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().optional(),
  resolved: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
});

export const CreateComplaintInput = z.object({
  category: z.enum(["booking", "refund", "fnb", "staff", "facility", "app", "other"]),
  description: z.string().min(5),
  cinemaId: z.string().optional(),
  bookingId: z.string().optional(),
  visitDate: dateStr.optional(),
  customerName: z.string().optional(),
  customerEmail: z.string().optional(),
  customerPhone: z.string().optional(),
  severity: z.enum(["low", "medium", "high"]).default("medium"),
  idempotencyKey: z.string().optional(),
});

export const GetRecommendationsInput = z.object({
  customerId: z.string().optional(),
  kind: z.enum(["movies", "fnb", "both"]).default("movies"),
  withChildren: z
    .boolean()
    .optional()
    .describe(
      "Set only after the guest answered whether children are joining; true = include family films, false = adults only",
    ),
  language: z
    .string()
    .optional()
    .describe("Film language the guest asked for (Tamil, Hindi, Arabic…) — overrides profile history"),
  cinemaId: z.string().optional(),
  date: dateStr.optional(),
  limit: z.number().int().min(1).max(8).default(4),
});

export const TransferToAgentInput = z.object({
  reason: z
    .string()
    .transform((r) => {
      const x = r.toLowerCase();
      if (/(request|asked|human|person|agent)/.test(x)) return "customer_request";
      if (/(sentiment|frustrat|angry|upset|unhappy)/.test(x)) return "sentiment";
      if (/(policy|exception|refund)/.test(x)) return "policy";
      if (/(fallback|fail|unable|cannot|can't)/.test(x)) return "fallback";
      return ["customer_request", "sentiment", "fallback", "complaint", "policy"].includes(x)
        ? x
        : "complaint";
    })
    .describe("customer_request | sentiment | fallback | complaint | policy"),
  summary: z.string().optional().describe("Agent-written summary; the middleware appends structured context"),
  idempotencyKey: z.string().optional(),
});

export const SetLanguageInput = z.object({ language: Language });
export const LogJourneyInput = z.object({
  journey: z.string(),
  status: z.enum(["completed", "abandoned", "failed"]),
  note: z.string().optional(),
});

/** Registry used to generate ElevenLabs tools + OpenAPI. Keep descriptions agent-friendly. */
export const TOOL_REGISTRY = {
  // reads
  search_films: {
    input: SearchFilmsInput,
    kind: "read",
    description:
      "Search movies (now showing, coming soon, advance booking) by title, actor, genre, language, rating or child age. Returns posters and trailers for cards.",
  },
  get_film: {
    input: GetFilmInput,
    kind: "read",
    description: "Get full details for one movie: synopsis, cast, runtime, rating, languages, trailer.",
  },
  search_sessions: {
    input: SearchSessionsInput,
    kind: "read",
    description:
      "Find showtimes for a movie and/or cinema on a date with optional experience, time window and language filters. Suggests alternatives when nothing matches.",
  },
  list_cinemas: {
    input: ListCinemasInput,
    kind: "read",
    description: "List VOX cinemas, optionally by emirate or experience.",
  },
  get_cinema: {
    input: GetCinemaInput,
    kind: "read",
    description:
      "Cinema details: address, opening hours, experiences, parking, in-mall directions, accessibility.",
  },
  nearest_cinemas: {
    input: NearestCinemasInput,
    kind: "read",
    description:
      "Three nearest cinemas to the location the guest shared or picked in the widget (no coordinates needed — never invent any). If it returns LOCATION_REQUIRED, ask the guest to tap the location button or name an area, or call request_location.",
  },
  get_age_rules: {
    input: GetAgeRulesInput,
    kind: "read",
    description:
      "Age restriction rules by rating and experience (e.g. GOLD/THEATRE 18+ policies) and whether a child of a given age may attend.",
  },
  list_offers: {
    input: ListOffersInput,
    kind: "read",
    description:
      "Available promotions and offers (bank, promo codes, Share Points, VOX Rewards) with images, eligibility and remaining balance.",
  },
  check_offer_eligibility: {
    input: CheckOfferEligibilityInput,
    kind: "read",
    description: "Check if an offer applies to a session, member or card.",
  },
  how_to_book: {
    input: HowToBookInput,
    kind: "read",
    description: "Explain how to book and return deep links to the booking page for a movie/session.",
  },
  find_booking: {
    input: FindBookingInput,
    kind: "read",
    description:
      "Find existing bookings by booking reference, email, phone or member id. Returns booking summary, tickets, seats, refund eligibility.",
  },
  check_cancellation_eligibility: {
    input: CheckCancellationEligibilityInput,
    kind: "read",
    description:
      "Evaluate the cancellation & refund policy for a booking (cut-off, used tickets, F&B, offers) and compute refund amount per method.",
  },
  prepare_cancellation: {
    input: PrepareCancellationInput,
    kind: "read",
    description:
      "Create the cancellation summary the customer must confirm (refund amount, method). Returns confirmationId. ALWAYS read the summary to the customer before cancel_booking.",
  },
  prepare_swap: {
    input: PrepareSwapInput,
    kind: "read",
    description:
      "Prepare a swap to a different showtime: availability, price difference, refund/charge summary. Returns confirmationId.",
  },
  get_action_result: {
    input: GetActionResultInput,
    kind: "read",
    description:
      "Fetch the outcome of a previously requested action (cancellation, refund, swap, order step, payment, transfer). Waits briefly for completion.",
  },
  browse_menu: {
    input: BrowseMenuInput,
    kind: "read",
    description:
      "Food & beverage menu per cinema/experience with prices, combos, images and dietary filters (vegetarian, vegan, gluten-free).",
  },
  get_ticket_types: {
    input: GetTicketTypesInput,
    kind: "read",
    description: "Ticket types and prices for a session (adult, child, student, premium view...).",
  },
  get_seat_plan: {
    input: GetSeatPlanInput,
    kind: "read",
    description:
      "Seat map and availability for a session; renders the interactive seat map in the widget and returns 2–3 suggested seats per area (front/middle/back) with their tier and price so you can offer choices instead of picking.",
  },
  get_order: {
    input: GetOrderInput,
    kind: "read",
    description: "Current order (cart) summary: tickets, seats, F&B, offers, totals, expiry.",
  },
  prepare_payment: {
    input: PreparePaymentInput,
    kind: "read",
    description:
      "Create the payment summary the customer must confirm. For CARD / SAVED_CARD / APPLE_PAY / SAMSUNG_PAY it opens the secure Review & Pay sheet in the widget — the guest completes payment there and you do NOT call pay_order. For VOX_CREDIT / SHARE_POINTS read the summary, get a yes, then call pay_order with the confirmationId. Never read the confirmationId aloud.",
  },
  quick_book: {
    input: QuickBookInput,
    kind: "read",
    description:
      "ONE-SHOT BOOKING. Give it everything the guest said (movie, cinema, day, time, experience, ticket count, seat wish) and it finds the best showtime, starts the order, holds the best seats and opens Review & Pay — in one call. If a detail is missing it either uses the profile (usual cinema, preferred experience) or returns `needs` with what to ask. If the time isn't available it returns up to three alternatives to pick from (then call it again with the chosen sessionKey). Prefer this over start_order/add_tickets/select_seats whenever the guest wants to book.",
  },
  resume_order: {
    input: ResumeOrderInput,
    kind: "read",
    description:
      "Continue a booking from earlier in this conversation or a previous visit: returns the order if it is still held (and re-opens Review & Pay), or automatically rebuilds it with the same or closest seats if the hold expired.",
  },
  recover_order: {
    input: RecoverOrderInput,
    kind: "read",
    description:
      "After a seat hold expired: rebuilds the order for the same showtime, re-holds the same seats if still free (otherwise the closest equivalent in the same row), re-adds food and offers, and re-opens Review & Pay. Call it when a tool says ORDER_EXPIRED or the widget reports the timer ran out.",
  },
  suggest_fnb: {
    input: SuggestFnbInput,
    kind: "read",
    description:
      "Quick food & drinks picks: the guest's usual order (from history), three popular items and a 'see full menu' option. Use this instead of browse_menu when offering food after the tickets are paid.",
  },
  order_fnb: {
    input: OrderFnbInput,
    kind: "read",
    description:
      "Order food & drinks as a separate order for a paid booking (Vista cannot add items to a paid order): creates the F&B order, adds the items (or repeats the usual order) and opens Review & Pay for it.",
  },
  get_loyalty_balance: {
    input: GetLoyaltyBalanceInput,
    kind: "read",
    description: "Share Points and VOX Rewards balance for the logged-in member.",
  },
  get_session_context: {
    input: GetSessionContextInput,
    kind: "read",
    description:
      "Whether the customer is logged in, their name, preferred language, location permission and any active order.",
  },
  login_customer: {
    input: LoginCustomerInput,
    kind: "read",
    description: "Simulated login by email/phone/member id and PIN (demo).",
  },
  list_my_bookings: {
    input: ListMyBookingsInput,
    kind: "read",
    description: "Bookings for the logged-in customer.",
  },
  get_recommendations: {
    input: GetRecommendationsInput,
    kind: "read",
    description: "Personalised movie and F&B recommendations from profile preferences and purchase history.",
  },
  // writes (asynchronous actions)
  cancel_booking: {
    input: CancelBookingInput,
    kind: "write",
    description:
      "Cancel a booking and trigger the refund exactly as summarised in prepare_cancellation. Requires confirmationId and confirmed=true.",
  },
  swap_booking: {
    input: SwapBookingInput,
    kind: "write",
    description:
      "Execute the prepared swap (refund original, rebook new session). Requires confirmationId and confirmed=true.",
  },
  start_order: {
    input: StartOrderInput,
    kind: "write",
    description: "Start a new booking order for a session. Returns userSessionId.",
  },
  add_tickets: { input: AddTicketsInput, kind: "write", description: "Add tickets to the order." },
  select_seats: {
    input: SelectSeatsInput,
    kind: "write",
    description: "Choose specific seats (or auto-allocate) for the tickets in the order.",
  },
  add_concessions: {
    input: AddConcessionsInput,
    kind: "write",
    description:
      "Add food & beverage items to the order, or remove one with quantity 0. Only add what the guest explicitly chose — never a guess.",
  },
  apply_offer: {
    input: ApplyOfferInput,
    kind: "write",
    description: "Apply an offer or promo code to the order.",
  },
  redeem_points: {
    input: RedeemPointsInput,
    kind: "write",
    description: "Redeem Share Points or VOX Rewards against the order.",
  },
  pay_order: {
    input: PayOrderInput,
    kind: "write",
    description:
      "Complete payment and create the booking (QR + reference) for VOX_CREDIT or SHARE_POINTS payments only — card, saved card, Apple Pay and Samsung Pay are completed by the guest in the widget's payment sheet, so never call this for those. Requires confirmationId and confirmed=true.",
  },
  cancel_order: {
    input: CancelOrderInput,
    kind: "write",
    description: "Abandon the in-progress order and release seats.",
  },
  submit_feedback: {
    input: SubmitFeedbackInput,
    kind: "write",
    description: "Record the end-of-chat feedback rating.",
  },
  create_complaint: {
    input: CreateComplaintInput,
    kind: "write",
    description: "Log a customer complaint with the details gathered in conversation.",
  },
  transfer_to_agent: {
    input: TransferToAgentInput,
    kind: "write",
    description:
      "Hand the conversation to a human agent with a summary. Use on explicit request, frustration, or after two failed answers.",
  },
  log_journey: {
    input: LogJourneyInput,
    kind: "write",
    description: "Mark a journey (e.g. 'movie_info', 'cancellation') completed or abandoned for reporting.",
  },
} as const;

export type ToolName = keyof typeof TOOL_REGISTRY;
export const TOOL_NAMES = Object.keys(TOOL_REGISTRY) as ToolName[];
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_REGISTRY)[N]["input"]>;

/** Client tools executed by the widget (ElevenLabs client tools). The agent calls these to drive UI. */
export const CLIENT_TOOLS = {
  render_cards: {
    description: "Render rich cards (movies, showtimes, cinemas, offers, menu, bookings) in the chat window.",
    params: z.object({ ui: z.record(z.unknown()) }),
  },
  render_seat_map: {
    description:
      "Draw the interactive seat map for the current order on the guest's screen (the widget fetches the live seat plan itself). Returns whether the map is on screen.",
    params: z.object({ sessionKey: z.string(), userSessionId: z.string().optional() }),
  },
  render_order_summary: {
    description: "Show the order summary / cart.",
    params: z.object({ userSessionId: z.string() }),
  },
  render_payment_sheet: {
    description: "Open the payment sheet for the prepared payment.",
    params: z.object({ userSessionId: z.string(), confirmationId: z.string(), method: PaymentMethod }),
  },
  render_qr: {
    description: "Show the booking confirmation with QR code.",
    params: z.object({ bookingId: z.string() }),
  },
  render_feedback: { description: "Show the feedback survey.", params: z.object({}) },
  request_location: {
    description: "Ask the browser for GPS location; returns lat/lng.",
    params: z.object({}),
  },
  play_trailer: {
    description: "Play a movie trailer.",
    params: z.object({ youtubeId: z.string(), title: z.string().optional() }),
  },
  open_link: {
    description: "Open a VOX website link in a new tab.",
    params: z.object({ url: z.string().url(), label: z.string().optional() }),
  },
  set_language: { description: "Switch the widget UI language.", params: z.object({ language: Language }) },
  set_mode: {
    description: "Switch the widget between bot and human-agent mode.",
    params: z.object({ mode: z.enum(["bot", "human"]), transferId: z.string().optional() }),
  },
  confirm_dialog: {
    description: "Show a confirm/cancel prompt with the spoken summary; returns the customer's tap.",
    params: z.object({
      title: z.string(),
      body: z.string(),
      confirmLabel: z.string().default("Confirm"),
      cancelLabel: z.string().default("Cancel"),
    }),
  },
} as const;
export type ClientToolName = keyof typeof CLIENT_TOOLS;
