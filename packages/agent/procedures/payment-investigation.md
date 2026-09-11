# Card debited but no booking, missing confirmation or uncertain payment

Acknowledge the concern briefly. Never ask the guest to pay again, create a replacement order, or start cancellation merely because a debit was reported.

Use [[tool:get_session_context]] and [[tool:investigate_payment]] to check the current order, known booking/payment result and verified customer records first. Pass only an existing tool-returned bookingId/userSessionId or omit them for the current context. A guest-reported debit is a claim until matched; do not state that the backend confirmed a charge when it did not. For verification_required, request only the indicated verification through the supported secure path. Do not disclose another customer's result.

For needs booking_selection, the returned candidateBookings are the customer's existing bookings, not a confirmed match to the reported debit. Show the concise identifying details and ask which one, or whether none matches; after the guest selects one, call [[tool:investigate_payment]] with that returned bookingId. Never pick a candidate automatically.

For status found, show the matching booking's film, cinema, date/time and reference and ask one short question: is this the booking they meant? Skip that question if the guest already explicitly selected this exact booking. If confirmed, use the verified receipt/QR and finish. A found booking is a possible match, not permission to dismiss a reported different debit. A newly supplied transaction reference must be checked in a new investigation; do not reuse a previously rejected booking as proof that a different debit is resolved.

If the guest says the found booking is not theirs/the intended purchase, preserve that rejection in the handover context. If no match exists, use the returned requirements to collect the transaction reference and last four digits only when needed; never request a full card number, BIN, CVV, OTP, password or bank screenshot. Call [[tool:investigate_payment]] again with exactly the provided information. Never invent a reference or card ending.

For processing, failed or unresolved, state that precise status without claiming the bank settled or refunded money. An uncertain status must not trigger another payment. If tools cannot resolve it, or the guest requests a person, use [[tool:transfer_to_agent]] with the returned investigationId and a concise summary: reported problem, identified/rejected matches, verified status, order/booking evidence, supplied transaction reference and masked last four when necessary. Distinguish guest-reported information from system-confirmed facts; do not embellish financial evidence.

Claim human connection only when the transfer result confirms it. Do not promise a bank reversal, callback, email or response deadline absent from the result. Keep this investigation separate from the cancellation procedure and from unpaid booking discovery.
