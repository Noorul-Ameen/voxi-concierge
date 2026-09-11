import { assessResponse } from "./coaching.js";

type Turn = {
  role?: string;
  message?: string | null;
  tool_calls?: Record<string, unknown>[];
  calls?: Record<string, unknown>[];
  tool_results?: Record<string, unknown>[];
  results?: Record<string, unknown>[];
};
type Evidence = { name: string; transcript: Turn[] };
const parse = (value: unknown): Record<string, any> => {
  if (typeof value === "string") {
    try {
      return parse(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
};
const positiveConsent = /(?:yes,? (?:apply|remove|cancel|change)|نعم[،,]? (?:طبقي|احذفي|ألغي|غيري))/iu;

/** Bounded independent audit for the authored journeys, not a general intent classifier. */
export function auditJourneyEvidence(test: Evidence): string[] {
  const scenario =
    /\bJourney (\d{2})-(positive|negative)-(en|ar)(?:-(accept|age|after-removal|render-failure|offer-error))?\b/.exec(
      test.name,
    );
  if (!scenario) return [];
  const [, group, path, language, variant] = scenario;
  const findings: string[] = [];
  let latestUser = "";
  let userIndex = -1;
  let investigated = false;
  let eligibility = false;
  let proposalSeen = false;
  let receiptSeen = false;
  let applyIndex = -1;
  let prepareIndex = -1;
  const confirmations = new Map<string, number>();
  const proposals = new Map<string, number>();
  const investigations = new Set<string>();
  const menuItems = new Set<string>();
  const orderIds = new Set<string>();
  const offerIds = new Set<string>();
  const pendingActionIds = new Set<string>();
  const filmRatings = new Set<string>();
  const rememberOrderIds = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(rememberOrderIds);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "userSessionId" && typeof child === "string") orderIds.add(child);
      else if (key === "offerId" && typeof child === "string") offerIds.add(child);
      else rememberOrderIds(child);
    }
  };
  const allMessages: string[] = [];
  const rememberItems = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(rememberItems);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "itemId" && typeof child === "string") menuItems.add(child);
      else rememberItems(child);
    }
  };
  for (const [index, turn] of test.transcript.entries()) {
    if (turn.role === "user" && turn.message) {
      latestUser = turn.message;
      userIndex = index;
    }
    for (const raw of turn.calls ?? turn.tool_calls ?? []) {
      const name = String(raw.name ?? raw.tool_name ?? "");
      const args = parse(raw.arguments ?? raw.params_as_json);
      if (typeof args.offerId === "string" && !offerIds.has(args.offerId))
        findings.push(
          `Turn ${index}: ${name} used an offer identifier absent from preceding verified results.`,
        );
      if (name === "get_action_result" && !pendingActionIds.has(args.actionId))
        findings.push(`Turn ${index}: action polling used no preceding verified pending actionId.`);
      if (name === "get_age_rules" && !filmRatings.has(args.rating))
        findings.push(`Turn ${index}: age check used a rating absent from preceding film evidence.`);
      if (name === "log_journey" && ["booking", "payment"].includes(args.journey))
        findings.push(
          `Turn ${index}: unnecessary transactional completion logging; backend owns this state.`,
        );
      if (name === "investigate_payment" && args.cardLast4 !== undefined && !/^\d{4}$/.test(args.cardLast4))
        findings.push(`Turn ${index}: investigation supplied invalid card last four digits.`);
      if (typeof args.userSessionId === "string" && !orderIds.has(args.userSessionId))
        findings.push(
          `Turn ${index}: ${name} used an order identifier absent from preceding verified results.`,
        );
      if (name === "pay_order")
        findings.push(`Turn ${index}: simulated journey attempted payment; no fixture authorizes pay_order.`);
      if (group === "01" && name !== "skip_turn")
        findings.push(`Turn ${index}: answer/pause-only journey invoked ${name}.`);
      if (
        group === "02" &&
        variant !== "accept" &&
        ["quick_book", "start_order", "add_tickets", "select_seats", "recover_order"].includes(name)
      )
        findings.push(`Turn ${index}: recommendation became a hold without acceptance.`);
      if (
        name === "quick_book" &&
        group === "02" &&
        (!args.proposalToken ||
          !proposals.has(args.proposalToken) ||
          userIndex <= proposals.get(args.proposalToken)! ||
          !/(?:yes,? hold|نعم[،,]? احجزي)/iu.test(latestUser))
      )
        findings.push(`Turn ${index}: proposal acceptance did not follow the current verified token.`);
      if (["apply_offer", "cancel_booking", "swap_booking"].includes(name)) {
        if (!positiveConsent.test(latestUser))
          findings.push(`Turn ${index}: ${name} has no explicit fixture consent.`);
        if (
          args.confirmationId &&
          (!confirmations.has(args.confirmationId) || userIndex <= confirmations.get(args.confirmationId)!)
        )
          findings.push(`Turn ${index}: ${name} used unverified or pre-consent confirmation.`);
        if (
          (group === "03" || group === "04" || group === "08") &&
          path === "negative" &&
          variant !== "offer-error"
        )
          findings.push(`Turn ${index}: mutation followed the fixture refusal.`);
      }
      if (group === "06" && name === "prepare_cancellation" && !eligibility)
        findings.push(`Turn ${index}: cancellation prepared before eligibility.`);
      if (name === "order_fnb" || name === "add_concessions") {
        if (Array.isArray(args.items) && args.items.some((item: any) => !menuItems.has(item.itemId)))
          findings.push(`Turn ${index}: food uses an item without a preceding menu/suggestion.`);
        if (group === "03" && applyIndex < 0)
          findings.push(`Turn ${index}: snacks changed before the agreed offer completed.`);
      }
      if (group === "03" && name === "suggest_fnb" && applyIndex < 0)
        findings.push(`Turn ${index}: snack pitch preceded the saved-card offer decision.`);
      if (group === "07" && name === "transfer_to_agent") {
        if (!investigated || !investigations.has(args.investigationId))
          findings.push(`Turn ${index}: handover lacks verified investigation context.`);
        if (path === "positive") findings.push(`Turn ${index}: matched booking unnecessarily handed over.`);
      }
      if (group === "08" && name === "search_sessions" && args.cinemaId !== "0001")
        findings.push(`Turn ${index}: swap search abandoned the original cinema.`);
      if (group === "08" && ["quick_book", "cancel_booking", "start_order", "pay_order"].includes(name))
        findings.push(`Turn ${index}: swap used a replacement purchase/cancellation workaround.`);
      if (name === "prepare_payment") prepareIndex = index;
    }
    for (const raw of turn.results ?? turn.tool_results ?? []) {
      const name = String(raw.name ?? raw.tool_name ?? "");
      const value = parse(raw.value ?? raw.result ?? raw.result_value);
      if (value.ok !== true || raw.is_error || raw.is_blocked || raw.tool_has_been_called === false) continue;
      rememberOrderIds(value);
      const data = parse(value.data);
      if (data.action?.actionId) {
        if (["queued", "running"].includes(data.action.status)) pendingActionIds.add(data.action.actionId);
        else pendingActionIds.delete(data.action.actionId);
      }
      if (["get_film", "search_films", "get_recommendations"].includes(name)) {
        const films = [...(data.films ?? []), ...(data.movies ?? []), ...(data.film ? [data.film] : [])];
        for (const film of films) if (typeof film.rating === "string") filmRatings.add(film.rating);
      }
      if (name === "propose_booking") {
        proposalSeen = true;
        if (data.proposalToken) proposals.set(data.proposalToken, index);
      }
      if (["prepare_cancellation", "prepare_swap", "prepare_payment"].includes(name) && data.confirmationId)
        confirmations.set(data.confirmationId, index);
      if (name === "check_cancellation_eligibility") eligibility = data.eligibility?.eligible === true;
      if (name === "apply_offer" && !["queued", "running"].includes(data.action?.status)) applyIndex = index;
      if (
        name === "get_action_result" &&
        data.action?.status === "succeeded" &&
        data.action?.type === "apply_offer"
      )
        applyIndex = index;
      if (name === "investigate_payment") {
        investigated = true;
        if (data.investigationId) investigations.add(data.investigationId);
      }
      if (["suggest_fnb", "browse_menu"].includes(name)) rememberItems(data);
      if (value.ui?.type === "receipt" || data.receipt || (value.rendered === true && value.receipt))
        receiptSeen = true;
    }
    if (turn.role === "agent" && turn.message) {
      allMessages.push(turn.message);
      if (group === "01") {
        const flags = assessResponse({
          text: turn.message,
          modality: "voice",
          answerOnly: userIndex >= 0,
        }).flags;
        for (const flag of flags) findings.push(`Turn ${index}: concise answer violation (${flag}).`);
      }
      if (/5\s*[–-]\s*10\s+working\s+days|خمسة.*عشرة.*أيام عمل/iu.test(turn.message))
        findings.push(`Turn ${index}: refund ETA changed from approved days to working days.`);
      if (
        /(?:emailed|email (?:was|has been) sent|sent (?:your|the) tickets? (?:by|to).*email|أرسلنا.*البريد|تم إرسال.*البريد)/iu.test(
          turn.message,
        )
      )
        findings.push(`Turn ${index}: email delivery claim has no configured evidence.`);
    }
  }
  if (group === "02" && variant !== "age" && !proposalSeen)
    findings.push("No successful read-only complete proposal was shown.");
  if (group === "01" && (!allMessages.length || userIndex < 0))
    findings.push("No actual user/assistant answer evidence was provided.");
  if (group === "05" && path === "positive" && !receiptSeen)
    findings.push("No verified receipt/QR result was shown.");
  if (group === "07" && !investigated) findings.push("No successful payment investigation occurred.");
  if (group === "03" && path === "positive" && prepareIndex >= 0 && applyIndex < 0)
    findings.push("Payment review has no completed agreed offer.");
  if (
    language === "ar" &&
    allMessages.length &&
    !allMessages.some((message) => /[\u0600-\u06ff]/u.test(message))
  )
    findings.push("Arabic fixture has no Arabic assistant response.");
  return findings;
}
