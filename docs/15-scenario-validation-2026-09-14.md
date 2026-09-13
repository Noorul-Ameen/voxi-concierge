# September 14 scenario fixes and validation scope

This change follows live checks of the supplied customer journeys on the linked VOX page, the located demo-profile/scenario spreadsheets, the updated September 13 showtime capture, and separate English/Arabic ElevenLabs simulations. The starting deployed revision was `d961deb68fa312f394516dc4448b69be6b264cfc`. This document describes source behavior; the dated external release evidence records deployed commits, agent versions and acceptance results.

## Changes driven by observed failures

- Returning greetings rotate through four paired English/Arabic messages. Names come from the currently authenticated server account. Login remains on the host page; anonymous, expired and switched accounts cannot inherit another customer's greeting. Existing unfinished-booking/hold-expiry context remains intact.
- VOX credit and SHARE redemption carry an explicit balance type and correct units. A partial VOX payment prepares the available credit plus the exact card remainder, with a fresh payment confirmation. Explicit zero clears a mistaken reservation. Old ambiguous SHARE calls cannot override an already selected VOX-credit path. The widget shows the full booking amount, chosen balance and remaining card amount separately.
- Child admission uses shared supported-rating rules and fresh classification checks at booking decisions, including direct provider requests. Unknown/provisional ratings do not become automatic child approval. A bounded startup sync corrects captured rating metadata without resetting customers, orders, balances or history.
- Ending Customer Care closes the owned handover, prevents later queued replies from reviving it, and preserves sign-in. Account changes clear the previous customer's support state. The widget verifies server-owned transfer status and no longer displays the internal support briefing.
- Confirmed-booking changes first look up the authenticated customer's bookings. Swap previews prioritize the original cinema and experience, closest requested time, exact seats where available, then the verified seating preference within the original tier. The preview still requires consent to its actual charge or refund.
- Model-reported cancellation/refund/swap completion requires a successful same-session backend action. A refusal or handover cannot mark a financial journey completed.
- Agent prompts, tool descriptions and existing Procedures handle verified widget decisions briefly, distinguish suggestions from completed actions, disclose meaningful time/experience changes, and avoid inventing prices, transaction references, QR alternatives or completed outcomes after failed tools.
- Four task Procedures remain: booking, cancellation, changing a paid booking and missing-payment investigation. The optional structured brevity Procedure is removed because transcript tests showed it suppressing real questions and verified widget outcomes. Brief responses are handled in the normal conversation instructions.
- Film-language filters use an explicit `filmLanguage` field in agent tools, separate from English/Arabic conversation language. Existing API film-language aliases remain compatible; the old general language hint on `get_film` keeps its previous behavior. Unknown cinema, bank, time and order values are omitted rather than guessed.

## Test approach

The regression suite covers authenticated greetings, account/transfer races, payment consent and reservations, classification refresh/admission, exchange preference and price preservation, and truthful financial reporting. Hosted checks use fresh synthetic guest transactions for actual payment/refund/swap execution; named spreadsheet bookings remain read-only and member balance checks stop before payment.

ElevenLabs simulations exercise the existing journeys plus verified widget acknowledgements, child-rating boundaries, proposal edits, VOX/card continuation, correction of rejected SHARE selection, and reference-less confirmed-booking lookup in English and Arabic. Provider pass counters are reviewed against tool results and spoken facts; a provider pass alone does not establish acceptance.

## Data and acceptance boundaries

- The source capture contains 93 films, 23 cinemas and 4,401 sessions. The initial hosted scan found every still-available captured session with matching film/cinema/experience/time. The demo also retains synthetic schedules and fixture records; these are not all newly captured live VOX inventory.
- Some older spreadsheet films, dates and booking stories differ from the updated hosted records. All nine referenced bookings were located. Rahul has multiple matching confirmed bookings, so disambiguation remains appropriate; no account data was reset to force the older single-booking example.
- Supported refunds retain the configured VOX-credit 90-day validity and original-card 5–10-day wording. A whole original-card refund of a mixed wallet/card payment is not supported by this mock provider; only returned permitted destinations may be offered.
- Payments and Customer Care are simulated. Browser text checks and mocked agent conversations do not establish real payment-provider integration, real contact-centre transfer, microphone recognition or subjective audio quality. The user's earlier English/Arabic speaker check with the microphone muted is separate evidence.
- One baseline in-app conversation closed with a provider transport error before the widget's inactivity deadline. A separate longer Chrome bilingual check completed normally and then paused after 180 seconds. No unsupported root cause or changed voice/timer setting is inferred from that intermittent observation.
