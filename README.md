# VOX Cinemas Virtual Assistant

A voice and text cinema concierge for English and Arabic, built on the existing ElevenLabs agent, Railway API and React widget. The same widget is used by the standalone Railway demo and the Cloudflare-hosted website.

The current enhancement adds email/password sign-in, history-backed recommendations, compact booking steps, optional snacks before one checkout, and explicit consent before replacing an expired seat hold. See [the current behavior and acceptance guide](docs/13-concierge-enhancements.md).

This is a demonstration system: the catalogue starts from a captured VOX website snapshot; an explicitly enabled synthetic schedule can keep demo screenings current. Accounts, bookings, seat plans, offers, loyalty and payments are simulated. A real integration requires provider-contract, identity, payment and operational validation; changing an endpoint alone does not establish production readiness.

## Architecture

ElevenLabs handles conversation and calls 44 server tools. The concierge API validates inputs and authenticated session state, reads catalogue/profile data, and coordinates booking actions through the Vista-shaped mock and durable action worker. Twelve client tools and server events drive the shared widget. The API and order state determine the functional UI; the model supplies concise wording.

| Path | Purpose |
|---|---|
| `apps/concierge-api` | Tool routes, secure widget sessions, profile/history, events, webhooks and reporting |
| `apps/vista-mock` | Simulated Vista/Apigee catalogue, orders, booking management, loyalty, offers and accounts |
| `apps/worker` | Durable action execution and simulated handover |
| `apps/web` | Shared React widget, Railway demo page and dashboard |
| `apps/scraper` | Captured VOX reference content and catalogue |
| `packages/contracts` | Shared tool and event schemas |
| `packages/domain` | Recommendations, history inference, offers, policy and geography |
| `packages/db` | Schema, migrations, initial fixtures and bounded demo updates |
| `packages/vista-client` | Provider adapter, authentication, retries and result handling |
| `packages/concierge-core` | Booking journeys, confirmation gates, state, actions and handover |
| `packages/agent` | Prompt/configuration, tool generation and offline coaching/regressions |
| `infra` | Deployment, OpenAPI, Postman and test utilities |

## Demo and embedding

The deployment targets are the [Railway demo](https://voxi-demo.up.railway.app) and the [Cloudflare website](https://voxi.kris-pradip.workers.dev/). Current deployment/version evidence belongs in the acceptance record; source changes are not proof that either target has been promoted.

```html
<script src="https://voxi-demo.up.railway.app/embed/voxi.js" charset="utf-8" defer></script>
```

The embed mounts the VOX Cinemas Virtual Assistant in a Shadow DOM. Supported settings include `data-lang="ar"`, `data-open="true"`, `data-theme="navy"`, `data-api`, and `window.VoxiConfig`. The host can call `Voxi.open()`, `Voxi.login()`, `Voxi.logout()`, `Voxi.profile()` and `Voxi.unmount()`. These global names, package scopes, URLs and asset filenames remain technical compatibility identifiers; they are not the displayed product name.

## Local setup

Use Node 22 or newer and the repository's pinned pnpm 10.28.0. Load environment settings from a private local file or shell. Provision the three demo passwords through `DEMO_SARA_PASSWORD`, `DEMO_RAHUL_PASSWORD` and `DEMO_JAMES_PASSWORD`; passwords are hashed and never displayed as demo hints.

For a fresh, disposable local database:

```sh
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres
pnpm db:migrate
pnpm db:seed
pnpm build:packages
```

Run `pnpm dev:vista`, `pnpm dev:api`, `pnpm dev:worker` and `pnpm dev:web` in separate terminals. The web page is at `http://localhost:5173`. Voice **and natural-language text conversation** use ElevenLabs; the development tool bridge is an explicit API testing facility, not a replacement conversational model.

The full seed resets demo data. Do not use it as a routine update to a populated shared environment. The deployment bootstrap applies migrations, provisions missing account hashes, and updates only recognized demo-profile records; the optional schedule refresh is separately gated. See [the runbook](docs/02-runbook.md).

## Verification

Run `pnpm typecheck`, `pnpm lint` and `pnpm test` against the intended isolated test environment. Database suites reset local test fixtures; do not point them at the demo database. Report actual results rather than relying on historical test counts.

The [simulation runbook](packages/agent/coaching/SIMULATION-RUNBOOK.md) defines 17 mocked ElevenLabs simulations covering the 13 agreed scenario groups. Provider results, browser checks on both hosts, mobile layout, and actual English/Arabic voice checks are separate acceptance gates.

Operational details: [runbook](docs/02-runbook.md), [demo script](docs/04-demo-script.md), [deployment identifiers](docs/06-live-environment.md), [current enhancement guide](docs/13-concierge-enhancements.md). Older architecture and audit documents describe earlier snapshots and are not evidence that the current candidate passed.
