# maxstack

A TypeScript app framework for building with a coding agent. Your database,
admin UI, forms, validation, REST API, auth and MCP tools all derive from one
typed spec — so the agent describes the product instead of hand-writing the
plumbing.

```sh
npx maxstack start "a bug tracker for small teams"
```

→ a running app with rows already in the tables.

---

```
$ npx maxstack start "a task tracker for a small team"
✔ scaffolded task-tracker · landed 4 spec-ops — origin: ai, in the op log
  ├ Project  name:string! · notes:string
  ├ Task     title:string! · status:enum · priority:enum · dueOn:date · project:->Project
▸ /admin/task · /workbench · POST /mcp   localhost:3000

$ cd task-tracker && claude
> add a due date to tasks, and a page grouped by assignee
✓ agent drove the spec-ops over POST /mcp — waiting in your review queue

$ maxstack add members billing
✓ teams + subscriptions installed with their prerequisites, through the same op path

$ maxstack validate
✓ spec valid · manifest intact · regeneration safe
```

## Why this shape

An agent writing a conventional app writes the same plumbing every time —
migrations, a form, a validator, a list page, an API route, a permission check
— and every one of those is a place for it to be subtly, silently wrong.

maxstack moves that work behind a **typed spec**. The agent proposes a change to
the spec; the framework derives the app. What the agent writes is small,
checkable, and rejected outright if it does not typecheck against the rest of
the system.

## Ownership, in three lines

- **Spec-op** — the app changes because the spec changed. Nothing is owned.
- **Slot** — a typed extension point inside a generated page. Written once,
  yours from then on.
- **Eject** — take a whole route. Copied with a banner, never regenerated.

The manifest records which of the three every file is. Regeneration rewrites
what it generated and leaves the rest alone — **never clobbers code you own** is
an invariant with tests behind it, not a policy.

## What you get from the spec

Database schema and migrations · admin CRUD UI · forms with client and server
validation · a REST API · full-text search · file storage · role-based
permissions · an MCP server so agents can drive the same operations · a review
queue for anything an agent proposes.

Plus a catalog of feature bundles that fold in whole capabilities — `auth`,
`members`, `billing`, `audit`, `email`, `jobs`, `flags`, `notifications`,
`storage`, `webhooks`, `api-keys`, `compliance`, `observability`,
`preferences`, `admin` — each through the same validated op path.

## Getting started

```sh
npx maxstack start "what you want to build, in a sentence"
```

- **[Quickstart](docs/quickstart.md)** — the ten-minute version.
- **[User guide](docs/user-guide.md)** — the full tour.
- **[Examples](examples/)** — complete example apps, as specs you can read.
- **[Architecture](ARCHITECTURE.md)** — the layer map, and how a change flows.
- **[Docs index](docs/README.md)** — reference for every op, verb and bundle.

Requirements: Node 22+. Docker only for `maxstack build` / `deploy`.

## Working on maxstack itself

```sh
pnpm install
pnpm validate
```

See **[CONTRIBUTING.md](CONTRIBUTING.md)** — including why each check in the
gate exists, which is mostly "because this bug shipped green once".

## How it is measured

Claims here are non-comparative and self-checkable: what cold start costs, what
the combination-safety sweep proves, what regeneration safety means. The method
and the caveats are in **[docs/measurement.md](docs/measurement.md)**.

## License

MIT — see [LICENSE](LICENSE).
