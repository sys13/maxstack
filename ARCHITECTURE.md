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

## Owning code

Three levels, in increasing order of commitment:

- **Spec-ops** — the app changes because the spec changed. Nothing is owned.
- **Slots** — a typed extension point inside a generated page. The generator
  writes the stub once and never again; the file is yours from then on.
- **Eject** — take a whole generated route. It is copied with a banner, marked
  owned in the manifest, and never regenerated.

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
