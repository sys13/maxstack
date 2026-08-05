# Deploying a maxstack app (Docker + Fly)

The maxstack web runtime is a **spec interpreter**: one fixed React Router
server (`apps/web`) that serves *any* generated project by reading its
`spec/` directory at request time. So "deploying your app" = building the runtime
with your project's spec baked in, then running that image anywhere.

The built image is self-contained — it needs no maxstack checkout, and neither does
the **build**: `maxstack build` vendors the runtime *into your project*, so the
Docker build context is the project itself.

## The one-command path

```sh
maxstack build  [dir]   # vendor <project>/.maxstack/runtime/ + build the image
maxstack deploy [dir]   # …then run it locally (docker) or ship it (fly)
```

`maxstack build` clones the workspace source into `<project>/.maxstack/runtime/`
(a structural clone → all `@maxstack/*` package paths still resolve from source),
mirrors your owned `app/` in, generates the owned-code manifest, bakes the `spec/`
dir, and emits a `Dockerfile` / `.dockerignore` / `fly.toml` whose build context is
that directory. `--vendor-only` stops after producing the tree (no image).

`maxstack deploy` re-vendors, then:

- `--target docker` (default) — builds the image and runs it detached on
  `--port` (3000). Open <http://localhost:3000>.
- `--target fly` — prints the `fly` runbook; add `--execute` to run `fly deploy`
  from the vendored tree.

Postgres in prod: pass `-e DATABASE_URL=postgres://…` (docker) or
`fly postgres attach` (fly) — the runtime selects postgres.js over pglite
automatically.

## What runs in the image

- Every accepted page in your spec, as a navigable route (list / create / edit),
  backed by the Sprout store.
- `/admin` CRUD, the MCP JSON-RPC transport, `/api/auth/*`, RBAC from the
  session role.
- **Your owned code** — filled `*.slots.tsx` and ejected route modules — compiled
  in and executing. `maxstack build` wires them via the owned-code manifest.
- Storage: **pglite** over the baked `/data` dir by default (durable only for
  the life of the machine), or **Postgres** when `DATABASE_URL` is set.
- **Cross-instance coordination** is decided by that choice and nothing else: on Postgres, live fan-out and rate-limit budgets are shared
  across every instance; on pglite they are per process, which is correct because
  pglite locks its data dir and a second instance cannot start. The mode is
  logged at boot.
- **PDF fonts**: the base-14 fonts by default, which cost nothing and print `?`
  for anything outside Latin-1. Add a `.ttf` to the image and point
  `MAXSTACK_PDF_FONT` (and optionally `MAXSTACK_PDF_FONT_BOLD`) at it to embed
  a subset of it instead — see [documents](documents.md#character-sets-and-the-font-you-can-bind).
  A path that cannot be used falls back with the reason in the log rather than
  failing the document.

## Manual Docker (under the hood)

`maxstack build` runs this for you; shown for reference. From the vendored tree
(`<project>/.maxstack/runtime/`, which IS the build context):

```sh
cd <project>/.maxstack/runtime
docker build -f Dockerfile --build-arg SPEC_DIR=spec -t my-app .

docker run -p 3000:3000 my-app                 # pglite (ephemeral)
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://user:pw@host/db \
  -e MAXSTACK_AUTH_STRICT=1 my-app             # real Postgres + strict auth
```

Then open <http://localhost:3000>. `SPEC_DIR` is any path to a `spec/`
directory inside the build context.

Build args:

| arg | default | meaning |
|-----|---------|---------|
| `SPEC_DIR` | `spec` | project spec directory (at the vendored-tree root) to bake as `/data/spec` |
| `NODE_VERSION` | `22-slim` | base Node image tag |

Runtime env:

| var | meaning |
|-----|---------|
| `PORT` | listen port (default 3000) |
| `MAXSTACK_DATA_DIR` | baked to `/data`; holds the `spec/` dir + pglite state |
| `DATABASE_URL` | `postgres://…` selects Postgres over pglite |
| `MAXSTACK_AUTH_STRICT` | `1` turns off the dev-admin fallback |

## Fly.io

`maxstack build` emits a ready `fly.toml` (app = `maxstack-<name>`, context = the
vendored tree, `SPEC_DIR = "spec"`) at `<project>/.maxstack/runtime/`. Run
`maxstack deploy [dir] --target fly` to print the runbook, or `--execute` to run
`fly deploy` for you. By hand, from the vendored tree:

```sh
cd <project>/.maxstack/runtime
fly launch --copy-config --no-deploy   # first time: create the app
fly deploy                             # builds Dockerfile, ships it
```

For anything real, add Postgres (pglite state is lost on machine recycle):

```sh
fly postgres create --name my-app-db
fly postgres attach my-app-db          # injects DATABASE_URL as a secret
fly secrets set MAXSTACK_AUTH_STRICT=1
fly deploy
```

## Notes / follow-ups

- **Image size** (~630 MB) copies the whole built workspace to keep pnpm's
  symlinked `node_modules` intact. Pruning to production deps (`pnpm deploy`) is
  a logged optimization, not a correctness gate.
- **Spec is baked** (immutable app surface per deploy): a spec change is an app
  change, so re-`fly deploy` to ship it. Mounting the spec instead is the
  alternative if you want it to evolve without a rebuild; it isn't supported yet.
- **Client-bundle hygiene**: the production build emits warnings for pglite /
  ts-morph chunks code-split into the browser bundle that never execute there;
  harmless, a bundle-size follow-up (needs server-subpath splits in the
  ownership / mcp packages, mirroring the `@maxstack/core/backend` split).
