# Examples

Eleven complete applications, each written as a spec you can read in one sitting.

If you are trying to answer *"what does a spec actually look like?"*, this is the
best place to start — better than the reference, because these are whole apps
rather than isolated features.

| Example | What it is | Entities | Pages |
|---|---|---|---|
| [`taskly`](src/taskly.ts) | shared team task tracker | 3 | 2 |
| [`todotracker`](src/todotracker.ts) | personal todos with habit streaks | 3 | 2 |
| [`blog`](src/blog.ts) | multi-author publishing | 3 | 2 |
| [`cardstack`](src/cardstack.ts) | spaced-repetition flashcards | 3 | 2 |
| [`recipebox`](src/recipebox.ts) | recipes and weekly meal plans | 3 | 2 |
| [`bugtrail`](src/bugtrail.ts) | issue tracker with sprints | 3 | 2 |
| [`bookclub`](src/bookclub.ts) | reading list and discussions | 4 | 2 |
| [`invoicer`](src/invoicer.ts) | freelance clients and invoices | 3 | 2 |
| [`gymlog`](src/gymlog.ts) | workout logger with an exercise library | 3 | 2 |
| [`crmlite`](src/crmlite.ts) | contacts and a deal pipeline | 4 | 2 |
| [`saas-starter`](src/saas-starter.ts) | multi-tenant SaaS shell | 6 | 3 |

`saas-starter` is the odd one out, and deliberately so: it is not hand-authored.
Its whole surface is **assembled from the feature-bundle catalog**, which is the
proof that bundles compose into a coherent app rather than a pile of parts.

## What each one contains

Two things, and the second is the interesting one.

**A spec** — three layers: the product definition (what it is for, who uses it),
the data layer (entities and fields), and the page layer (routes, blocks, and
natural-language `e2eTests` describing what each page must do).

**A change set** — ten to fourteen follow-up requests a real maintainer would
make after the first version shipped. This is where the design gets tested,
because a framework's shape only shows under sustained change. Each change is
classified by how it lands:

- `spec-op` — expressible as a typed change to the spec. Nothing is owned.
- `slot-fill` — needs bespoke UI, but only inside a slot.
- `eject` — needs a whole route taken over.
- `off-surface` — the platform has no seam for it at all.

That last category is present on purpose. A set of examples where everything is
a tidy spec-op would be a set written to flatter the framework, and would tell
you nothing about where its edges are.

## Running one

These are spec definitions rather than checked-out projects, so the fastest way
to see one running is to describe it and let maxstack build it:

```sh
npx maxstack start "a workout logger with an exercise library"
```

To work from a spec directly, read the file, then land its entities and pages
with `maxstack add-entity` / `add-page`, or hand the spec to an agent and let it
drive the ops over MCP.

## Using them as fixtures

They are also a workspace package (`@maxstack/examples`), which the CLI's
derivation and determinism tests import. That is intentional: the same apps that
serve as documentation are the ones the test suite runs against, so an example
that stopped being valid would fail the build rather than quietly rot.

```ts
import { examples, tasklyExample } from '@maxstack/examples'
```

Every one is validated by `examples.test.ts` — a valid three-layer spec, CRUD
pages, `e2eTests` on every page, and a distinct change set.
