# The maxstack web runtime as a self-contained, deployable image.
#
# The runtime is a *spec interpreter*: one fixed React Router server that serves
# ANY generated project by reading its `spec/` directory at request time. So a
# deploy is "this runtime + one project's spec baked in as the data dir". The
# built image needs no maxstack checkout — only the BUILD does (strategy C, vendored
# runtime; see docs/task-30-publishable-runtime.md). Build context is the
# workspace root:
#
#   docker build -f apps/web/Dockerfile \
#     --build-arg SPEC_DIR=path/to/your-project/spec -t my-app .
#   docker run -p 3000:3000 my-app
#
# Postgres in prod: pass -e DATABASE_URL=postgres://… (task 22). Without it the
# app runs on pglite over the baked /data dir (ephemeral on a fresh container).
ARG NODE_VERSION=22-slim

# ---- base: pnpm on Node ------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Activate the pinned pnpm at build time so no stage downloads it over the
# network at boot (a runtime `corepack` fetch would make container start depend
# on npm being reachable).
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /repo

# ---- builder: install the workspace and build the web runtime ----------------
FROM base AS builder
# Populate the pnpm store from the lockfile alone — a cacheable layer that only
# busts when dependencies change, not on every source edit.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
# Bring in the full workspace source (node_modules/build are .dockerignore'd)
# and install offline from the warm store, then produce the RR build.
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @maxstack/web build

# ---- runtime: the built server + a baked project spec ------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Copy the built workspace wholesale so pnpm's symlinked node_modules stays
# intact (cross-stage copies of a symlink farm are fragile if split). Pruning to
# production deps for a smaller image is a logged follow-up, not a Bar 1 gate.
COPY --from=builder /repo /repo
# Bake the project spec as the app's data dir: an immutable app surface per
# image (O1 = bake — a spec change is an app change, so it should be a new
# build/deploy). pglite writes durable state under here; a real deploy points
# DATABASE_URL at managed Postgres and leaves this as spec-only.
ARG SPEC_DIR=path/to/your-project/spec
COPY ${SPEC_DIR} /data/spec
ENV MAXSTACK_DATA_DIR=/data
ENV PORT=3000
# The build ships source maps (issue #143); tell node to apply them so a crash
# in the deployed runtime prints `app/…tsx:LINE`, not a minified chunk offset.
ENV NODE_OPTIONS=--enable-source-maps
EXPOSE 3000
WORKDIR /repo/apps/web
# pnpm is pre-activated in `base`, so `pnpm exec` runs the server with no network
# fetch at boot (the earlier corepack-download-at-start problem).
CMD ["pnpm", "exec", "react-router-serve", "./build/server/index.js"]
