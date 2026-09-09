type FunnelAction = {
  conversationId: string;
  type: string;
  status: string;
  result: Record<string, unknown> | null;
};
type FunnelConversation = { id: string; journeys: { name: string }[] | null };

/** Count completed booking milestones for both guided and one-call booking paths. */
export function bookingFunnel(actions: FunnelAction[], conversations: FunnelConversation[]) {
  const started = new Set<string>();
  const tickets = new Set<string>();
  const seats = new Set<string>();
  const paid = new Set<string>();
  const orderSteps = new Set([
    "start_order",
    "add_tickets",
    "select_seats",
    "add_concessions",
    "apply_offer",
    "pay_order",
  ]);
  for (const action of actions) {
    if (action.status !== "succeeded") continue;
    if (orderSteps.has(action.type)) started.add(action.conversationId);
    if (action.type === "add_tickets") tickets.add(action.conversationId);
    if (action.type === "select_seats") seats.add(action.conversationId);
    if (action.type === "pay_order") paid.add(action.conversationId);
    if (["quick_book", "recover_order"].includes(action.type)) {
      const result = action.result?.toolResult as
        | { ok?: boolean; data?: { order?: { tickets?: unknown[]; seatsAllocated?: boolean } } }
        | undefined;
      const order = result?.data?.order;
      if (result?.ok && order?.tickets?.length) {
        started.add(action.conversationId);
        tickets.add(action.conversationId);
        if (order.seatsAllocated) seats.add(action.conversationId);
      }
    }
  }
  for (const conversation of conversations)
    if (conversation.journeys?.some((journey) => journey.name === "guided_booking"))
      started.add(conversation.id);
  return [
    { step: "Booking started", n: started.size },
    { step: "Tickets added", n: tickets.size },
    { step: "Seats chosen", n: seats.size },
    { step: "Paid", n: paid.size },
  ];
}
