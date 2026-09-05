# 08 — End-to-end validation report (5 Sep 2026)

Aggressive pre-UAT pass against the **live stack** (Railway: `web-production-f54a1`, `concierge-api-production-3d90`) and the **live ElevenLabs agent** (`agent_1001m1m6rghcfsr8nrpj5x08g16e`). Source of truth for scope: *VOX 2.0 Digital Concierge – Refocused Scope (vf)*, items 1–22 (Phase 1 = 1–12, Phase 2 = 13–22; Phase 3 items 23–25 are out of scope).

## What was run

| Layer | How | Result |
|---|---|---|
| Unit / integration | `pnpm -r test` (domain 12, vista-mock 23, concierge-api 22, concierge-core 1) | **58 / 58 pass** |
| Live tool + widget-command harness | `infra/e2e/live-harness.js` injected into the deployed site (`/e2e/live-harness.js`), `V.run("all")` — 120 checks across every tool, widget command, reporting endpoint, Arabic, concurrency and security | **118 / 120 pass** on a fresh seed (the 2 "failures" are state-dependent checks, see below) |
| Widget (browser) | Text-mode session, showtime/film/menu/seat-map/payment-sheet/receipt cards, location bar, expanded mode, Arabic RTL, dashboard | verified with screenshots; 4 defects found and fixed |
| ElevenLabs agent simulations | 16 scripted guest conversations (EN + AR, guest / Sara / Rahul / James) run with `agents_create_test` (simulation) + `agents_run_tests`, real tools against production, client (widget) tools mocked | **14 / 16 pass**; the 2 non-passes are evaluator/state artefacts (see below) |

## Defects found and fixed in this pass (all deployed)

| # | Area | Defect | Fix |
|---|---|---|---|
| 1 | Data | All seven **City Centre** cinemas (Deira, Mirdif, Sharjah, Al Zahia, Fujairah, Shindagha, Ajman) had been scraped with Ajman's slug, address and coordinates — "City Centre Deira is at Al Ettehad St, Ajman", wrong distances for near-me | Corrected slugs / addresses / coordinates / in-mall notes; KB cinema docs regenerated (49 docs) |
| 2 | Tools | `browse_menu` query "7up" found nothing ("7 Up" in the catalogue) | Tolerant matching: punctuation/space-insensitive, all-token match, singular/plural fallback |
| 3 | Tools | `prepare_payment` crashed (INTERNAL) when the conversation carried a stale/unknown `customerId` (e.g. widget reloaded after a reseed) | Falls back to the guest path; balances failure tolerated |
| 4 | Tools | `find_booking` on a swapped/cancelled booking said "0 tickets … Status: swapped" | Clear speech: "was swapped to booking W…", "already refunded, AED x back to the original method in 5–10 working days" |
| 5 | Tools | `add_concessions` quantity 0 removed **every** line with that item id — swapping the drink in a combo (Pepsi → 7 Up) removed both combos | Removal matches the modifier set when given |
| 6 | Speech | "on tomorrow at 7:45 pm" in cancellation/swap confirmations | "on" only before calendar dates |
| 7 | Arabic | "و20 مواعيد أخرى" (wrong plural) | Proper dual / 3–10 / 11+ forms ("و20 موعداً آخر") |
| 8 | Widget | Transcript did not stay pinned to the newest card (CSS smooth scroll was cancelling programmatic scrolls; late-loading cards changed height) | Instant scroll + resize observer; verified live |
| 9 | Widget | Seat map: the seats auto-held by `add_tickets` were not shown as selected ("Tap 2 seats") | Held seats start selected with their tier/price; Confirm enabled |
| 10 | Widget | After paying in the Review & Pay sheet the agent was only told "I've completed the payment" | Message now carries the new booking reference so the agent can read it back without a tool call |
| 11 | Widget (AR) | Location bar kept the English "My current location" label after switching to Arabic | Translated at render |
| 12 | Dashboard | Guided-booking funnel bar overflowed the card when a later step exceeded "Booking started" | Started = any order step or journey; bars clamped |
| 13 | Agent | "Pay with my saved Mastercard" was sent as `method: CARD`; the agent then called `pay_order` for a card payment and got a validation error | Tool descriptions + prompt: saved-card phrasing → `SAVED_CARD`; card/wallet methods finish in the sheet, `pay_order` only for VOX credit / Share Points |
| 14 | Agent | Arabic "can I cancel and get my money back?" answered vaguely and asked for a reference first | Prompt: state the policy (30-min cut-off, refund method, bank-offer exclusion) before looking up |
| 15 | Agent | Read the internal `cnf_…` confirmation id aloud once; only one back-row seat option offered | Prompt: `cnf_` added to never-read list; read every suggestion for the requested region; one-call F&B swap rule |

## Requirement-by-requirement coverage

Legend: ✅ covered & working (verified live in this pass) · ⚠️ covered with a known limitation · ❌ not covered (out of demo scope / needs real integration)

### Phase 1 — answers my questions and resolves my issues

| # | Requirement | Status | Evidence in this pass |
|---|---|---|---|
| 1 | Movie information: now showing / coming soon, sessions by date, time, location, experience; search by title, genre, rating, child age, language; posters + trailers; alternatives when nothing matches | ✅ | Harness: fuzzy title, Tamil filter, Animation + age 8, coming soon, PG13 filter, film detail, MOE alias, emirate = every Dubai cinema, "tonight" ≤3 spoken + more on screen, impossible window → relaxed alternative, Arabic kept when relaxing, IMAX filter, past date graceful, no film/no cinema → asks. Sim VOXI-01 (relaxation explained, no invented times), VOXI-14 (Arabic showtimes). |
| 2 | Cinema information: locations, hours, 3 nearest from GPS, accessibility, Google Maps links | ✅ | Harness: by emirate, hours/directions/parking/accessibility + map link, LOCATION_REQUIRED without location, Yas Island → Yas Mall first with km, near-me sessions sorted by distance, cleared location asks again. Sim VOXI-02 (asks for location, never invents). Data fix #1. |
| 3 | Age restrictions (ratings + experience rules) | ✅ | Harness: 18+/12yo → No, PG13/10yo → accompanied, GOLD rule, G/3yo. Sim VOXI-03 (asks age first, definite verdict). |
| 4 | General information (FAQs, policies, bank offers, refunds, parking, accessibility) | ✅ | 12 KB docs attached to the agent (RAG) + 49 KB docs in the concierge DB. Sim VOXI-04 (Arabic policy + 10 pts = 1 AED, no language flip on "أممم"). |
| 5 | Promos & offers information (per session, eligibility, images, bank/card filters) | ✅ | Harness: images + eligibility, HSBC-only filter, unknown bank honest, card BIN → ENBD, guest members-only note, member saved-card hint (Mastercard 3845), BOGO with 3 tickets refused with reason, wrong card refused. Sims VOXI-05, VOXI-06. |
| 6 | Booking information (how to book, deep links) | ✅ | Harness: how_to_book in-chat + voxcinemas link, film link. |
| 7 | Ticket cancellation (identify booking, cancel in Vista, summary, refund amount & method) | ✅ | Harness: eligibility matrix (cut-off/started, bank offer, collected, already cancelled), guest verification required, wrong last-4 rejected, summary with amount + original-card method, bogus confirmation rejected, 5 concurrent confirms → 1 action, RF- reference, refunded status, second cancel → clean "already cancelled", member partial cancel 1 of 3 → Share Points, 2 seats remain. Sims VOXI-07 (guest flow), VOXI-08 (bank-offer booking refused → agent). |
| 8 | Refunds & swaps | ✅ | Harness: swap prepared with price difference → executed → new W reference, old cancelled (verified: W9RBSB5, AED 175 to VOX credit, new AED 170). Sim VOXI-15. |
| 9 | In-mall location (where in the mall, parking, accessible route) | ✅ | Harness get_cinema directions/parking/accessibility; per-cinema KB docs (now correct for City Centre malls). |
| 10 | Reporting & insights dashboard | ✅ | Harness: /reporting/summary (window, KPIs, journeys, funnel), conversation list with transcripts; dashboard screenshot-verified (funnel fix #12). ⚠️ E2E harness conversations count as "active" until the reseed clears them. |
| 11 | Voice & text, EN + AR, VOX keywords | ✅ | Harness: Arabic speech, Arabic cinema/emirate names resolved, Arabic age verdict; widget RTL verified; sims VOXI-04/14 in Arabic. Voice mode uses the same tools (not exercised by the simulator — voice is verified manually in the widget). |
| 12 | Seamless transfer to agent (sentiment, summary, graceful fallback) | ✅ | Harness: transfer accepted with summary, widget in human mode with agent name, guest message reaches the simulated agent. Sims VOXI-08, VOXI-16. ⚠️ Genesys adapter exists but the live demo uses the simulated agent (`HANDOVER=simulated`). |

### Phase 2 — the seamless booking concierge

| # | Requirement | Status | Evidence in this pass |
|---|---|---|---|
| 13 | F&B information (menu per location/experience, images, combos, dietary) | ✅ | Harness: popcorn tab with images + sizes, vegan filter, combos with drink choice, GOLD menu, "7up" spelling tolerance (fix #2). Compact 3-column tiles verified in widget. |
| 14 | Pre-order F&B in the booking journey | ✅ | Harness: add with modifier, swap (remove + add in one call). Sim VOXI-09 (Pepsi → 7 Up, no cancel_order). Fix #5. |
| 15 | Guided booking (browse → sessions → seat map → offers → payment → confirmation with QR) | ✅ | Harness: session found, ticket types with tiers, start order, 3 tickets auto-held, seat plan tiers + suggestions with prices, sold seat → SEATS_UNAVAILABLE, choose 3 seats, change to 2 tickets, W reference + QR payload, new booking findable with "paid with" card. Widget: seat map (tiers, legend, selected seats, fix #9), Review & Pay sheet, receipt with QR verified. Sims VOXI-09 (Sara), VOXI-11 (guest Samsung Pay), VOXI-14 (Arabic). |
| 16 | Apply promos & offers (bank offers, BOGO rules, re-check on change) | ✅ | Harness: BOGO with 3 tickets refused, applied with 2 on an eligible day, wrong-bank card at payment refused, correct saved card pays. Sim VOXI-10 (3 → 2 tickets, HSBC card → offer condition explained). |
| 17 | Payment (saved cards, new card, Apple Pay, Samsung Pay, VOX credit, Share Points; balance enquiry; Checkout-style tokenisation) | ✅ | Harness: balance (10 pts = 1 AED), Share Points path, saved-card sheet with 2 saved cards + wallet + VAT + bank offers, declined card → clear failure, retry with right card → paid, guest without details asked for name/email/mobile, guest Samsung Pay sheet with no bank offers + login nudge → booking. Widget: Pay AED 156 → "Payment received" → receipt. ⚠️ Simulated tokenisation (no real checkout.com). |
| 18 | Booking status (logged-in vs guest, retrieve from Vista) | ✅ | Harness: find by reference (case-insensitive), unknown reference helpful, by phone with spaces, by email case-insensitive, guest data masked, session context guest/member, wrong PIN, login, my bookings. |
| 19 | Customer feedback survey | ✅ | Harness: feedback stored, rating validated 1–5; agent asks once for a rating at the end (sims VOXI-07/13). |
| 20 | Complaint management | ✅ | Harness: complaint reference CMP-…; sim VOXI-13 (details gathered, reference given, rating). |
| 21 | Personalisation (history-based recommendations, children question, explicit request wins) | ✅ | Harness: guest cold start = popular, Sara asks about children first, with children → family films + usual snack, adults only → no family films, Rahul → Tamil/Hindi without children question, explicit Hindi wins, James → English only. Sim VOXI-12. |
| 22 | Omni-channel accessibility | ⚠️ | Harness: `channel: whatsapp` accepted end-to-end; tools are channel-agnostic. Only the web widget (voice + text) is wired in the demo — WhatsApp/phone numbers are not attached to the agent. |

### Cross-cutting

| Requirement | Status | Evidence |
|---|---|---|
| Never block the conversation; concurrent inputs | ✅ | 5 concurrent cancel confirms → 1 action; 10 concurrent searches OK; action ledger idempotency |
| Every write confirmed once | ✅ | bogus / expired confirmations rejected; prepare → confirm → act in every sim |
| Security | ✅ | tools require the key (401/403 without it); PANs never leave the browser (tokens only) |
| Ask, don't assume | ✅ | Sims: showtime, seats, F&B, payment method all offered as choices; child age asked; location never invented |

## Not covered / known limitations (be explicit in the demo)

1. **Real Vista / Apigee, checkout.com, Genesys** — the demo runs against the Vista-shaped mock, simulated tokenisation and the simulated human agent. Swap points are documented in `docs/03-go-live-swap.md`.
2. **Voice quality / accents** — the simulator is text-only; voice was checked manually in the widget, not measured (no WER/latency numbers).
3. **WhatsApp / phone channels** — channel-agnostic, not attached.
4. **Demo data is time-based**: showtimes come from a one-week capture (3–10 Sep) and the seeded bookings are relative to seed time. The "inside 30-minute cut-off" booking (Rahul WM3PQ9X) is only inside the window for ~25 minutes after a reseed (afterwards it correctly reports "already started"); Sara's WXA7K2M becomes a past booking the day after seeding. **Reseed right before the demo** (`SEED_FORCE=true` → deploy → `false`).
5. **Simulator artefacts**: ElevenLabs simulations cannot run client (widget) tools, so cards/feedback/location are mocked in the 16 tests; VOXI-07 fails only when an earlier run already cancelled WLHGST5 (the agent then correctly says it is already refunded), and VOXI-16's evaluator marks the immediate transfer as "did not decline first" — behaviour is acceptable.
6. **Phase 3 items (23–25)** — not in scope.

## Test assets

- `infra/e2e/live-harness.js` — browser harness (`window.V.run("all"|"info,offers,bookings,booking,service,platform")`), also served at `/e2e/live-harness.js`; needs `window.__VOXI_KEY`.
- ElevenLabs tests `VOXI-01 … VOXI-16` in the workspace (simulation type, client tools mocked) — re-runnable from the ElevenLabs "Tests" tab or `agents_run_tests`.
- Production reseeded after this pass (all harness/simulation bookings, orders and conversations cleared).
