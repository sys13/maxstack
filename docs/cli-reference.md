<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: the commander tree in `apps/maxstack/src/program.ts`
     Regenerate: pnpm docs:reference   (the validate gate checks this is current) -->

# CLI reference

Every `maxstack` verb, rendered from the command tree itself (CLI v0.11.12).

This is the **consult** doc — it tells you what a flag does, not when to
reach for it. For the narrative, start with [`quickstart.md`](quickstart.md)
and then [`user-guide.md`](user-guide.md).

## Conventions

- **`[dir]` defaults to `.`** on every platform verb, so run them from the
  project root and omit it.
- **Every write verb takes `--origin`.** It records *who authored the change*
  (person vs agent) on the op-log entry, not which wire carried it. Resolution
  order: `--origin` → `MAXSTACK_ORIGIN` → agent-environment detection
  (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`) → `human`.
- **`--accept` skips the review queue.** Without it a spec change lands as a
  *suggestion* awaiting accept/reject in `/workbench`; with it the row lands
  already accepted.
- **`--gen` regenerates after landing.** Spec-ops change the spec; code appears
  when the tree is regenerated (a running `maxstack dev` does it for you).
- **Exit codes are binary**: `0` on success, `1` with a `✖ <message>` line on
  stderr for any failure. There are no other codes to branch on.

## Environment

| Variable | Read by | Effect |
| --- | --- | --- |
| `MAXSTACK_ORIGIN` | every write verb | `ai` \| `human` — overrides origin detection. Not read by `mcp`, where the transport already settles it. |
| `MAXSTACK_AGENT` | every write verb, `mcp` | Which agent authored the change, for the audit trail. Overridden by `--agent`. |
| `MAXSTACK_SESSION` | every write verb, `mcp` | Opaque id grouping one agent run, so a batch of ops reviews as one piece of work. |
| `MAXSTACK_KEY_ID` | every write verb, `mcp` | The api-key row id that authorized the change — never the secret. |
| `MAXSTACK_DATA_DIR` | `dev`, `demo` | Durable runtime state dir for the project. |
| `PORT` | `dev`, `demo`, `deploy` | Default port when `--port` is absent. |
| `DATABASE_URL` | `dev`, `build` | Postgres connection when the backend is `postgres`. |
| `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` | origin detection | Presence means an agent is driving; origin becomes `ai`. |
| `NO_COLOR` | all output | Suppresses ANSI colour. |

## Starting and running a project

`start` is the one-command entry: a description in, a populated app serving on localhost out. `init` is the same scaffold without the starting spec, the sample rows, or the server. After that it is the everyday loop: regenerate, serve, and check.

### `maxstack start`

Scaffold, land the implied spec-ops, seed sample rows, and serve — in one command

```sh
maxstack start [options] <description> [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `description` | yes | — | what you want built, in a sentence |
| `dir` | no | — | project directory (default: a kebab-case name derived from the description) |

| Option | Meaning | Default |
| --- | --- | --- |
| `--port <port>` | port to serve on (default: PORT env, then 3000) | — |
| `--backend <backend>` | store backend: pglite \| postgres | `"pglite"` |
| `--no-seed` | skip the sample rows (start empty) | — |
| `--no-dev` | stop after generating the app tree — do not serve | — |

### `maxstack init`

Scaffold a standalone maxstack project (spec + app + gate)

```sh
maxstack init [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | — | project directory (omit to be prompted for a name; defaults to ./<kebab-case-name>) |

| Option | Meaning | Default |
| --- | --- | --- |
| `-d, --desc <description>` | one-line product description | — |
| `--backend <backend>` | store backend: pglite \| postgres | `"pglite"` |
| `--preflight-json` | emit the preflight diagnostics as JSON (for agents) instead of the human report | — |
| `--with <slugs>` | comma-separated feature bundles to install while scaffolding (prerequisites resolved and shown first) | — |
| `--dry-run` | with --with: preview what the selected modules would contribute; scaffold nothing | — |
| `--no-git` | skip `git init` and the scaffold commit (never-clobber then has no undo behind it) | — |

### `maxstack gen`

Regenerate the app tree from the spec (never-clobber)

```sh
maxstack gen [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--upgrade` | regenerate against the current framework generators instead of the pinned ones | — |

### `maxstack dev`

Run the platform web app over the project data dir

```sh
maxstack dev [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--owned` | force the owned-code dev server (auto-selected when owned modules exist): vendors + installs the runtime source once, then runs its dev server (needs pnpm) | — |
| `--port <port>` | port to serve on (default: PORT env, then 3000) | — |
| `--preflight-json` | emit the preflight diagnostics as JSON (for agents) instead of the human report | — |

### `maxstack demo`

Load sample data into the project so there is something to explore

```sh
maxstack demo [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--port <port>` | port a running `maxstack dev` is on (default: PORT env, then the port `maxstack dev` recorded, then 3000) | — |
| `--clear` | remove the rows a previous seed created, leaving your own data alone | — |

### `maxstack validate`

The standalone gate: spec valid · manifest intact · regen safe

```sh
maxstack validate [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

### `maxstack doctor`

Report what is actually running: CLI/runtime versions, staleness, store lock, dev server, MCP reachability

```sh
maxstack doctor [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--offline` | skip the npm registry staleness probe | — |
| `--no-mcp-probe` | skip the MCP stdio handshake (spawns a process) | — |
| `--json` | emit the findings as JSON | — |

## Changing the spec

Every one of these lands a typed [spec-op](spec-ops.md). `op` takes the raw JSON; the rest are terminal-native sugar that compile to exactly the same thing, so anything you can do here you can also do over [MCP](mcp-reference.md).

### `maxstack op`

Apply a typed spec-op to the spec (validate then land)

```sh
maxstack op [options] [dir|file]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir\|file` | no | `.` | project directory, or an op JSON file to apply |

| Option | Meaning | Default |
| --- | --- | --- |
| `-f, --file <file>` | op JSON file: { "op": "...", "args": {...} } | — |
| `--op <json>` | inline op JSON | — |
| `--accept` | auto-accept the change (clear the review queue) | — |
| `--gen` | regenerate the app tree after landing | — |
| `--origin <who>` | who authored this change: ai \| human (default: detected, see MAXSTACK_ORIGIN) | — |
| `--agent <name>` | which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT) | — |

### `maxstack add-entity`

Add a data entity — sugar that compiles to a data.addEntity op

```sh
maxstack add-entity [options] <slug> [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `slug` | yes | — | entity id slug (lowercase, e.g. task -> e-task) |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--field <spec>` | a field as name:type[!] (repeatable): title:text!, done:bool, 'priority:enum(low,high)', author:ref:e-user — quote any spec with ( or -> , they are shell syntax | — |
| `--name <name>` | display name (default: title-cased slug) | — |
| `--with-page` | also land a default list page for the entity in one shot | — |
| `--route <route>` | route for --with-page (default: /<slug>) | — |
| `--page-id <id>` | page id for --with-page (default: pg-<slug>) | — |
| `--page-name <name>` | page display name for --with-page (default: the entity name) | — |
| `--accept` | auto-accept the change (clear the review queue) | — |
| `--gen` | regenerate the app tree after landing | — |
| `--origin <who>` | who authored this change: ai \| human (default: detected, see MAXSTACK_ORIGIN) | — |
| `--agent <name>` | which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT) | — |

### `maxstack add-field`

Add a field to an entity — sugar for a data.addField op

```sh
maxstack add-field [options] <entity> <spec> [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `entity` | yes | — | target entity id or slug (e-task or task) |
| `spec` | yes | — | the field as name:type[!] — dueOn:date!, 'status:enum(todo,done)', owner:ref:e-user (quote any spec with ( or ->) |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--accept` | auto-accept the change (clear the review queue) | — |
| `--gen` | regenerate the app tree after landing | — |
| `--origin <who>` | who authored this change: ai \| human (default: detected, see MAXSTACK_ORIGIN) | — |
| `--agent <name>` | which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT) | — |

### `maxstack add-page`

Add a default list page for an entity — sugar that compiles to a page.addPage op

```sh
maxstack add-page [options] <entity> [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `entity` | yes | — | target entity id or slug (e-task or task) |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--name <name>` | page display name (default: title-cased slug) | — |
| `--route <route>` | route path (default: /<slug>) | — |
| `--id <id>` | page id (default: pg-<slug>) | — |
| `--accept` | auto-accept the change (clear the review queue) | — |
| `--gen` | regenerate the app tree after landing | — |
| `--origin <who>` | who authored this change: ai \| human (default: detected, see MAXSTACK_ORIGIN) | — |
| `--agent <name>` | which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT) | — |

### `maxstack theme`

Set the app's visual theme — sugar that compiles to a theme.set op (live immediately)

```sh
maxstack theme [options] <preset> [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `preset` | yes | — | theme preset: zinc \| ocean \| forest \| sunset \| mono \| rose \| amber |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--accent <hex>` | accent color as #rgb/#rrggbb (overrides primary) | — |
| `--radius <r>` | corner rounding: sm \| md \| lg \| full | — |
| `--density <d>` | rendering density: comfortable \| compact | — |
| `--font <f>` | font stack: sans \| serif \| mono \| rounded \| humanist | — |
| `--type-scale <s>` | type scale: compact \| default \| relaxed | — |
| `--origin <who>` | who authored this change: ai \| human (default: detected, see MAXSTACK_ORIGIN) | — |
| `--agent <name>` | which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT) | — |

### `maxstack add`

Browse the catalog (no argument), install a feature bundle, or "add view <resource>" to scaffold an owned list view

```sh
maxstack add [options] [target] [arg2] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `target` | no | — | feature bundle slug (auth, members, audit, ...), or "view" to scaffold a resource view. Omit to browse the catalog. |
| `arg2` | no | — | for "add view": the resource to scaffold; otherwise the project directory |
| `dir` | no | `.` | for "add view": the project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--dry-run` | preview the spec diff the install would produce; write nothing | — |
| `--force` | for "add view": overwrite the view module even though you own it (destroys your edits) | — |

## Owning generated code

The lower rungs of the [change ladder](user-guide.md#5-making-a-change) — see [`ownership.md`](ownership.md) for what the manifest guarantees. `slots` comes before `eject`: it lists every region you can take over *without* owning a whole file, so bespoke UI costs one component instead of a surface (see [`block-slots.md`](block-slots.md)). `gen --upgrade` regenerates against the current framework generators. `drift` is the other half of the eject bargain: it reports what you own, what it was derived from, and how far it has fallen behind — and never writes anything (see [`upgrade-safety.md`](upgrade-safety.md)).

### `maxstack slots`

List every place bespoke UI can go without ejecting, and which are filled

```sh
maxstack slots [options] [dir] <subcommand>
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--json` | emit the inventory as JSON | — |

#### `maxstack slots fill`

Scaffold a typed, user-owned stub for one block slot

```sh
maxstack slots fill <id> [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `id` | yes | — | slot id, as printed by `maxstack slots` |
| `dir` | no | `.` | project directory |

### `maxstack eject`

Take ownership of a generated route (never re-clobbered)

```sh
maxstack eject [options] <route-id> [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `route-id` | yes | — | route id to take ownership of |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--to <file>` | destination file (default: in place) | — |
| `--dry-run` | preview the file that would be ejected; write nothing | — |

### `maxstack drift`

What you own, what it was derived from, and how far it has drifted (never writes)

```sh
maxstack drift [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--patches` | print the unified diff for every drifted file | — |
| `--json` | emit the report as JSON | — |

## Reviewing and measuring

The review loop and its cost, in the terminal rather than only in the workbench. `review` is the entry point: **what needs you, in order**, worst first — public exposure that would change, then anything that would stop existing, then proposals that cannot be batched, then drift, then the routine majority as one line. Its `--section exposure` answers "what of mine is on the internet", and `--section blast-radius` answers "what does accepting this actually do to the built app" — which tables, routes, forms and REST payloads move (see [`workbench.md`](workbench.md)). `review` prints the queue with a conservative risk classification and clears the safe groups in one action — it will not batch anything touching access, public exposure or a file you own, at any size (see [`bulk-review.md`](bulk-review.md)). `review-cost` is the *human* half of the north-star metric: how much attention approving a change actually takes, separated from wall-clock time and reported per proposal rather than per decision (see [`workbench.md`](workbench.md)). Opt-in — it is telemetry about your own reviewing, so it measures nothing until you ask it to. `regen-cost` is the *platform* half of the same question: how many files a regeneration redraws per op that landed, over time, so a project getting harder to change shows up as a number climbing. It is a proxy and says so — it is deliberately **not** the platform’s own `weightPerSafeChange`, which needs a replay of *attempted* changes that no project records.

### `maxstack review`

What needs you, in order — worst first, with the reason why, plus bulk accept/reject and undo

```sh
maxstack review [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--json` | emit the queue + risk assessments as JSON | — |
| `--accept <selector>` | accept a group ("field:e-order") or one proposal ("fld-total"), comma-separated | — |
| `--reject <selector>` | reject, same selector grammar as --accept | — |
| `--undo <batchId>` | return every row that batch settled to undecided | — |
| `--origin <who>` | who authored this change: ai \| human (default: detected, see MAXSTACK_ORIGIN) | — |
| `--agent <name>` | which agent authored it, for the audit trail (default: detected, see MAXSTACK_AGENT) | — |
| `--section <name>` | "exposure" (what is publicly reachable, and what is one op away) or "blast-radius" (what accepting everything pending does to the built app); omit for the ordered what-needs-you list | — |

### `maxstack review-cost`

What approving a change costs you: engaged time per proposal, separate from wall clock (opt-in)

```sh
maxstack review-cost [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--json` | emit the full report as JSON (summary, decisions, curve) | — |
| `--idle-cutoff <seconds>` | re-derive engaged time with a different idle cutoff (default 120) — the parameter exists so the number can be rechecked, not tuned | — |

### `maxstack regen-cost`

Whether this project is getting harder to change: files regenerated per op, over time

```sh
maxstack regen-cost [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--json` | emit the full report as JSON (points, trend, totals) | — |

## Shipping

Vendor a portable runtime, then run it. See [`deploy.md`](deploy.md).

### `maxstack build`

Vendor a portable deployable runtime (owned code compiled in) + build an image

```sh
maxstack build [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--image <tag>` | docker image tag (default maxstack-<name>) | — |
| `--vendor-only` | produce the portable tree only; skip the image build | — |

### `maxstack deploy`

Ship the vendored runtime (local docker run, or Fly)

```sh
maxstack deploy [options] [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

| Option | Meaning | Default |
| --- | --- | --- |
| `--target <target>` | docker (local run) or fly | `"docker"` |
| `--port <port>` | host port for the local docker run | `"3000"` |
| `--image <tag>` | docker image tag (default maxstack-<name>) | — |
| `--execute` | for --target fly: actually run `fly deploy` | — |

## Agent and contributor tooling

`mcp` and `guard-edit` are wired into the scaffolded project for you — you rarely type them.

### `maxstack mcp`

Serve the MCP platform tools over stdio (spawned by agent clients via .mcp.json)

```sh
maxstack mcp [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

### `maxstack guard-edit`

PreToolUse hook: deny agent edits to generated files (reads the event on stdin)

```sh
maxstack guard-edit
```

### `maxstack runtime`

Run this project against a local maxstack checkout (contributor debugging)

```sh
maxstack runtime <subcommand>
```

#### `maxstack runtime link`

Serve this project from a local checkout instead of the installed runtime

```sh
maxstack runtime link <path> [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `path` | yes | — | path to a maxstack checkout (the dir holding apps/web) |
| `dir` | no | `.` | project directory |

#### `maxstack runtime unlink`

Drop the link and go back to the installed runtime

```sh
maxstack runtime unlink [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |

#### `maxstack runtime status`

Show which runtime this project resolves to, and why

```sh
maxstack runtime status [dir]
```

| Argument | Required | Default | Meaning |
| --- | --- | --- | --- |
| `dir` | no | `.` | project directory |
