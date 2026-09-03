#!/usr/bin/env bash
# Start the whole stack locally (without Docker): vista-mock, concierge-api, worker, web.
set -a; . "$(dirname "$0")/../.env"; set +a
export DEV_TOOL_BRIDGE=${DEV_TOOL_BRIDGE:-true}
cd "$(dirname "$0")/.."
pnpm build:packages >/dev/null
mkdir -p /tmp/voxi
nohup pnpm --filter @voxi/vista-mock dev > /tmp/voxi/vista.log 2>&1 &
nohup pnpm --filter @voxi/concierge-api dev > /tmp/voxi/api.log 2>&1 &
nohup pnpm --filter @voxi/worker dev > /tmp/voxi/worker.log 2>&1 &
(cd apps/web && nohup pnpm dev --host 127.0.0.1 > /tmp/voxi/web.log 2>&1 &)
sleep 8
curl -s localhost:4010/healthz; echo; curl -s localhost:4020/healthz; echo
