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

The agent source contains four free-form Procedures: booking, cancellation/refund, exchange and debited/no-booking investigation. A fifth structured Procedure gives an exact, brief English/Arabic acknowledgement only when the guest asks for brevity because details are already visible. It has no business tools. Financial correctness remains enforced by backend validation and confirmation records. Model, voices and conversation/platform settings are preserved. Procedure/tool/KB references are bound to a separately published candidate version before promotion.

Candidate branch: `agtbrch_4001m26hjbkyerhr4mqhdxbg0bye`. The first premium candidate was `agtvrsn_5101m26p97e6fs0tx9mw9rdh6j3n`, promoted to main as `agtvrsn_3001m278vm1peqzvsc8zar6twafq`. There are 46 server tools and 12 client tools, with 12 KB documents. Forty-two bilingual and negative conversation scenarios are now defined, including explicit QR-render and offer/handover failure cases. Publication is not evidence that those scenarios or real audio have passed.

The connected EU tool cannot execute generation-based conversation tests. After browser access was restored, the supported ElevenLabs dashboard ran all 38 initial logical scenarios against main. Results exposed both agent failures and inconsistent fixture facts/criteria; original results are retained separately from corrected tests. A follow-up candidate addresses identifier/amount grounding, one-time questions, failed-render claims and unconfirmed email delivery. Use final native run metadata to assess that candidate, rather than the original test definitions or code-only tests. Physical audio acceptance remains separate because browser automation cannot inspect microphone permission or listen to the result.

## Hosted acceptance findings

The first release, GitHub PR #5 / commit `4fee34d999f2af3c0a4cc5adf97af827494fe2f9`, deployed successfully to API, mock, worker and web. Both websites passed page-owned login and signed-in privacy checks; actual English and Arabic age-rating replies were brief. Hosted simulated transactions passed proposal/offer/snack checkout, original-card cancellation, payment investigation, full six-minute hold expiry and recovery, and same-cinema swaps charging/refunding only the price difference (AED 90 in each direction).

The follow-up fixes three observed gaps: completed payment retries retain verified ownership after the active basket clears; existing-ticket QR requests retrieve only a verified active booking and acknowledge only after the actual PNG renders; the linked site's wrapped login labels are updated in both languages. Receipt lookup preserves a separate current hold. Failed/missing QR and changed-account results never count as successful display.

The live `REFUND_METHODS` override on API and worker was explicitly aligned to `VOX_CREDIT,ORIGINAL_PAYMENT`; this is required alongside the source policy. Test bookings were newly tagged synthetic records and cleaned up through normal cancellation/exchange flows. Balance-tender purchases remain local-test coverage where normal hosted refunds cannot restore the original demo balances.

## Deployment and verification

API bootstrap applies additive migrations `0004_refund_credit_expiry` and `0005_ledger_order_reference`. Mock and worker wait, read-only, for the committed schema before accepting HTTP or jobs; failure after 120 seconds is explicit. Do not force-reseed a populated deployment.

The first release passed 415 tests across 46 files locally and in CI. The hosted-fix regression run passed 451 tests across 48 files; after the final fixture-only assertion, PR #6 CI passed **452 tests across 48 test files** (web 136, contracts 3, agent 110, domain 21, DB 13, mock 47, core 62, API 60). The subsequent conversation-verification changes passed all 112 agent tests plus the existing five handover reliability tests. Tests cover account runtime races, credential isolation, proposals/retries/reconnect, refund proof ownership, offer switching, exact confirmation binding, atomic exchange settlement, receipt ownership/rendering and migration startup readiness. These counts describe code tests; native conversation runs are recorded independently.

The simulated handover adapter's refund-keyword reply only offers to review the request. It does not claim an actual refund was processed or an email was sent; those require a real action and result.

The agent HTTP booking tool requires a valid proposal token before its inline mutation path. Missing or fabricated tokens preserve the current basket and payment confirmation. The shared widget retains its explicit internal booking controls. The ElevenLabs tool definition and public OpenAPI schema reflect this boundary. Focused acceptance passed all 65 API tests and 114 agent tests; the full release CI remains recorded separately.

Repository lint passes with existing warnings. Production builds include both native site and embed bundle. The committed OpenAPI document is regenerated from all 46 server-tool contracts.

Before declaring full acceptance, record the deployed Git commit and all four Railway service statuses, the promoted ElevenLabs version and reference readback, actual English/Arabic journey results, and browser checks of both sites including page login/logout, responsive layout, QR download and microphone-input mute with continued assistant audio.
