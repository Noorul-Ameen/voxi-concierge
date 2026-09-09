# 13 — Current concierge enhancement behavior and acceptance

This is the current source-level handover for the VOX Cinemas Virtual Assistant enhancement. Deployment and acceptance are separate: record the final service revisions, agent version and actual test evidence when promoted. Earlier documents 08, 11 and 12 contain historical snapshots and must not be used as current acceptance evidence.

Current verification is recorded in the [dated acceptance record](14-enhancement-acceptance.md): **224 local tests across 34 files passed without failures or skips; 11 builds passed; lint has 0 errors and 212 warnings**. V9 scored 49/51 with no partial tool-audit failures, but a wrong spoken price remains an acceptance failure. V10's 17 variants × 3 repeats have been invoked on validation version `agtvrsn_2201m243pa2qfq8b35nsrae8swha`; results and the next PR CI run are pending. Main is not promoted, the application is not deployed, and actual voice listening is unverified.

## Agreed product choices

- Enhance the existing project and use one shared widget on both the Cloudflare website and Railway demo.
- Offer optional snacks before one ticket/food checkout. Food ordered after paid tickets remains a separate order.
- Unknown quantity must be asked. Explicit movie, cinema, language, date, time and seat choices override inferred history.
- Three minutes of user inactivity ends the conversation only. Account, order and seat hold remain independent.
- A valid hold keeps its original expiry. Expired choices are retained; checking and creating a fresh hold requires a new explicit agreement.
- Sign-in is email and password in the secure UI. Keep the verified live voice/model unchanged during prompt/tool enhancement.
- Improve conversation through structured state, concise prompting and reviewed offline coaching/regressions. No automatic self-training or extra runtime review model.

## Implementation map across the 62 brief sections

| Brief sections | Implementation and current validation boundary |
|---|---|
| 1–6, 21–22 | Natural one/two-sentence prompt, known-information checks, sparse name use and UI-action acknowledgements; actual tone/repetition must pass candidate simulations and listening |
| 7–8, 52 | Tool facts remain authoritative; offline response flags, review examples and regression loop; quality flags assist review and do not rewrite or guarantee every live response |
| 9, 44–47 | Structured booking state, separate authenticated/transport/order lifecycles, retained expiry, explicit recovery and 180-second inactivity; API/unit tests plus actual browser expiry/reconnect checks required |
| 10–20, 23–24, 53–54 | Three coherent history-backed personas, single language/cinema, separate weekday/weekend windows, clean profile/history panel and explicit preference overrides |
| 25–33, 57–58 | Shared responsive widget, compact header, one main recommendation, poster-free showtimes, collapsed prior decisions, touch seat map and progressive checkout; inspect both hosts and mobile keyboard behavior |
| 34–43 | Direct booking, unknown quantity, supported alternatives, visible/changeable seats, optional snacks, percentage/BOGO offers, wallet/SHARE and compact payment summary; verify actual tool totals and consent |
| 48–51 | Shared text/voice tools, deterministic server-driven UI, active-card deduplication and ordered event replay; actual speech, interruption and mode-switch checks remain separate |
| 55–56 | Thirteen scenario groups with 17 runnable simulation variants, all three secure sign-ins and guest booking; record repeated provider and application outcomes |
| 59–62 | Existing booking management, information, loyalty and handover retained; final acceptance includes tests, deployment evidence and a customer-view review, not merely source completion |

## History and accounts

Sara: Arabic/MOE/centre, weekdays around 19:00 and weekends around 16:00. Rahul: Tamil/Burjuman/back, weekdays around 21:00 and weekends around 18:00. James: English/MOE/back, weekdays around 20:00 and weekends around 16:30. These are intended synthetic patterns; the profile is calculated from the actual available history, not forced despite contradictory real visits.

The updater targets only the known matching demo IDs/emails and tagged synthetic history. It preserves unrelated records, bookings and balances. Passwords use salted hashes and are provisioned privately through environment variables. Legacy package names, event names, member IDs and URLs are compatibility details only.

## Evidence and promotion record

The [runbook](02-runbook.md), [demo script](04-demo-script.md) and [simulation runbook](../packages/agent/coaching/SIMULATION-RUNBOOK.md) specify the execution steps. A complete record must include:

- Type/lint and relevant unit/integration results for the final code.
- Candidate agent ID/version/branch, final attached tool IDs, and each of the 17 simulation variants with repeated results.
- Railway and Cloudflare browser checks, three account sign-ins, guest booking, quantity/seat/food/card/offer changes and one deliberate simulated payment.
- Valid and expired continuation, cross-account isolation, payment confirmation after reconnect, original hold expiry, and actual 180-second inactivity.
- English/Arabic voice discovery, booking and continuation; concise speech, interruption, transcript and transport switching.
- Mobile sizing, no page overflow, keyboard-safe controls, seat-map interaction and reduced-motion behavior.
- Final deployment revisions, migration outcome, preserved model/voice/knowledge settings, unresolved limitations and rollback references.

Do not replace missing evidence with old “all passed” counts or the existence of a scenario JSON file.
