export type HumanMode = { transferId: string; agentName?: string; status: string };
type TransferState = { conversation: Record<string, unknown>; transfer?: Record<string, unknown> };

/** Only the current authenticated server state can authorize a handover display. */
export async function applyVerifiedHumanMode(
  request: { mode: "bot" | "human"; transferId?: string },
  conversationId: string,
  load: () => Promise<TransferState>,
  apply: (value: HumanMode | null) => void,
  isCurrent: () => boolean,
  hasEnded: (id: string) => boolean,
) {
  const fail = () => ({ ok: false, error: "No matching current conversation handover was verified." });
  if (!isCurrent() || !["human", "bot"].includes(request.mode)) return fail();
  if (request.mode === "human" && (!request.transferId || hasEnded(request.transferId))) return fail();
  try {
    const state = await load();
    if (!isCurrent() || state.conversation.id !== conversationId) return fail();
    const transfer = state.transfer;
    const active = transfer && typeof transfer.id === "string" && typeof transfer.status === "string"
      && ["requested", "queued", "connected"].includes(transfer.status) && !hasEnded(transfer.id);
    if (request.mode === "bot") {
      if (active) return fail();
      apply(null);
    } else {
      if (!active || transfer.id !== request.transferId) return fail();
      apply({ transferId: transfer.id as string, status: transfer.status as string,
        ...(typeof transfer.agentName === "string" ? { agentName: transfer.agentName } : {}) });
    }
    return { ok: true };
  } catch { return fail(); }
}
