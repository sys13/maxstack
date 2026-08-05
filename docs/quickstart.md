# Quickstart

A running, browsable app in one command — with the one mental model you need to
keep it safe to change afterwards.

**Prerequisite:** Node ≥ 22. That's it — Docker only enters when you get to
[`deploy.md`](deploy.md).

## 1. One command, no install

```sh
cd ~/code
npx maxstack@latest start "a bug tracker for small teams"
```

That scaffolds the project, lands the spec-ops your description implies, seeds
sample rows, and serves the app — then prints the URL. Open it and there is
something there: pages with rows in them, not an empty table.

Three things worth knowing about what just happened, because none of it is
magic and all of it is inspectable:

- **The starting spec is reviewable, not conjured.** Every entity and page
  arrived as a typed [spec-op](spec-ops.md) in the op log, recorded with
  `origin: ai`. `/workbench` shows them as machine-authored, same as any later
  change an agent proposes.
- **The rows are labelled demo data.** They carry a `demo` chip in every list
  and a notice at the top of the app, and
  `npx maxstack@latest demo --clear` removes exactly those rows and nothing
  else. You will never wonder which rows were yours.
- **With no API key it is still deterministic.** The description is compiled by
  a built-in compiler; an `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) lets a
  model draft a better-fitting model instead. Either way the result is a spec
  you review.

`--no-seed` starts empty, and `--no-dev` stops after generating the app tree.

### Or scaffold without the starting spec

`start` is `init` plus the three steps most people take next. If you want the
bare project — no entities, no rows, no server:

```sh
npx maxstack@latest init          # prompts for a name, scaffolds ./<kebab-case-name>
cd <your-project>
```

That is the whole install step: `npx` fetches the CLI and the prebuilt web
runtime it pins (`maxstack-runtime`) into npm's cache and runs it. No `-g`, no
global state, nothing to uninstall — and everything below works standalone, with
no repo checkout and no pnpm.

You now have a spec, an app tree generated from it, a validate gate, and a
`.mcp.json` that hands the platform tools to any agent you point at the project.
A project is its own directory and can live anywhere — you do **not** scaffold
inside a maxstack checkout.

> Scaffolded through `npx`, the project's `.mcp.json` and edit-guard hook are
> written as `npx -y maxstack@<version> …` rather than a bare `maxstack`, so they
> resolve without a global install and stay pinned to the version that created
> the project.

### If you'll come back to this often

A global install drops the prefix from every command below, and is worth it once
you have more than one project:

```sh
npm install -g maxstack
maxstack --version
```

Everything in this guide works either way; where it says `maxstack <verb>`, read
`npx maxstack@latest <verb>` if you skipped the install.

> Right after a release npm's cached metadata can lag a few minutes and resolve
> an older version. If `--version` isn't what you expected, pin it:
> `npx maxstack@<version>` (or `npm install -g maxstack@<version>`).

## 2. Run it

`start` already left a server running; `Ctrl-C` and `maxstack dev` bring it back
(and it is what you run after an `init`):

```sh
maxstack dev           # leave running
```

Open the URL it prints. Two surfaces are worth knowing immediately:

- **`/admin`** — CRUD over everything in your spec, derived from it directly.
  No per-entity code was written to make this exist.
- **`/workbench`** — the review queue. Every AI-proposed change waits here for
  your accept/reject.

## 3. Make a change

Leave `dev` running and use a second shell. Say the app needs tasks:

```sh
maxstack add-entity task --field title:string! --field done:bool
maxstack add-page task
maxstack demo                    # sample rows, so the page isn't an empty table
```

Refresh the browser — `/task` is there with rows in it, and `/admin` knows about
tasks. (`maxstack demo` only has something to seed once entities exist, which is
why it comes after this step and not before; `maxstack demo --clear` takes those
rows back out again.)

What actually happened: each command compiled to a typed **spec-op**
(`data.addEntity`, `page.addPage`), the op was validated and appended to the
op-log with its author recorded, and the generators derived the code. You did
not hand-edit a generated file, and you never will — that is the whole trick.

Changes you make yourself land accepted and regenerate as they go — no flags.
The review queue is for changes you did *not* make: an agent proposing through
MCP arrives as a *suggestion* and waits for you in `/workbench`. Set
`"reviewMode": "review"` in `maxstack.json` if you want your own edits queued
too.

Check the gate whenever you want reassurance:

```sh
maxstack validate      # spec valid · manifest intact · regen safe
```

## 4. Point an agent at it

The project's `.mcp.json` already registers the platform tools over stdio, so
an MCP-capable agent started in this directory has them in every session — no
port, no ordering against `maxstack dev`. From Claude Code, just start `claude`
in the project and ask for a feature; it will propose spec-ops that queue up in
`/workbench` for you.

If your client has no MCP, the CLI verbs above reach the identical op path.
Nothing is agent-only. See [`mcp-reference.md`](mcp-reference.md).

## Where to go next

| You want to | Read |
| --- | --- |
| The real walkthrough, including the 10th and 50th change | [`user-guide.md`](user-guide.md) |
| What every CLI flag does | [`cli-reference.md`](cli-reference.md) |
| The full spec-op vocabulary with arg schemas | [`spec-ops.md`](spec-ops.md) |
| The agent surface | [`mcp-reference.md`](mcp-reference.md) |
| Owning generated code — slots, eject, the manifest | [`ownership.md`](ownership.md) |
| Getting it deployed | [`deploy.md`](deploy.md) |
| How the 60-second entry claim is measured | [measurement.md](measurement.md) |

## The one thing to remember

**The spec is the source of truth, and nothing grounds until a human decides.**
Agents propose typed ops; proposals land *suggested*; you accept or reject;
generators build only from what's accepted; generated files are never clobbered
once you touch or eject them.

When you need code the spec can't express, you don't fight it — you fill a slot
or eject the route and own it outright. That ladder is
[§5 of the user guide](user-guide.md), and it is the canonical statement of how
change works here.
