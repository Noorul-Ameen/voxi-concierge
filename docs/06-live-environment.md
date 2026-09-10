# 06 — Deployment identifiers and configuration

These identifiers belong to the existing VOX Cinemas Virtual Assistant deployment. They do not imply the current enhancement candidate has already been promoted. Record the final Railway revisions and ElevenLabs version with the [current enhancement acceptance record](13-concierge-enhancements.md).

| Component | Hosting / identifier |
|---|---|
| Shared widget and standalone demo | [Railway web](https://voxi-demo.up.railway.app), dashboard at `/dashboard` |
| Embedded website | [Cloudflare host](https://voxi.kris-pradip.workers.dev/), using the same Railway-built widget |
| Concierge API | `https://concierge-api-production-3d90.up.railway.app`; health `/healthz`, contract `/openapi.json` |
| Vista mock / Postgres | Railway private service network; inspect the environment for the current host/credentials |
| Railway project | `voxi-concierge`, ID `52e8f8a4-19fd-41a1-8978-6c60ee8f930a` |
| Source | [GitHub repository](https://github.com/Noorul-Ameen/voxi-concierge); inspect branch/deployment source before promotion |
| ElevenLabs agent | EU-residency workspace, `agent_1001m1m6rghcfsr8nrpj5x08g16e` |
| Agent tools | 44 server + 12 client contracts; use the actual attached IDs for the candidate version |

## Current operating requirements

- The widget uses the EU-residency origin from `ELEVENLABS_BASE_URL` through `/widget/signed-url`. Signed URLs and origin rules must match the actual target agent; do not infer them from older allowlist notes.
- Preserve the verified live Gemini 3.6 Flash / temperature 0 / minimal reasoning and v3 conversational expressive/speculative voice configuration. Existing-agent synchronization patches prompt/tool IDs only. The old flash-v2 requirement below was superseded.
- Tool calls use the configured `x-voxi-key`/HMAC credentials. Do not expose these in source, browser diagnostics, exports or documentation.
- The shared embed remains `/embed/voxi.js`; technical global/asset/package names retain compatibility while visible copy uses VOX Cinemas Virtual Assistant.
- Provision the three email/password accounts through private environment variables. The secure widget is the only credential-entry path. Guest booking remains available.
- Read seat expiry from the actual backend order. Three minutes closes the conversation only; no local expiry reset or automatic re-hold is allowed.
- Normal bootstrap applies migrations and bounded demo-profile updates. Full seeding is destructive to demo tables and is not a routine deployment step; leave `SEED_FORCE` disabled.
- Synthetic future schedule refresh requires both `VISTA_PROVIDER=mock` and `DEMO_SCHEDULE_REFRESH=true`. Keep it disabled for real provider integration.
- Re-read provider service regions, plan status, attached KB IDs, security/privacy configuration and post-call webhook before promotion. Earlier claims about US-West, trial status, a fixed 11-document KB or a specific allowlist are not current configuration evidence.

The simulated human-handover adapter remains separate from a configured real Genesys integration. The checkout is simulated; no money is taken.

## Historical deployment notes

The entries below are retained as dated implementation history. Their old test results, login behavior, names and configuration are not current acceptance evidence.

## Real-site alignment (4 Sep 2026)
Commit `9b6ca87` aligned the demo's structures with what a logged-in member sees on uae.voxcinemas.com (reference: `docs/07-real-site-reference.md`): seat tiers and per-area pricing, the real Deira F&B menu with images, the Review & Pay sheet (bank offers, SHARE redeem at 10 pts = 1 AED, VAT info, saved cards / ADCB TouchPoints / new card / Apple Pay), and the receipt/e-ticket card. Production was reseeded by setting `SEED_FORCE=true` on concierge-api for one deploy (then removed); conversation history was kept. The ElevenLabs agent prompt was updated and a new KB document `voxi/checkout-payments-and-receipts` (id `hSlmfgAfDCIairgU3rUc`) attached.

## Widget feedback round (5 Sep 2026)
Commit `2bc3a78`: three demo profiles (UAE / India / UK) plus a non-account guest booking, personalised recommendations with the children question, location bar (near-me showtimes with Google Maps links), Samsung Pay / Apple Pay / saved-card / new-card payment choice, guest checkout nudge, bank-filtered offers with saved-card hints, strict BOGO validation and same-bank card check at payment, compact F&B tiles. Production reseeded once more (`SEED_FORCE=true` for one deploy, then off); prompt and the checkout KB doc re-synced to the ElevenLabs agent.

## Live verification (3 Sep 2026)
- Backend: 25 read/write tools exercised over HTTPS from Dubai; 3 concurrent confirmations → 1 action; full booking (tickets → seats → F&B → ENBD BOGO → card → QR `VNVWSA8`); swap `WJMX42R → X9HJLRH`; bank-offer and cut-off refusals; complaint `CMP-2026-000001`; simulated transfer; feedback; dashboard populated.
- Agent (text, via ElevenLabs EU): login → find → prepare → confirm → cancel `WXA7K2M` (action ledger `cancel_booking: succeeded`); Arabic offers query answered in Arabic; guided booking started with tools; widget in Chrome connected, showtime cards rendered.
- Voice: needs a microphone on the tester's machine — see `docs/04-demo-script.md`.
