# 06 — Live environment (deployed 3 Sep 2026)

| Component | Where | URL / id |
|---|---|---|
| Demo site (widget + dashboard) | Railway `web` | **https://voxi-demo.up.railway.app** (dashboard at `/dashboard`) — renamed from `web-production-f54a1.up.railway.app` on 7 Sep 2026; the old link no longer resolves |
| Concierge API | Railway `concierge-api` | https://concierge-api-production-3d90.up.railway.app (`/healthz`, `/openapi.json`) |
| Vista mock, worker, Postgres | Railway (private network only) | `vista-mock.railway.internal:4010`, `postgres.railway.internal:5432` |
| Railway project | workspace "noorul-ameen's Projects" | project `voxi-concierge` (id `52e8f8a4-19fd-41a1-8978-6c60ee8f930a`) |
| Source | GitHub | https://github.com/Noorul-Ameen/voxi-concierge (`main` auto-deploys) |
| ElevenLabs agent | EU-residency workspace | `agent_1001m1m6rghcfsr8nrpj5x08g16e` — 39 webhook tools + 12 client tools (`infra/elevenlabs-tool-ids.json`), 11 KB docs, RAG (multilingual e5), EN default (flash v2) + AR preset (flash v2.5) |

## Embedding the widget elsewhere
`https://voxi-demo.up.railway.app/embed/voxi.js` is a drop-in script (see README "Embed the widget on any page"; live example at `/embed/demo.html`). Add the embedding page's hostname to the ElevenLabs agent allowlist first. The API already allows any origin (CORS `*`) and the embed calls it through the web service's `/api` proxy, so nothing else needs configuring.

## Things that are specific to this deployment
- **EU data residency**: the agent lives in the EU workspace, so the widget must open its socket to `api.eu.residency.elevenlabs.io`. The API exposes this as `wsOrigin` on `/widget/signed-url` (from `ELEVENLABS_BASE_URL`), and the widget maps it to the React SDK's `serverLocation`. The global host answers "agent not found" for this agent.
- **English TTS model**: ElevenLabs requires `eleven_flash_v2` (or turbo v2) for an English-default agent; the Arabic language preset overrides to `eleven_flash_v2_5`.
- **Tool auth**: tools send `x-voxi-key` = `TOOL_HMAC_SECRET` (set on Railway). Rotate by changing the Railway variable and re-running the deploy script (or editing the 39 tools' header).
- **Seeding**: `bootstrap.js` runs before every `concierge-api` deploy — migrations always, seed only when the catalogue is empty. To reset demo data before a demo: set `SEED_FORCE=true` on `concierge-api`, redeploy, then remove it.
- **Region**: Railway default (US-West). Tool round-trips measured from Dubai: 170–390 ms. Moving to Railway's EU region (Amsterdam) is a per-service setting in the dashboard and would shave ~100 ms.
- **Plan**: the Railway workspace is on Trial — upgrade to Hobby before demo day so the services are not paused.

## Not yet configured (optional)
- ElevenLabs **post-call webhook** → `https://concierge-api-production-3d90.up.railway.app/webhooks/elevenlabs` with secret `ELEVENLABS_WEBHOOK_SECRET` (Railway variable). Set in the ElevenLabs console under Agents → Settings → Post-call webhook (needs workspace admin). Until then the dashboard is fed by the concierge's own event log, which already covers tool calls, actions, journeys, transfers, complaints and feedback; the webhook adds ElevenLabs' transcript, sentiment and evaluation results.
- `ELEVENLABS_API_KEY` on Railway enables signed URLs (private agent) — currently the agent is public with an origin allowlist: `voxi-demo.up.railway.app`, `web-production-f54a1.up.railway.app`, `elevenlabs.io` (agent → Security → Allowlist). **If the web domain ever changes, add the new hostname there first** — otherwise the widget fails with "Host … is not allowed to connect to this agent" (this happened after the 7 Sep rename and was fixed the same day).
- Genesys Open Messaging (`HANDOVER_ADAPTER=genesys`, `GENESYS_*`) — simulated adapter is active.

## Real-site alignment (4 Sep 2026)
Commit `9b6ca87` aligned the demo's structures with what a logged-in member sees on uae.voxcinemas.com (reference: `docs/07-real-site-reference.md`): seat tiers and per-area pricing, the real Deira F&B menu with images, the Review & Pay sheet (bank offers, SHARE redeem at 10 pts = 1 AED, VAT info, saved cards / ADCB TouchPoints / new card / Apple Pay), and the receipt/e-ticket card. Production was reseeded by setting `SEED_FORCE=true` on concierge-api for one deploy (then removed); conversation history was kept. The ElevenLabs agent prompt was updated and a new KB document `voxi/checkout-payments-and-receipts` (id `hSlmfgAfDCIairgU3rUc`) attached.

## Widget feedback round (5 Sep 2026)
Commit `2bc3a78`: three demo profiles (UAE / India / UK) plus a non-account guest booking, personalised recommendations with the children question, location bar (near-me showtimes with Google Maps links), Samsung Pay / Apple Pay / saved-card / new-card payment choice, guest checkout nudge, bank-filtered offers with saved-card hints, strict BOGO validation and same-bank card check at payment, compact F&B tiles. Production reseeded once more (`SEED_FORCE=true` for one deploy, then off); prompt and the checkout KB doc re-synced to the ElevenLabs agent.

## Live verification (3 Sep 2026)
- Backend: 25 read/write tools exercised over HTTPS from Dubai; 3 concurrent confirmations → 1 action; full booking (tickets → seats → F&B → ENBD BOGO → card → QR `VNVWSA8`); swap `WJMX42R → X9HJLRH`; bank-offer and cut-off refusals; complaint `CMP-2026-000001`; simulated transfer; feedback; dashboard populated.
- Agent (text, via ElevenLabs EU): login → find → prepare → confirm → cancel `WXA7K2M` (action ledger `cancel_booking: succeeded`); Arabic offers query answered in Arabic; guided booking started with tools; widget in Chrome connected, showtime cards rendered.
- Voice: needs a microphone on the tester's machine — see `docs/04-demo-script.md`.
