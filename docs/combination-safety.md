# Combination safety (program gate G5)

> The apparatus that runs this sweep lives in the maintainer's own
> repository rather than here, because it is measurement machinery rather
> than part of the framework. This document is the method; see
> [measurement.md](measurement.md) for what the results do and do not say.

> A catalog of composable modules makes a promise the modules themselves
> cannot: that they still work *together*, in whatever combination and whatever
> order you installed them. This document is how that stays true.

Gate on epic

## The failure mode

Six bundles is 63 non-empty subsets. Sixteen is 65,535.

The ownership-safety gate proves never-clobber over benchmark projects that
happen to carry a handful of bundles. That is a real proof about the
regeneration machinery, and it says nothing about combinations. Nothing in it
would notice that `{auth, members, preferences}` is fine and
`{auth, members, preferences, api-keys}` is not — or, worse, that the same four
bundles installed in a different sequence produce a different app.

The second one is the quiet failure. Nobody installs bundles in a canonical
order. One developer runs `maxstack add billing` before `maxstack add members`;
another does the reverse; both projects validate, both boot, and their generated
trees differ. Every regeneration diff between the two is noise nobody can
review, and the difference compounds silently for as long as it goes unnoticed.
**Order-dependent output is a latent corruption bug, not a cosmetic one.**

## What the gate asserts

the measurement harness, run by the harness runner, by the `combination-safety` job on every PR (a stated sample — see
[Two tiers](#two-tiers-a-sample-per-pr-the-sweep-nightly)), and in full by
`nightly-safety`.

For each point in the lattice — a **prerequisite-closed** subset of the
user-facing catalog — the gate installs the subset in several **valid
topological orders** and asserts:

1. **Every install validates.** Each bundle goes in through
   `validateBundleApply` → `applyBundle`, the same path `maxstack add` uses, and
   the resulting spec passes `collectSpecSystemErrors`. No privileged install
   path, in the gate or out of it.
2. **Order-independence.** Two valid orders of the same subset produce a
   **byte-identical** rendered project: the generated route modules, the
   ownership manifest, `routes.ts`, the emitted `schema.sql`, and the raw
   `infra.sql` the composition root runs.
3. **Determinism.** Rendering the same order twice is byte-identical, so a
   divergence in (2) is attributable to ordering rather than to the generators.

It **fails the build; it does not warn** (the validate gate is a ship gate, not advice).

### What is deliberately *not* byte-identical

The spec itself. It carries an op log — a record of what happened, in the order
it happened — and two install sequences genuinely are two histories. Holding
that to byte-identity would mean forging the history to make a gate green.

What must not differ is the app that falls out of it: the same entities, the
same fields, the same pages. That equivalence is `specContentKey`, asserted
separately, and it is what makes the byte-identity claim about generated output
meaningful rather than tautological.

## Why the sampling is scored

Uniform random sampling over tens of thousands of subsets mostly draws easy
ones — two independent bundles that share nothing — and produces a green board
that means nothing. That is the difference between a gate and a decoration.

`scoreSubset` ranks each point by:

| Signal | Weight | Why |
| --- | --- | --- |
| Prerequisite depth | 8 | The deepest chain is where the topological walk has the most freedom, so the most orders to disagree about. |
| Cross-references | 4 | A field pointing at an entity *another* bundle owns resolves only because that bundle happens to be installed. |
| Anchor touches | 3 | `user`, `organization`, and the audit sink are what two bundles independently reach for. |
| Raw DDL bundles | 2 | Tables materialized outside the spec bridge, which no op reveals. |
| Size | 1 | A tie-break, not a driver — a big subset of independent bundles is easy. |

The per-PR tier takes the top of that ranking, never the fastest points.

## Two tiers: a sample per PR, the sweep nightly

At eleven bundles the
whole lattice was 343 points and ran in three seconds, so the PR tier was not a
sample at all — it was the complete sweep. The catalog closed at **fifteen**
user-facing bundles and the lattice went to **4047** points: ~34s of CPU
standalone, and about **264s** inside `validate`, past that suite's 120s
per-test budget. The gate was not wrong; it was too big for the tier it was in.
So it moved, which is the response this document sanctioned in advance.

One implementation, `runLatticeGate`, at two tiers:

| | PR tier (`--tier pr`) | Nightly (`--require-ratchet`) |
| --- | --- | --- |
| Points | **256 of 4047** (6.3%) | all 4047 |
| Selection | top of the adversarial ranking, extended to a whole score band | none — everything |
| Orders / subset | 3, seed 1 | 8, seed 20260727 |
| Can meet the G5 ratchet | **never** | yes, and must |
| Where | `validate`'s `lattice.test.ts` + the `combination-safety` job | `nightly-safety` |

**The selection rule.** Descending score, take the top `PR_TIER_TARGET` (256),
then extend to the end of whatever score band the cut lands in. The extension is
the honest part: cutting at exactly 256 would slice a band of equally-adversarial
subsets in half on an alphabetical tie-break, so which half got checked would
depend on a subset's *name*, and adding a bundle whose slug sorts early would
silently evict an equally contended point that used to be covered. Taking whole
bands makes the sample a property of the scores. Today the boundary falls at
score 75 and the extension is a no-op — 256 points exactly, checked down to 75,
highest skipped 74.

**Nothing is sampled by speed or by chance.** There is no `Math.random()` in the
gate; order sampling is a seeded mulberry32 and the ranking is a total order
(score, then subset key), so a re-run covers the same points.

**It says so.** Every run at either tier prints `describeLatticeRun` — one
function, so the CLI, the test suite and the CI log cannot describe the same run
differently:

```
lattice [pr]: 256/4047 closed subsets over 15 user-facing bundles, 3 install orders each (seed 1)
  selection: the 256 highest-scoring points of the adversarial ranking (PR tier: top 256 by
    prerequisite depth and contention over user / organization / the audit sink, extended to
    the end of the score band so no band is cut mid-tie)
  SAMPLE, NOT THE FULL SWEEP — 3791 lower-scoring subsets were NOT checked (checked down to
    score 75, highest skipped 74); the full sweep and the G5 ratchet run nightly
```

**What it costs, stated rather than discovered later.** Between nightlies, a
break confined to the low-scoring tail — shallow, uncontended subsets — lands
green and is caught the next morning. That is the trade the split makes. It is
bounded by the ranking being *adversarial*: every failure this gate has found
lived at the top of it. A nightly-only failure is a coverage gap in the sample
and is triaged as one, per `nightly-safety.yml`'s own rule. The full sweep is one
command away for anyone who wants it on a branch:
the harness runner (or
`MAXSTACK_LATTICE_FULL=1 (full sweep)`).

## Coverage, and the ratchet

`LATTICE_RATCHET` in `lattice.ts` records the largest lattice ever proven green
— subsets *and* the catalog size they were drawn from, because proving the same
subset count over a smaller catalog is a coverage regression dressed as a pass.
It stands at **4047 subsets over 15 bundles**, and moving the sweep to the
nightly did not lower it by a single point.
A `check-lattice-ratchet` gate (the `governance` job) fails any PR that lowers
either number, and `--require-ratchet` fails any run that does not reach them.
That gate, `lattice.ts` and the harness runner named above are all part of the
apparatus this page opened by placing in the maintainer's own repository rather
than here — none of them is a file to open in this tree.

The cheapest way to keep a combinatorial gate green is to check fewer
combinations, and that edit is a two-character diff that reads like tuning.
Lowering coverage has to look like what it is.

Sampling is where that could have gone wrong, so the ratchet and the sample are
kept structurally incapable of being confused:

- `meetsRatchet` is **false on every sampled run**, unconditionally — not
  "false because 256 < 4047", which would flip to true the day someone lowered
  the recorded number. A sample is not evidence about the whole lattice.
- `--require-ratchet` together with `--tier pr` or `--limit` is a **usage error**
  (exit 2), not a failed gate. There is no invocation that evaluates the ratchet
  against a sample.
- `PR_TIER_TARGET` is a sample size and carries no proof, so tuning it down
  wins nothing: the recorded high-water mark lives in `LATTICE_RATCHET`, which
  the governance job watches.
- `lattice.test.ts` asserts all of the above directly — *"cannot satisfy the G5
  ratchet from a sample"* — so the split cannot silently decay into a retirement
  of the ratchet.

`MAX_ENUMERATED` bounds enumeration itself and is raised only with a runtime
measurement.

## Interpreting a failure

The job uploads `lattice-report.json` on every run (pass or fail), matching
`ownership-safety`'s behavior. For each failing point it carries the subset, the
install orders that disagreed, and the first differing line of every divergent
file. The console output is the same information, formatted.

Three shapes of failure, in rough order of how often they happen:

- **`order-dependent output: "<path>" differs between [...] and [...]`** — an
  emitter is inheriting its input's order. Fix it at the emitter by making the
  order canonical, not at the call site by sorting the input: the call site is
  not the only caller. This is what the gate found on the day it landed, in
  `routes.ts` (insertion-ordered route array) and `schema.sql` (grounding-ordered
  `CREATE TABLE` statements) — both now sorted at the emitter.
- **`install [...]: bundle "x" claims table "y", already owned by "z"`** — two
  bundles claim the same footprint. That is [bundle contract
  v2] requirement 7 doing its job;
  the fix is in the catalog, not in the gate.
- **`non-deterministic: "<path>" differs between two renders of the same
  order`** — not a combination problem at all. A generator drifted; see
  [`ownership.md`](ownership.md).

## Why this gates catalog breadth

Ten library areas are promoted to first-class bundles. Its own gating
language is blunt about it: the combination gate "must exist *before* the
catalog passes ~10, or we will be shipping untested combinations." That is what
`USER_FACING_CATALOG_CAP` enforced while this did not exist, and why the cap
moved to sixteen the moment it did.

The commercial argument for breadth is that a fixed starter kit you delete from
is not the same product as a composable set that knows about itself. That claim
is only worth making if the composition is actually checked.
