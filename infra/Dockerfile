# Multi-stage build for all Node services (vista-mock, concierge-api, worker, migrate, seed)
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/vista-mock/package.json apps/vista-mock/
COPY apps/concierge-api/package.json apps/concierge-api/
COPY apps/worker/package.json apps/worker/
COPY apps/scraper/package.json apps/scraper/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/vista-client/package.json packages/vista-client/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm -r --filter '!@voxi/web' build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY --from=build /app ./
USER node
