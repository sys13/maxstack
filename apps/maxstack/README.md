# maxstack

The AI-native app platform. You describe your product as a **spec** — entities,
fields, pages, features — and maxstack generates a runnable full-stack app from
it. Every change is a typed, validated **spec-op** that lands in an append-only
ledger, and regeneration **never clobbers code you own**. Evolve the app from
the terminal, from the built-in workbench, or by pointing Claude Code at it
(every project ships with the MCP server and skills pre-wired).

## Requirements

- Node >= 22
- Docker (only for `maxstack build` / `maxstack deploy`)

That's it — no install step:

```sh
npx maxstack@latest start "a bug tracker for small teams"
```

That one command scaffolds the project, lands the spec-ops your sentence
implies, seeds sample rows and serves the app — you end up at a running app
with data already in the tables.

`npx` fetches the CLI and the prebuilt web runtime it pins
(`maxstack-runtime`) and runs it. Coming back often? A global install drops the
prefix from every command below:

```sh
npm install -g maxstack
maxstack --version
```

> **Tip:** right after a release, npm's cached registry metadata can lag and
> resolve an older version. If the version isn't what you expected, pin it
> exactly (`npx maxstack@<version>`, or `npm install -g maxstack@<version>`).

## Quick start

The fast path — a sentence in, a running app out:

```sh
npx maxstack@latest start "a bug tracker for small teams"
```

Or start empty and add things yourself:

```sh
npx maxstack@latest init my-app   # scaffold: spec + generated app + validate gate
cd my-app
npx maxstack@latest dev           # serve the app + workbench + MCP server
```

Then give it something to show — a fresh spec has no entities yet:

```sh
npx maxstack@latest add-entity task --field title:string! --field done:bool
npx maxstack@latest add-page task
npx maxstack@latest demo          # sample rows, so the page isn't an empty table
```

`maxstack dev` keeps running and regenerates the app tree automatically as the
spec changes. To drive the project with Claude Code, open a shell in the project
and run `claude` — the scaffolded `.mcp.json` and `.claude/skills/` auto-load
(the MCP server runs over stdio, so it needs no ordering against `dev`), then
start with `/plan-and-scope`.

## How it works

A project is a small, inspectable tree:

- `maxstack.json` — project config (app dir, data dir, backend, reviewMode)
- `spec/` — the one-system spec, split by layer: product · data · pages · pricing · decision ledger · oplog
- `app/` — generated route modules, user-owned slot stubs, and the ownership
  manifest
- `data/` — durable runtime state (created by `maxstack dev`)

You never edit generated files by hand. Instead:

1. **Apply a spec-op** — from sugar commands (`add-entity`, `add-field`), a
   feature bundle (`add auth`), the workbench UI, Claude via MCP, or raw JSON
   (`op --file change.json`).
2. **Review it** — changes you make land accepted; an agent's proposals queue
   immediately, or set `"reviewMode": "auto"` in `maxstack.json` if you're
   working solo and trust yourself.
3. **Regenerate** — `--gen` (or the always-on regen in `maxstack dev`) rewrites
   the app tree through the never-clobber writer.
4. **Own what you need to** — `maxstack eject <route-id>` hands you the file
   for a generated route; from then on regeneration leaves it alone, forever.

`maxstack validate` is the standalone gate: the spec parses, generated files
match the ownership manifest, and a fresh regeneration changes nothing you
own — the safe-change-over-time guarantee, enforceable in CI.

## Everyday changes

```sh
# Add an entity (! marks a required field)
maxstack add-entity task \
  --field title:string! \
  --field done:bool \
  --field priority:enum(low,med,high) \
  --field author:ref:e-user

# Add a field to an existing entity
maxstack add-field task dueOn:date!

# Give the entity a browsable page (a list page derived from the entity)
maxstack add-page task            # → pg-task at /task, a table block

# Install a feature bundle (dependencies install automatically)
maxstack add auth
maxstack add members

# The gate
maxstack validate
```

Your own writes land and regenerate as they go. Set `"reviewMode": "review"` in `maxstack.json` to queue them for review instead.

Field specs are `name:type[!]` — a trailing `!` makes the field required.
The canonical types are `string`, `number`, `bool`, `date`, `json`,
`enum(a,b,c)`, and `ref:<entity-id>` for a reference. The CLI also accepts the
aliases `text`→`string` and `int`/`integer`/`float`→`number`; note these are
*terminal sugar* only — a raw spec-op (what an agent posts through MCP
`apply_spec_change`) must carry a canonical type, so `text` is rejected there.

## Feature bundles

`maxstack add <slug>` folds a whole feature — schema, pages, seeds, wiring —
into your spec through the same validated op pipeline as everything else.
Available bundles:

`admin` · `api-keys` · `audit` · `auth` · `billing` · `compliance` ·
`email` · `flags` · `jobs` · `members` · `notifications` · `observability` ·
`preferences` · `storage` · `webhooks`

Run `maxstack add` with an unknown slug to print the current catalog. Installs are
recorded in `maxstack.json`, and bundles compose (e.g. `billing` brings the
entitlement checks that other bundles can enforce).

## When you need your own code

Most changes should stay in the spec: spec-driven pages regenerate freely and
keep improving as the platform does. When a surface genuinely needs custom
code, climb the ladder deliberately:

1. **Fill a slot.** Generated routes ship `*.slots.tsx` stubs — scoped
   injection points (a custom cell, a submit handler). You write the small
   component; the page around it stays generated and keeps regenerating.
2. **Scaffold an owned view.** `maxstack add view <resource>` writes the
   resource's inferred list view out as an explicit, editable file and ejects
   it — start from inference, then hand-edit the one cell you care about.
3. **Eject a route.** `maxstack eject <route-id>` (`--dry-run` to preview)
   hands you any generated route wholesale.

The trade, stated plainly: an ejected file is **yours forever** — regeneration
never clobbers it, and it no longer picks up generator improvements.

Owned code is compiled, not interpreted from the spec, so the prebuilt server
plain `maxstack dev` runs can't execute it. Serve it with:

`maxstack dev` notices and switches to the owned-code server for you — it
vendors and installs the runtime source once (this is the one path that needs
`pnpm`), then runs its dev server with hot reload. `--owned` forces that path
explicitly; you should not need it.

If owned code exists and `pnpm` is missing, `dev` **refuses to start** rather
than serving a server with your own code silently missing from it.

```sh
maxstack dev            # auto-selects the owned-code server when you own code
maxstack build          # or compile it into the deployable Docker image
```

## Ship it

```sh
maxstack build              # vendor a portable runtime (your owned code
                            # compiled in) + build a Docker image
maxstack deploy             # run it locally in Docker (default port 3000)
maxstack deploy --target fly --execute   # or ship to Fly.io
```

`build` produces a self-contained tree under `.maxstack/runtime/` — no publish
step, no lockfile surgery — and `deploy` runs the image. `--vendor-only` skips
the image build; `--image <tag>` and `--port <n>` do what they say.

## Command reference

| Command | What it does |
| --- | --- |
| `init [dir]` | Scaffold a standalone project (spec + app + gate) |
| `dev [dir]` | Run the app + workbench + MCP server on port 3000; auto-regenerates. `--owned` serves your owned code live (vendors + installs the runtime source once; needs pnpm) |
| `demo [dir]` | Load sample data so there's something to explore |
| `add-entity <slug>` | Add a data entity (sugar for a `data.addEntity` op) |
| `add-field <entity> <spec>` | Add a field (sugar for a `data.addField` op) |
| `add-page <entity>` | Add a browsable list page for an entity (sugar for a `page.addPage` op) |
| `add <bundle>` | Install a feature bundle |
| `add view <resource>` | Scaffold an owned list view (ejects the route — see "When you need your own code") |
| `eject <route-id>` | Take ownership of a generated route (yours forever, never re-clobbered) |
| `op --file <f> \| --op <json>` | Apply a raw typed spec-op |
| `gen [dir]` | Regenerate the app tree (never-clobber) |
| `validate [dir]` | The gate: spec valid · manifest intact · regen safe |
| `upgrade [dir]` | Regenerate against the current framework generators |
| `build [dir]` | Vendor a deployable runtime + build a Docker image |
| `deploy [dir]` | Ship it: local `docker run`, or Fly |

Common flags on the write commands: `--accept` (force-accept even in review
mode), `--gen` (regenerate after landing — redundant while `maxstack dev` is
running, which regenerates on every spec change).

> **Note:** every project command runs standalone from the npm install. The
> web runtime ships as the CLI's `maxstack-runtime` dependency: `dev`/`demo`
> run its prebuilt server (spec changes show live; *owned code* — filled slots
> and ejected routes — isn't compiled into it). To iterate on owned code, run
`maxstack dev` again — it auto-selects the owned-code path, vendoring the
> runtime source under `.maxstack/runtime/` and running its dev server with HMR
> (one-time `pnpm install`; pnpm is the one extra tool this path needs).
> `maxstack build` compiles the same owned code into a deployable image. Inside
> a maxstack checkout the CLI prefers the checkout and owned code always runs.
