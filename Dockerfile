# syntax=docker/dockerfile:1

# PLAN.md S7.4: multi-stage, non-root, no assumption about CPU architecture.
#
# Architecture: the base image is NOT pinned to an architecture, so the build resolves
# whatever the builder's platform is. The `linux/amd64`, `linux/arm64` in the CI matrix is
# what actually proves that, because S5-LINUX was only ever run on one of them.

# --- deps -----------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` installs exactly the committed lockfile and fails on drift.
RUN npm ci --ignore-scripts --no-audit --no-fund

# --- build ----------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime --------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# PLAN.md B-28: tree-kill builds a POSIX process tree by shelling out to `ps`, which lives
# in the `procps` package and is ABSENT from node:24-bookworm-slim. Verified: the Sprint 4
# suite on that image produced `spawn ps ENOENT` from inside tree-kill's own error handler,
# where a try/catch cannot intercept it. Installing procps here is the resolution chosen in
# docs/adr/0010-procps-vs-process-group.md after testing the real image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY gateway.schema.json ./
COPY scripts ./scripts
COPY docs/SECURITY.md docs/OPERATIONS.md ./docs/

# `data/` holds the AES-256-GCM token store. Created and owned by the runtime user so the
# store is never world-readable, and mounted as a volume in compose.
RUN mkdir -p /app/data && chown -R node:node /app

# Non-root. verified: nodejs.org/api/docker.html#running-your-container-as-a-non-root-user
USER node

EXPOSE 3000

# The health check uses the gateway's own unauthenticated endpoint (D9), so it needs no
# secret and no network access from the health checker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]