# 12 — Current build: full details

> Historical snapshot from 9 September 2026. “Current” and “right now” below refer to that snapshot, not the later enhancement candidate or its deployment. See [the current enhancement guide](13-concierge-enhancements.md) and its acceptance record. The original snapshot is retained for traceability.

Snapshot taken 9 Sep 2026, 16:55 Dubai. Everything below is what is deployed and running right now.

## 1. Build identity

| Item | Value |
|---|---|
| Product | VOX 2.0 Digital Concierge — Phase 1 & 2 demo |
| Guest-facing name | **VOX Cinemas Virtual Assistant** (formerly "Voxi"; internal identifiers unchanged) |
| Repository | https://github.com/Noorul-Ameen/voxi-concierge (private), branch `main` |
| Deployed commit | `09cee73` — "Rename the persona to VOX Cinemas Virtual Assistant; simple welcome message; KB and dashboard wording" (9 Sep 2026 11:50 UTC) |
| Working tree | clean — nothing uncommitted |
| Total commits | 52 (first commit 3 Sep 2026) |
| Codebase | ~25,300 lines of TypeScript/TSX across 5 apps and 6 packages, pnpm 10 monorepo, Node 22, TypeScript 5.7 strict, Biome 1.9, Vitest 3 |
| Tests | 64 green (domain 12 · concierge-core 1 · vista-mock 23 · concierge-api 28) |
| Deploy status | Railway auto-deploy from `main`; all four services SUCCESS on `09cee73` at 11:51–11:52 UTC |

## 2. Live URLs

| Surface | URL |
|---|---|
| Demo site (landing + widget) | https://voxi-demo.up.railway.app |
| Dashboard | https://voxi-demo.up.railway.app/dashboard |
| Embeddable widget script | https://voxi-demo.up.railway.app/embed/voxi.js |
| Example host page | https://voxi-demo.up.railway.app/embed/demo.html |
| Concierge API | https://concierge-api-production-3d90.up.railway.app (every route also under `/api/*`) |
| OpenAPI | `GET /openapi.json` on the API |
| Health | `GET /healthz` and `GET /readyz` on the API |
| Prototype site using the embed | https://voxi.kris-pradip.workers.dev/ (navy theme matches it) |

## 3. Runtime architecture (as deployed)

```
Browser (widget, Shadow DOM)  ──WebSocket──►  ElevenLabs Agents (EU residency)
        │  /widget/*, SSE                            │ 44 webhook tools (x-voxi-key)
        ▼                                            ▼
   web (nginx) ──────►  concierge-api (Hono)  ◄─────┘
                              │  action ledger / sagas
                              ▼
                         worker  ──►  vista-mock (Vista-shaped API)  ──►  Postgres
```

Railway project `voxi-concierge` (`52e8f8a4-…`), environment production (`b67e9b17-…`), Amsterdam region (1 replica each), Trial plan.

| Service | Role | Notes |
|---|---|---|
| `web` (`f8170ea1`) | nginx serving the React widget site + `/embed/voxi.js` | `charset utf-8`, cache headers on `/embed/` |
| `concierge-api` (`dc25db07`) | Hono API: agent tool webhooks, widget session/login/logout, SSE events, dashboard reporting | pre-deploy: migrate → seed-if-empty → synthetic history once; `SEED_FORCE=true` for one deploy reseeds |
| `worker` (`b5d0d44f`) | executes write actions (book, pay, cancel, swap) with idempotent ledger; API waits ≤4 s for inline result | |
| `vista-mock` (`db33f2f1`) | Vista Connect–shaped mock (V1 result codes, orders, seat plans, concessions, bookings, refunds, loyalty, offers) | `VISTA_MOCK_ORDER_EXPIRY_MINUTES=6` |
| `postgres` | Drizzle schema, volume-backed | |

Go-live swap point: only `packages/vista-client` changes to point at the real MAF/Apigee Vista APIs (`docs/03-go-live-swap.md`).

## 4. Repository layout

| Path | Contents |
|---|---|
| `apps/web` | React 18 + Vite widget site: `Concierge.tsx` (conversation, voice, timer, resume, mute), `Cards.tsx` (showtimes, seat map, menu, Review & Pay sheet, receipt/QR, booking cards), `Demo.tsx` landing, `Dashboard.tsx`, `embed.tsx` (IIFE build), `styles.css` (VOX theme + `navy` preset), `lib/i18n.ts` EN/AR |
| `apps/concierge-api` | Hono app: `/tools/*` (44), `/widget/session|login|logout|events`, `/commands`, `/reporting/*`, `/demo/films`, webhooks; 28 tests + `test/harness.ts` |
| `apps/worker` | action executor + sagas (cancel, swap, pay, F&B order) |
| `apps/vista-mock` | Vista-shaped API + seed (22 cinemas, 104 films, 3,654 sessions from the 7–13 Sep capture, City Centre Deira menu 126 items, bank offers, personas) |
| `apps/scraper` | VOX site capture scripts (`browser-capture.js`, merge) |
| `packages/contracts` | Zod schemas for every tool input/output, widget events & commands, OpenAPI generation |
| `packages/domain` | pure rules: cancellation policy (30-min cut-off), offers (BOGO/percentage/fixed, BIN match, monthly limit), points (10 pts = AED 1), date/time/place parsing |
| `packages/concierge-core` | tool implementations: `quick.ts` (quick_book, recover_order, resume_order, suggest_fnb, order_fnb), `ordering.ts` (order/seats/F&B/offers/reviewAndPay), `bookings.ts` (find/cancel/swap/refund), `customer.ts` (login, loyalty, recommendations, feedback, transfer), `search.ts`, `actions/executor.ts` |
| `packages/vista-client` | typed client for the Vista-shaped API (the go-live swap module) |
| `packages/db` | Drizzle schema, migrations (0000, 0001 savedCards), seed + synthetic history |
| `packages/agent` | agent-as-code: `prompts/system.md` (88 lines), 49 KB docs in `kb/`, `src/index.ts` sync script (tools, KB, first message, dynamic variables, turn config, evaluation criteria, data collection) |
| `infra` | Dockerfiles, nginx template, docker-compose, `elevenlabs-tool-ids.json`, `openapi.json`, Postman collections, `e2e/live-harness.js` (120 checks), load scripts, `railway.md` |
| `docs` | 01 architecture · 02 runbook · 03 go-live swap · 04 demo script (persona credentials) · 05 scope traceability · 06 live environment · 07 real-site reference · 08 e2e validation report · 10 VOX brand house · 11 booking v2 requirements · 12 this file |

## 5. ElevenLabs agent

| Item | Value |
|---|---|
| Agent | `agent_1001m1m6rghcfsr8nrpj5x08g16e`, EU data residency (`wss://api.eu.residency.elevenlabs.io`) |
| Name | VOX Cinemas Virtual Assistant (Phase 1 & 2 demo) |
| Current version | `agtvrsn_2601m233vgage39vp489mymzkdwv` (branch `agtbrch_1701m1m6rk9vfpvr3dajwz6ak3eg`); previous `agtvrsn_8701m2302…` differs only in TTS model/expressive mode and `speculative_turn` |
| LLM | gemini-3.6-flash |
| Voices | voice `cgSgspJ2msm6clMCkdW9`; TTS model **eleven_v3_conversational (expressive)** since a UI edit at 16:56 Dubai on 9 Sep (was eleven_flash_v2 in every conversation up to 16:45) · AR preset flash v2.5 |
| ASR | Scribe v2 realtime, keyword boosts for cinema/film names |
| Tools | **56** — 44 webhook (`/tools/*`, header `x-voxi-key`) + 12 client tools (render cards, seat map, QR, trailer, payment sheet, language switch, transfer UI, log journey…) |
| Newest tools | quick_book, resume_order, recover_order, suggest_fnb, order_fnb (ids in `infra/elevenlabs-tool-ids.json`) |
| Knowledge base | 12 attached documents (consolidated from the 49 source files in `packages/agent/kb`: refunds, age restrictions, booking/loyalty, about VOX & Customer Care, Arabic glossary, app/EATS/genres, offers, T&Cs, FAQ, experiences, UAE locations, checkout & receipts), multilingual RAG (e5-large, 20 chunks, distance 0.6) |
| First message | `{{greetingEn}}` / AR preset `{{greetingAr}}` — member: "Hi {firstName}, welcome back. How can I help you today?" · guest: "Hi there, welcome to VOX Cinemas. How can I help you today?" |
| Dynamic variables | conversationId, customerId, memberId, channel, language, firstName, greetingEn, greetingAr |
| Turn config | turn_v3, turn timeout 8 s, speculative turns on, silence end-call 180 s, max duration 30 min; LLM temperature 0, minimal reasoning |
| Origin allowlist | empty (widget may be embedded on any page) |
| Analysis | evaluation criteria: confirmation_before_action, no_hallucinated_facts, language_match · data collection: outcome, topics, sentiment, language_used |
| Post-call webhook | not configured (optional, see §10) |

## 6. Widget capabilities (live)

- Voice and text in EN/AR (RTL), language switch mid-conversation, mute (mic + audio) without ending the session.
- Log in from the page header or the widget (email / mobile / member id + PIN) or by asking the assistant; logout; personalised greeting after sign-in.
- Cards: film-hero showtimes with day tabs and per-film grouping; seat map with tiers and pre-selected held seats; F&B tiles with "Your usual"/popular tags; Review & Pay sheet (progress steps, bank-offer banner, saved cards with preferred/offer card pre-selected, new card, Apple/Samsung Pay, VOX credit, Share Points, guest name/email/mobile fields, hold countdown); boarding-pass receipt with QR; booking, refund, transfer and feedback cards.
- Booking v2: one-sentence booking → seats held → Review & Pay; up to 3 alternatives when a time isn't available; "usual cinema" confirm; 6-minute hold bar with 2:00 / 0:45 warnings that also make the assistant speak; automatic re-hold on expiry; same-device resume for 30 minutes; 60-second inactivity nudge; tickets first, F&B as a separate quick order after the QR.
- Location bar (GPS or area) drives "near me"; remembered per device.
- Embeddable: `<script src="https://voxi-demo.up.railway.app/embed/voxi.js" charset="utf-8" defer></script>` — options `data-lang`, `data-open`, `data-api`, `data-theme` (`navy` default) or `window.VoxiConfig`; page API `Voxi.open/login/logout/unmount`.

## 7. Journeys covered (22 scope items)

Showtimes & film info · cinema info & directions · age restrictions · general FAQ · offers & bank offers · guided booking with seats and F&B · quick one-shot booking · payment (saved card / new card / wallets / credit / points) · booking status · cancellation & refund with policy checks · swap (carries F&B) · in-mall / experiences · F&B pre-order and separate F&B order · loyalty balance & redemption · personalised recommendations (history, language, family) · feedback & rating · complaint logging · transfer to Customer Care (simulated Genesys handover) · dashboard reporting · Arabic end-to-end · guest identity verification (last-4 phone / email). Coverage table in `docs/05-scope-traceability.md` and `docs/08-e2e-validation-report.md`.

## 8. Data in the mock

| Data | Detail |
|---|---|
| Cinemas | 22 VOX UAE cinemas with real addresses/coordinates |
| Films / sessions | 104 films, 3,654 sessions (7–9 Sep + advance 11–13 Sep capture) — **re-capture before a later demo date** |
| Pricing | per seat area (Regular / Premium / Preferred View), VAT-inclusive, no booking fee |
| F&B | real City Centre Deira menu, 126 items, sizes/drink modifiers, images on assets.voxcinemas.com |
| Offers | bank offers (ENBD, ADCB, HSBC, Mashreq, CBD…) with BIN rules, BOGO = exactly 2 tickets, monthly limit enforced; promo MONDAY30 |
| Personas | Sara (SHARE Gold), Rahul (Silver), James (Platinum), guest bookings — credentials in `docs/04-demo-script.md` |
| Seat hold | 6 minutes, extended on each order change (Vista behaviour simulated) |

## 9. Verification state

- Unit/integration: 64 tests green on `09cee73`.
- Live harness (`infra/e2e/live-harness.js`): 118/120 on a fresh seed (2 state-dependent).
- ElevenLabs simulation tests VOXI-01…16: 14/16 (rest evaluator/state artefacts).
- Manual live runs today: Booking v2 end-to-end as Rahul (alternative → ADCB BOGO → pay WH4YB5F → F&B WDBNXS7) and as Sara (usual cinema, warnings, nudge, auto re-hold); rename verified in header, launcher, first message and self-introduction.
- Latest conversation review (this afternoon, 7 sessions): no hallucinations; five improvements identified — default cinema for time-only searches, "already started" wording and cut-off filtering on chips, no re-hold for started shows, single question when an order is pending, stricter fuzzy film match. **Not yet applied.**

## 10. Open items

1. Apply the five fixes from today's conversation review (≈1 h incl. tests + deploy).
2. Reseed production (`SEED_FORCE=true` for one deploy) right before the demo; re-capture showtimes if the demo is after 13 Sep.
3. Railway: upgrade Trial → Hobby before demo day; optionally move to EU region.
4. Revoke the temporary GitHub push token (still active; Railway deploys via its own GitHub app).
5. Optional: ElevenLabs post-call webhook → dashboard transcripts/sentiment; `ELEVENLABS_API_KEY` on Railway for signed URLs; Genesys Open Messaging credentials for a real handover.
6. Needs VOX IT: booking search/refund endpoint variant, Offers Engine contract, customer-profile source, real Vista/Checkout credentials.
