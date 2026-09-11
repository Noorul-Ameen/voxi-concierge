# Premium concierge journeys

Implementation checkpoint: 11 September 2026. This combines the approved conversation, widget and page-account plans. Release and voice acceptance must be recorded separately from local test results.

## Customer experience

- The native page follows the linked VOX reference layout and retains the blue, white and charcoal theme. Both entry points use the shared widget.
- Account entry belongs to the page. The linked site's page form uses verified email/password authentication; the widget shows a minimal signed-in status. Credentials are never sent to the agent. Account switching clears previous profile/history and conversation content.
- Microphone mute controls input only. Assistant output is independent.
- A complete movie/cinema/experience/show/seat proposal is read-only until accepted. Unknown ticket quantity is requested once. An accepted proposal is bound to the account and retries reuse its existing hold without extending its deadline.
- Eligible saved-card offers require consent. Card offers cannot combine with VOX credit or SHARE points. Changing to those tenders requires showing the actual reprice, confirming removal, and then separately reviewing/confirming payment.
- Optional usual snacks are offered before combined checkout; later food orders remain available.
- Confirmed tickets show the booking reference and real QR payload; Download QR Code saves a PNG. No synthetic QR fallback is used.
- Cancellation offers only validated refund destinations. The approved demo policy uses 90-day VOX credit and 5–10 days for original-card refunds. Guest refund choice retains short-lived booking-specific verification. Final confirmation binds the exact request ID.
- Payment investigations inspect real booking/order/action records before handover. Possible bookings are explicitly unverified until selected and matched; transaction reference and card last four remain reported evidence unless independently verified.
- Swaps prefer the same cinema, film, experience, time and seats. Preview explains changes and exact price difference. The mock exchange atomically transfers the original payment and settles only the difference. A provider lacking exchange capability fails closed.
- Sara, James and Rahul fixtures are tagged and created once. Only named untouched synthetic examples are archived from the active demo list; modified bookings and history remain.

## ElevenLabs configuration

The agent source contains four free-form Procedures: booking, cancellation/refund, exchange and debited/no-booking investigation. Financial correctness remains enforced by backend validation and confirmation records. Model, voices and conversation/platform settings are preserved. Procedure/tool/KB references are bound to a separately published candidate version before promotion.

Candidate branch: `agtbrch_4001m26hjbkyerhr4mqhdxbg0bye`. Candidate version at this checkpoint: `agtvrsn_5101m26p97e6fs0tx9mw9rdh6j3n`. There are 46 server tools and 12 client tools, with 12 KB documents. Thirty-eight bilingual and negative conversation scenarios are defined. Publication is not evidence that those scenarios or real audio have passed.

The connected EU tool cannot execute generation-based conversation tests. These scenarios remain unrun pending an appropriate supported connection. Browser/physical microphone acceptance is also pending because both permitted browser-access attempts timed out during automatic approval review.

## Deployment and verification

API bootstrap applies additive migrations `0004_refund_credit_expiry` and `0005_ledger_order_reference`. Mock and worker wait, read-only, for the committed schema before accepting HTTP or jobs; failure after 120 seconds is explicit. Do not force-reseed a populated deployment.

The full isolated local suite passed: **415 tests across 46 test files** (web 107, contracts 3, agent 105, domain 21, DB 13, mock 47, core 62, API 57). Tests cover account runtime races, credential isolation, proposals/retries/reconnect, refund proof ownership, offer switching, exact confirmation binding, atomic exchange settlement and migration startup readiness.

Repository lint passes with existing warnings. Production builds include both native site and embed bundle. The committed OpenAPI document is regenerated from all 46 server-tool contracts.

Before declaring full acceptance, record the deployed Git commit and all four Railway service statuses, the promoted ElevenLabs version and reference readback, actual English/Arabic journey results, and browser checks of both sites including page login/logout, responsive layout, QR download and microphone-input mute with continued assistant audio.
