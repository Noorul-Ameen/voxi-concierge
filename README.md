# Voxi — VOX 2.0 Digital Concierge (Phase 1 + Phase 2 demo)

A production-grade, portable implementation of the **VOX 2.0 Digital Concierge** re-prioritised
scope (22 features across Phase 1 and Phase 2), showcased with **ElevenLabs Agents** (voice + text,
EN/AR) and a **Lovable**-buildable React widget.

Movies, cinemas and showtimes are **real** (extracted from uae.voxcinemas.com). Everything else —
bookings, customers, loyalty, offers, F&B, seat plans, payments — is dummy data held in a local
Postgres database exposed through a **Vista Connect / VOX Apigee-shaped mock API**. Going live is an
endpoint + credentials swap (see `docs/03-go-live-swap.md`).

```
ElevenLabs Agent ──webhook tools──▶ concierge-api ──▶ vista-client ──▶ vista-mock (Apigee/Connect shape)
        ▲                               │  ▲                              │
        │ client tools / SSE            │  │ Action Ledger + worker       ▼
   Web widget (React, Lovable)  ◀───────┘  └──────── Postgres (reference + commerce + concierge)
```

## Repository layout

| Path | Purpose |
|---|---|
| `apps/vista-mock` | Vista Connect V1 / Apigee mock: OAuth handshake, OData reference data, Ticketing order lifecycle, RESTBooking search/refund/cancel, RESTLoyalty, Offers Engine, Customer profile |
| `apps/concierge-api` | Concierge orchestration API (Hono): 39 agent tools, widget session/SSE endpoints, ElevenLabs + Genesys webhooks, reporting, OpenAPI |
| `apps/worker` | Action executor — drains the Action Ledger so write actions run exactly once, independent of the conversation |
| `apps/web` | React widget + demo page + reporting dashboard (import into Lovable) |
| `apps/scraper` | Extracts real films/cinemas/showtimes + KB pages from the VOX website (browser-driven snapshot committed under `out/`) |
| `packages/db` | Drizzle schema, migrations, seed (real catalogue + dummy personas/bookings/offers/menu) |
| `packages/contracts` | Zod schemas for every tool, client tool, event and error — the single source of truth for ElevenLabs tool definitions, OpenAPI and the widget |
| `packages/domain` | Pure business rules: cancellation/refund policy, offers, recommendations, geo, spoken-name matching |
| `packages/vista-client` | The **only** module that changes at go-live (base URL, OAuth, retries, V1 result-code handling) |
| `packages/concierge-core` | Action Ledger, executor, confirmation gate, swap saga, handover port (simulated / Genesys), event bus |
| `packages/agent` | ElevenLabs agent-as-code: system prompt, tool export, KB build, deploy script |
| `infra` | Docker Compose, Dockerfiles, nginx, CI, e2e (Playwright), concurrency proof, OpenAPI + Postman collections |
| `docs` | Architecture, runbook, go-live swap, demo script, scope traceability |

## Live demo

Demo site: https://voxi-demo.up.railway.app · API: https://concierge-api-production-3d90.up.railway.app · details in `docs/06-live-environment.md`.

### Embed the widget on any page

```html
<script src="https://voxi-demo.up.railway.app/embed/voxi.js" charset="utf-8" defer></script>
```

One script tag adds the "Ask Voxi" launcher to the bottom-right of the page (`apps/web/src/embed.tsx`, built by `vite.embed.config.ts` into `dist/embed/voxi.js`, ~245 KB gzipped, React included). It renders in a Shadow DOM, so the host page's CSS and the widget's never interfere. Options: `data-lang="ar"` (start in Arabic), `data-open="true"` (start expanded), `data-api="https://…/api"` (another concierge API; default is the script's origin + `/api`), or `window.VoxiConfig = { apiBase, lang, open }` before the tag. The page can call `Voxi.open()`, `Voxi.login()`, `Voxi.logout()`, `Voxi.unmount()`. Example host page: https://voxi-demo.up.railway.app/embed/demo.html. Every hostname that embeds the widget must be on the ElevenLabs agent's origin allowlist (or the allowlist must be empty), otherwise the socket is refused with "Host … is not allowed to connect to this agent".

## Quick start

```bash
pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d postgres
pnpm db:migrate && pnpm db:seed && pnpm db:seed:history   # real catalogue + demo personas + synthetic dashboard history
infra/dev-up.sh            # vista-mock :4010, concierge-api :4020, worker, web :5173
open http://localhost:5173 # demo page (text mode works without ElevenLabs credentials)
```

Full stack in Docker: `docker compose -f infra/docker-compose.yml up --build` (web on :8080).

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm test      # unit + integration (mock 22, concierge 16, domain 10, events 1)
node infra/load/concurrency.mjs               # 6 concurrency invariants (idempotency, single-writer, seat races)
node infra/e2e/booking.mjs                    # Playwright: full guided booking → QR in the widget
```

See `docs/02-runbook.md` for environment variables, ElevenLabs agent deployment, Lovable import and
Genesys handover configuration; `docs/05-scope-traceability.md` maps each of the 22 scope items to
code and test evidence.
