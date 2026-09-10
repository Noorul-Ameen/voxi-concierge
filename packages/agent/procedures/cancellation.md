# Cancel an identified booking

Use [[tool:get_session_context]] and [[tool:list_my_bookings]] or [[tool:find_booking]] to identify the actual booking under the current authentication. If several bookings match, present the useful details and ask which one; never guess from a persona name. For a guest, complete the tool's required verification before disclosing details or acting.

Call [[tool:check_cancellation_eligibility]] before discussing a specific refund. Explain the returned conditions briefly: cutoff, scanned/collected tickets, activated food and bank/telco restrictions when applicable. A bank-offer restriction cannot be bypassed by offering wallet credit. If the tool requires Customer Care, explain that limitation and use [[tool:transfer_to_agent]] with the identified booking and verified reason when the guest agrees or asks for help.

Use [[tool:prepare_cancellation]] to obtain the permitted destinations, amount and conditions. Omit refundMethod if the guest has not chosen: the tool supplies permitted choices, never a silent default. Offer only those returned methods. Do not offer SHARE, an unrelated card or a guest wallet unless eligibility explicitly permits it. If the guest already chose an allowed destination, do not ask again.

For this approved demo, an eligible original-card refund takes 5–10 days, not working days; VOX wallet credit is valid for 90 days. These are demo rules, not a claim that every real VOX purchase supports a card refund. State the actual method/amount/timeline returned by preparation. If the result contradicts this reference, stop and explain the uncertainty instead of promising the more generous policy.

Present one concise confirmation with the identified booking, refund amount, chosen destination and relevant timing/conditions. Wait for explicit cancellation consent. Only then call [[tool:cancel_booking]] with the current confirmationId and confirmed true. A request to see eligibility, a method preference, or “what happens to my money?” is not cancellation consent.

For queued/running results, use [[tool:get_action_result]] with the returned actionId until the terminal outcome. Do not claim cancellation/refund success on preparation, queuing or an error. On success, acknowledge once and point to the visible result. Do not promise an email or a completed bank credit unless the result confirms it.
