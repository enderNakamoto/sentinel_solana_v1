# Sentinel Solana — executor cron daemon
#
# Single-image deployment for all 3 crons (FlightDataFetcher,
# FlightClassifier, SettlementExecutor) running under node-cron with a
# /health endpoint. Built from the repo root:
#
#   docker build -t sentinel-executor -f executor/Dockerfile .
#
# Run:
#
#   docker run --rm -p 8080:8080 \
#     -e CLUSTER=devnet \
#     -e ORACLE_KEYPAIR=/keys/devnet-oracle.json \
#     -e KEEPER_KEYPAIR=/keys/devnet-keeper.json \
#     -e AEROAPI_KEY=$AEROAPI_KEY \
#     -v $(pwd)/keys:/keys:ro \
#     -v $(pwd)/deployments:/app/deployments:ro \
#     sentinel-executor

# ─── Stage 1: build ──────────────────────────────────────────────────────
FROM node:22-alpine AS build

RUN apk add --no-cache bash python3 make g++

WORKDIR /app

# Copy workspace + lockfile + only the package.jsons we need to install.
# Doing this in a layer-friendly order minimizes rebuild churn.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY contracts/package.json ./contracts/
COPY executor/package.json ./executor/
COPY frontend/package.json ./frontend/

# Install pnpm + deps. We install the full workspace because the executor
# imports from `executor/src/clients/...` which is generated from the IDL
# under `contracts/target/idl/` via `pnpm gen-clients` — handled below.
RUN corepack enable && corepack prepare pnpm@9.9.0 --activate
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy the rest of the source needed for the build.
COPY scripts/ ./scripts/
COPY contracts/target/idl/ ./contracts/target/idl/
COPY executor/ ./executor/

# Generate Codama clients into executor/src/clients/.
RUN pnpm gen-clients

# Bundle the cron daemon (includes all 3 cron tick functions).
RUN ./node_modules/.bin/esbuild executor/src/scripts/run-cron.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --packages=external \
    --target=node22 \
    --outfile=executor/dist/cron.mjs

# ─── Stage 2: runtime ────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copy the bundle + the executor/contracts package.jsons + the workspace
# node_modules. We only need the executor's runtime deps + their transitive
# graph; pnpm's symlinked node_modules makes shipping them tricky, so we
# copy the full tree (~80MB).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/executor/dist/cron.mjs ./cron.mjs
COPY --from=build /app/executor/package.json ./package.json

# Default health-server port; can be overridden via -p / -e HEALTH_PORT.
ENV HEALTH_PORT=8080
EXPOSE 8080

# Healthcheck — k8s and Docker swarm will use /health to gate restarts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=2m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "cron.mjs"]
