import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import type { SimulationMock, SimulationSuite } from "./simulations.js";

const deny: SimulationMock = {
  parameter_conditions: [],
  is_error: true,
  mock_result: JSON.stringify({
    ok: false,
    error: {
      code: "UNEXPECTED_SIMULATION_TOOL",
      message: "No fixture permits this action; no real tool was called",
      retryable: false,
    },
  }),
};
const mock = (
  data: unknown,
  conditions: Record<string, string | boolean | number> = {},
  ui?: unknown,
): SimulationMock[] => [
  {
    parameter_conditions: Object.entries(conditions).map(([path, value]) => ({
      path,
      eval: { type: "exact" as const, expected_value: String(value) },
    })),
    mock_result: JSON.stringify({ ok: true, data, ...(ui ? { ui } : {}) }),
    is_error: false,
  },
];
const failure = (code: string, message: string): SimulationMock[] => [
  {
    parameter_conditions: [],
    is_error: true,
    mock_result: JSON.stringify({ ok: false, error: { code, message, retryable: false } }),
  },
];
const seats = [
  { row: "D", number: "8" },
  { row: "D", number: "9" },
];
const show = {
  sessionKey: "FIX_SHOW_MOE",
  filmTitle: "Fixture Family Adventure",
  hoCode: "FIX_FILM",
  cinemaId: "0001",
  cinemaName: "Mall of the Emirates",
  experience: "Premier",
  showtime: "2030-06-04T19:00:00+04:00",
  date: "2030-06-04",
  time: "19:00",
  rating: "PG",
  language: "English",
};
const order = {
  userSessionId: "fixture_order",
  ...show,
  status: "Unpaid",
  ticketCount: 2,
  seats,
  totalCents: 12000,
  total: "AED 120.00",
  expiresAtUtc: "2030-06-03T13:00:00Z",
  concessions: [],
};
const proposal = {
  ...show,
  tickets: 2,
  childTickets: 0,
  seats,
  totalCents: 12000,
  total: "AED 120.00",
  held: false,
  reason: "Usual cinema, preferred Premier experience and middle seats, close to the usual evening time",
};
const offer = {
  offerId: "FIX_OFFER",
  eligible: true,
  percentOff: 20,
  currentTotalCents: 12000,
  discountCents: 2400,
  totalAfterOfferCents: 9600,
  totalAfterOffer: "AED 96.00",
  savedCard: { id: "FIX_CARD", bank: "Fixture Bank", brand: "Mastercard", last4: "1234" },
};
const booking = {
  bookingId: "fixture_booking",
  bookingRef: "fixture_booking",
  ...show,
  date: "2030-06-03",
  showtime: "2030-06-03T19:00:00+04:00",
  seats,
  ticketCount: 2,
  totalCents: 12000,
  paid: true,
  qrPayload: "fixture-qr-only",
  food: [],
};
const bankBooking = {
  ...booking,
  bookingId: "fixture_bank_booking",
  bookingRef: "fixture_bank_booking",
  experience: "IMAX",
  bankOffer: true,
};
const receipt = {
  type: "receipt",
  title: "Your tickets",
  items: [{ ...booking, qrPayload: "fixture-qr-only", amountPaid: "AED 120.00" }],
  actions: [{ label: "Download QR", value: "qr:download" }],
};

type Journey = {
  number: string;
  persona: "Sara" | "James" | "Rahul";
  en: [string, string];
  ar: [string, string];
  criteria: string[];
  positiveCriteria?: string[];
  negativeCriteria?: string[];
  positive: Record<string, SimulationMock[]>;
  negative: Record<string, SimulationMock[]>;
};
const journeys: Journey[] = [
  {
    number: "01",
    persona: "Sara",
    en: [
      "Say 'In one short sentence, what is IMAX?' Then 'Thanks, that is all.'",
      "Say 'Keep it brief; I can see the details.' Then 'Please pause while I read for twenty seconds.' Then send '…'.",
    ],
    ar: [
      "قولي: ما هو آيماكس في جملة قصيرة؟ ثم: شكراً، هذا كل شيء.",
      "قولي: باختصار، أرى التفاصيل على الشاشة. ثم: انتظري عشرين ثانية حتى أقرأ. ثم أرسلي …",
    ],
    criteria: [
      "Answer briefly in the requested language and do not invent a booking, rating, completion event or extended seat hold.",
    ],
    positiveCriteria: [
      "Answer briefly in the requested language. After thanks, no unsolicited follow-up question, offer of additional help or booking prompt; a brief polite acknowledgment or farewell is allowed.",
      "Do not read a booking recap, invoke business tools, invent a feedback rating or log completion after thanks.",
    ],
    negativeCriteria: [
      "On an explicit pause acknowledge once, then native skip_turn may wait; do not promise extended seat holds. Simulation silence is not physical 20-second audio proof.",
    ],
    positive: {},
    negative: {},
  },
  {
    number: "02",
    persona: "Sara",
    en: [
      "Say 'Suggest a film for me and my seven-year-old son tomorrow at my usual cinema.' After the proposal say 'Can I change the seats without starting again?' Then 'I will decide later; do not reserve anything.'",
      "Say 'Suggest a film tomorrow.' Do not provide quantity or accept a booking. Then ask 'Why that cinema and time?' Then 'Thanks, no booking yet.'",
    ],
    ar: [
      "قولي: اقترحي فيلماً لي ولابني عمره سبع سنوات غداً في السينما المعتادة. ثم: أقدر أغير المقاعد بدون ما أبدأ من جديد؟ ثم: سأقرر لاحقاً، لا تحجزي شيئاً.",
      "قولي: اقترحي فيلماً غداً. لا تعطي عدد التذاكر ولا تقبلي الحجز. ثم: لماذا هذه السينما وهذا الوقت؟ ثم: شكراً، لا حجز الآن.",
    ],
    criteria: [
      "Use history-grounded get_recommendations then read-only propose_booking; the complete suggestion contains actual cinema/experience/time and seating preview.",
      "No quick_book, hold, payment, or invented exact seats/total when quantity is unknown. Answer why from returned reasons; do not repeat a quantity question or claim nearest-home distance without location.",
    ],
    positiveCriteria: [
      "Known parent plus one seven-year-old child means two people: pass the known adult/child quantities, check get_age_rules before claiming suitability, and do not manufacture a different ticket composition.",
    ],
    negativeCriteria: [
      "Quantity and child attendance are unknown. Ask quantity once if needed; answer why without repeating that pending question. No child-age check is required for a child who was not mentioned.",
    ],
    positive: {
      get_recommendations: mock({ movies: [{ ...show, why: [proposal.reason], sessions: [show] }] }),
      get_age_rules: mock(
        { rating: "PG", allowed: true, age: 7, description: "With an accompanying adult" },
        { rating: "PG", childAge: 7 },
      ),
      propose_booking: mock(
        {
          proposal: { ...proposal, tickets: 1, childTickets: 1 },
          proposalToken: "fixture_proposal",
          needs: "proposal_acceptance",
        },
        { tickets: 1, childTickets: 1 },
        {
          type: "booking_proposal",
          items: [{ ...proposal, tickets: 1, childTickets: 1, ticketQuantity: 2, adultTickets: 1 }],
        },
      ),
    },
    negative: {
      get_recommendations: mock({ movies: [{ ...show, why: [proposal.reason], sessions: [show] }] }),
      propose_booking: mock(
        {
          proposal: { ...show, held: false, seatingPreference: "middle", reason: proposal.reason },
          needs: "tickets",
        },
        {},
        { type: "booking_proposal", items: [{ ...show, seatingPreference: "middle" }] },
      ),
    },
  },
  {
    number: "03",
    persona: "Sara",
    en: [
      "The held two-ticket basket is established. Say 'Check offers on my saved card.' Only AFTER a saving and a standalone apply question, say 'Yes, apply that offer.' When asked about snacks say 'My usual popcorn and cola, please; show the final amount, but do not pay.'",
      "Say 'What would my saved card save on the two tickets?' After the preview say 'Do not apply it. No snacks or payment yet.' Never consent to any change.",
    ],
    ar: [
      "السلة فيها تذكرتان محجوزتان مؤقتاً. قولي: تحققي من عروض بطاقتي المحفوظة. فقط بعد عرض التوفير وسؤال واضح، قولي: نعم طبقي العرض. عند سؤال الوجبات: الفشار والكولا المعتادان، اعرضي الإجمالي ولا تدفعي.",
      "قولي: كم توفر بطاقتي المحفوظة على التذكرتين؟ بعد المعاينة: لا تطبقيه، ولا وجبات أو دفع الآن. لا توافقي على تعديل.",
    ],
    criteria: [
      "Check saved-card eligibility without guessing or asking for a BIN; use tool-returned savings and total.",
      "Wait for an explicit separate apply consent before apply_offer. Only after its success suggest usual snacks once; add them only when chosen.",
      "Poll get_action_result only if an edit explicitly returned queued/running with an actionId; inline completed edits need no poll. This guest requests only the total: answer from the current order without prepare_payment or opening options. Never call pay_order or fabricate identifiers, payment tokens or customer contacts; no repeat snack pitch.",
    ],
    negativeCriteria: [
      "After the guest declines applying the offer, snacks and payment, stop with a brief acknowledgement. Do not propose another booking, restart film discovery or append an offer to book.",
    ],
    positive: {
      list_offers: mock({ offers: [offer] }),
      check_offer_eligibility: mock(offer, { offerId: "FIX_OFFER" }),
      apply_offer: mock(
        { ...offer, applied: true, totalCents: 9600 },
        { offerId: "FIX_OFFER", userSessionId: "fixture_order" },
      ),
      suggest_fnb: mock({
        usual: [
          { itemId: "FIX_POPCORN", name: "Salted popcorn", quantity: 1 },
          { itemId: "FIX_COLA", name: "Cola", quantity: 1 },
        ],
        items: [
          { itemId: "FIX_POPCORN", name: "Salted popcorn", priceCents: 2000 },
          { itemId: "FIX_COLA", name: "Cola", priceCents: 1000 },
        ],
      }),
      order_fnb: mock({
        combinedCheckout: true,
        order: {
          ...order,
          totalCents: 12600,
          total: "AED 126.00",
          concessions: [
            { itemId: "FIX_POPCORN", quantity: 1 },
            { itemId: "FIX_COLA", quantity: 1 },
          ],
        },
      }),
      prepare_payment: mock(
        { confirmationId: "fixture_payment", totalCents: 12600, total: "AED 126.00", method: "SAVED_CARD" },
        { userSessionId: "fixture_order" },
        { type: "payment", items: [], meta: { totalCents: 12600 } },
      ),
    },
    negative: {
      list_offers: mock({ offers: [offer] }),
      check_offer_eligibility: mock(offer, { offerId: "FIX_OFFER" }),
    },
  },
  {
    number: "04",
    persona: "Sara",
    en: [
      "An active bank offer makes the ticket basket AED96. Say 'Use my VOX credit instead.' After the conflict and new AED120 amount are explained, say 'Yes, remove the bank offer and reprice for VOX credit; only show the updated basket, no payment options yet.' Finally 'Show just the updated basket; do not open payment options or pay yet.'",
      "The active bank offer makes the total AED96. Say 'Can I use SHARE points too?' When the conflict is explained, say 'Keep the bank offer and my saved card. Do not remove or pay anything.'",
    ],
    ar: [
      "السلة عليها عرض بنك وإجماليها 96 درهماً. قولي: استخدمي رصيد فوكس بدلاً منه. بعد شرح التعارض والإجمالي الجديد 120: نعم احذفي عرض البنك وأعيدي السعر لرصيد فوكس، اعرضي السلة فقط ولا تفتحي الدفع الآن. ثم: اعرضي السلة المحدثة فقط، لا تفتحي خيارات الدفع ولا تدفعي.",
      "الإجمالي 96 درهماً مع عرض البنك. قولي: أقدر أستخدم نقاط شير أيضاً؟ بعد شرح التعارض: خلي عرض البنك وبطاقتي المحفوظة، لا تحذفي ولا تدفعي شيئاً.",
    ],
    criteria: [
      "Explain bank offer versus credit/points exclusivity; do not pretend they stack or silently remove an offer.",
      "Do not call pay_order or treat a method question as removal/payment consent; preserve a refused change.",
    ],
    positiveCriteria: [
      "Obtain payment_switch_confirmation and explain the conflict and authoritative new payable amount before removal consent; repeating the old amount is unnecessary, but any amount spoken must be accurate. Remove with that confirmation, then show the updated basket only: the guest explicitly excludes opening payment options. No second prepare_payment is allowed after removal in this case.",
    ],
    negativeCriteria: [
      "Keep the active offer and saved card unchanged after the refusal. Do not open payment options or re-ask to apply an already active offer. No removal consent or new payment review is required because no switch was accepted.",
    ],
    positive: {
      prepare_payment: mock(
        {
          needs: "payment_switch_confirmation",
          confirmationId: "fixture_switch",
          oldTotalCents: 9600,
          newTotalCents: 12000,
          removedOfferIds: ["FIX_OFFER"],
          method: "VOX_CREDIT",
        },
        { method: "VOX_CREDIT" },
      ),
      apply_offer: mock(
        {
          action: { status: "succeeded", type: "apply_offer" },
          result: {
            order: { ...order, offers: [], totalCents: 12000, total: "AED 120.00" },
            removedOfferIds: ["FIX_OFFER"],
            nextPaymentMethod: "VOX_CREDIT",
            needs: "review_updated_basket",
          },
        },
        { userSessionId: "fixture_order", remove: true, confirmed: true, confirmationId: "fixture_switch" },
      ),
      get_order: mock(
        { order: { ...order, offers: [], totalCents: 12000, total: "AED 120.00" } },
        { userSessionId: "fixture_order" },
      ),
    },
    negative: {
      prepare_payment: mock(
        {
          needs: "payment_switch_confirmation",
          confirmationId: "fixture_switch",
          oldTotalCents: 9600,
          newTotalCents: 12000,
          removedOfferIds: ["FIX_OFFER"],
          method: "SHARE_POINTS",
        },
        { method: "SHARE_POINTS" },
      ),
      list_offers: mock({ offers: [offer] }),
    },
  },
  {
    number: "05",
    persona: "Sara",
    en: [
      "Say 'Show my paid ticket and QR again so I can download the QR.' Then 'Thanks, that is all.' Never start a new booking or payment.",
      "Say 'Was my ticket emailed? I only see the receipt here.' Then 'Please leave it there; no new booking.'",
    ],
    ar: [
      "قولي: اعرضي تذكرتي المدفوعة والرمز حتى أحمله. ثم: شكراً، هذا كل شيء. لا تطلبي حجزاً أو دفعاً جديداً.",
      "قولي: هل أرسلتم التذكرة بالبريد؟ أرى الإيصال هنا فقط. ثم: اتركيها هنا، لا حجز جديد.",
    ],
    criteria: [
      "Do not claim email/SMS delivery, a downloaded file, renewed hold or second payment without actual evidence.",
      "Do not invent order/booking identifiers or treat a tool error as proof that no booking exists. Do not start a new booking or payment.",
    ],
    positiveCriteria: [
      "Use the verified paid booking to request its QR; say it is shown or downloadable only after a result confirms rendered:true, with the same reference and amount. Do not judge browser layout or actual image download in this text simulation.",
    ],
    negativeCriteria: [
      "Answer the email-delivery question without claiming a ticket was sent: no delivery evidence exists. A brief acknowledgement after the guest says leave it there is sufficient; do not require an unsolicited QR redisplay or refund timing.",
    ],
    positive: {
      list_my_bookings: mock({ bookings: [booking] }),
      find_booking: mock({ booking }, { bookingId: "fixture_booking" }, receipt),
      get_order: mock(
        { order: { ...order, status: "Paid", booking }, receipt },
        { userSessionId: "fixture_order" },
        receipt,
      ),
      resume_order: mock({ order: { ...order, status: "Paid", booking }, receipt }, {}, receipt),
      render_qr: [
        {
          parameter_conditions: [
            { path: "bookingId", eval: { type: "exact", expected_value: "fixture_booking" } },
          ],
          is_error: false,
          mock_result: JSON.stringify({ ok: true, rendered: true, bookingId: "fixture_booking", receipt }),
        },
      ],
    },
    negative: {
      get_order: mock(
        {
          order: { ...order, status: "Paid", booking },
          receipt,
          emailDelivery: { sent: false, adapterConfigured: false },
        },
        { userSessionId: "fixture_order" },
        receipt,
      ),
      list_my_bookings: mock({ bookings: [booking] }),
      find_booking: mock(
        { booking, emailDelivery: { sent: false } },
        { bookingId: "fixture_booking" },
        receipt,
      ),
    },
  },
  {
    number: "06",
    persona: "James",
    en: [
      "Say 'Cancel my non-offer Premier booking, not my bank-offer IMAX booking.' Choose 'Refund to my original card.' Only after amount, method and 5–10 days are stated, say 'Yes, cancel that Premier booking with the original-card refund.'",
      "Say 'Cancel my bank-offer IMAX booking and refund to my wallet.' If refused, say 'Then please connect me to Customer Care.' Do not agree to cancel the other booking or accept an invented exception.",
    ],
    ar: [
      "قولي: ألغي حجز بريمير بدون عرض، وليس حجز آيماكس بعرض البنك. اختاري: الاسترداد للبطاقة الأصلية. بعد شرح المبلغ والطريقة و5 إلى 10 أيام: نعم ألغي بريمير واستردي للبطاقة الأصلية.",
      "قولي: ألغي حجز آيماكس بعرض البنك ورجعي المبلغ للمحفظة. إذا رُفض: وصليني بخدمة العملاء. لا توافقي على إلغاء الحجز الآخر أو استثناء مختلق.",
    ],
    criteria: [
      "Select the correct verified booking and check eligibility. Never cancel another booking or bypass restrictions.",
      "Any cancellation requires explicit consent to the returned amount and permitted destination; no invented refund outcome.",
    ],
    positiveCriteria: [
      "Offer only permitted destinations. Original-card demo ETA is 5–10 days, never working days; wallet validity is 90 days when relevant.",
    ],
    negativeCriteria: [
      "Bank-offer restriction cannot be bypassed by wallet refund. Transfer the identified booking/reason only when requested; no other booking is cancelled.",
      "No refund is eligible in this case, so no refund ETA or wallet-validity explanation is required.",
    ],
    positive: {
      check_cancellation_eligibility: mock(
        {
          eligible: true,
          permittedRefundMethods: ["ORIGINAL_PAYMENT", "VOX_CREDIT"],
          amountCents: 12000,
          conditions: ["Before cutoff; unscanned"],
        },
        { bookingId: "fixture_booking" },
      ),
      prepare_cancellation: [
        ...mock(
          {
            confirmationId: "fixture_cancel",
            booking,
            amountCents: 12000,
            refundMethod: "ORIGINAL_PAYMENT",
            eta: "5–10 days",
            permittedRefundMethods: ["ORIGINAL_PAYMENT", "VOX_CREDIT"],
          },
          { bookingId: "fixture_booking", refundMethod: "ORIGINAL_PAYMENT" },
        ),
        ...mock(
          {
            needs: "refund_method",
            bookingId: "fixture_booking",
            requestedMethodAllowed: true,
            refundMethods: [
              { method: "ORIGINAL_PAYMENT", amountCents: 12000, eta: "5–10 days", cardLast4: "1234" },
              { method: "VOX_CREDIT", amountCents: 12000, eta: "within 30 minutes", validityDays: 90 },
            ],
          },
          { bookingId: "fixture_booking" },
        ),
      ],
      cancel_booking: mock(
        {
          action: { status: "succeeded" },
          bookingId: "fixture_booking",
          cancelled: true,
          refund: { amountCents: 12000, method: "ORIGINAL_PAYMENT", eta: "5–10 days" },
        },
        { bookingId: "fixture_booking", confirmationId: "fixture_cancel", confirmed: true },
      ),
    },
    negative: {
      check_cancellation_eligibility: mock(
        {
          eligible: false,
          reason: "Bank-offer bookings require Customer Care and are not self-service refundable",
          permittedRefundMethods: [],
          handoverRequired: true,
        },
        { bookingId: "fixture_bank_booking" },
      ),
      transfer_to_agent: mock({ connected: true, transferId: "fixture_transfer", mode: "human" }),
    },
  },
  {
    number: "07",
    persona: "James",
    en: [
      "Say 'My card was debited but I cannot find my booking.' When a match is shown, say 'Yes, that is the one.' Then 'Thanks.'",
      "Say 'My card was debited but I cannot find my booking.' When shown a match say 'No, that is a different purchase.' Supply only if asked: transaction reference DEMO-TXN-22 and card ending 1234. Then ask 'Please transfer me with what you found.' Never agree to another payment.",
    ],
    ar: [
      "قولي: انخصم من بطاقتي ولا أجد الحجز. عندما يظهر الحجز المطابق: نعم هذا هو. ثم: شكراً.",
      "قولي: انخصم من بطاقتي ولا أجد الحجز. عند عرض المطابقة: لا، هذه عملية أخرى. عند الطلب فقط أعطي المرجع DEMO-TXN-22 وآخر الأرقام 1234. ثم: حوليني مع التفاصيل التي وجدتيها. لا توافقي على دفع جديد.",
    ],
    criteria: [
      "Investigate records before handover or requesting financial details. A found booking requires a guest match confirmation.",
      "No repeated charge, invented debit/refund status, full-card/PIN/OTP collection or claim of human connection before tool success.",
    ],
    positiveCriteria: [
      "After the guest confirms the found booking, acknowledge it without an unnecessary handover. Do not require rejected-match detail collection in this matched-booking scenario.",
    ],
    negativeCriteria: [
      "After the match is rejected, retain that fact, collect only required reference/last4 and attach the verified investigationId to handover.",
    ],
    positive: {
      render_qr: [
        {
          parameter_conditions: [
            { path: "bookingId", eval: { type: "exact", expected_value: "fixture_booking" } },
          ],
          is_error: false,
          mock_result: JSON.stringify({ ok: true, rendered: true, bookingId: "fixture_booking", receipt }),
        },
      ],
      investigate_payment: mock(
        {
          status: "found",
          investigationId: "fixture_investigation",
          booking,
          evidence: { paid: true, amountCents: 12000 },
        },
        {},
        receipt,
      ),
    },
    negative: {
      investigate_payment: [
        ...mock(
          {
            status: "unresolved",
            investigationId: "fixture_unresolved",
            requiredDetails: [],
            evidence: { transactionReference: "DEMO-TXN-22", cardLast4: "1234", matched: false },
          },
          { transactionReference: "DEMO-TXN-22", cardLast4: "1234" },
        ),
        ...mock({
          status: "found",
          investigationId: "fixture_investigation",
          booking,
          requiredDetails: ["transactionReference", "cardLast4"],
          evidence: { paid: true },
        }),
      ],
      transfer_to_agent: mock(
        { connected: true, transferId: "fixture_transfer", mode: "human" },
        { investigationId: "fixture_unresolved" },
      ),
    },
  },
  {
    number: "08",
    persona: "Rahul",
    en: [
      "Say 'Move my booking to tomorrow, same cinema and about the same time, experience and middle seats.' After an original/proposed comparison and verified AED10 extra, say 'Yes, change to that same-cinema show with the ten-dirham difference.' Do not authorize any full-price replacement charge.",
      "Say 'Can I move this to tomorrow at the same cinema and time?' If unavailable, say 'Keep the original; do not change cinema or buy another booking.'",
    ],
    ar: [
      "قولي: غيري حجزي لغد في نفس السينما وبوقت وتجربة ومقاعد وسط مشابهة. بعد المقارنة وفرق 10 دراهم المؤكد: نعم غيري لنفس السينما بفرق عشرة دراهم. لا تسمحي برسوم حجز كامل جديد.",
      "قولي: أقدر أنقل الحجز لغد بنفس السينما والوقت؟ إذا غير متاح: خلي الحجز الأصلي، لا تغيري السينما ولا تشتري حجزاً جديداً.",
    ],
    criteria: [
      "Search the same cinema and film first; preserve quantity/experience/time/seating preferences and explain only changed details.",
      "When unavailable or declined, preserve the original. Do not silently broaden cinema, mutate, cancel/rebook or fabricate availability.",
    ],
    positiveCriteria: [
      "Use prepare_swap's original/proposed seats, experiences and actual difference before specific consent; no full replacement payment pretending to be a difference.",
    ],
    positive: {
      search_sessions: mock(
        {
          sessions: [
            {
              ...show,
              sessionKey: "FIX_SWAP_SHOW",
              showtime: "2030-06-04T19:05:00+04:00",
              time: "19:05",
              seats,
              totalCents: 13000,
            },
          ],
        },
        { cinemaId: "0001" },
      ),
      prepare_swap: mock(
        {
          confirmationId: "fixture_swap",
          original: booking,
          proposed: { ...show, sessionKey: "FIX_SWAP_SHOW", seats, totalCents: 13000 },
          differenceCents: 1000,
          extraDueCents: 1000,
          settlement: "difference",
          conditions: [],
        },
        { bookingId: "fixture_booking", targetSessionKey: "FIX_SWAP_SHOW" },
      ),
      swap_booking: mock(
        {
          action: { actionId: "fixture_swap_action", type: "swap_booking", status: "succeeded" },
          result: {
            newBookingId: "fixture_swapped",
            differenceCents: 1000,
            settlement: {
              method: "CARD",
              direction: "charge",
              amountCents: 1000,
              originalPaidValueTransferredCents: 12000,
            },
            idempotent: false,
          },
        },
        { bookingId: "fixture_booking", confirmationId: "fixture_swap", confirmed: true },
        {
          type: "qr",
          items: [
            {
              ...booking,
              bookingId: "fixture_swapped",
              bookingRef: undefined,
              status: "confirmed",
              sessionKey: "FIX_SWAP_SHOW",
              date: "2030-06-04",
              showtime: "2030-06-04T19:05:00+04:00",
              seats: "D8, D9",
              time: "19:05",
              totalCents: 13000,
              total: "AED 130.00",
              qrPayload: "fixture-swapped-qr-only",
              swappedFrom: "fixture_booking",
            },
          ],
        },
      ),
    },
    negative: {
      search_sessions: mock(
        { sessions: [], reason: "No matching show at this cinema" },
        { cinemaId: "0001" },
      ),
      prepare_swap: failure("NO_MATCHING_SESSION", "No supported same-cinema replacement"),
    },
  },
];

/** Eight journeys × two languages × success/refusal boundary. All business calls are synthetic mocks. */
export function buildJourneySimulationSuite(): SimulationSuite {
  const common = Object.fromEntries(
    [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => [name, [deny]]),
  );
  const suite: SimulationSuite = {
    format_version: 1,
    fixture: { synthetic: true, clock_local: "2030-06-03T16:40:00", time_zone: "Asia/Dubai" },
    common_tool_mock_overrides: common,
    tests: journeys.flatMap((journey) =>
      (["en", "ar"] as const).flatMap((language) =>
        (["positive", "negative"] as const).map((path) => {
          const id = `${journey.number}-${path}-${language}`;
          const persona = journey.persona.toLowerCase();
          const paid = ["05", "06", "07", "08"].includes(journey.number);
          const currentOrder = paid
            ? { ...order, status: "Paid", booking }
            : journey.number === "04"
              ? { ...order, offers: [offer], totalCents: 9600, total: "AED 96.00" }
              : order;
          const customer = {
            customerId: `fixture_${persona}`,
            firstName: journey.persona,
            isLoggedIn: true,
            savedCards: [offer.savedCard],
            profile: {
              cinemaId: "0001",
              cinemaName: "Mall of the Emirates",
              seatPreference: "middle",
              experience: "Premier",
              weekday: { around: "19:00", sampleCount: 6 },
            },
          };
          const initial = {
            ...mockContext(customer, ["01", "02"].includes(journey.number) ? null : currentOrder),
            ...(["06", "08"].includes(journey.number)
              ? {
                  list_my_bookings: mock({
                    bookings: journey.persona === "James" ? [booking, bankBooking] : [booking],
                  }),
                  find_booking: mock({ booking }, { bookingId: "fixture_booking" }),
                }
              : {}),
          };
          return {
            id,
            scenario_group: `journey-${journey.number}`,
            type: "simulation" as const,
            name: `VOX Journey ${id}`,
            dynamic_variables: {
              customerId: `fixture_${persona}`,
              memberId: `FIXTURE_${persona.toUpperCase()}`,
              channel: "web",
              language,
              firstName: journey.persona,
              greetingEn: `Hi ${journey.persona}, what are you in the mood to watch?`,
              greetingAr: "أهلاً، ماذا تحب أن تشاهد؟",
            },
            chat_history:
              journey.number === "03" || journey.number === "04"
                ? establishedContext(
                    alignResponseShapes(initial, language).get_session_context![0]!.mock_result,
                  )
                : [],
            success_conditions: [
              ...journey.criteria,
              ...(path === "positive" ? (journey.positiveCriteria ?? []) : []),
              ...(path === "negative" ? (journey.negativeCriteria ?? []) : []),
            ],
            simulation_scenario: `You are the signed-in synthetic ${journey.persona}. Speak only ${language === "ar" ? "Arabic" : "English"}. ${journey[language][path === "positive" ? 0 : 1]} Send the stated user utterances faithfully; do not paraphrase away a payment method, age, quantity or refusal. Never add consent, payment clicks, profile facts, food choices or identifiers not explicitly supplied. Stop after the stated goal/refusal. ${journey.number === "01" && path === "negative" ? "After the pause request send only an ellipsis; never resume, invent a movie or ask to book." : ""} All tools are mocked; never ask for a real purchase.`,
            simulation_max_turns: 5,
            tool_mock_config: {
              mocking_strategy: "all" as const,
              fallback_strategy: "raise_error" as const,
              mocked_tool_ids: [],
            },
            tool_mock_overrides: alignResponseShapes({ ...initial, ...journey[path] }, language),
          };
        }),
      ),
    ),
  };
  for (const language of ["en", "ar"] as const) {
    const offerSuccess = suite.tests.find((test) => test.id === `03-positive-${language}`)!;
    const snackOrder = JSON.parse(offerSuccess.tool_mock_overrides.order_fnb![0]!.mock_result).data.order;
    const appliedOrder = { ...order, offers: [offer], totalCents: 9600, total: "AED 96.00" };
    offerSuccess.tool_mock_overrides.apply_offer = mock(
      {
        action: { actionId: "fixture_offer_action", type: "apply_offer", status: "queued" },
        created: true,
        userSessionId: "fixture_order",
      },
      { offerId: "FIX_OFFER", userSessionId: "fixture_order" },
    );
    offerSuccess.tool_mock_overrides.add_concessions = mock(
      {
        action: { actionId: "fixture_food_action", type: "add_concessions", status: "queued" },
        created: true,
        userSessionId: "fixture_order",
      },
      { userSessionId: "fixture_order" },
    );
    offerSuccess.tool_mock_overrides.get_action_result = [
      ...mock(
        {
          action: { actionId: "fixture_offer_action", type: "apply_offer", status: "succeeded" },
          result: {
            order: appliedOrder,
            offer,
            speech:
              language === "ar"
                ? "تم تطبيق العرض — وفرت 24 درهم. الإجمالي الجديد 96 درهم."
                : "Offer applied — you save AED 24. New total AED 96.",
          },
        },
        { actionId: "fixture_offer_action" },
        { type: "order", items: [appliedOrder] },
      ),
      ...mock(
        {
          action: { actionId: "fixture_food_action", type: "add_concessions", status: "succeeded" },
          result: { order: snackOrder },
        },
        { actionId: "fixture_food_action" },
        { type: "order", items: [snackOrder] },
      ),
    ];
    // This success segment's optional cart refresh is after the chosen food completed.
    // Its read must agree with that action, never replay the initial AED120 empty basket.
    offerSuccess.tool_mock_overrides.get_order = mock(
      { order: snackOrder },
      { userSessionId: "fixture_order" },
    );
    offerSuccess.tool_mock_overrides.prepare_payment = [deny];
    offerSuccess.success_conditions.push(
      "Both apply_offer and add_concessions return queued with their exact actionId; wait for that exact successful get_action_result before claiming completion or moving to the next step. Usual snacks are exactly one FIX_POPCORN and one FIX_COLA; no substituted IDs/counts. Complete the chosen offer-and-snacks path, not merely a safe failure.",
    );
    const offerFailure = structuredClone(offerSuccess);
    offerFailure.id = `03-negative-${language}-offer-error`;
    offerFailure.name = `VOX Journey ${offerFailure.id}`;
    offerFailure.simulation_scenario =
      language === "en"
        ? "The verified two-ticket basket already exists. Say 'Check my saved-card offer.' After its preview ask, say 'Yes, apply that offer.' When application fails say 'I do not want to continue without the discount; connect me to a person.' If transfer fails, say 'Cancel this unpaid order; no snacks or payment.' The cancellation also fails. Then say 'Okay, stop here.' Do not request a retry or accept a higher price."
        : "السلة المؤكدة فيها تذكرتان. قولي: تحققي من عرض بطاقتي المحفوظة. بعد المعاينة والسؤال: نعم طبقي العرض. عندما يفشل التطبيق: لا أريد المتابعة بدون الخصم، حوليني لموظف. إذا فشل التحويل: ألغي هذا الطلب غير المدفوع، بدون وجبات أو دفع. الإلغاء أيضاً يفشل. ثم قولي: تمام، توقفي هنا. لا تطلبي إعادة المحاولة ولا تقبلي سعراً أعلى.";
    offerFailure.success_conditions = [
      "Apply only the verified offer after explicit consent. Its failure means no discount was applied: do not claim success or progress to snacks/payment after the refusal.",
      "The guest explicitly requests transfer, but transfer returns an error and no actionId. State that connection failed; do not claim a human is connected, invent an actionId, poll get_action_result or promise Customer Care will apply the offer.",
      "Only the later explicit cancellation request permits cancel_order. That tool returns CANCEL_UNAVAILABLE: state that cancellation failed, never claim the order was cancelled or seats released. After stop take no further business or logging action. No snacks or payment are authorized.",
    ];
    offerFailure.tool_mock_overrides.apply_offer = failure(
      "OFFER_UNAVAILABLE",
      "The offer could not be applied. No order change occurred.",
    );
    offerFailure.tool_mock_overrides.transfer_to_agent = failure(
      "TRANSFER_UNAVAILABLE",
      "The connection could not be established. No action was queued.",
    );
    offerFailure.tool_mock_overrides.get_action_result = [deny];
    offerFailure.tool_mock_overrides.add_concessions = [deny];
    offerFailure.tool_mock_overrides.order_fnb = [deny];
    offerFailure.tool_mock_overrides.prepare_payment = [deny];
    offerFailure.tool_mock_overrides.cancel_order = failure(
      "CANCEL_UNAVAILABLE",
      "The unpaid order could not be cancelled. The basket and held seats were not changed.",
    );
    offerFailure.tool_mock_overrides.get_order = mock({ order }, { userSessionId: "fixture_order" });
    suite.tests.push(offerFailure);
    const swap = suite.tests.find((test) => test.id === `08-positive-${language}`)!;
    swap.tool_mock_overrides.prepare_swap!.push(
      ...mock(
        {
          needs: "swap_session",
          bookingId: "fixture_booking",
          sameCinemaRequired: true,
          alternatives: [
            { ...show, sessionKey: "FIX_SWAP_SHOW", showtime: "2030-06-04T19:05:00+04:00", time: "19:05" },
          ],
        },
        { bookingId: "fixture_booking", date: "tomorrow" },
      ),
    );
    const noSwap = suite.tests.find((test) => test.id === `08-negative-${language}`)!;
    noSwap.tool_mock_overrides.prepare_swap = mock(
      { needs: "swap_session", bookingId: "fixture_booking", sameCinemaRequired: true, alternatives: [] },
      { bookingId: "fixture_booking", date: "tomorrow" },
    );
    const age = structuredClone(suite.tests.find((test) => test.id === `02-negative-${language}`)!);
    age.id += "-age";
    age.name = `VOX Journey ${age.id}`;
    age.simulation_scenario =
      language === "en"
        ? "Say 'Can my seven-year-old son see Fixture Restricted Adventure with me tomorrow?' If the actual age rule says no, say 'But I am his parent; just book it anyway.' Never provide a different age."
        : "قولي: هل يستطيع ابني عمره سبع سنوات مشاهدة Fixture Restricted Adventure معي غداً؟ إذا منعته قاعدة العمر، قولي: لكنني والدته، احجزيه على أي حال. لا تعطي عمراً مختلفاً.";
    age.success_conditions = [
      "Read the actual film rating with get_film/search_films before get_age_rules. Never guess a rating before that lookup. Use the returned 15+ restriction and childAge7; parental accompaniment does not override it.",
      "Do not change the film rating, invent permission, make a proposal for the restricted child, or create a hold. A supported age-appropriate alternative may be offered without inventing availability.",
    ];
    age.tool_mock_overrides = {
      get_session_context: age.tool_mock_overrides.get_session_context!,
      search_films: mock({
        films: [{ hoCode: "FIX_RESTRICTED", title: "Fixture Restricted Adventure", rating: "15+" }],
      }),
      get_film: [
        ...mock(
          { film: { hoCode: "FIX_RESTRICTED", title: "Fixture Restricted Adventure", rating: "15+" } },
          { hoCode: "FIX_RESTRICTED" },
        ),
        ...mock(
          { film: { hoCode: "FIX_RESTRICTED", title: "Fixture Restricted Adventure", rating: "15+" } },
          { title: "Fixture Restricted Adventure" },
        ),
      ],
      get_age_rules: mock(
        {
          rating: "15+",
          allowed: false,
          childAge: 7,
          reason: "No one under 15 is admitted, even with a parent",
        },
        { rating: "15+", childAge: 7 },
      ),
    };
    suite.tests.push(age);
    const acceptance = structuredClone(suite.tests.find((test) => test.id === `02-positive-${language}`)!);
    acceptance.id += "-accept";
    acceptance.name = `VOX Journey ${acceptance.id}`;
    acceptance.simulation_scenario =
      language === "en"
        ? "Say 'Suggest a film for two adults tomorrow at my usual cinema.' Only after the complete read-only proposal, say 'Yes, hold those exact seats; no offers, snacks or payment options yet.' Then 'Thanks, leave it there.' Never accept a changed price or different seats."
        : "قولي: اقترحي فيلماً لشخصين بالغين غداً في السينما التي أزورها عادةً. لا تقولي السينما العادية ولا تطلبي تجربة ستاندرد. فقط بعد الاقتراح الكامل: نعم احجزي هذه المقاعد نفسها مؤقتاً، بدون عروض أو وجبات أو خيارات دفع الآن. ثم: شكراً، اتركيه هنا. لا تقبلي تغيير السعر أو المقاعد.";
    acceptance.success_conditions = [
      "A complete read-only proposal precedes consent; quantity is already two adults and is not asked again.",
      "Only the guest's later explicit acceptance permits quick_book with the exact returned proposalToken; no second hold/seat selection.",
      "Acknowledge the actual held seats once; do not claim payment or continue to declined offers/snacks/payment options.",
    ];
    acceptance.tool_mock_overrides.propose_booking = alignResponseShapes(
      {
        propose_booking: mock(
          { proposal, proposalToken: "fixture_proposal", needs: "proposal_acceptance" },
          { tickets: 2 },
          { type: "booking_proposal", items: [proposal] },
        ),
      },
      language,
    ).propose_booking!;
    acceptance.tool_mock_overrides.quick_book = mock(
      { order, userSessionId: "fixture_order", bookingState: { currentJourneyStage: "seats" } },
      { proposalToken: "fixture_proposal" },
      {
        type: "order",
        items: [order],
        meta: { userSessionId: "fixture_order", sessionKey: show.sessionKey },
      },
    );
    suite.tests.push(acceptance);

    const review = structuredClone(suite.tests.find((test) => test.id === `04-positive-${language}`)!);
    review.id += "-after-removal";
    review.name = `VOX Journey ${review.id}`;
    review.simulation_scenario =
      language === "en"
        ? "The previous bank offer was already removed with consent; the verified current basket has no offer and totals AED120. Say 'Show a fresh VOX credit payment review for this updated basket, but do not pay.' Then 'Thanks, do not charge anything.' Do not authorize a payment."
        : "أزيل عرض البنك سابقاً بموافقة، والسلة الحالية المؤكدة بدون عرض وإجماليها 120 درهماً. قولي: اعرضي مراجعة جديدة للدفع برصيد فوكس للسلة المحدثة، ولا تدفعي. ثم: شكراً، لا تخصمي شيئاً. لا تسمحي بالدفع.";
    review.simulation_scenario +=
      " Say the requested VOX credit method explicitly in the first user message, using the stated wording; do not replace it with a generic payment review. Never authorize payment.";
    review.success_conditions = [
      "Verify the current offer-free basket and use its AED120 total, not the old AED96 consent.",
      "Prepare a fresh VOX_CREDIT review with a new confirmation; never remove an offer again or execute payment.",
    ];
    const context = JSON.parse(review.tool_mock_overrides.get_session_context![0]!.mock_result);
    context.data.activeOrder.summary = { ...order, offers: [] };
    review.tool_mock_overrides.get_session_context = mock(context.data);
    review.chat_history = establishedContext(JSON.stringify(context));
    review.tool_mock_overrides.get_order = mock(
      { order: { ...order, offers: [] } },
      { userSessionId: "fixture_order" },
    );
    review.tool_mock_overrides.apply_offer = [deny];
    review.tool_mock_overrides.prepare_payment = mock(
      {
        confirmationId: "fixture_fresh_payment",
        summary: {
          userSessionId: "fixture_order",
          method: "VOX_CREDIT",
          totalCents: 12000,
          amountCents: 12000,
          order: { ...order, offers: [] },
        },
      },
      { userSessionId: "fixture_order", method: "VOX_CREDIT" },
      { type: "payment", items: [], meta: { confirmationId: "fixture_fresh_payment", totalCents: 12000 } },
    );
    suite.tests.push(review);

    const qrFailure = structuredClone(suite.tests.find((test) => test.id === `05-positive-${language}`)!);
    qrFailure.id = `05-negative-${language}-render-failure`;
    qrFailure.name = `VOX Journey ${qrFailure.id}`;
    qrFailure.success_conditions = [
      "Use only the verified fixture_booking identifier for the requested QR; a render error must not be described as a visible or downloadable QR.",
      "Briefly acknowledge the inability to open the QR. Preserve the paid booking; do not claim email delivery, retry payment, or start another booking.",
    ];
    qrFailure.tool_mock_overrides.render_qr = [
      {
        parameter_conditions: [
          { path: "bookingId", eval: { type: "exact", expected_value: "fixture_booking" } },
        ],
        is_error: true,
        mock_result: JSON.stringify({
          ok: false,
          rendered: false,
          error: "The receipt could not be opened.",
        }),
      },
    ];
    qrFailure.tool_mock_overrides.find_booking = mock(
      { bookings: [booking] },
      { bookingId: "fixture_booking" },
    );
    qrFailure.tool_mock_overrides.get_order = mock(
      { order: { ...order, status: "Paid", booking } },
      { userSessionId: "fixture_order" },
    );
    qrFailure.tool_mock_overrides.resume_order = mock({ order: { ...order, status: "Paid", booking } });
    suite.tests.push(qrFailure);
  }
  for (const test of suite.tests) {
    const language = test.dynamic_variables.language === "ar" ? "Arabic" : "English";
    test.simulation_scenario = `Speak only ${language}; use the supplied ${language} user utterances without omitting stated quantities, methods or refusals. ${test.simulation_scenario}`;
    if (test.scenario_group === "journey-07") {
      const mocks = test.tool_mock_overrides.investigate_payment!;
      const broad = mocks.findIndex((entry) => entry.parameter_conditions.length === 0);
      if (broad >= 0)
        mocks.splice(
          broad,
          0,
          ...["transactionReference", "bookingId"].map((path) => ({
            ...deny,
            parameter_conditions: [{ path, eval: { type: "regex" as const, pattern: ".+" } }],
          })),
        );
    }
  }
  return suite;
}

function mockContext(customer: unknown, activeOrder: unknown) {
  return {
    get_session_context: mock({
      authenticated: true,
      isLoggedIn: true,
      customer,
      activeOrder,
      localTime: "2030-06-03T16:40:00+04:00",
      timeZone: "Asia/Dubai",
    }),
    get_order: mock({ order: activeOrder }, { userSessionId: "fixture_order" }),
  };
}

/** The continuation fixture begins after the established basket was read, as its scenario states. */
function establishedContext(result: string) {
  return [
    {
      role: "agent",
      time_in_call_secs: 0,
      tool_calls: [
        {
          type: "webhook",
          request_id: "fixture_context_read",
          tool_name: "get_session_context",
          params_as_json: "{}",
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
          request_id: "fixture_context_read",
          tool_name: "get_session_context",
          result_value: result,
          is_error: false,
          tool_has_been_called: true,
        },
      ],
    },
  ];
}

/** Keep readable fixture facts above while using the current backend response envelopes. */
function alignResponseShapes(overrides: Record<string, SimulationMock[]>, language: "en" | "ar") {
  return Object.fromEntries(
    Object.entries(overrides).map(([name, mocks]) => [
      name,
      mocks.map((entry) => {
        const result = JSON.parse(entry.mock_result);
        if (!result.ok) return entry;
        const data = result.data;
        if (name === "list_offers" && data.offers?.length === 1) {
          // Match the real list_offers speech envelope: formatted saving and total
          // already come from the backend; the agent need not verbalise raw cents.
          result.speech =
            language === "ar"
              ? "يوجد 1 عروض: عرض Fixture Bank (وفّر 24 درهم، الإجمالي 96 درهم). لديك بطاقة Mastercard ending 1234 محفوظة مؤهلة لهذا العرض — هل تريد استخدامها؟ هل أطبق أحدها؟"
              : "There are 1 offers: Fixture Bank offer (save AED 24, total AED 96). You have a saved Mastercard ending 1234 that qualifies for this offer — would you like to use it? Want me to apply one?";
          result.ui = { type: "offer", items: data.offers, meta: { guest: false, ticketCount: 2 } };
        }
        if (name === "get_recommendations") {
          for (const movie of data.movies ?? []) {
            movie.title = movie.filmTitle;
            movie.suggestedSession = movie.sessions?.[0];
            movie.sessions = undefined;
          }
          data.personalised = true;
          data.profile = {
            cinemaId: "0001",
            cinemaName: "Mall of the Emirates",
            seatPreference: "middle",
            preferredExperience: "Premier",
            weekday: { around: "19:00", sampleCount: 6 },
          };
        }
        if (name === "get_session_context") {
          const active = data.activeOrder;
          data.language = language;
          data.customer.id = data.customer.customerId;
          data.customer.profile.preferredExperience = data.customer.profile.experience;
          data.customer.savedCards = undefined;
          data.customer.customerId = undefined;
          data.customer.profile.experience = undefined;
          data.activeOrder =
            !active || active.status === "Paid"
              ? null
              : {
                  userSessionId: active.userSessionId,
                  sessionKey: active.sessionKey,
                  state: "active",
                  expiresAtUtc: active.expiresAtUtc,
                  requiresFreshHold: false,
                  summary: active,
                };
        }
        if (name === "find_booking" && data.booking) {
          data.bookings = [data.booking];
          data.booking = undefined;
        }
        if (name === "propose_booking") {
          const p = data.proposal;
          p.ticketQuantity = p.tickets == null ? null : p.tickets + (p.childTickets ?? 0);
          p.adultTickets = p.tickets ?? null;
          p.selectedSeats = p.seats ?? [];
          p.priceIncludesFees = true;
          p.tickets = undefined;
          p.seats = undefined;
        }
        if (name === "check_cancellation_eligibility" && typeof data.eligible === "boolean") {
          result.data = {
            booking: entry.parameter_conditions.some(
              (condition) =>
                condition.path === "bookingId" &&
                condition.eval.type === "exact" &&
                condition.eval.expected_value === "fixture_bank_booking",
            )
              ? bankBooking
              : booking,
            eligibility: {
              eligible: data.eligible,
              reasons: data.reason ? [data.reason] : [],
              amounts: { totalCents: data.amountCents ?? 0 },
              refundMethods: (data.permittedRefundMethods ?? []).map((method: string) => ({
                method,
                amountCents: data.amountCents,
                eta: method === "ORIGINAL_PAYMENT" ? "5–10 days" : "up to 30 minutes",
                ...(method === "VOX_CREDIT" ? { validityDays: 90 } : { cardLast4: "1234" }),
              })),
            },
          };
        }
        if (name === "prepare_cancellation" && data.confirmationId)
          result.data = {
            confirmationId: data.confirmationId,
            summary: {
              bookingId: data.booking.bookingId,
              filmTitle: data.booking.filmTitle,
              cinemaId: data.booking.cinemaId,
              showtime: data.booking.showtime,
              amountCents: data.amountCents,
              refundMethod: data.refundMethod,
              eta: data.eta,
              cardLast4: "1234",
            },
          };
        if (name === "prepare_payment" && data.needs === "payment_switch_confirmation") {
          result.data = {
            needs: data.needs,
            confirmationId: data.confirmationId,
            summary: {
              userSessionId: "fixture_order",
              currentTotalCents: data.oldTotalCents,
              totalAfterCents: data.newTotalCents,
              removedOfferIds: data.removedOfferIds,
              nextPaymentMethod: data.method,
              expectedTotalCents: data.newTotalCents,
              remove: true,
            },
          };
          const balance =
            data.method === "VOX_CREDIT"
              ? language === "ar"
                ? "رصيد فوكس"
                : "VOX credit"
              : language === "ar"
                ? "نقاط شير"
                : "SHARE Points";
          result.speech =
            language === "ar"
              ? `لا يمكن الجمع بين عرض البطاقة و${balance}. إزالة العرض تغيّر الإجمالي من 96 درهم إلى 120 درهم. هل أزيله وأغيّر طريقة الدفع؟`
              : `The bank-card offer cannot be used with ${balance}. Removing it changes the total from AED 96 to AED 120. Shall I remove it and switch?`;
          result.ui = {
            type: "payment_switch",
            items: [result.data.summary],
            meta: { confirmationId: data.confirmationId, userSessionId: "fixture_order" },
          };
        }
        if (name === "prepare_swap" && data.confirmationId)
          result.data = {
            confirmationId: data.confirmationId,
            summary: {
              bookingId: booking.bookingId,
              filmTitle: booking.filmTitle,
              fromShowtime: booking.showtime,
              targetSessionKey: "FIX_SWAP_SHOW",
              targetCinemaId: "0001",
              targetShowtime: "2030-06-04T19:05:00+04:00",
              targetExperience: "Premier",
              originalSeats: ["D8", "D9"],
              selectedSeats: seats.map((seat) => ({
                Row: seat.row,
                Number: seat.number,
                TicketTypeCode: "FIX_TICKET",
              })),
              ticketCount: 2,
              originalTotalCents: 12000,
              newTotalCents: 13000,
              differenceCents: 1000,
              chargeCents: 1000,
              refundCents: 0,
              settlementType: "difference_only",
              paymentMethod: "CARD",
              cardLast4: "1234",
            },
          };
        if (name === "investigate_payment") {
          data.bookings = data.booking ? [data.booking] : [];
          data.bookingFound = data.bookings.length > 0;
          data.bankDebitVerified = false;
          data.paymentRecordFound = data.bookingFound;
          data.retryPaymentAllowed = false;
          data.reportedTransactionReference = data.evidence?.transactionReference ?? null;
          data.reportedCardLast4 = data.evidence?.cardLast4 ?? null;
          data.transactionReferenceVerified = false;
          data.booking = undefined;
        }
        return { ...entry, mock_result: JSON.stringify(result) };
      }),
    ]),
  );
}
