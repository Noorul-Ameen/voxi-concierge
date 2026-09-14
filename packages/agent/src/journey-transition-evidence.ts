import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import type { SimulationDefinition } from "./simulations.js";

type EvidenceTurn = {
  role?: string;
  message?: string | null;
  tool_calls?: {
    request_id?: string;
    tool_name?: string;
    params_as_json?: unknown;
    tool_has_been_called?: boolean;
  }[];
  tool_results?: {
    request_id?: string;
    tool_name?: string;
    result_value?: unknown;
    is_error?: boolean;
    is_blocked?: boolean;
    tool_has_been_called?: boolean;
  }[];
};
const object = (input: unknown): Record<string, any> | undefined => {
  try {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};
const external = new Set([...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)]);
const words = (message: string | null | undefined) =>
  (message ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Mechanical boundaries only, not a natural-language quality grader.
 * The complete provider transcript includes authored history, which never counts as generated success.
 * A later user rescue cannot satisfy a missing first-response tool transition.
 */
export function auditJourneyTransitionEvidence(
  test: Pick<SimulationDefinition, "id" | "chat_history">,
  transcript: EvidenceTurn[],
): string[] {
  if (
    !/^transition-(enquiry-plan|film-only-edit|named-rating-age|rating-definition|identify-booking|single-booking|swap-refund-choice|offer-snacks|offer-information)-(en|ar)$/.test(
      test.id,
    )
  )
    throw new Error("Unsupported transition evidence case");
  // Only these fixed-trigger cases seed the current user request. No authored
  // agent/tool response is included as evidence of a generated transition.
  const finalAuthored = object(test.chat_history.at(-1));
  const fixedTrigger =
    /transition-(enquiry-plan|film-only-edit|swap-refund-choice)-(en|ar)$/.test(test.id) &&
    finalAuthored?.role === "user" &&
    typeof finalAuthored.message === "string" &&
    finalAuthored.message.trim();
  const configuredGreeting =
    test.id.includes("rating-definition") &&
    test.chat_history.length === 0 &&
    transcript[0]?.role === "agent" &&
    !!transcript[0].message?.trim() &&
    !transcript[0].tool_calls?.length &&
    !transcript[0].tool_results?.length &&
    transcript[1]?.role === "user";
  const start = test.chat_history.length - (fixedTrigger ? 1 : 0) + (configuredGreeting ? 1 : 0);
  const turns = transcript.slice(start);
  const findings: string[] = [];
  if (turns[0]?.role !== "user" || !turns[0]?.message?.trim())
    return ["Missing generated first user turn after the exact authored-history boundary."];
  if (fixedTrigger && turns[1]?.role !== "agent")
    findings.push("Fixed current-user trigger requires the first generated turn to be agent.");
  const reply = turns.findIndex((turn) => turn.role === "agent" && turn.message?.trim());
  if (reply < 0) findings.push("No generated first spoken response.");
  const nextUser = turns.findIndex((turn, index) => index > 0 && turn.role === "user");
  const boundary = Math.min(reply < 0 ? turns.length : reply, nextUser < 0 ? turns.length : nextUser);
  const calls: { index: number; requestId: string; name: string; args: Record<string, any> }[] = [];
  const results: { index: number; requestId: string; name: string; value: Record<string, any> }[] = [];
  for (const [index, turn] of turns.entries()) {
    for (const call of turn.tool_calls ?? []) {
      const args = object(call.params_as_json);
      if (
        turn.role !== "agent" ||
        !call.request_id ||
        !call.tool_name ||
        !args ||
        call.tool_has_been_called === false
      ) {
        findings.push(`Turn ${start + index}: malformed or unexecuted call evidence.`);
        continue;
      }
      if (
        !external.has(call.tool_name) &&
        !["start_procedure", "end_procedure", "skip_turn"].includes(call.tool_name)
      )
        findings.push(`Turn ${start + index}: unknown tool cannot establish evidence.`);
      calls.push({ index, requestId: call.request_id, name: call.tool_name, args });
    }
    for (const result of turn.tool_results ?? []) {
      const value = object(result.result_value);
      if (
        turn.role !== "agent" ||
        !result.request_id ||
        !result.tool_name ||
        !value ||
        result.is_error ||
        result.is_blocked ||
        result.tool_has_been_called === false
      ) {
        findings.push(`Turn ${start + index}: failed, blocked, unexecuted or malformed result evidence.`);
        continue;
      }
      if (
        !calls.some(
          (c) => c.requestId === result.request_id && c.name === result.tool_name && c.index < index,
        )
      ) {
        findings.push(`Turn ${start + index}: result has no preceding matching request ID and tool.`);
        continue;
      }
      results.push({ index, requestId: result.request_id, name: result.tool_name, value });
    }
  }
  const succeeded = (name: string, before = boundary) =>
    results.filter(
      (r) =>
        r.name === name &&
        r.index < before &&
        r.value.ok === true &&
        calls.some((c) => c.requestId === r.requestId && c.name === name && c.index < r.index),
    );
  const forbidden = (allowed: string[]) => {
    for (const call of calls)
      if (external.has(call.name) && !allowed.includes(call.name))
        findings.push(`Turn ${start + call.index}: ${call.name} is not authorized in this boundary case.`);
  };
  if (test.id.includes("enquiry-plan") || test.id.includes("film-only-edit")) {
    forbidden(["get_session_context", "get_film", "search_films", "get_age_rules", "propose_booking"]);
    const entry = results.find(
      (r) =>
        r.name === "start_procedure" &&
        r.index < boundary &&
        r.value.result_type === "start_procedure_success" &&
        r.value.status === "success" &&
        r.value.procedure_name === "VOX · Discover and book" &&
        calls.some((c) => c.requestId === r.requestId && c.name === "start_procedure" && c.index < r.index),
    );
    if (
      !entry ||
      calls.some((c) => external.has(c.name) && c.name !== "get_session_context" && c.index < entry.index)
    )
      findings.push("Booking Procedure was not entered before the first plan response.");
    const proposal = succeeded("propose_booking").find((r) => {
      const p = r.value.data?.proposal;
      return (
        p?.held === false &&
        p.adultTickets === 1 &&
        p.childTickets === 1 &&
        p.ticketQuantity === 2 &&
        p.sessionKey &&
        p.filmTitle &&
        p.cinemaId &&
        p.showtime &&
        p.selectedSeats?.length === 2 &&
        typeof p.totalCents === "number" &&
        r.value.data?.proposalToken &&
        r.value.data?.proposalRef &&
        r.value.data.admission?.verified === true &&
        r.value.data.admission.rating === "PG13" &&
        r.value.data.admission.experience === p.experience &&
        JSON.stringify(r.value.data.admission.childAges) === "[7]" &&
        r.value.data.admission.children?.length === 1 &&
        r.value.data.admission.children[0].checkedChildAge === 7 &&
        r.value.data.admission.children[0].allowed === true
      );
    });
    if (!proposal)
      findings.push("Missing complete successful family proposal before the first spoken response.");
    const proposalCall =
      proposal && calls.find((c) => c.requestId === proposal.requestId && c.name === "propose_booking");
    const beforeProposal = proposalCall?.index ?? boundary;
    // Authored data supplies only the expected date, never evidence of a new success.
    // The caller separately verifies the complete authored prefix before this audit.
    let priorProposalDate: string | undefined;
    let priorProposalRef: string | undefined;
    if (test.id.includes("film-only-edit"))
      for (let i = test.chat_history.length - 1; i >= 0 && !priorProposalDate; i--) {
        const authored = object(test.chat_history[i]);
        for (const result of authored?.tool_results ?? []) {
          const value = object(result.result_value);
          const date = value?.data?.proposal?.showtime?.slice(0, 10);
          if (
            authored?.role === "agent" &&
            result.tool_name === "propose_booking" &&
            result.request_id &&
            !result.is_error &&
            value?.ok === true &&
            typeof date === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(date) &&
            value.data.proposal.showtime?.startsWith(`${date}T`) &&
            test.chat_history
              .slice(0, i)
              .some((turn) =>
                object(turn)?.tool_calls?.some(
                  (call: Record<string, unknown>) =>
                    call.tool_name === "propose_booking" && call.request_id === result.request_id,
                ),
              )
          ) {
            priorProposalDate = date;
            priorProposalRef = value.data.proposalRef;
          }
        }
      }
    const args = proposalCall?.args;
    if (
      test.id.includes("enquiry-plan") &&
      (!args ||
        args.intent !== "initial" ||
        args.baseProposalRef !== undefined ||
        args.tickets !== 1 ||
        args.childTickets !== 1 ||
        JSON.stringify(args.childAges) !== "[7]")
    )
      findings.push(
        "Initial family proposal requires explicit initial intent and the supplied age7, not inferred admission.",
      );
    if (test.id.includes("film-only-edit")) {
      const p = proposal?.value.data?.proposal;
      const optional = (key: string, expected: unknown) =>
        args?.[key] === undefined || args[key] === expected;
      if (
        (!succeeded("get_film", beforeProposal).length &&
          !succeeded("search_films", beforeProposal).length) ||
        !args ||
        args.intent !== "edit" ||
        !priorProposalRef ||
        args.baseProposalRef !== priorProposalRef ||
        !proposal ||
        proposal.value.data.proposalRef === priorProposalRef ||
        !optional("cinemaId", "0002") ||
        !optional("time", "18:45") ||
        !optional("experience", "Premier") ||
        !optional("tickets", 1) ||
        !optional("childTickets", 1) ||
        (args.childAges !== undefined && JSON.stringify(args.childAges) !== "[7]") ||
        (args.date !== undefined && args.date !== "tomorrow" && args.date !== priorProposalDate) ||
        p?.cinemaId !== "0002" ||
        p?.experience !== "Premier" ||
        p?.showtime?.slice(0, 10) !== priorProposalDate ||
        !p?.showtime?.endsWith("T18:30:00+04:00") ||
        p?.requested?.time !== "18:45"
      )
        findings.push(
          "Film-only change must use the exact current edit reference and new verified admission, and preserve prior proposal choices before speaking.",
        );
    }
  } else if (test.id.includes("offer-snacks")) {
    forbidden(["apply_offer", "get_action_result", "suggest_fnb"]);
    const queued = succeeded("apply_offer").find((r) => r.value.data?.action?.status === "queued");
    const completion =
      queued &&
      succeeded("get_action_result").find(
        (r) =>
          r.index > queued.index &&
          r.value.data?.action?.status === "succeeded" &&
          r.value.data.action.actionId === queued.value.data.action.actionId &&
          calls.some(
            (c) =>
              c.name === "get_action_result" &&
              c.index > queued.index &&
              c.index < r.index &&
              c.args.actionId === queued.value.data.action.actionId,
          ),
      );
    const enriched = completion?.value.data?.result?.snackSuggestions;
    const ready =
      enriched?.status === "ready" &&
      enriched.purchaseRequiresConsent === true &&
      enriched.cinemaId === "0001" &&
      typeof enriched.checkedAtUtc === "string" &&
      Array.isArray(enriched.items) &&
      enriched.items.length > 0 &&
      enriched.items.every(
        (item: any) => item.itemId && (item.name || item.nameEn) && Number.isInteger(item.priceCents),
      ) &&
      Array.isArray(enriched.usual) &&
      enriched.usual.every(
        (item: any) =>
          Number.isInteger(item.quantity) &&
          item.quantity > 0 &&
          enriched.items.some((menu: any) => menu.itemId === item.itemId),
      );
    const menu =
      completion &&
      succeeded("suggest_fnb").find(
        (r) =>
          r.index > completion.index && Array.isArray(r.value.data?.items) && r.value.data.items.length > 0,
      );
    if (enriched?.status === "ready" && calls.some((c) => c.name === "suggest_fnb"))
      findings.push("Already verified ready snack facts must not trigger a duplicate menu lookup.");
    if (!queued || !completion || (!ready && !menu))
      findings.push(
        "First response must follow exact queued offer completion with verified ready snack facts or an appropriate successful menu lookup; later user prompts cannot supply this step.",
      );
  } else if (test.id.includes("single-booking")) {
    forbidden(["get_session_context", "list_my_bookings"]);
    if (
      !succeeded("list_my_bookings").some(
        (r) => r.value.data?.bookings?.length === 1 && r.value.data.bookings[0]?.verified === true,
      )
    )
      findings.push(
        "Exactly one verified owned booking must be read before the first identity-confirmation response.",
      );
  } else if (test.id.includes("identify-booking") || test.id.includes("offer-information")) {
    forbidden([]);
  } else if (test.id.includes("swap-refund-choice")) {
    forbidden(["get_session_context", "prepare_swap"]);
    const choice = succeeded("prepare_swap").find(
      (r) =>
        r.value.data?.needs === "swap_refund_method" &&
        !r.value.data.confirmationId &&
        r.value.data.summary?.refundMethodSelected === false &&
        !r.value.data.summary.refundMethod &&
        r.value.data.refundMethods?.length === 2,
    );
    if (!choice)
      findings.push(
        "First preview must expose refund-method choice without a selected method or confirmation.",
      );
    const acceptedAt = turns.findIndex(
      (t) =>
        t.role === "user" &&
        /^(?:(?:vox wallet credit|wallet credit|vox credit)(?: please)?|رصيد محفظة فوكس(?: من فضلك)?)$/u.test(
          words(t.message),
        ),
    );
    for (const call of calls)
      if (
        call.name === "prepare_swap" &&
        call.args.refundMethodForDifference !== undefined &&
        (acceptedAt < 0 ||
          call.index < acceptedAt ||
          call.args.refundMethodForDifference !== "VOX_CREDIT" ||
          !choice ||
          call.args.bookingId !== choice.value.data.bookingId ||
          call.args.targetSessionKey !== choice.value.data.targetSessionKey)
      )
        findings.push(
          "Refund method requires a preceding explicit wallet choice and the exact preview booking/target.",
        );
    if (acceptedAt >= 0) {
      const response = turns.findIndex((t, i) => i > acceptedAt && t.role === "agent" && !!t.message?.trim());
      if (
        !succeeded("prepare_swap", response < 0 ? turns.length : response).some(
          (r) =>
            r.index > acceptedAt &&
            r.value.data?.confirmationId &&
            r.value.data.summary?.refundMethodSelected === true &&
            r.value.data.summary.refundMethod === "VOX_CREDIT",
        )
      )
        findings.push(
          "Wallet choice needs a successful new confirmation preview before exchange-consent speech.",
        );
    }
  } else if (test.id.includes("rating-definition")) {
    forbidden(["get_age_rules"]);
    if (calls.some((c) => c.name === "get_age_rules" && c.args.childAge !== undefined))
      findings.push("A general information-only rating definition supplied no child age.");
  } else {
    forbidden(["get_session_context", "get_film", "search_films", "get_age_rules"]);
    if (!succeeded("get_film").length && !succeeded("search_films").length)
      findings.push("No successful named-film lookup before the first rating answer.");
    const ageTurn = turns.findIndex(
      (t) =>
        t.role === "user" &&
        /^(?:(?:he is|he s|my son is) 7(?: years old)?|عمره (?:7|٧)(?: سنوات)?)$/u.test(words(t.message)),
    );
    for (const call of calls)
      if (
        call.name === "get_age_rules" &&
        call.args.childAge !== undefined &&
        (ageTurn < 0 || call.index < ageTurn || call.args.childAge !== 7)
      )
        findings.push(
          "Child age must come from the preceding generated user, not a future/absent fixture reply.",
        );
    if (ageTurn >= 0) {
      const answer = turns.findIndex((t, i) => i > ageTurn && t.role === "agent" && !!t.message?.trim());
      if (
        !succeeded("get_age_rules", answer < 0 ? turns.length : answer).some(
          (r) =>
            r.index > ageTurn &&
            r.value.data?.allowed === true &&
            calls.some(
              (c) =>
                c.name === "get_age_rules" &&
                c.index > ageTurn &&
                c.index < r.index &&
                c.args.rating === "PG13" &&
                c.args.childAge === 7,
            ),
        )
      )
        findings.push("Missing successful exact age7/PG13 check before the subsequent admission answer.");
    }
  }
  return findings;
}
