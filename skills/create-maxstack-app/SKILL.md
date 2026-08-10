---
name: maxstack
description: The entrypoint for working with maxstack — create a new app and drive it through its whole lifecycle. Use whenever the user wants to create/scaffold/start a maxstack app, add an entity/page/field/feature, evolve the spec with an op, install a feature bundle, own/eject a view, run/build/deploy a project, or asks how any maxstack CLI verb works. Triggers on "new app", "create an app", "maxstack init", "maxstack op/add/gen/eject/dev/build/deploy", "how do I ... in maxstack".
license: MIT
---

# maxstack

maxstack grows an app **change-by-change**: the `spec/` directory (one system,
split by layer — product · data · pages · pricing · ledger · oplog) is the source
of truth, typed *spec-ops* evolve it, and a never-clobber generator rebuilds the app
tree without ever overwriting code you own. This skill is the entrypoint for both
**standing up a new app** and **general day-to-day usage** of an existing one —
evolving the spec, adding features, owning code, running, and shipping.

## Prerequisite: the `maxstack` CLI

The `maxstack` CLI is published to npm. Install it globally (or run it ad-hoc
with `npx`):

```sh
npm install -g maxstack   # or: npx maxstack <verb>
maxstack --version        # confirm it's available
```

Generated projects carry **no dependencies** — their npm scripts (`npm run gen`,
`npm run validate`, …) shell out to the `maxstack` CLI on your `PATH`, so
`npm install` inside a fresh project is a clean no-op, not a setup step.

## The golden path

Run these in order. Each step is one CLI verb; stop and show the user output
after `init` and after the first `gen`.

```sh
maxstack init my-app              # scaffold spec + app + gate (bare `init` prompts for the dir; add -d "desc" to seed a richer spec)
cd my-app
maxstack op --file change.json    # apply a typed spec-op (add entity/field/page)
maxstack gen                      # regenerate the app tree (never clobbers your edits)
maxstack add auth                 # install a feature bundle (schema + pages + DI + seeds)
maxstack add view <resource>      # scaffold an OWNED list view (loader-fed)
maxstack eject <route-id>         # take ownership of a generated file
maxstack validate                 # spec valid · manifest intact · regen safe
maxstack dev                      # run the app over its data dir
```

`maxstack init` seeds `maxstack.json`, a `spec/` directory, a `package.json` whose
`validate` gate runs green standalone, and the generated `app/` tree — so a fresh
project already validates before you touch it. Inside a project, every verb is
also wired as an npm script (`npm run gen`, `npm run validate`, `npm run dev`, …).

## Command reference

For general usage — you don't have to start from `init`. Point any verb at an
existing project (`[dir]` defaults to the current directory):

| Verb | What it does |
|------|--------------|
| `maxstack init [dir]` | Scaffold a new project (spec + app + gate). `-d "desc"`, `--backend pglite\|postgres`. |
| `maxstack op [dir]` | Apply a typed spec-op. `--file <op.json>` or `--op '<json>'`. Validates, then lands. |
| `maxstack gen [dir]` | Regenerate the app tree from the spec (never clobbers owned files). |
| `maxstack add <slug> [dir]` | Install a feature bundle (see references/bundles.md). |
| `maxstack add view <resource> [dir]` | Scaffold an **owned** list view, rendered from the loader's props. |
| `maxstack eject <route-id> [dir]` | Take ownership of a generated route. `--to <file>` to relocate. |
| `maxstack validate [dir]` | The gate: spec valid · manifest intact · regen safe. |
| `maxstack upgrade [dir]` | Migrate installed bundles through their codemods, then regenerate against the current framework generators. Same action as `gen --upgrade`. |
| `maxstack dev [dir]` | Run the platform web app over the project's data dir. |
| `maxstack build [dir]` | Vendor a portable runtime + build a Docker image. `--image`, `--vendor-only`. |
| `maxstack deploy [dir]` | Ship the vendored runtime. `--target docker\|fly`, `--port`, `--execute`. |

A few commands are registered but hidden from `--help` because nothing types
them by hand: `mcp` (spawned by agent clients via `.mcp.json`), `guard-edit` (a
PreToolUse hook), and `runtime link|unlink|status` (for debugging against a
local checkout). Run `maxstack --help` or `maxstack <verb> --help` for the full
option list.

## How to evolve the spec

Never hand-edit the files under `spec/`. Every change is a typed op applied through
`maxstack op`, which validates against the whole system before it lands
(dangling references, duplicate ids, and bad targets are rejected). Write the op
to a JSON file and apply it:

```json
{
  "op": "data.addEntity",
  "args": {
    "entity": {
      "id": "e-invoice",
      "name": "Invoice",
      "fields": [
        { "id": "fld-total", "name": "total", "type": "number", "required": true }
      ]
    }
  }
}
```

```sh
maxstack op --file add-invoice.json && maxstack gen
```

Adding an entity does **not** by itself generate CRUD pages. The entity is
immediately reachable at the generic `/admin/:resource` surface, but a
dedicated route is only scaffolded once you apply an explicit `page.addPage`
op for it and run `gen`. The full op vocabulary (entities, fields, pages,
blocks, table ordering, metrics, requirements, pricing tiers, decisions,
provenance review) is in [references/spec-ops.md](references/spec-ops.md).

## Feature bundles

`maxstack add <slug>` folds a versioned bundle into the spec — entities, pages,
DI bindings, DDL, and seeds — in one shot. Available slugs: `auth`, `members`,
`billing`, `audit`, `email`, `di`, `db-plugins`, `admin`. See
[references/bundles.md](references/bundles.md) for what each installs and its
prerequisites (e.g. `members`/`billing` build on `auth`).

## Owning code — the never-clobber contract

Generated files are regenerated on every `gen`. To edit one safely, take
ownership first:

- `maxstack add view <resource>` — scaffold an *owned* list view: the module is
  handed the page loader's rows, columns, permissions, resolved references and
  signed file URLs and draws the list by spreading them, with the title cell
  written out as an editable `columns` override. The route flips to `ejected` so
  `gen` never regenerates over it. Edit cells freely.
- `maxstack eject <route-id>` — take ownership of any generated route in place
  (or `--to <file>`). Eject copies-with-banner and **never clobbers** an existing
  owned file.

Invariants that never bend: regeneration never deletes manual items, grounds only
on accepted items, and eject never overwrites. `maxstack validate` fails if a fresh
regeneration would change anything you own — that's the safe-change guarantee.

## Running, building, deploying

```sh
maxstack dev                 # run the platform web app over the project data dir
maxstack build               # vendor a portable runtime (owned code compiled in) + Docker image
maxstack deploy              # docker run locally, or --target fly
```

`maxstack dev` runs the app straight from the spec over the project's data dir;
`build` vendors a self-contained tree under `.maxstack/runtime/` (owned code
compiled in) so the deployable is fully portable.

## Guardrails

- **Show, don't assume.** After `init` and the first `gen`, print the CLI output
  so the user sees the route writes and artifacts.
- **One op per change.** Prefer small, named op files over batched edits — they
  read as a changelog and each is validated independently.
- **Never hand-edit the `spec/` files or the manifest.** Use `op`, `add`, and `eject`.
- **Gate before you call it done.** `maxstack validate` (typecheck · lint · test ·
  spec-valid · regen-safe) is the definition of green.
- If a verb errors, read the message — the CLI reports the exact missing entity,
  bad reference, or existing-project conflict. Fix the op, don't retry verbatim.
