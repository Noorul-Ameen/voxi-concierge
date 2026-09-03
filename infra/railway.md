# Railway deployment map (created by the MCP-driven deploy; kept here as the reference)

| Service | Source | Dockerfile | Start command | Health | Public |
|---|---|---|---|---|---|
| postgres | Railway Postgres | – | – | – | no |
| vista-mock | repo | infra/Dockerfile | `node apps/vista-mock/dist/main.js` | /healthz | no (private `vista-mock.railway.internal:4010`) |
| concierge-api | repo | infra/Dockerfile | pre-deploy `node packages/db/dist/bootstrap.js` then `node apps/concierge-api/dist/main.js` | /healthz | yes → `CONCIERGE_PUBLIC_URL` |
| worker | repo | infra/Dockerfile | `node apps/worker/dist/main.js` | – | no |
| web | repo | infra/Dockerfile.web | nginx (PORT=80, API_UPSTREAM=http://concierge-api.railway.internal:4020) | / | yes → demo URL |

Bootstrap applies migrations on every deploy and seeds only when the catalogue is empty; set `SEED_FORCE=true` on
concierge-api and redeploy to reset demo data before a demo (then remove it).
