# Voxi — Solution Architecture

**Product:** VOX 2.0 Digital Concierge ("Voxi") — Phase 1 + Phase 2 demo, production-grade, portable.
**Author:** Solution Architecture (prepared with Noorul Ameen, MAF Customer Care Solutions)
**Date:** 3 September 2026 · **Status:** Approved for build (decisions D1–D4 below)

---

## 1. Objectives and constraints

| # | Objective | How the architecture satisfies it |
|---|---|---|
| O1 | Full Phase 1 + Phase 2 functional scope (features 1–22) | Every feature maps to a concierge *capability* (§6) backed by a tool, a knowledge-base document, or a UI component. Nothing is "display only". |
| O2 | Purely conversational, voice + text, EN/AR | ElevenLabs Agent is the only conversational surface; the UI never has forms that bypass the agent. Rich cards are *driven by* the agent through client tools. |
| O3 | Conversation must not disturb action execution under concurrent input | Actions are **asynchronous, idempotent, and serialised per conversation** through an Action Ledger (§7). The agent never executes state-changing logic itself; it *requests* an action and later *reads* its outcome. |
| O4 | Portable: lift out and run on another architecture later | Hexagonal layout, Hono (runs on Node, Bun, Cloudflare Workers, AWS Lambda), Drizzle ORM (Postgres today; D1/SQLite/MySQL tomorrow), Docker Compose, no vendor lock-in in business logic. Vista, ElevenLabs, Genesys, Offers Engine are all *adapters* behind ports. |
| O5 | Vista fidelity so go-live is an endpoint + credential swap | `apps/vista-mock` reproduces the VOX Apigee partner API byte-for-byte (paths, headers, OAuth handshake, OData syntax, V1 `Result` semantics). The middleware talks to it through `packages/vista-client`, whose only configuration is `VISTA_BASE_URL`, `VISTA_API_KEY`, `VISTA_CLIENT_SECRET`. |
| O6 | Production-grade quality | TypeScript strict, Zod validation at every boundary, OpenAPI generated from code, unit + integration + concurrency tests, structured logging with correlation IDs, migrations, health checks, secrets via env, CI on every push. |

**Decisions taken (3 Sep 2026)**
- **D1** One Git monorepo owned by MAF; Lovable builds the UI connected to GitHub so UI code lives in the repo.
- **D2** Runtime: Node 22 + Postgres 16 in Docker Compose. Code kept runtime-agnostic (Hono + Drizzle) so Cloudflare Workers/D1 is a config-level port.
- **D3** Transfer to agent: real Genesys Cloud handover (Open Messaging), summary carried as message metadata / OneView note.
- **D4** ElevenLabs agent created in the connected (EU residency) workspace; agent definition kept as code in the repo.

---

## 2. Context (C4 level 1)

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                       Customer (web / app)                    │
                    └───────────────┬──────────────────────────────┬───────────────┘
                                    │ voice + text                 │ rich UI events
                        ┌───────────▼───────────┐       ┌─────────▼──────────┐
                        │  ElevenLabs Agent     │◄──────┤  Voxi Widget (UI)  │
                        │  (LLM, STT, TTS, RAG) │ client│  Lovable / React   │
                        └───────────┬───────────┘ tools └─────────┬──────────┘
                    server tools    │ HTTPS + HMAC                 │ REST / SSE
                        ┌───────────▼──────────────────────────────▼──────────┐
                        │            Concierge API (middleware)               │
                        │  capabilities · policies · action ledger · events   │
                        └───┬───────────────┬───────────────┬────────────────┘
                            │               │               │
                 ┌──────────▼────┐  ┌───────▼───────┐  ┌────▼─────────────┐
                 │ Vista (mock → │  │ Genesys Cloud │  │ Offers / Loyalty │
                 │ Apigee prod)  │  │ Open Messaging│  │ / OneView (mock) │
                 └───────────────┘  └───────────────┘  └──────────────────┘
```

Only the **Vista** box changes at go-live. Offers Engine, Loyalty and OneView are mocked inside `vista-mock` under their own route prefixes so they can be re-pointed independently when VOX IT exposes them.

---

## 3. Containers (C4 level 2) and repository layout

```
voxi/
├── apps/
│   ├── vista-mock/        Vista-shaped mock API (Apigee partner API + booking/refund + offers + loyalty + customer)
│   ├── concierge-api/     Middleware: agent tools, action ledger, policies, webhooks, reporting API
│   ├── worker/            Action executor + schedulers (order expiry, scrape refresh, metrics rollup)
│   ├── scraper/           VOX website extraction → Vista-shaped seed (cinemas, films, sessions)
│   └── web/               Widget + dashboard (React/Vite, authored via Lovable on GitHub)
├── packages/
│   ├── db/                Drizzle schema, migrations, seed, repositories
│   ├── vista-client/      Typed client for the Vista/Apigee API (the only thing swapped at go-live)
│   ├── domain/            Pure business rules: cancellation eligibility, refund policy, swap rules, recommendations
│   ├── contracts/         Zod schemas + OpenAPI for tool I/O, events, widget messages (shared by agent, API, UI)
│   └── agent/             ElevenLabs agent as code: prompts (EN/AR), tool definitions, KB manifest, deploy script
├── infra/                 docker-compose, Dockerfiles, env templates, Postman, k6 concurrency test
└── docs/                  this document, ADRs, runbooks, demo script, go-live swap guide
```

### 3.1 `vista-mock` (port 4010)
Reproduces `https://api-{env}.maflec.com/vistatickets/vista/v2/` behaviour:

- `GET /v1/oauth/generate?grant_type=client_credentials` with `Authorization: Basic …` → `{access_token, expires_in}`; expiry produces the exact Apigee `fault` JSON.
- Every other route requires `x-api-key` + `Authorization: Bearer` (401/403 with Apigee-style faults).
- **OData V1**: `Cinemas`, `Films`, `ScheduledFilms`, `Sessions`, `CinemaOperators`, `FilmGenres` with `$format`, `$filter` (eq/ne/gt/ge/lt/le/and/or, string/datetime literals), `$select`, `$expand=Attributes`, `$top/$skip/$orderby`.
- **Data**: `/Data/Cinemas/{c}/sessions/{s}/tickets`, `/Data/Cinemas/{c}/sessions/{s}/seat-plan`, `/Data/concession-items-grouped-by-tabs`.
- **Ticketing (order lifecycle)**: `/Ticketing/Order/tickets`, `/Ticketing/Order/seats`, `/Ticketing/Order/concessions`, `/Ticketing/order`, `/Ticketing/order/payment`, `/Ticketing/order/cancel` — V1 semantics: HTTP 200 with `Result`/`ExtendedResultCode`/`ErrorDescription`; order expiry (10 min, extended on modification); seat holds released on cancel/expiry.
- **Booking & refund** (Vista-native shapes, not in partner doc): `POST /RESTBooking.svc/booking/search` (by booking id, email, phone, member id), `GET /RESTBooking.svc/booking/{bookingId}`, `POST /RESTBooking.svc/booking/refund` (full/partial, tender category CREDIT | EWALLET | LOYALTY), `POST /RESTBooking.svc/booking/cancel`.
- **Loyalty** `/RESTLoyalty.svc/member/validate`, `/RESTLoyalty.svc/member/{id}/balances` (Share Points, VOX Rewards).
- **Offers Engine** `/offers/v1/offers?cinemaId&sessionId&memberId`, `/offers/v1/offers/{id}/eligibility`, `/offers/v1/redemptions`.
- **Customer** `/customer/v1/customers/{id}` (profile, preferences, purchase history).
- **Concessions** grouped by tabs with dietary tags, images, combos; add-to-order supported.

### 3.2 `concierge-api` (port 4020)
- `/tools/*` — one endpoint per agent tool (§6), HMAC-signed by ElevenLabs, validated with Zod, returns **agent-friendly** JSON (plain language fields + `ui` hints for client tools).
- `/actions/*` — enqueue / status / result for state-changing actions (§7).
- `/events` — SSE stream per conversation for the widget (cards, action outcomes, transfer state).
- `/webhooks/elevenlabs` — post-call transcript + analysis ingestion (reporting).
- `/webhooks/genesys` — inbound messages from the human agent (Open Messaging) relayed to the widget.
- `/reporting/*` — metrics for the dashboard.
- `/healthz`, `/readyz`, `/openapi.json`.

### 3.3 `worker`
Consumes the action queue (Postgres-backed `SKIP LOCKED` queue, swappable for SQS/Cloudflare Queues), executes actions against the ports, writes outcomes, publishes events. Also runs cron: order expiry sweep, showtime refresh, metrics rollup, transcript backfill.

### 3.4 `web`
React + Vite + ElevenLabs React SDK (`@elevenlabs/react`). Components: Conversation panel (voice/text), MovieCard, ShowtimeGrid, CinemaCard, OfferCard, MenuCard, SeatMap, OrderSummary, PaymentSheet (simulated Checkout), QRTicket, BookingCard, FeedbackSurvey, TransferBanner, LanguageToggle. Dashboard route `/dashboard`. All UI state comes from agent client-tool calls or the SSE event stream — no standalone forms.

---

## 4. Data model (Vista-shaped, Postgres)

Vista tables keep Vista field names (PascalCase in JSON, snake_case in DB, mapped in `packages/db`).

**Reference data:** `cinemas` (ID, Name, NameAlt, Address1, City, Latitude, Longitude, ParkingInfo, TimeZoneId, CurrencyCode, opening hours, accessibility, mall directions), `films` (ID = `{CinemaId}-{HO}`, ScheduledFilmId, Title, TitleAlt, Rating, Synopsis, SynopsisAlt, OpeningDate, RunTime, TrailerUrl, genres[], cast[], language, subtitles, poster/hero URLs, status: now-showing | coming-soon | advance), `scheduled_films`, `sessions` (ID `{CinemaId}-{SessionId}`, Showtime, ScreenName, SeatsAvailable, CinemaOperatorCode (experience), Attributes[], SalesChannels, SoldoutStatus, PriceGroupCode), `cinema_operators`, `film_genres`, `session_attributes`.

**Commerce:** `ticket_types` (per experience/area category), `screens` + `seat_layouts` (per experience template), `session_seat_state` (seat status per session, JSONB, versioned), `concession_items` (tabs, dietary tags, images, combos), `orders` (UserSessionId, state machine, ExpiryDateUtc, totals, applied offers), `order_lines`, `bookings` (VistaBookingId, VistaBookingNumber, customer, tickets w/ seats, concessions, payments, status: confirmed | cancelled | refunded | partially_refunded | swapped, `version` for optimistic locking), `payments`, `refunds`.

**Customer & loyalty:** `customers` (id, name, email, phone, memberId, preferences, language), `loyalty_accounts` (SharePoints, VoxRewards balances, ledger), `purchase_history`.

**Offers:** `offers` (id, title, titleAlt, image, type: bank | promo | loyalty | member, rules JSONB, remaining balance), `offer_redemptions`.

**Concierge:** `conversations` (elevenlabs conversation id, channel, language, customer, status), `conversation_events` (append-only), `actions` (Action Ledger, §7), `complaints`, `feedback`, `transfers` (Genesys conversation id, summary, status), `kb_documents` (source, hash, uploaded id).

**Reporting:** `metrics_daily` rollups; `transcripts`.

---

## 5. Runtime views

### 5.1 Read journey (e.g. "What's showing at Mall of the Emirates tonight in MAX?")
1. Agent calls tool `search_sessions` (cinema, date, experience, film filters).
2. Concierge validates, resolves cinema by fuzzy name/alias, queries `vista-client` (`OData/Sessions` + `ScheduledFilms`) → normalises to a compact list.
3. Response includes `speech` (what to say) and `ui.cards` (ShowtimeGrid). Agent speaks; widget renders via client tool `render_cards`.

### 5.2 Write journey (e.g. "Cancel my booking WL59LFJ")
1. `find_booking` (read) → booking summary + `eligibility` from `packages/domain` (ByD ValidateBooking rules).
2. Agent confirms with the customer, then calls `request_action` `{type: cancel_booking, bookingId, refundMethod, idempotencyKey}`.
3. Concierge writes an `actions` row (`queued`) and returns immediately with `actionId` and a spoken acknowledgement. Conversation continues.
4. Worker picks the action, executes `vista.refundBooking` under a **per-booking advisory lock** and **optimistic version check**, writes `succeeded|failed` + result, emits SSE `action.completed`.
5. Agent tool `get_action_result` (or a client-tool push) returns the outcome; agent narrates the summary: cancelled, refund amount, method, ETA.

### 5.3 Guided booking (Phase 2)
Order state machine: `draft → tickets_added → seats_selected → concessions_added? → offers_applied? → awaiting_payment → paid | expired | cancelled`. Each transition is an action (idempotent). The widget's SeatMap sends selections through the agent (client tool → `select_seats` action), never directly to Vista. Payment is a simulated Checkout adapter (`PaymentPort`): card (test PAN rules incl. declined case), wallet, Share Points, VOX Rewards; on success `complete_order` yields `VistaBookingId` + QR (payload = booking id) and the booking becomes visible to Booking Status Check and Cancellation flows.

### 5.4 Transfer to human (Genesys)
Trigger: explicit ask, sentiment/frustration detected by the agent, or two consecutive fallbacks. Action `transfer_to_agent` → summary generated from the conversation events → Genesys Open Messaging inbound message with summary + customer attributes (OneView note mocked as `transfers.summary`) → widget switches to "human agent" mode; subsequent widget messages route to Genesys via concierge; agent replies come back through `/webhooks/genesys` → SSE.

---

## 6. Capability map (scope → implementation)

| # | Feature | Tools (server) | Client tools (UI) | Data / policy |
|---|---|---|---|---|
| 1 | Movie Information | `search_films`, `get_film`, `search_sessions`, `suggest_alternatives` | `render_cards(movie|showtimes)`, `play_trailer` | Scraped films/sessions; alternatives = relax filters in order (time → experience → cinema → date) |
| 2 | Cinema Information | `list_cinemas`, `get_cinema`, `nearest_cinemas(lat,lng)` | `request_location`, `render_cards(cinema)` | Real cinema list + coordinates; hours/accessibility seed |
| 3 | Age Restrictions | KB + `get_film.rating` + `get_experience_rules` | — | KB docs per market/experience |
| 4 | General Information | KB (RAG) | `open_link` | KB extracted from uae.voxcinemas.com |
| 5 | Promos & Offers Info | `list_offers`, `check_offer_eligibility` | `render_cards(offer)` | Mock Offers Engine |
| 6 | Booking Information | `how_to_book` (KB) + `search_sessions` deep links | `open_link` | Deep links `uae.voxcinemas.com/booking/{c}-{s}` |
| 7 | Ticket Cancellation | `find_booking`, `check_cancellation_eligibility`, action `cancel_booking` | `render_cards(booking)`, `confirm_dialog` | ByD ValidateBooking rules in `packages/domain` |
| 8 | Refunds & Swaps | action `refund_booking`, action `swap_booking` (cancel+rebook atomic saga, price difference handling) | `render_cards(showtimes)` | Refund policy: VOX credit / Share Points; card refund path configurable |
| 9 | In-mall Location | KB per cinema + `get_cinema.directions` | `render_cards(cinema)` | Seed directions/parking |
| 10 | Reporting & Insights | `/reporting/*` | Dashboard | Post-call webhook + events |
| 11 | Voice & Text EN/AR | ElevenLabs config: multilingual, language detection, pronunciation dictionary | `set_language` | Keyword list in `packages/agent/keywords.json` |
| 12 | Transfer to Agent | action `transfer_to_agent`, `summarize_conversation` | `set_mode(human)` | Genesys Open Messaging adapter |
| 13 | F&B Information | `browse_menu(cinema, tab, dietary)` | `render_cards(menu)` | Mock concessions |
| 14 | Pre-order F&B | action `add_concessions` | `render_order_summary` | Order lifecycle |
| 15 | Guided Booking | `search_sessions`, `get_ticket_types`, `get_seat_plan`, actions `start_order`, `add_tickets`, `select_seats`, `complete_order` | `render_seat_map`, `render_order_summary`, `render_qr` | Order state machine, seat holds |
| 16 | Apply Promos & Offers | action `apply_offer`, `redeem_points` | `render_order_summary` | Offer rules engine (discount lines) |
| 17 | Payment | action `pay_order(method)`, `get_loyalty_balance` | `render_payment_sheet` | PaymentPort (simulated Checkout) |
| 18 | Booking Status Check | `get_session_context` (logged-in vs guest), `find_booking`, `list_my_bookings` | `render_cards(booking)` | Customer profiles |
| 19 | Feedback Survey | action `submit_feedback` | `render_feedback` | `feedback` table (OneView mock) |
| 20 | Complaint Management | action `create_complaint` | `render_cards(complaint)` | `complaints` table, transfer fallback |
| 21 | Personalisation | `get_recommendations` | `render_cards(movie|menu)` | `packages/domain/recommendations` over profile + history |
| 22 | Omni-channel | Same agent exposed via ElevenLabs phone number / WhatsApp adapter (config only) | — | Channel recorded on conversation |

---

## 7. Concurrency and consistency model (objective O3)

**Problem.** In a voice+text widget the customer can talk over the agent, tap a card while speaking, or repeat "yes, cancel it" twice. The LLM may also re-issue a tool call after an interruption. None of that may produce duplicate refunds, double seat holds or half-completed swaps.

**Design.**

1. **Reads are synchronous and side-effect free.** Any tool that only reads Vista/DB executes inline and may run concurrently.
2. **Writes are actions, never inline.** State-changing tools return within ~50 ms after inserting an `actions` row; the worker executes them. The conversation is never blocked and a barge-in cannot cancel a half-executed write.
3. **Idempotency.** Each action carries an `idempotency_key` = `{conversationId}:{toolCallId}` (or an agent-supplied key). Unique index → the second identical request returns the *same* action (status + result) instead of executing again.
4. **Per-conversation serialisation.** The worker claims actions `FOR UPDATE SKIP LOCKED` ordered by `created_at`, but only one *running* action per `conversation_id` (partial unique index on `(conversation_id) WHERE status='running'`). Multiple inputs therefore queue in order; none interleave.
5. **Per-resource locking.** Execution takes a Postgres advisory lock on the target resource (`booking:{id}`, `order:{userSessionId}`, `session:{cinemaId}-{sessionId}` for seats) and checks `version` (optimistic locking). A stale version → `conflict` outcome with a spoken explanation ("that booking was already cancelled a moment ago").
6. **State machines, not flags.** Bookings and orders have explicit states; each action declares allowed *from* states. Illegal transitions fail fast with domain error codes the agent can narrate.
7. **Sagas for multi-step writes.** `swap_booking` = `refund_original` → `create_order` → `add_tickets` → `select_seats` → `pay` with compensations (`cancel_order`, `restore_booking`) recorded step-by-step in `actions.steps` so a crash mid-way resumes or compensates deterministically.
8. **Confirmation gate.** Destructive actions (cancel, refund, pay) require `confirmed: true` in the tool call *and* a matching `pending_confirmation` row created by the preceding `prepare_*` call within 5 minutes. A spoken "yes" cannot cancel a booking the agent never summarised.
9. **Outcome delivery is push + pull.** Worker emits SSE `action.completed` to the widget (client tool renders the result) and the agent can poll `get_action_result`. Both paths read the same ledger row, so narration is always consistent with what happened.
10. **Observability.** Every tool call, action, step and external call is logged with `conversation_id`, `action_id`, `correlation_id`. The ledger doubles as the audit trail required by refund policy.

---

## 8. Security

- ElevenLabs → concierge: per-tool HMAC secret in header, timestamp + nonce replay protection, allow-listed tool names.
- Widget → concierge: short-lived conversation token (JWT) issued at conversation start (binds conversationId + customer + channel); SSE and client-tool callbacks carry it.
- Concierge → Vista: OAuth token cache with early refresh; secrets from env/secret manager only; IP allow-listing handled at network layer.
- PII: no card PAN stored (simulated payment stores masked PAN only); customer fields encrypted at rest optional (pgcrypto); logs redact email/phone.
- Rate limiting on booking search and refund tools.

---

## 9. Portability checklist

| Concern | Today | Alternative without code change in business logic |
|---|---|---|
| HTTP runtime | Node 22 (`@hono/node-server`) | Cloudflare Workers, Bun, Lambda (Hono adapters) |
| Database | Postgres 16 (Drizzle) | D1/SQLite, MySQL, Neon, Supabase (Drizzle drivers; JSONB → JSON) |
| Queue | Postgres `SKIP LOCKED` | Cloudflare Queues, SQS, BullMQ (QueuePort) |
| Events to UI | SSE | WebSocket, Pusher, Supabase Realtime (EventPort) |
| Vista | `vista-mock` | Apigee prod: change `VISTA_BASE_URL`, key, secret |
| Human handover | Genesys Open Messaging | Salesforce Messaging, Zendesk (HandoverPort) |
| Payment | Simulated Checkout | Checkout.com hosted payments (PaymentPort) |
| Voice/LLM | ElevenLabs Agents | Any tool-calling agent runtime — tool contracts are OpenAPI in `packages/contracts` |
| UI | Lovable-authored React | Any framework consuming `/tools`, `/events`, contracts |

---

## 10. Milestones

| M | Deliverable | Exit criteria |
|---|---|---|
| M0 | This document, ADRs | Reviewed |
| M1 | Monorepo scaffold, Docker Compose, CI | `pnpm test` green, `docker compose up` serves health checks |
| M2 | Scraper + seed (real cinemas, films, sessions; dummy customers, bookings, offers, menu, seat layouts) | ≥ 20 cinemas, all now-showing films, 7 days of sessions with real Vista IDs |
| M3 | `vista-mock` complete | Partner-doc Postman collection passes; V1 semantics verified; contract tests |
| M4 | `concierge-api` + `worker` | All 22 capabilities' tools implemented; concurrency test (k6) shows zero duplicate side-effects under 50 concurrent identical requests |
| M5 | Knowledge base + agent as code + agent created | Agent answers KB and executes all tools in EN and AR |
| M6 | Widget + dashboard (Lovable) | All rich components driven by client tools; dashboard reads reporting API |
| M7 | Reporting pipeline | Post-call webhook ingested; metrics visible |
| M8 | Verification + docs | E2E scripts for every scope item; runbook; go-live swap guide; demo script |
