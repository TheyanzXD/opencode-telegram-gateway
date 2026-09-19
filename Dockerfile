# syntax=docker/dockerfile:1
# language: Dockerfile
# Multi-stage: build nothing (pure ESM, no compile step), but keep the runtime
# image small and non-root. Chromium is excluded — mount or fetch it if /browse
# is needed in a container.

FROM node:20-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 is native — needs build tooling only at install time
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install first so a code change does not re-download deps
COPY package.json ./
# lockfile is intentionally absent from the repo; install generates one locally
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# sqlite3 shared lib + a non-root user
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 1001 --create-home gateway

COPY --from=base /app/node_modules ./node_modules
COPY . .
RUN mkdir -p data workspace && chown -R gateway:gateway /app

USER gateway
EXPOSE 3000
VOLUME ["/app/data", "/app/workspace"]

# grammY long-polling; no port to publish. Health is the process staying up.
CMD ["node", "src/index.js"]
