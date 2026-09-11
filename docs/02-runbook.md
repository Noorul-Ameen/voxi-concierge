# 02 — VOX Cinemas Virtual Assistant runbook

This runbook describes the current enhancement source. Confirm the deployed revision and agent version before treating it as live behavior. [Deployment identifiers](06-live-environment.md) and [acceptance requirements](13-concierge-enhancements.md) are separate from historical audit results.

See the [dated acceptance record](14-enhancement-acceptance.md) for current check results and outstanding gates. Local test/build completion and validation-branch simulations do not mean Railway, Cloudflare or the production agent has been promoted.

## Environment and prerequisites

Use Node 22+ and pnpm 10.28.0 from `package.json`, PostgreSQL, and the existing EU-residency ElevenLabs agent. Optional real human handover uses Genesys; the default adapter is simulated.

| Concern | Settings and behavior |
|---|---|
| Database | `DATABASE_URL`; every service must use the intended environment |
| Vista adapter | `VISTA_BASE_URL`, `VISTA_OAUTH_URL`, API/client credentials and sales channel |
| Mock hold | `VISTA_MOCK_ORDER_EXPIRY_MINUTES`; use the backend's actual returned expiry, not a UI constant |
| Demo accounts | `DEMO_SARA_PASSWORD`, `DEMO_RAHUL_PASSWORD`, `DEMO_JAMES_PASSWORD`; only email and password authenticate |
| Calendar | `VOX_WEEKEND_DAYS`, comma-separated JavaScript day numbers; default `6,0` (Saturday/Sunday), Dubai timezone |
| Rolling demo schedule | Requires both `VISTA_PROVIDER=mock` and `DEMO_SCHEDULE_REFRESH=true`; never enable for a real provider |
| Concierge | `CONCIERGE_PORT`, `CONCIERGE_PUBLIC_URL`, `TOOL_HMAC_SECRET`, `WIDGET_JWT_SECRET` |
| ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_BASE_URL=https://api.eu.residency.elevenlabs.io`, webhook secret |
| Reporting | `SEED_HISTORY=auto|off|force` and `SEED_HISTORY_DAYS`; report access uses the configured authorization |
| Handover | `HANDOVER_ADAPTER=simulated|genesys` and the relevant `GENESYS_*` credentials |
| Payments/policy | Simulated payment adapter; configured cancellation cutoff/refund methods remain authoritative |

Keep secrets in the environment or private local configuration. Do not put account passwords, authentication tokens, complete card data or secret-bearing exports in docs or test fixtures. Existing member IDs are internal references, not sign-in credentials.

## Local development

For a **new disposable local database**, start PostgreSQL, then run:

```sh
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm build:packages
```

Start the four processes separately: `pnpm dev:vista`, `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:web`. Keep shared packages built or run `pnpm dev:packages` during source edits. Default local ports are 4010, 4020 and 5173 for mock, API and web. Check `/healthz` on the mock/API and `/readyz` on the API. Docker Compose remains available through `infra/docker-compose.yml`.

Both conversational text and voice require the ElevenLabs connection. `DEV_TOOL_BRIDGE` is a development-only direct-tool route; it does not generate conversational replies.

## Data lifecycle

The full `db:seed` resets commerce, customer and concierge demo tables. It is suitable for disposable fixtures, not a routine refresh of a shared environment. Do not enable `SEED_FORCE` during a normal deployment.

Bootstrap applies migrations and performs the full seed only for an empty catalogue or explicit force. The versioned profile updater matches both the known demo customer ID and email, updates synthetic preference history, and preserves unrelated customers, real history, existing balances and bookings. Missing password hashes are provisioned from the three private password variables; later environment changes do not silently reset existing passwords.

The optional rolling schedule creates only synthetic future sessions, preserving sessions referenced by existing bookings/orders. It is gated by the two mock flags above. It does not make the captured catalogue a live VOX feed.

Synthetic reporting history is separate from purchase history and customer preference inference. `db:seed:history` replaces only its synthetic reporting rows. The dashboard can distinguish these from actual demo traffic.

## Booking, authentication and continuation

Sign-in is the host page's secure email/password surface, outside the widget. `login_customer` opens that page surface and never collects credentials in chat/voice. Widget identity comes from its authenticated token and database state; supplied customer/member/conversation IDs do not grant access. After login the widget displays only signed-in status, while account details remain on the page.

Conversation transport, account login, booking order and seat hold have separate lifecycles. Three minutes without user activity closes the conversation only. Reconnection retains authenticated same-device state and revalidates the actual order. Valid holds retain their original expiry; an expired hold preserves choices and requires explicit agreement before checking and holding seats again.

Unknown ticket quantity is asked, never defaulted to one. `quick_book` can hold known tickets and return an editable review. Optional selected snacks join the unpaid ticket basket before one checkout; food added after paid tickets remains a separate order. Payment, refund and cancellation use the current confirmed summary. The SHARE conversion remains 10 points = AED 1, including fractional points when cents require them.

## Agent configuration and coaching

The shared contracts define 44 server tools and 12 client tools. Film-language fields accept values such as Tamil/English/Arabic independently of the conversation's en/ar language. `infra/openapi.json` is regenerated from current contracts.

`agent:export` produces a reviewable configuration with a secret reference placeholder. The existing-agent `agent:deploy` script is a **remote mutation**: it creates replacement definitions for changed tools, reuses unchanged attached definitions, checks for an intervening agent version change, then patches only prompt/tool IDs. It does not replace the live voice, model, knowledge base or privacy configuration, and it does not delete shared tools.

For this enhancement the verified model/voice baseline is Gemini 3.6 Flash, temperature 0, minimal reasoning, and ElevenLabs v3 conversational with expressive/speculative behavior. Preserve the actual live settings unless a separate change is agreed. Do not rerun a full generated-config patch to overwrite a console change.

Validate a candidate branch/version before production promotion. The [simulation runbook](../packages/agent/coaching/SIMULATION-RUNBOOK.md) explains the complete tool-ID mapping, fail-closed mocks, 17 variants, repeat runs and evidence. Coaching is an offline review/evaluation loop; it adds no second model to the live path and does not learn automatically from customer conversations.

## Verification and promotion

1. Run type checking and lint, then the relevant unit/integration tests. The root test command builds shared packages before serial workspace tests. API suites explicitly require local isolated databases ending in `_test`; do not run ad hoc reset scripts against the shared demo.
2. Review real API order results for quantity, seats, snacks, offers, totals, consent, recovery and idempotency. Verify all three email/password accounts plus a guest.
3. Run the 17 candidate ElevenLabs simulations and inspect each transcript/tool trace. A generated JSON file or historical green report is not a passed conversation test.
4. Exercise the shared widget on Railway and the Cloudflare host, desktop and mobile. Verify same-device resume, actual hold expiry, three-minute inactivity, language switching, keyboard/seat-map use and account isolation.
5. Listen to actual English/Arabic voice runs, including interruption and text/voice switching. Record latency and the tested voice/model settings.
6. Record code revision, service deployments, agent version/tool IDs, migrations, test results and remaining limitations. Promote only the reviewed candidate; retain the previous agent configuration and deployment revision for rollback.

## Troubleshooting

| Symptom | Check |
|---|---|
| Agent not found or socket refused | Correct EU-residency origin, agent ID, signed URL and current origin settings |
| Sign-in fails | Both email/password required; account hash provisioned; do not fall back to PIN/member ID |
| Tools unauthorized | Shared tool-secret configuration or HMAC age; do not print secret headers |
| Action remains pending | Worker health and durable ledger/lease state; query outcome before issuing another action |
| No matching screening | Requested date/window/language/cinema and actual mock schedule; avoid destructive reseeding as the first response |
| Expired hold | Preserve choices, ask for a new hold, then recheck availability; never reset the clock locally |
| Profile and history times differ | API wall time must be interpreted as Dubai time, independent of browser timezone |
| Missing/repeated cards after reconnect | Token/auth generation, event sequence and current order state; do not fabricate client cards |
