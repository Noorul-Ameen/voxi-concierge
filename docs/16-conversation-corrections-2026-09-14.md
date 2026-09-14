# Conversation corrections — 14 September 2026

This change follows the complete customer-scenario review in document 15. Provider simulation grades are checked against their actual transcripts; a passing score alone is not acceptance.

## Customer-facing changes

- A guest can name an area in English or Arabic without sharing GPS or signing in. The same 21 areas already offered by the location picker supply the coordinates. Explicit areas override old shared location; unknown areas require clarification. Distances are approximate straight-line distances from an area, not a home address or driving time.
- A request to move a paid booking can proceed from the closest matching show to its actual seat/price preview without asking the already-known time again. This remains read-only preparation: the final exchange and any payment still need the existing confirmation. The original cinema and film remain the defaults.
- The widget and agent tests now share the actual draft-selection acknowledgement envelope. Selecting a card means selected, not paid or confirmed. A paid event uses the real action-result fields rather than an invented receipt field.
- The linked reference site's existing cinema and movie selectors read the public catalogue through the shared embed. This applies only to `voxi.kris-pradip.workers.dev`. It preserves selector elements, selected values, original handlers and page login. A network failure preserves the existing options. The host's private source and its own showtime/booking handler are not modified by this adapter.

## Agent guidance

The core prompt, existing free-form Procedures and tool descriptions reinforce complete unheld proposals, child-age checks, exact lookup constraints, truthful dates/status, brief acknowledgements and payment consent. A stop or goodbye must not trigger another display/search. Email delivery remains unknown in either direction without a delivery result. Unsupported areas must not be shortened or replaced with guessed nearby cinemas.

For a specific named film, the agent uses the film lookup tools: `get_recommendations` does not accept title/query filters. A complete suggestion requires `propose_booking` before its acceptance question. Pricing, tickets, seats and availability continue to come from the backend.

The existing four Procedures are retained. Research and traces do not establish that changing workflow architecture or voice/model settings would fix the observed errors. Those settings are preserved while the authored guidance is tested on an isolated branch.

## Validation and release boundary

Local checks cover named-area matching and rejection, read-only swap continuation (including an omitted date), widget event fidelity, and safe selector refresh. Strict native fixtures deny unexpected tools and preserve financial/refusal checks. Six area cases supplement the existing 68 English/Arabic scenarios.

At the final source checkpoint, all **725 tests across 69 test files**, the complete application build and workspace typecheck passed. Repository lint passed with the existing 231 warnings. Known-credential scanning found no matches in the proposed changes. The first rerun stopped on an outdated text assertion for the QR description; the assertion was updated to check the revised wording and explicit request/stop constraints, then the entire suite passed.

The first focused candidate exposed remaining conversation failures and fixtures whose inputs did not match the live tools or widget; their original grades and transcripts are retained in the workspace release evidence. The corrected candidate requires a new run and manual review before promotion. Code deployment is not evidence that the live agent has been promoted or every conversation has passed.

The corrected nine-case candidate run had eight provider passes and one overstrict area-distance grade. Manual review confirmed the core proposal, consent, area and paid-acknowledgement gates, while retaining Arabic wording and repetition limitations. The simulated email follow-up varied, so two additional fixed-history probes explicitly test correction of an unsupported “not emailed” inference together with a stop request. Full-suite and hosted-release acceptance are recorded separately after execution.

Updated showtime source data is preserved. Named customer bookings and balances must not be reset to fit an older demo script. Hosted checks must report the current data and distinguish real public schedule captures from synthetic demo sessions. Demo payment and support integrations remain simulated.

Browser checks can verify connection and microphone-mute state, but cannot independently certify audible speech or recognition accuracy. The user previously confirmed hearing English and Arabic output while microphone input was muted.
