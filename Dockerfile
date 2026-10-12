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

# ADR 0012 D5: the config directory lives under the HOME DIRECTORY, and GATEWAY_HOME says
# so explicitly rather than relying on the image's user home.
#
# Why /home/node and not /app: `os.homedir()` returns /home/node for this user, so the CLI's
# own default (`$GATEWAY_HOME or homedir()` + /.mcp-gateway/gateway.json) resolves there
# with no extra flags -- which is what lets `docker compose run --rm gateway init` write
# into the volume and a bare `docker compose up` find it. Setting the variable as well means
# the layout does not silently change if the image's user home ever does.
#
# Why a NAMED VOLUME and never a host bind mount: the Docker host is a remote Armbian
# machine, so a Windows path cannot be mounted there at all (B-29), and a bind mount would
# also hand the non-root `node` user host directory permissions it should not inherit.
# Docker seeds a fresh named volume from the image content at that path, INCLUDING
# ownership, so creating the directory here is what makes the volume writable by `node`.
ENV GATEWAY_HOME=/home/node

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY gateway.schema.json ./
# `mcp-gateway init` reads this from the package root at runtime. Without it the image can
# start the gateway but cannot create a config, and the failure was a raw ENOENT stack trace.
COPY gateway.example.json ./
COPY scripts ./scripts
COPY docs/SECURITY.md docs/OPERATIONS.md ./docs/

# F-1: the smoke test must make a REAL tools/call, so it needs a real upstream. The smoke
# upstream is a dedicated single-tool stdio server rather than the suite's fixture, whose
# argv-driven tools include `hang` (never answers) and `crash` (exits non-zero) -- a smoke
# test must not depend on which tool its own parser happens to pick.
# PLAN.md D15: local only, no network. Its deps (@modelcontextprotocol/server, zod) are
# already in the runtime node_modules, so this adds no new dependency to the image.
COPY spikes/smoke/fake-upstream.mjs ./spikes/smoke/fake-upstream.mjs
# The smoke configuration is baked in so `scripts/smoke.sh` needs no volume and no
# host bind-mount; the remote Docker host cannot mount a Windows drive at all (B-29).
COPY spikes/smoke/gateway.json ./spikes/smoke/gateway.json

# Created here, owned by the runtime user, so a fresh named volume mounted at /home/node is
# already writable by `node` when Docker seeds it. The OAuth token store goes to
# /home/node/.mcp-gateway/data and is created 0700 at write time.
# 0700 explicitly, because `mkdir` is masked by the umask and would otherwise leave the
# config directory world-readable and listable inside the volume.
RUN mkdir -p /home/node/.mcp-gateway \
 && chmod 700 /home/node/.mcp-gateway \
 && chown -R node:node /home/node \
 && chown -R node:node /app

# Non-root. verified: nodejs.org/api/docker.html#running-your-container-as-a-non-root-user
USER node

EXPOSE 3000

# The health check uses the gateway's own unauthenticated endpoint (D9), so it needs no
# secret and no network access from the health checker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]