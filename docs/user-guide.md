# User guide — using MAXSTACK as a maintainer

This is the practical walkthrough: setup, starting a project, getting an
initial app, and — the part the platform actually exists for — making the 2nd,
10th, and 50th change safely. It documents what works **today**.

The one mental model to hold: **the spec is the source of truth, and nothing
grounds until a human decides.** ("Grounds" = becomes truth the generators and
the admin surface are allowed to build on; only rows a human has accepted — or
added manually — ground.) Agents propose typed spec-ops; a proposal lands
*suggested*; you accept/reject in the workbench (or via the
`provenance.review` op). That is the loop `"reviewMode": "review"` gives you;
be aware that it is **not** what a fresh project does — `init` writes
`"reviewMode": "auto"`, which accepts in the same invocation, and
`apply_spec_change` lands accepted whatever the mode says. Generators derive code, DB, admin CRUD, docs, and
test scaffolds from the *accepted* spec; generated files are never clobbered
once you touch or eject them. You never hand-edit generated files — you change
the spec, fill a slot, or eject.

---

## 1. Setup

### Using maxstack (the normal path)

No install. **Node ≥ 22** is the only prerequisite (Docker only if you'll run
`maxstack build`/`deploy`):

```sh
npx maxstack@latest init my-app
```

`npx` fetches the CLI plus the prebuilt web runtime it pins
(`maxstack-runtime`), so `dev`, `demo`, `build`, and `deploy` all work
standalone — no monorepo checkout, no pnpm, no global state. Measured cold on a
machine that has never seen the packages, that first command lands in well under
a minute; [measurement.md](measurement.md) is how that number is produced.

Once you're using it regularly, a global install drops the prefix from every
command in this guide:

```sh
npm install -g maxstack
```

Everything below is written as `maxstack <verb>`; read `npx maxstack@latest
<verb>` if you skipped the install. Skip ahead to §3a.

Right after a release, npm's cached registry metadata can lag by a few minutes
and resolve an older version. If the version isn't the release you expected, pin
it exactly: `npx maxstack@<version>` (or `npm install -g maxstack@<version>`).

### Staying current

A global install is the one that goes stale silently, so the CLI tells you.
At most once a day, on an interactive terminal, a command that finishes while
you're behind the published `latest` prints a short notice naming both versions
and the command to fix it:

```
  Update available  0.11.7 → 0.12.0
  npm install -g maxstack@latest      (maxstack-runtime updates with it)
```

The check runs *alongside* your command rather than before it, so it does not
slow anything down, and it never fails a command — an unreachable registry just
means no notice. It stays quiet in CI, when output is piped, and over the `mcp`
stdio transport, which is also what keeps the banner out of a JSON-RPC stream.

Turn it off with `MAXSTACK_NO_UPDATE_CHECK=1` (or the conventional
`NO_UPDATE_NOTIFIER=1`), or permanently by setting `"enabled": false` in
`~/.maxstack/update-check.json`.

To ask on demand instead — including the runtime's version, which is pinned per
project and reported separately — use [`maxstack doctor`](cli-reference.md#maxstack-doctor).
It also states whether the passive notice is on, and which rule silenced it if
not.

There is deliberately **no `maxstack self-update`**. Global installs land
through npm, pnpm, bun, volta, and asdf, with and without `sudo`, and a command
that mutates its own running binary across that matrix is a support burden out
of proportion to typing one line. `maxstack gen --upgrade` is a different thing
entirely — it upgrades a *project* against the installed generators, not the
installed packages.

### Working on the platform itself (the `maxstack` checkout)

Only needed to hack on maxstack, run §2's tour, or use the harness
(`eval`/`dogfood`):

- **Node ≥ 22.7** — repo scripts run TypeScript directly via
  `--experimental-strip-types` / `--experimental-transform-types`, no build step.
  (The repo's `engines` field only enforces ≥ 22, so check `node -v` yourself —
  22.0–22.6 installs fine and then fails with a cryptic unknown-flag error.)
- **pnpm** (the repo uses pnpm workspaces + turborepo).
- Optional: `gh` (the scaffolder will best-effort create a private GitHub repo).

```sh
cd maxstack
pnpm install
pnpm validate        # typecheck && lint && test — the validate gate. Run it; trust nothing that hasn't passed it.
```

When a `maxstack` checkout is present, the CLI prefers it over the packaged
runtime automatically (vite dev server, HMR — see §3a).

## 2. Five-minute tour (no project needed — requires the `maxstack` checkout)

```sh
pnpm --filter @maxstack/web dev
```

With no `MAXSTACK_DATA_DIR` set, the dev server seeds a demo project (the
Taskly fixture) into `.maxstack/` under `apps/web` on first boot, so state
survives restarts. The server prints its URL — `http://localhost:5173` by
default. Open:

- **`/workbench`** — the review-first canvas. Left: the spec as a zoomable
  tree (product → data → pages → pricing), every row badged with its
  provenance state. Center: the **review queue** (every undecided AI
  suggestion, Accept/Reject per row), or a node's detail when you click a
  zoom link — for a page, that includes a **rendered live preview** of the
  code the generator would emit. Right: the decision ledger (open decisions
  with alternatives, pros/cons, and a Resolve form) plus the interaction
  telemetry feed.
- **`/admin`** — the generic CRUD surface (**Sprout** — the schema-driven
  admin engine): list/detail/create/edit forms and tables derived from the
  schema, no per-entity code.
- **`POST /mcp`** (`http://localhost:5173/mcp`) — the JSON-RPC MCP endpoint
  agents use. Same tools, same spec singleton as the workbench: an agent
  conversation and your workbench session see one source of truth. §4 shows
  how to connect an agent to it.

To see the whole loop run end-to-end reproducibly before trying your own
(stop the tour's dev server first — the next step starts its own):

```sh
maxstack demo <project-dir>            # load sample data
maxstack demo <project-dir> --clear    # remove just the rows it created
maxstack dev <project-dir>             # browse it
```

That loads sample data through the platform's own surfaces — agent spec-ops,
human review ops, generators — and leaves you a browsable project.

## 3. Starting a new project

Two distinct paths exist today; don't confuse them.

### 3a. A platform project (spec-driven — the real thing)

The front door is `maxstack init`. A project is its own directory, and it can
live **anywhere on disk** — you don't scaffold it inside `maxstack/`:

```sh
cd ~/code
maxstack init       # asks for a project name; scaffolds into ./<kebab-case-name>
cd todo
maxstack demo       # optional: load sample data to explore
maxstack dev        # keep running — serves the app + the MCP server
# ...then, from Claude Code (`claude` in another shell): /plan-and-scope...
# ...or evolve the spec straight from the terminal:
maxstack add-entity task --field title:text! --field done:bool --accept --gen
maxstack add-page task --accept --gen   # give it a browsable page (a list at /task)
maxstack validate   # the standalone gate: spec valid · manifest intact · regen safe
```

Bare `maxstack init` is the whole quickstart: it asks what the project should
be called (Enter accepts the current folder's name) and scaffolds into a
`./<kebab-case-name>` subdirectory — the human-facing name goes in
`maxstack.json` and the spec title, the kebab-case slug becomes the directory
and package name. Pass a directory as an argument (`maxstack init ~/code/todo`)
to skip the prompt and let `init` create that exact path. Two optional flags
refine the seed: `--desc "one-line product description"` seeds a richer spec,
and `--backend postgres` swaps the default `pglite` store.

**Hybrid onboarding.** `maxstack init` is the single one-time shell step; it now
drops a `.mcp.json` and the `.claude/skills`, so `cd && claude` auto-registers
the MCP server (no `claude mcp add`) and the `plan-and-scope` → `run-next-task`
→ `ship-check` skills load themselves. Keep `maxstack dev` running the whole
time — the HTTP MCP server only answers while it's up.

The layout `init` creates:

- `spec/` — the one-system spec, split by layer (product · data · pages ·
  pricing · ledger, plus an append-only `oplog.jsonl`). The
  **source of truth, committed to git**. `maxstack op`/`gen`/`validate`, the
  workbench, and agents over MCP all read and write this one file.
- `maxstack.json` — project config (app dir, data dir, backend, `reviewMode`).
  `"reviewMode": "auto"` is what `init` writes (trusted-solo): every `op`/
  `add-entity`/`add-field` auto-accepts + regenerates, because the review queue
  is pure friction when you're reviewing your own intent. Set it to
  `"review"` for the review-first loop, where those verbs land *suggested* and
  wait in `/workbench`. It keys off the write path, not the author — an agent
  driving the CLI settles the same way you do. `"cookieBanner"` decides whether the runtime shows
  the cookie-consent banner: `"auto"` (default) shows it only once the `auth`
  bundle is installed — a personal app with no sign-in has nothing to disclose —
  and `"always"`/`"never"` make it a deliberate choice.
- `.mcp.json` + `.claude/skills/` — the MCP registration and the spec-driven
  skills. Committed; this is what makes `cd && claude` just work.
- `app/` — generated route modules + user-owned `*.slots.tsx` stubs + the
  ownership manifest. `maxstack dev` regenerates it automatically as the spec
  changes — you don't run `maxstack gen` by hand in the dev loop.
- `.maxstack/` — durable **runtime** state (pglite `db/`, `telemetry.jsonl`),
  gitignored. Created on first `maxstack dev`.

**Where the runtime comes from.** Every project verb runs standalone from the
npm install: with no owned code, `maxstack dev` serves the **prebuilt
runtime** shipped in the `maxstack-runtime` package (spec changes are live on
the next request; *owned code* — filled slots, ejected routes — isn't compiled
into it). The moment the project carries owned modules, `maxstack dev`
**auto-selects the owned dev server** (the `--owned` path, announced at
startup): it vendors the runtime source under `.maxstack/runtime/` (one-time),
`pnpm install`s it (pnpm is the one extra tool this path needs — without pnpm
you get the prebuilt server plus an "install pnpm" pointer), and runs *its*
vite dev server — the same HMR + owned-slot hot loop a checkout gets.
`maxstack build` compiles the same owned code into a deployable image. Whatever the mode, `maxstack dev` serves
on **port 3000** (override with `--port` or `PORT`), which is what the
scaffolded `.mcp.json` points at. Inside a `maxstack` checkout the CLI
automatically prefers the checkout instead — a vite dev server with HMR and
the owned-slot hot loop (package mode announces itself with a `prebuilt
runtime` banner). Working from a checkout, link the CLI once instead of
installing it:

```sh
pnpm --filter maxstack link --global        # or a shell alias, see README
```

`maxstack dev` reads the data dir from `maxstack.json` and resolves it to an
absolute path itself, so you no longer need the `$PWD/...` dance. If you *do*
point `MAXSTACK_DATA_DIR` at a project by hand, a relative value now resolves
against your shell (`INIT_CWD`), not the dev server's cwd — and a boot that
finds no spec at the resolved path logs a loud one-liner instead of silently
seeding a ghost project.

## 4. Building the initial version

**Connecting an agent.** Projects scaffolded by `maxstack init` already carry
a `.mcp.json`, so Claude Code auto-discovers the server — nothing to do. For
any other MCP client (or a pre-`.mcp.json` project), point an HTTP transport
at the endpoint — e.g. for Claude Code:

```sh
claude mcp add --transport http maxstack http://localhost:3000/mcp
```

(Port `3000` is `maxstack dev`'s default in every mode — if you serve on
another port via `--port`/`PORT`, set `MAXSTACK_MCP_URL` to match. A bare
`pnpm --filter @maxstack/web dev` outside the CLI runs vite on `5173`.)

The endpoint speaks plain JSON-RPC 2.0 over POST (`initialize`, `tools/list`,
`tools/call`), so `curl` works too for a quick poke.

The loop, whether driven by a bootstrap script or an agent talking to
`POST /mcp`:

1. **Agent proposes the spec.** Spec changes go through
   `propose_spec_change` (dry-run: what would change, validation result) →
   `apply_spec_change`. The op vocabulary is typed and deliberately
   **additive**: `prd.addRequirement/addScopeItem/addRisk/addMetric/recordDecision`,
   `data.addEntity`, `data.addField`, `page.addPage`, `page.addBlock`,
   `pricing.addTier`, plus `provenance.review`. Every AI-origin op lands
   *suggested* — and then, unless the project sets `"reviewMode": "review"`,
   is accepted by the same invocation that landed it (`apply_spec_change`
   always does; the CLI verbs do under the default `auto`), so the row is
   marked suggested *and* accepted. Design forks land as pending decisions in
   the ledger, not as silent choices.

2. **You review.** Open `/workbench`. Work the queue: Accept makes a
   suggestion grounding truth; Reject is a soft-reject (never a delete — the
   row stays, unaccepted). Resolve open decisions in the right pane (pick an
   alternative, write the rationale). Every accept/reject is a
   `provenance.review` op in the spec's op log — the decision trail is as
   durable and diffable as the spec itself.

3. **Use the app immediately.** You don't wait for codegen to have a working
   app: `/admin` is grounded in *your* project's accepted spec (the
   spec→Sprout bridge derives live drizzle tables + additive-only DDL on
   on-disk pglite). Rows persist in `<data-dir>/db`. The grounding rule:
   accepted (or manually-added) entities and fields count; an accepted
   `data.addField` is writable on the very next request — no restart, no
   migration ceremony.

4. **Generators land the code.** The `page` generator (also reachable as the
   `run_generator` MCP tool) emits route modules, user-owned `*.slots.tsx`
   stubs, `routes.ts`, and the ownership manifest into `<data-dir>/app/`;
   `docs` and `e2e-tests` add `OVERVIEW.md` and Playwright scaffolds from each
   page's acceptance criteria. Regeneration over an unchanged spec is
   asserted **all-unchanged** — that's the never-clobber guarantee, checked,
   not asserted.

## 5. Making a change

This is the platform's whole reason to exist. This section is the **canonical
statement of the change ladder** — other docs link here rather than restating
it (the mechanisms behind rungs 2–4 are designed in
[`ownership.md`](ownership.md)). Changes go up an explicit ladder — always
reach for the lowest rung that expresses the change:

1. **Spec-op** (most changes): tell the agent what you want ("add a
   `renewsOn` date field to Subscription"). It applies `data.addField` via
   MCP; the admin form has the field on the next request and the next
   regeneration derives it everywhere. Zero hand-written code. `apply_spec_change`
   lands **accepted**, not queued — the tool description says so — so read the
   `effect` it returns rather than expecting a gate downstream; ask for
   `propose_spec_change` when you want the diff without the write. Driving it
   yourself from the terminal is the same primitive with sugar: `maxstack
   add-field subscription renewsOn:date!` (or a whole entity: `maxstack
   add-entity subscription --field renewsOn:date!`), which under the default
   `"reviewMode": "auto"` also lands accepted and regenerates. Set
   `"reviewMode": "review"` to make those verbs queue instead, and then
   `--accept --gen` collapses land → accept → regenerate for a single write.
   The raw `maxstack op --file <op.json>` stays the honest underlying wire
   format — the sugar just compiles to it.

   **Quote any field spec carrying `(` or `->`.** Both are shell syntax, so
   `--field 'status:enum(todo,done)'` and `--field 'owner:->e-user'` need the
   quotes. Unquoted, `owner:->e-user` is the word `owner:-` followed by a
   redirect that writes an empty file named `e-user`, and the CLI reports a
   field type `-` you never typed. The `ref:` spelling —
   `--field owner:ref:e-user` — means the same thing and needs no quoting.

   **Who gets the credit.** Every landed op records an `origin` in
   `spec/oplog.jsonl` — the *author*, not the transport. An agent that shells
   out to the CLI (encouraged: the terminal sugar is fine for agents to use)
   is detected automatically and logs `"origin": "ai"`, the same label the MCP
   path writes, and its rows land accepted-but-visibly-suggested rather than
   `manual()`. Override it per command with `--origin ai|human`, or for a whole
   shell with `MAXSTACK_ORIGIN=ai|human` — the flag wins over the env var, and
   both win over detection. Set `MAXSTACK_ORIGIN` if you drive maxstack from an
   agent harness we don't detect.

2. **Slot-fill** (custom UI inside a generated page): generated pages render
   `<Slot name="…"/>` wired to a **stable, user-owned `*.slots.tsx` file**.
   The generator wrote that stub exactly once and will never touch it again —
   edit it freely (e.g. color a row red when a renewal is < 7 days away).
   The generated file keeps regenerating; your slot file survives
   byte-identical.

   Slots are not only page-level. Every resource page also exposes **block-level
   slots** — its header, its list, one row, one field's cell, its empty state —
   derived from the spec rather than declared in it, so a bespoke card or a
   custom player replaces *one region* while everything around it keeps
   regenerating. Run `maxstack slots` to see every one and which are filled, and
   `maxstack slots fill <id>` to scaffold a typed stub. This is the rung that
   makes genuinely bespoke UI cost a component instead of a surface — see
   [`block-slots.md`](block-slots.md).

3. **Eject** (you need to own the whole file): eject copies the generated
   file with a banner stripped and flips its ownership to `ejected` in the
   manifest. From then on regeneration will *never* overwrite it — it's
   yours, including the responsibility to keep it current.

4. **Regeneration-as-diff**: for spec changes that touch already-generated
   files, `regenerateAsDiff` re-derives and returns a reviewable unified diff
   instead of overwriting; protected files are surfaced, never proposed. The
   batch lands only if the validate gate passes.

### Scaffolding a view — infer-then-eject (`maxstack add view`)

Rung 3 has a fast path for list/detail pages: `maxstack add view <page>`.
Where `maxstack gen` emits a *framework-owned* route module, `add view` emits an
**owned** one, pre-ejected, on the same contract `maxstack eject` hands over
(`OwnedRouteProps`):

```sh
maxstack add view post     # writes app/routes/post.tsx, ejected
```

**The argument names a page**, because a page — not an entity — is the unit you
own: one module per page, one manifest entry per module. Naming the resource is
the shorthand for "the one page over it", and it is all you need until an entity
has two. When it does, name the page: its route path, its page id, or the module
key `gen` filed it under. The command lists them if you don't.

```sh
maxstack add view /archive        # the page at /archive
maxstack add view pg-post-archive # …the same page, by id
maxstack add view post-archive    # …by the module key gen wrote
maxstack add view post            # error: "post" has 2 pages — say which
```

The scaffolded file:

- takes the page's loader output as props and draws the list by spreading it
  (`<ResourceList {...list} …/>`), so it renders the *same* rows the framework's
  own list would — already ordered, permission-gated, with foreign keys resolved
  to their titles and file keys signed into URLs. Nothing is refetched in the
  browser and no schema is frozen into the file, so a field added to the spec
  later shows up without an edit here;
- demonstrates the eject seam with one overridden cell (the title column) in a
  `columns` map merged *over* that inference — delete it to fall fully back to
  inference, or add more overrides for the cells you care about.

What you own is the **render**. The **loader** is still framework code: it
resolves this page from `spec/` on every request, so the page keeps its spec
entry.

The route is registered `ejected` in the manifest, so **your edits survive
regeneration**: `maxstack gen` reports it `skipped-user-owned` and never touches
it again. The workflow is the whole point — start inferred → eject the one cell
you care about → the rest stays inferred. `maxstack build` wires the owned module
into `OWNED_ROUTES` so it also executes in a deployed build.

Three things to know before you reach for it:

- **An owned module replaces the page's whole surface.** If the page it lands on
  is arranged by a `calendar`, `timeline` or `board` block, the scaffold draws a
  table there instead — the same trade `maxstack eject` refuses to make quietly.
  The command warns; prefer filling a block slot, which keeps the arrangement.
- **The view renders at one page, and only that page.** An owned view has no URL
  of its own — the runtime mounts it at the page you named, by that page's
  module key. Sibling pages over the same entity keep their generated modules.
  If the resource has no page at all yet, the command warns and prints the exact
  `page.addPage` op to run; without it you'd 404 in dev.
- **Owned code is compiled, not spec-interpreted.** From an npm install,
  `maxstack dev` auto-selects the owned dev server whenever owned modules
  exist (§3a; needs pnpm — otherwise it falls back to the prebuilt server with
  a pointer), and `maxstack build` compiles them into the deployable image.
  From a maxstack checkout, `maxstack dev` runs owned code as-is.

The invariants that make all of this safe: additive-only spec-ops + additive
DDL (a change can't strand your data), manual rows survive regeneration,
generators ground only on accepted entities, and the manifest-checked
never-clobber writer. And the standing rule from the validate gate: every
change ends with `maxstack validate` (or `pnpm validate` when you're working
in the `maxstack` repo itself).

## 6. Reference

**Commands** — the full, always-current list (every verb, every flag, the
environment variables, and the exit behavior) is
[`cli-reference.md`](cli-reference.md), generated from the command tree itself.
The verbs you will actually reach for day to day:

| Command | What it does |
|---|---|
| `maxstack init [dir]` | Scaffold a project: spec + config + `app/` + `.mcp.json` + skills |
| `maxstack dev` | Serve the app over the project's data dir: `/admin`, `/workbench` — port `3000` in every mode (`--port`/`PORT` to change); `--owned` serves owned code live |
| `maxstack demo` | Load sample data into the project |
| `maxstack add-entity <slug> --field name:type[!] …` | Sugar → a `data.addEntity` op (no hand-authored JSON) |
| `maxstack add-field <entity> <name:type[!]>` | Sugar → a `data.addField` op |
| `maxstack add-page <entity>` | Sugar → a `page.addPage` op |
| `maxstack op … --accept --gen` | Land + auto-accept + regenerate in one shot (the trusted-solo happy path) |
| `maxstack eject <route-id> --dry-run` | Preview the file eject would take ownership of; write nothing |
| `maxstack validate` | The standalone gate: spec valid · manifest intact · regen safe |
| `maxstack doctor` | What is actually running: versions, staleness, store lock, dev server, MCP handshake |
| `maxstack build` / `maxstack deploy` | Vendor a self-contained runtime → Docker image → run/Fly |

Monorepo-only (they need the `maxstack` checkout, so they are not CLI verbs):

| Command | What it does |
|---|---|
| `pnpm validate` | The repo gate: lint + boundaries + generated-docs drift + typecheck + test (`--fix` available) |
| `pnpm docs:reference` | Regenerate the generated reference docs after changing a CLI verb, spec-op, or MCP tool |
| `pnpm --filter @maxstack/web dev` | Checkout dev server on `http://localhost:5173` (set `MAXSTACK_DATA_DIR=<dir>` to point it at a project) |
| `
**Spec-ops**: the complete vocabulary, with the JSON Schema for every op's
arguments, is [`spec-ops.md`](spec-ops.md).

**MCP tools**: `query_spec`, `propose_spec_change`, `apply_spec_change`,
`run_generator`, `run_checks`, `explain_feature`, `list_acceptance_criteria`,
`record_decision` — served over **stdio** via the scaffolded `.mcp.json`, plus
the Sprout data tools (`describe_resources`, `list_records`, `get_record`,
`query_records`, `create_record`, … — a fixed vocabulary that takes the resource
as an argument). `query_records` answers a question spanning several
entities in one call by walking the references the spec declares.
See [`mcp-reference.md`](mcp-reference.md).

**Project data dir** (`MAXSTACK_DATA_DIR`): `spec/` (spec split by layer + op log) ·
`telemetry.jsonl` (interaction events) · `db/` (pglite, survives restarts) ·
`app/` (generated code + `.generated.routes.json` ownership manifest).
Always pass it as an **absolute path** (see §3a).

**Resetting state**

- The no-`MAXSTACK_DATA_DIR` tour state lives in `apps/web/.maxstack/` —
  delete it and the next boot re-seeds the demo fresh.
- Demo data: `maxstack demo <dir> --clear` removes just the rows it created.
- A project dir is disposable the same way: delete `<data-dir>` (or just its
  `db/`) and the next boot starts it over.

**When `pnpm validate` fails**: it runs typecheck → lint → test in order and
reports the failing stage. `pnpm validate --fix` auto-fixes lint first; the
stages also run individually as `pnpm typecheck` / `pnpm lint` / `pnpm test`.

## 7. When things go wrong

The happy path above is the *common* path, not the *only* one. The first time
an op is rejected or `maxstack validate` goes red is exactly where trust is won
or lost — here's the map.

**A rejected op.** `maxstack op` (and `add-entity`/`add-field`) validate the
change *before* touching the `spec/` dir, so a rejection never leaves the spec
half-changed. You'll see the op name and a bulleted list of reasons:

```
✖ op "data.addField" rejected:
- data.addField: unknown entity "e-tsak"
- data.addField: duplicate field id "fld-task-title"
```

The three usual causes: an **unknown id** (a typo in an `entityId`/`reference`
— check `maxstack op --op '{"op":"…"}'` targets an id that exists), a
**duplicate id** (the entity/field/page already exists — ops are additive, so
re-adding is an error, not an upsert), or an **out-of-range field** (e.g. a
`page.setBlockOrder` direction that isn't `asc`/`desc`). Fix the argument and
re-run; nothing was written, so there's nothing to undo.

**A red `maxstack validate`.** The gate makes three separate claims; the
failure line tells you which broke:

- `drift: app/routes/x.tsx no longer matches the generator` — a *generated*
  file was hand-edited. Either you meant to own it (`maxstack eject <id>` — then
  the edit is legitimate and survives), or you didn't (`maxstack gen` rewrites
  it back to the generated form). Generated files are never yours to edit in
  place; that's what eject is for.
- `missing generated file: …` — a tracked file was deleted. `maxstack gen`
  re-emits it.
- `unsafe regen …` — a regeneration would clobber something owned. This should
  not happen; if it does, it's a generator bug worth reporting, not something to
  work around by deleting files.

**Preview before you eject.** Rung-4 eject takes *whole-file* ownership — from
then on you keep it current, and `maxstack gen` stops touching it. That's a real
commitment, so look before you leap:

```sh
maxstack eject post --dry-run    # prints the exact file, writes nothing
maxstack eject post              # commit to owning it
```

**Config-name drift (three files, three jobs).** Newcomers trip over the
overlapping names — they are genuinely different files:

| File | Where | What it is |
|---|---|---|
| `spec/` | your project root | the **spec** — product/data/pages/pricing/ledger, split by layer (+ `oplog.jsonl`). The source of truth. |
| `maxstack.json` | your project root | your **project config** — `appDir`, `dataDir`, `backend`, `reviewMode`, `cookieBanner`, installed bundles. |

If you're inside a project you init'd, you only ever touch the `spec/` dir (via
ops, never by hand) and `maxstack.json`.

**Start with `maxstack doctor`.** Before theorizing about any misbehavior, run
it in the project. One report answers the questions that otherwise take a
checkout to answer: which CLI is running versus which one `PATH` (and therefore
`.mcp.json`) resolves, which runtime is serving and whether it is behind npm or
linked to a local checkout, whether that runtime ships source maps, whether the
store lock or the dev-server record is stale, and whether the MCP server
actually completes a handshake. It exits non-zero only on `✖` findings, so it
also works as a CI check.

```sh
maxstack doctor              # the full report
maxstack doctor --offline    # skip the npm registry probe
maxstack doctor --json       # the findings as data
```

### Is this my spec, or the runtime? (the boundary)

This distinction matters more than it sounds, because getting it wrong means
auditing a five-op spec for hours over a bug that lives somewhere you can't see.

**Your spec** decides *what exists*: entities, fields, pages, blocks, which
fields a list shows, the theme, installed bundles. If the wrong data is on the
page — a missing column, an entity that shouldn't be there, a page at the wrong
route — that is a spec question, and a spec-op fixes it.

**The runtime** decides *how it all behaves*: rendering, form widgets and their
coercion, routing, hydration, auth, the `/api/<resource>` surface, the admin and
workbench shells. It is the `maxstack-runtime` package — a prebuilt server under
your global install, the same for every maxstack project. If a date input mangles
what you typed, a banner reappears after you dismiss it, or a form posts the
wrong shape, **no spec-op can fix that** and nothing in your project explains it:
it's a runtime bug.

Runtime bugs go to <https://github.com/sys13/maxstack/issues> — paste the
`maxstack doctor` output, which pins down the exact runtime version. If the
runtime ships source maps (doctor says so; every build from 0.11.7 on does),
browser devtools shows real component and file names and server stack traces
point at `app/…tsx:LINE`, so a report can name the actual code.

Want to fix it yourself? You don't need the folk procedure of copying a fresh
`build/` over your npm install — link a checkout:

```sh
git clone https://github.com/sys13/maxstack && cd maxstack/maxstack && pnpm install
maxstack runtime link "$PWD" ~/my-project   # the dir holding apps/web
maxstack dev ~/my-project                   # now the checkout's vite server: HMR, real sources
maxstack runtime unlink ~/my-project        # back to the installed runtime
```

The link is recorded in the project's (gitignored) data dir, so it is local to
your machine and never reaches a teammate. While it is active, `dev`, `build`
and `deploy` all print a **LINKED RUNTIME** banner — a linked runtime is
unpublished code, and an image built from one contains it.

**Further reading**: the full docs index is [`README.md`](README.md). Closest
neighbors: [`workbench.md`](workbench.md) · [`ownership.md`](ownership.md) ·
[`deploy.md`](deploy.md).
