# Railway deployment map (created by the MCP-driven deploy; kept here as the reference)

| Service | Source | Dockerfile | Start command | Health | Public |
|---|---|---|---|---|---|
| postgres | Railway Postgres | – | – | – | no |
| vista-mock | repo | infra/Dockerfile | `node apps/vista-mock/dist/main.js` | /healthz | no (private `vista-mock.railway.internal:4010`) |
| concierge-api | repo | infra/Dockerfile | pre-deploy `node packages/db/dist/bootstrap.js` then `node apps/concierge-api/dist/main.js` | /healthz | yes → `CONCIERGE_PUBLIC_URL` |
| worker | repo | infra/Dockerfile | `node apps/worker/dist/main.js` | – | no |
| web | repo | infra/Dockerfile.web | nginx (PORT=80, API_UPSTREAM=http://concierge-api.railway.internal:4020) | / | yes → demo URL |

Bootstrap applies migrations on every deploy and seeds only when the catalogue is empty. Keep `SEED_FORCE=false` for normal deployment: existing bookings, balances, holds and customer history must be preserved.

For the premium journeys release, mock and worker inspect the committed database schema before opening HTTP or claiming jobs. They wait up to 120 seconds for API bootstrap to finish migrations `0004_refund_credit_expiry` and `0005_ledger_order_reference`; they do not run competing migrations themselves. Check API bootstrap logs if either service exits with a schema-readiness error.

Provision the three private `DEMO_SARA_PASSWORD`, `DEMO_RAHUL_PASSWORD` and `DEMO_JAMES_PASSWORD` values on concierge-api. The bounded updater fills missing password hashes and upgrades only the known demo personas. Enable `DEMO_SCHEDULE_REFRESH=true` with `VISTA_PROVIDER=mock` there to add seven days of synthetic bookable sessions without replacing existing sessions or bookings. Keep `DEV_TOOL_BRIDGE=false` on the hosted API.

The Railway web bundle is also loaded by the linked Cloudflare website at `/embed/voxi.js`. Verify both entry points after deployment; the existing embed cache can retain the previous bundle for up to five minutes. Follow [the current runbook](../docs/02-runbook.md) for deployment and verification.
