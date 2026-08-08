# The long-lived fixture — day fifty, measured

> The harness that produces these numbers lives in the maintainer's own
> repository rather than here, because it is measurement machinery rather
> than part of the framework — the fixture, the replay and every command
> below run there, not in this tree. This document is the method and the
> result; see [measurement.md](measurement.md) for what the numbers do and
> do not say.

> *"Still fast on day fifty."* Everything else the harness measures runs against
> a fresh scaffold carrying a nine-to-eleven change backlog. This is the one
> project that has actually reached fifty.

**This is goal #2's evidence** (the program plan §5), and since 2026-07-30 that
is the second claim rather than the headline. It is unchanged, fully in service,
and it answers the question every buyer eventually asks — *does it decay?* — one
quarter after they decided. What it cannot do is be felt inside a fifteen-minute
evaluation, which is why speed to a large app leads now and this follows.

It is also, incidentally, the closest thing the repo has to a **large** app: 17
entities, 13 pages, 124 DDL statements. It was built to answer an aging
question, not a scale one, so it is not a substitute for the large benchmark the
leverage curve needs — but it is the existence proof that the layers hold at
that size.

Issue #196. Gate on epic #166, alongside
[`combination-safety.md`](combination-safety.md) (does the catalog compose?) and
[`upgrade-safety.md`](upgrade-safety.md) (does it move forward?). This one asks
the third question: **does any of it get worse as the project ages?**

## The failure modes it exists to catch

They are all emergent over time, and every one of them is structurally invisible
to a fresh scaffold:

- **manifest growth** — how many files the platform is tracking, and how many of
  them the user now owns;
- **ownership sprawl** — the distribution across the rungs (`generated` /
  `ejected` / `user`), i.e. how much of the app has fallen off the platform;
- **migration accumulation** — how many DDL statements a boot now runs, and
  since issue #233 what running them actually **costs**, against rows;
- **spec bloat** — how many bytes the spec directory carries;
- **generation wall-clock** — whether regenerating gets slower faster than the
  project gets bigger;
- and the one that matters most: whether a file the maintainer owned at change 13
  still holds its bytes at change 56.

## The history is the artifact

The fixture's `history.jsonl`, kept with the harness in the maintainer's own
repository, is an **append-only ledger**
— one JSON line per recorded change, in the order it happened. Entries are never
renumbered, reordered or deleted; `loadLedger` refuses a file whose `n`s are not
`1..N` in order, because rewriting the history destroys the measurement. This
mirrors the decision-ledger posture deliberately.

**A fifty-change fixture cannot be created retroactively.** So the end state is
not authored: `replayLongLived` walks the ledger and applies every entry through
the *real* path —

| ledger action | the path it takes |
| --- | --- |
| `addEntity` / `addField` / `addPage` / `setBlock*` / `theme` | `applyOp`, the validated spec-op vocabulary |
| `bundle` | `validateBundleApply` → `applyBundle`, at the version the ledger records |
| `upgrade` | `planBundleUpgrades` → `applyBundleUpgrades` → `bumpInstalledVersions` |
| `slot` | `fillBlockSlot`, then a hand edit into the file |
| `eject` | `eject`, then a hand edit into the file |

— regenerating the whole app tree through the never-clobber writer after **every
single change**, and measuring as it goes. A change that stops validating stops
the replay with a failure; it is never skipped. So the fixture cannot be faked
into looking healthy, and every point on the curve below is a change that
actually landed through the shipped vocabulary.

The bundles are installed at **historical versions** (`auth`, `audit`,
`members`, `billing`, `storage` and `flags` all go in at 0.1.0), which is what makes the `upgrade` entry
at n55 a real migration rather than a recorded no-op. The replay refuses an
`upgrade` entry that had nothing to do — a padded history is worse than a short
one.

### What the ledger is *not*

It is **not corpus material.** It is not one of the benchmark modules, it moves no
published expressibility ratio, and its `weightPerSafeChange` is **not
comparable** to the corpus's — the corpus is a deliberately adversarial ask set
chosen to find the platform's limits, while this is a project's ordinary change
stream, which is mostly schema and page work. Putting the two numbers next to
each other would be the exact category error
[`corpus-integrity.md`](corpus-integrity.md) exists to prevent.

## The measured numbers

Run: `pnpm --filter @maxstack/harness longlived --curve`.

| | |
| --- | --- |
| recorded changes | **56** |
| landed safely | **56 (100%)** |
| `weightPerSafeChange` | **1.29** |
| owned files that never moved a byte | **6** (2 ejected, 4 filled slots) across every later change |
| entities / pages at the end | 17 / 13 |
| manifest entries at the end | 17 — 11 generated, 2 ejected, 4 user |
| DDL statements at the end | 124 |
| a boot's DDL, executed against a real database | **8.9ms** for those 124 statements over 80 rows |
| spec size at the end | 37.3 KiB |
| `weightPerSafeChange` first half → second half | **1.23 → 1.27 (×1.03)** |
| `generationMs` per change, first half → second half | **≈4.4 → ≈5.6 (×1.2–1.35)** over roughly twice the pages |

### The published curve

Regenerated by `pnpm --filter @maxstack/harness longlived --write-doc`; the test
suite asserts this block matches a fresh replay, so a stale table is a red suite
rather than a quiet lie.

<!-- curve:begin -->
| n | change | kind | weight/safe change | entities | pages | manifest (gen/eject/user) | DDL stmts | spec KiB |
| ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | `c-001-customer` | spec-op | 1.00 | 1 | 0 | 0/0/0 | 5 | 6.8 |
| 5 | `c-005-sites-page` | spec-op | 1.00 | 2 | 2 | 2/0/0 | 10 | 8.7 |
| 10 | `c-010-assets-page` | spec-op | 1.20 | 3 | 3 | 3/0/1 | 16 | 10.8 |
| 15 | `c-015-workorder-asset` | spec-op | 1.40 | 4 | 4 | 3/1/1 | 24 | 12.9 |
| 20 | `c-020-technicians-page` | spec-op | 1.30 | 6 | 5 | 4/1/1 | 38 | 16.0 |
| 25 | `c-025-asset-warranty` | spec-op | 1.24 | 7 | 6 | 5/1/1 | 45 | 18.5 |
| 30 | `c-030-timesheets-page` | spec-op | 1.27 | 11 | 8 | 7/1/2 | 72 | 24.1 |
| 35 | `c-035-invoices-page` | spec-op | 1.23 | 12 | 9 | 8/1/2 | 79 | 26.5 |
| 40 | `c-040-invoice-currency` | spec-op | 1.25 | 13 | 10 | 9/1/3 | 89 | 29.7 |
| 45 | `c-045-assets-columns` | spec-op | 1.31 | 14 | 11 | 9/2/3 | 94 | 31.7 |
| 50 | `c-050-flags` | spec-op | 1.28 | 15 | 11 | 9/2/3 | 107 | 34.7 |
| 55 | `c-055-upgrade` | spec-op | 1.29 | 17 | 13 | 11/2/4 | 123 | 42.7 |
| 56 | `c-056-timesheet-approved` | spec-op | 1.29 | 17 | 13 | 11/2/4 | 124 | 43.1 |
<!-- curve:end -->

### How to read it

The curve rises to **1.40 at n15** and settles back to **1.29**. That shape is
the honest one: the two ejects and four slot fills are a fixed fraction of the
history, so early on a single expensive change dominates a short average, and as
the project grows the average converges on the mix. **The second half is flatter
and cheaper than the first**, which is the claim.

Two things about that number are worth stating plainly rather than letting a
reader assume:

1. **Its shape is partly an authoring choice.** Which asks the ledger contains,
   and in what order, is something a human decided. Staging every eject at the
   end would manufacture a rising curve; staging them at the start would
   manufacture a falling one. So the rule is stated and followed: the six
   expensive changes are **distributed across the timeline** — n7, n13, n26 in
   the first half, n36, n44, n52 in the second.
2. **What it therefore genuinely catches is a step, not a slope.** A change kind
   that got *more expensive* — a spec op that degrades to an eject because the
   platform lost an op, or an eject that has to be repeated — moves this number
   in a way no authoring choice explains.

The number that is **not** an authoring artifact at all is `generationMs`. The
ledger's order cannot affect how long it takes to emit a tree with thirteen pages
in it. It grows by about ×1.2–1.35 across a history whose second half carries
roughly twice the pages of its first — i.e. **sub-linear per change**, which is
what "the platform does not get slower as your project grows" has to mean
concretely.

## The stop condition

Per the issue: *"If cost per safe change grows with project age, the central
claim is false and we should know it from our own instrumentation before a user
tells us. A rising curve is a program-level stop condition, not a backlog item."*

`checkLongLivedTrends` compares the first half of the history against the second
and **fails the build** when either tracked cost rises past its tolerance:

| trend | tolerance | why that tolerance |
| --- | --- | --- |
| `weightPerSafeChange` | ×1.25 | Generous on purpose — the shape is partly the ledger's own mix, and a tight bound here would bound the authoring rather than the platform. It is watching for a *step*. |
| `generationMs` | ×6 | Regeneration is allowed to cost more when there is more to emit. It is not allowed to cost *disproportionately* more. |

Halves rather than a least-squares slope, for two reasons: the quantity is a
running average over a fifty-point series, where a slope is dominated by the
first few points; and halves are what a human can check by reading the table
above.

## Coverage, and the ratchet

`LONGLIVED_RATCHET`, in the harness's long-lived module, records the longest
history ever replayed green — **56 changes**. A `check-longlived-ratchet` gate
(the `governance` job) fails any PR that
lowers it, because the cheap way to keep this gate green is to replay fewer
changes, and truncating an append-only ledger is a one-line diff that reads like
tidying. Both of them are part of the apparatus this page opened by placing in
the maintainer's own repository rather than here — neither is a file to open in
this tree.

## Where it runs

| | PR tier | Nightly |
| --- | --- | --- |
| the replay | yes — `longlived.test.ts` inside `validate` | yes, plus the standing regeneration + validation |
| the trend gate | yes | yes |
| the ratchet | the governance script (the literal) | `--require-ratchet` (the run) |

The whole replay is ~0.4s, so unlike the lattice and the convergence sweep there
is nothing here to sample: the PR tier runs the **complete ledger**, and
`describeLongLivedRun` says so in as many words. The nightly adds the
`--require-ratchet` run and uploads `longlived-report.json`, which carries the
full per-change health series for trend review.

## Adding a change

Append a line. Never edit one.

```
pnpm --filter @maxstack/harness longlived --curve   # replay and read the curve
pnpm --filter @maxstack/harness longlived --write-doc
```

Then raise `LONGLIVED_RATCHET.changes` to the new length, and commit the
regenerated curve block with it. If the trend gate goes red, that is the finding
— not something to tune the tolerance around.


## Executing the schema, not just counting it

The replay above is entirely in memory, so `ddlStatements` was a *count*. A count
is not a cost, and it says nothing about what happens when those statements meet
data. `--backend` replays the same history against a real pglite database,
executing the DDL after each change against rows that accumulate as it goes:

```sh
pnpm --filter @maxstack/harness longlived -- --backend --curve
```

It is the nightly's variant, never `validate`'s: the in-memory replay is ~0.4s and
this is seconds, which would take the fixture out of the PR tier. It runs over the
history the in-memory pass just walked (`collectShapes` hands over the per-change
entity shapes) so the two curves describe one fixture rather than two runs that
might have diverged.

Two things it answers that nothing else could:

**Boot cost as the schema grows.** Roughly linear at this size — about 0.09ms per
statement, so the 124 statements a boot runs today cost ~8.9ms. The first change
reads ~800ms; that is pglite starting, not DDL, and it is why the curve is read
from its slope rather than its head.

**A migration against accumulated data.** The fixture now puts rows in a column
*before* a later change declares it a reference, which is the case the ledger
never produced. `reconcileReferenceColumn` (issue #208) does exactly what it is
specified to do — refuses rather than coerces:

```
n55: invalid input syntax for type uuid: "row-0"
n56: invalid input syntax for type uuid: "row-0"
```

That is the guard working, and it is reported rather than fatal. Failing the build
on it would turn a measurement into an assertion nobody agreed to — and the honest
finding is precisely that the platform's one non-additive statement stops a boot
when the data does not fit, which a project on day fifty needs to know is what
happens.


### A note on the statement count

`ddlStatements` read 146, then 148, then **124**. Only the last is right.

The counter was `ddl.split('\n').filter(l => l.endsWith(';')).length` — lines
ending in a semicolon, which is not the same as statements. A `DO $$ … $$` block
contains several such lines (`RAISE NOTICE …;`, `END IF;`, `END $$;`) and is one
statement. Issue #215 made those blocks longer, the number jumped, and the jump is
what exposed the proxy.

It now counts through `splitStatements`, the same dollar-quote-aware splitter the
Postgres backend runs the DDL with — so the published figure and the thing a boot
actually executes are the same derivation. The drop from 148 to 124 is a
correction, not an improvement.
