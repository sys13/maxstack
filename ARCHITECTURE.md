# Architecture

maxstack derives an application from a typed spec. This document is the map:
what the layers are, which way dependencies point, and where the seams for your
own code live.

## The one-sentence model

**The spec is the source of truth, and nothing grounds until a human decides.**

A spec is data. Ops change it. Generators read it and write an app. Anything you
write yourself is recorded as owned, and regeneration never touches it.

## The layers

Dependencies point strictly downward. Nothing below imports from anything above,
and no package imports an app — `scripts/check-boundaries.mjs` enforces this
against `scripts/boundaries.config.json` on every run of `pnpm validate`, so a
violation fails the gate rather than relying on review.

```
packages/
  spec/          the source of truth: PRD + data/page/pricing layers,
                 provenance columns, the append-only ledger, typed spec-ops.
                 No I/O — no database, no filesystem, no clock.
  maxstack-core/ the runtime engine: schema derivation, CRUD operations,
                 permissions, validation, ownership + the never-clobber writer.
  ui/            the component layer: forms derived from Zod schemas, the
                 <Slot> runtime, theming. Publishes standalone.
  mcp/           the agent interface: platform tools over the same operations
                 the REST API uses, so an agent and a human hit one code path.
  features/      feature bundles — auth, billing, content, email, audit,
                 members, notifications and the rest of the catalog.
  spec-derive/   spec -> generator-input derivations, the AI port behind
                 `maxstack start`, feedback clustering and ranking.

apps/
  maxstack/      the CLI. This is the product a user installs.
  web/           the runtime app: admin UI, REST, MCP transport, workbench.

examples/        worked example apps — complete specs you can read.
```

`spec`, `maxstack-core` and `ui` are the foundation and import no workspace
package at all. `features` and `mcp` may import `core` and `spec`. Apps may
import anything.

## How a change flows

1. **An op is proposed.** From the CLI (`maxstack add-entity`), from an agent
   over MCP (`propose_spec_change`), or by hand in a spec file.
2. **It is validated before it applies.** References must resolve and ids must
   be fresh. An invalid op is rejected rather than half-applied.
3. **It lands in the spec**, immutably — the op is applied to a clone, diffed,
   and appended to the op log with its author recorded.
4. **It is accepted, or it waits.** A change you make yourself is accepted as it
   lands. A change an agent proposes arrives *suggested* and waits for you.
   Generation grounds only on accepted items.
5. **The app is regenerated** through the never-clobber writer. Generated files
   are rewritten; anything you own is left alone.

Regeneration reconciles in **both** directions. Remove a page from the spec and
its route module, its line in `app/routes.ts` and its manifest entry all go —
otherwise the tree only ever grows, and a route for a deleted entity keeps
shipping and 500s. What may be removed is decided by ownership, not by the spec:
a module that is still the generator's byte for byte is deleted, a *generated*
module you have edited since is unwired from the route table but left on disk for
you to delete, and an **ejected module is not touched at all** — route included,
because that route is yours now. The user-owned slot file beside a pruned module
is never deleted; `maxstack validate` already fails on a slot with nothing left
to fill, which is a question only you can answer.

The same reconciliation runs over the four seam registries — schedules, sources,
imports, live channels. Undeclare one of several and the registry is re-emitted
without it; undeclare the **last** one and the registry itself goes, because a
project that declares none never had the file (no declaration, no directory).
This matters more than a dead route does: a route is inert until somebody visits
it, while a registry the runtime still imports keeps every retired handler
resolvable to the job queue, and the work behind a handler reaches external
systems and writes rows. **The handler, refiner, parser or surface itself is
never deleted** — it is hand-written domain logic, the whole reason the seam
exists. Losing its registration is what stops it running; deleting the file is
yours to do.

## Owning code

Three levels, in increasing order of commitment:

- **Spec-ops** — the app changes because the spec changed. Nothing is owned.
- **Slots** — a typed extension point inside a generated page. The generator
  writes the stub once and never again; the file is yours from then on.
- **Eject** — take a whole generated route. It is copied with a banner, marked
  owned in the manifest, and never regenerated.

**What eject hands over is the page's render, not the whole page.** The route
module is the real thing — it composes the declared surface from the props the
runtime passes it, so editing it changes what you see, and an ejected page keeps
its rows, its inline editing and its permission gating. What it does *not* take
over is the loader: rows, introspected columns, capabilities and resolved
reference titles are still produced by framework code that resolves this page
from `spec/` on every request, so an ejected page still needs its spec entry.
The banner in the file says exactly this, because "you own it now" was being
read as "this file is the whole app" and it is not.

That holds for the *arranged* pages too. A `board`, `calendar` or `timeline`
page emits its declared view component drawn from the same props (`view` on the
contract, beside `list`), with the declaration — the grouping column, the date
column, the display, the timezone — inlined as literals. What is deliberately
**not** inlined is a board's `options`: `<BoardView>` draws its columns from the
grouping column's *introspected* options, and the only other reader of the
declared list is the guard that refuses a drop on a destination the enum does
not declare. That guard is a write-side check, so it stays in framework code
rather than moving into a file the user is invited to edit — and the server
enforces it again on the record's own edit route, which is what actually makes
it safe. A page whose list a `mode: 'replace'` slot owns materializes as well:
the runtime renders nothing in that region, and so does the emitted module.

Two surfaces are still not materialized: a page arranged by an `aggregate`
block, whose buckets are a `GROUP BY` the server computed and never reach the
rows contract an owned module is handed, and a page with no entity behind it.
Their route module is a placeholder that says so, and `maxstack eject` warns
before handing one over — because an ejected module replaces the framework's
whole surface, ejecting one of those trades a working chart for the placeholder.
Fill a block slot instead until they materialize.

**A generated list surface is featureful by default.** Search, the derived
filter facets, sortable column headers and CSV export are on every list page
without a spec op, a declaration or an eject — the whole set derives from
introspection, exactly as the field widgets do. This is a correction, not a
feature: every one of those components had shipped and was mounted only on
`/admin` and the workbench, so the app a user actually generated was a
second-class citizen of its own component library, and "let me search my books"
was an eject.

Two rules make it safe to have on by default. Search, filters and ordering are
**server-side** — a list page is the first hundred rows of a table, so sorting
what arrived would reorder a page rather than the list — and they are confined
to **exactly the columns the page renders**, because ordering or filtering by a
column the viewer was never shown is a comparison oracle over its values. Every
control's state lives in the query string, so a searched, filtered, sorted list
is a link somebody can send. Export writes the rows on screen, under the same
read policy, tenant scope and portal bound that produced them, rather than
opening a second bulk-read path with its own limit to get wrong.

The controls reach an *ejected* page too, on the same props contract as the
rows: `toolbar` is one element the owned module places. Owning a page must not
silently cost you its search box.

That confinement is what made a related-records "view all" hard, and the way it
is resolved is worth stating because it will come up again. A record page's
related section links to the child's list filtered to this record
(`?filter.<fk>=`), and a child list is the one list guaranteed *not* to render
its own foreign key — it holds the same value on every row. Rather than exempt
foreign keys from the rule, which would re-open the oracle for any value a
caller cares to guess, **a filtered relation joins the columns the page
renders**: the destination shows the column it was filtered by, so the filter is
honoured for the ordinary reason and the invariant is preserved by construction
rather than by exception. The promotion is confined to declared relations, and a
column the spec marked `hidden` or `filterable: false` is never promoted — so
the widening follows the relation graph the spec already declares rather than
the query string. A section whose child page cannot honour the filter (no page,
an arranged view, an opted-out FK) shows its count as plain text, as before: an
absent link is a small loss, and a link that lies about which rows it shows is
the failure the missing link was preferable to.

The manifest records, per file, whether it is generated, ejected or user-written,
plus a content hash. `maxstack drift` reports what you own and how far it has
moved from what would be derived today.

## Invariants

These do not bend, and each has a test that fails if it does:

- Regeneration never deletes manually added items.
- Generation grounds only on accepted items.
- Eject never clobbers — it copies with a banner and skips what exists.
- Regeneration safety is 100%, not a target.

## Why the checks exist

Several checks in `pnpm validate` look like ceremony and are not — each was
added after a specific silent failure. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Stack

React Router · React 19 · shadcn/ui on Base UI · Tailwind v4 · Drizzle ·
Postgres (pglite for local scale) · Zod 4 · better-auth · Conform · Vitest ·
Playwright · Biome · pnpm + turborepo.
