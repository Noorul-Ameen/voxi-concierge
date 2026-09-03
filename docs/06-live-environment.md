# 06 — Live environment (deployed 3 Sep 2026)

| Component | Where | URL / id |
|---|---|---|
| Demo site (widget + dashboard) | Railway `web` | https://web-production-f54a1.up.railway.app (dashboard at `/dashboard`) |
| Concierge API | Railway `concierge-api` | https://concierge-api-production-3d90.up.railway.app (`/healthz`, `/openapi.json`) |
| Vista mock, worker, Postgres | Railway (private network only) | `vista-mock.railway.internal:4010`, `postgres.railway.internal:5432` |
| Railway project | workspace "noorul-ameen's Projects" | project `voxi-concierge` (id `52e8f8a4-19fd-41a1-8978-6c60ee8f930a`) |
| Source | GitHub | https://github.com/Noorul-Ameen/voxi-concierge (`main` auto-deploys) |
| ElevenLabs agent | EU-residency workspace | `agent_1001m1m6rghcfsr8nrpj5x08g16e` — 39 webhook tools + 12 client tools (`infra/elevenlabs-tool-ids.json`), 11 KB docs, RAG (multilingual e5), EN default (flash v2) + AR preset (flash v2.5) |

## Things that are specific to this deployment
- **EU data residency**: the agent lives in the EU workspace, so the widget must open its socket to `api.eu.residency.elevenlabs.io`. The API exposes this as `wsOrigin` on `/widget/signed-url` (from `ELEVENLABS_BASE_URL`), and the widget maps it to the React SDK's `serverLocation`. The global host answers "agent not found" for this agent.
- **English TTS model**: ElevenLabs requires `eleven_flash_v2` (or turbo v2) for an English-default agent; the Arabic language preset overrides to `eleven_flash_v2_5`.
- **Tool auth**: tools send `x-voxi-key` = `TOOL_HMAC_SECRET` (set on Railway). Rotate by changing the Railway variable and re-running the deploy script (or editing the 39 tools' header).
- **Seeding**: `bootstrap.js` runs before every `concierge-api` deploy — migrations always, seed only when the catalogue is empty. To reset demo data before a demo: set `SEED_FORCE=true` on `concierge-api`, redeploy, then remove it.
- **Region**: Railway default (US-West). Tool round-trips measured from Dubai: 170–390 ms. Moving to Railway's EU region (Amsterdam) is a per-service setting in the dashboard and would shave ~100 ms.
- **Plan**: the Railway workspace is on Trial — upgrade to Hobby before demo day so the services are not paused.

## Not yet configured (optional)
- ElevenLabs **post-call webhook** → `https://concierge-api-production-3d90.up.railway.app/webhooks/elevenlabs` with secret `ELEVENLABS_WEBHOOK_SECRET` (Railway variable). Set in the ElevenLabs console under Agents → Settings → Post-call webhook (needs workspace admin). Until then the dashboard is fed by the concierge's own event log, which already covers tool calls, actions, journeys, transfers, complaints and feedback; the webhook adds ElevenLabs' transcript, sentiment and evaluation results.
- `ELEVENLABS_API_KEY` on Railway enables signed URLs (private agent) — currently the agent is public with an origin allowlist (`web-production-f54a1.up.railway.app`, `localhost`, `elevenlabs.io`).
- Genesys Open Messaging (`HANDOVER_ADAPTER=genesys`, `GENESYS_*`) — simulated adapter is active.

## Live verification (3 Sep 2026)
- Backend: 25 read/write tools exercised over HTTPS from Dubai; 3 concurrent confirmations → 1 action; full booking (tickets → seats → F&B → ENBD BOGO → card → QR `VNVWSA8`); swap `JWIMX42 → X9HJLRH`; bank-offer and cut-off refusals; complaint `CMP-2026-000001`; simulated transfer; feedback; dashboard populated.
- Agent (text, via ElevenLabs EU): login → find → prepare → confirm → cancel `VXA7K2M` (action ledger `cancel_booking: succeeded`); Arabic offers query answered in Arabic; guided booking started with tools; widget in Chrome connected, showtime cards rendered.
- Voice: needs a microphone on the tester's machine — see `docs/04-demo-script.md`.
