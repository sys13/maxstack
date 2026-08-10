# Corpus integrity (program gate G1)

> The benchmark corpus and the harness that scores it live in the maintainer's
> own repository rather than here, because they are measurement machinery
> rather than part of the framework — every module, gate and command named
> below runs there, not in this tree. This document is the policy and the
> frozen record; see [measurement.md](measurement.md) for what the numbers do
> and do not say.

> Every number this project publishes about expressibility depends on the
> benchmark corpus being an honest sample of what people actually ask software
> to do. This document is how that stays true.

Issue #180. Gate on epic #163.

## The failure mode

Change-expressibility is a ratio: the share of a realistic backlog the ladder
absorbs as typed spec ops. There are two ways to raise it.

1. Make the platform better.
2. Make the backlog easier.

The second one is much cheaper, requires no code, happens with entirely good
intentions, and produces an **identical-looking graph**. Over a program with a
headline expressibility exit criterion, it is close to inevitable unless it is
structurally prevented.

Nothing about it looks like cheating from the inside. You ship a rollup op. You
write a new benchmark ask that exercises it, because that seems like the
responsible thing to do. The ratio rises. The ask was realistic — you just
happened to think of it *after* building the thing that expresses it. Repeat
eleven times and the number means nothing.

## Growing the corpus for the new north star

Speed to a *large* app is the north star as of 2026-07-30, and the corpus is
eleven small apps. It needs a deliberately large benchmark — many entities,
several roles, billing and auth and audit interacting — because composition only
breaks at size and a small-app corpus structurally cannot surface it. (#216,
billing subjects being inexpressible for want of a polymorphic reference, was
exactly that class of defect: found by hand, not by the corpus. It has since been
absorbed — see below — which does not weaken the point, it sharpens it: the
corpus did not find it and could not have.)

**#216 landed, and the corpus was deliberately not rewired to it.** A project
may now narrow an open bundle reference instead of declaring a parallel typed
column, which is what `saas-starter` and `clientcruise` do by hand. Changing how
a corpus app is assembled changes what the expressibility score measures, so
that rewiring is a corpus-version decision with the comparability break stated —
not a line in the commit that shipped the primitive. The apps still declare
their own columns; the frozen backlog is untouched.

**That change is the precise thing this gate exists to police**, so it does not
get a pass for being strategically motivated:

- A new benchmark **changes the denominator** every published expressibility
  figure is scored against. Adding it silently would move the numbers while
  looking like coverage — the G1 failure mode with better intentions.
- So it lands as a **declared corpus version** with the comparability break
  stated, exactly as a protocol amendment would. Figures either side of it are
  not comparable and the dashboard breaks the line there.
- The frozen baseline stays frozen. `expressibility@baseline` continues to score
  the original eleven; the large benchmark reports beside it, not into it, until
  a new baseline is deliberately frozen.

The temptation this forecloses is obvious: a big new benchmark authored *after*
the layers exist, whose asks the ladder happens to absorb, would raise every
headline number at once and read as proof of the thesis. It would be the same
mistake as an easy ask, at eleven times the scale.

## The declared corpus versions

Issue #253. The versions are declared in the benchmark corpus's
`corpus-version` module and enforced by its own test.

| Version | Declared | Set | Published |
|---|---|---|---|
| **1** | 2026-07-26 (#180) | the original eleven | **yes** — every figure in the published-stats artifact |
| **2** | 2026-07-30 (#253) | the eleven **plus `clientcruise`** | no — reports *beside*, never into |

### What version 2 adds

`clientcruise` is a large real-world-derived benchmark (issue #62): a
declaration-level port of a shipped, multi-tenant Customer-Success SaaS of
roughly 350 TypeScript and TSX modules. Its shape was fixed before this
platform existed, so it could not have been drawn to suit it — which is the
property that makes it worth measuring against. Its size, which is reported
beside every figure derived from it:

| | |
|---|---|
| Entities | **30** (24 domain + 6 from the bundles) |
| Fields | **167** |
| Pages | **23** |
| Blocks | 24 |
| Acceptance tests | 44 |
| **Authored declarations** | **288** (the published corpus spans 20–60) |
| Bundles installed | **11**, cross-wired rather than co-installed |
| Backlog | 23 changes — 13 spec ops, 1 slot fill, 1 eject, **8 off-surface** |

The full sourcing argument is one of the corpus notes described below, and
lives with the corpus in the maintainer's own repository.

### The comparability break, stated

**Every corpus aggregate is computed over a different set on either side of this
boundary and the two values must not be plotted as one series or quoted as a
trend.** That includes mean and median leverage, the min/max spread, mean
`expressibility@current`, the off-surface total, and worst cost per safe change.

`expressibility@baseline` is **not** affected. It scores the frozen changes of
the eleven; `clientcruise` has none, so it reports 0 over an empty set and
`summarizeResults` excludes it from the mean. That is the same guarantee that
already makes a newly written easy ask worthless to the headline — applied at
the scale of a whole benchmark.

### How "beside" is enforced

- `benchmarks` — the array every published aggregate is computed over — is still
  the eleven. `corpus-version.test.ts` asserts it *is* the published version.
- A later version's benchmarks are run only when asked
  (`maxstack eval --corpus 2`) and land on `EvalSummary.beside`
  (the harness's `beside` field), which no aggregate reads. The field is
  spread in rather than assigned, so a default run's recorded JSONL line — and
  therefore its `run.id`, the SHA-256 of that line — is byte-identical to a
  pre-#253 run.
- Every beside figure travels in the same object as the **size it was measured
  at**. A leverage number without its size invites exactly the comparison it
  cannot support.
- The trend dashboard draws the beside points as their own series behind a
  dashed **version-break rule** and never joins them to the published line: a
  regression fitted across the boundary would be a trend drawn over a
  comparability break.
- No figure derived from version 2 appears in the published-stats artifact.

### What version 2 found, including the part that is unwelcome

The first measurement with real spread on the size axis **does not support the
flat-or-rising thesis**. At 288 declarations `clientcruise` reports **4.1**
artifacts per declaration (files-only floor **1.4**) against a published-corpus
median of 6.2 (floor 3.2) at ~21 declarations. Recorded here rather than tuned
away; the mechanism and the confound are in
[`harness-metrics.md`](harness-metrics.md#the-leverage-curve).

Promoting version 2 to published is a **deliberate act** that re-freezes the
baseline against the new set. It is not a side effect of adding a benchmark, and
nothing in this repository does it automatically.

## The four mechanisms

### 1. The corpus is frozen

The corpus's `baseline` module records every one of the 119 changes across the
11 benchmarks as they stood on **2026-07-26**, before any L2 primitive existed:
change id, kind at freeze, difficulty weight, and — for the 22 `off-surface`
asks — the #163 cluster it belongs to and the child issue that owns it.

The lineage is **append-only**, consistent with the decision-ledger posture. An
entry is never edited or removed. A frozen change may be *reclassified* in the
live corpus — that is the entire point — but the frozen record still says what
it was, and `baseline.test.ts` fails if a frozen id disappears from the live set.

### 2. Expressibility is reported twice

Every eval run publishes both:

| Number | What it is | What moves it |
|---|---|---|
| `expressibility@baseline` | Spec-op share over **only** the frozen changes, scored by their kind *today* | A primitive absorbing an ask that already existed. **Nothing else.** |
| `expressibility@current` | Spec-op share over the live backlog | The platform improving *or* the backlog changing |

`@baseline` is the headline. A newly-written ask contributes zero to it by
construction, so it is immune to the failure mode above.

`expressibilityDrift` is `@current − @baseline`. It is 0.00 while the corpus is
untouched. A positive, widening drift means the live backlog is scoring better
than the frozen one — the corpus got easier faster than the platform got better.

The review trigger has **two arms**, because the corpus mean dilutes: appending
three easy asks to one 11-change backlog moves that benchmark's own drift ~0.07
but the eleven-benchmark mean only ~0.01. Watching the mean alone would miss the
cheapest version of the failure mode — soften one backlog at a time.

| Arm | Threshold | Catches |
|---|---|---|
| `expressibilityDrift` (mean) | `DRIFT_REVIEW_THRESHOLD` = 0.05 | A systematic, corpus-wide pattern |
| `maxBenchmarkDrift` (worst single) | `BENCHMARK_DRIFT_REVIEW_THRESHOLD` = 0.05 | One softened backlog |

Either arm sets `expressibilityDriftReviewTrigger`; the dashboard flags the tile
and the nightly emits a warning annotation naming the worst three benchmarks.

Drift is deliberately **not** an exit code. The honest remedy is usually a
corpus-hardening pass, not a code change, and failing the build would push
toward the wrong fix.

### 3. The moat-gap invariant has a rising bar

`benchmarks.test.ts` used to assert that every benchmark carries at least one
`off-surface` ask, and that at least one is `unexpressible`. Those tests encoded
the assumption that the gap is *permanent*. As L2 lands, they go red — and the
tempting fix, deleting them, is exactly the wrong one.

They are replaced by four assertions against `MOAT_GAP_BAR`:

| Bar | At freeze | Guards against |
|---|---|---|
| `minResidualDifficulty` | 231 | The corpus getting cheaper overall (Σ weight of ejects + off-surface asks) |
| `minUnexpressible` | 12 | A corpus with nothing the platform *cannot* do — which has stopped measuring a moat |
| `minClustersRepresented` | 8 | The corpus narrowing to shapes the platform happens to handle well |
| `minBenchmarksReachingPastSurface` | 11 | Any single backlog becoming all-typed-ops |

**When a primitive absorbs an ask, these go red by design.** That is the
corpus-hardening cadence firing: a harder, externally-sourced ask in the same
product area takes the retired one's place, with a justification note, and then
the bar ratchets **up** to the new level.

Never lower a value in `MOAT_GAP_BAR`. Lowering it is deleting the assertion with
one extra indirection, and CI diffs it against the merge base for exactly that
reason.

### 4. Backlog edits are reviewed, not gated on a written justification

**Changed 2026-08-04** (`d-remove-the-ritual-keep-the-checks`). Until then, any
PR touching a benchmark module had to ship a corpus note — frontmatter plus
three prose sections — enforced by a `check-corpus` gate in the `governance`
job. Fifty-six such notes exist and **stay on disk as a record** beside the
corpus; they are no longer required or validated.

The rule itself has not moved: **do not soften an ask, and do not add one shaped
like an op you just shipped.** What changed is that it is enforced by review
rather than by CI, and the reason that is safe is structural rather than a
matter of trust. The headline is `expressibility@baseline`, scored against the
**frozen** corpus — so softening the wording of a live ask cannot move the
published number, and the frozen lineage it *is* scored against is still guarded
mechanically by rule 5 (append-only, bar never lowered), which is the layer that
survives.

What is genuinely given up, stated plainly: a quietly softened ask in a live
benchmark module no longer trips a gate. It still cannot reach the headline. If
`expressibility@current` is ever promoted to a published figure, this rule has
to come back with it.

## The frozen numbers

| | |
|---|---|
| Frozen at | 2026-07-26, commit `8054055` |
| Benchmarks | 11 |
| Changes | 119 |
| Off-surface asks | 22, across 11 clusters |
| Unexpressible | 12 |
| Ejects | 11 |
| Total difficulty | 360 |
| Residual difficulty | 231 |
| Expressibility | mean **0.59**, median 0.55, spread 0.45–0.73 |
| Expressibility ceiling | **0.77** raw, **0.75** honoring the epic's non-goals |

## The ceiling, and why 0.80 was withdrawn

Issue #225.

A frozen scoring set bounds its own ratio, and the bound is nowhere near 1.00.
Of the 119 frozen changes, **11 are deliberate ejects** — one per benchmark,
authored as ejects at the freeze — and **24 are deliberate slot fills**. Neither
was ever going to become a typed op. Reclassifying one would not be a platform
gain; it would be the cage #163's own non-goals rule out:

> Chasing 1.0 expressibility. Bespoke UI should remain an eject.

So the most this corpus can report is the share it would reach if every
off-surface ask, and nothing else, became an op. `expressibilityCeiling()`
computes it:

| Ceiling | Value | What converts |
|---|---|---|
| Raw | **0.77** | All 22 off-surface asks |
| Policy | **0.75** | The same, minus the 3 `bespoke-ui` asks the epic says must stay hand-written |

**Both sit below the 0.80 #163 declared.** That target was therefore unreachable
on the day it was written, before a single L2 primitive existed — not because
the platform fell short, but because the mean stood at 0.59 and the denominator
only ever had 0.16 to give. The secondary clause (*no benchmark below 0.70*)
failed the same way: cardstack's policy ceiling is 0.64.

The defect was not the value chosen. It was choosing an absolute ratio without
checking what its denominator permitted. Restating the number would leave that
mistake available, so the criterion changed shape instead:

| | Old (#163) | New (#225) |
|---|---|---|
| Metric | `expressibility@baseline` | `headroomCaptured` |
| Definition | spec-op share of the frozen corpus | `(realized − atFreeze) / (policyCeiling − atFreeze)` |
| Range | 0.59 … 0.75 | 0.00 … 1.00 |
| Target | 0.80 — **above the range** | 0.80 |
| Today | 0.71 | **0.74** |

Capture is 0 at the freeze and 1 at the ceiling *whatever the corpus is*, so it
cannot be declared unreachable — the structural fix, not a moved goalpost. It
inherits G1's other guarantee unchanged: the scoring set is the frozen one, so a
newly written easy ask still contributes nothing.

`baseline.test.ts` asserts the ceilings against the frozen literal, asserts that
the retired 0.80 really was above them (if that ever goes green, the withdrawal
was wrong and #225 should be reopened), and asserts capture's 0/1 endpoints.

Two things this does **not** license. Capture is a ratio of ratios, so it never
justifies a unit word — "0.74 of the available headroom", never "74% of product
change". And the frozen corpus is not exhausted: 0.26 of its headroom is
unclaimed, held by five non-bespoke asks that landed as slot fills
(`ch-realtime-board`, `ch-sm2-scheduler`, `ch-anki-import`,
`ch-threaded-discussion`, `ch-inbox-sync`). Only when that runs out does the
question of scoring the post-freeze frontier arise.

### A note on 0.55 vs 0.59

Epic #163 originally quoted 0.55 as "the" expressibility. That is the **median**
benchmark (and taskly's ratio). The **mean** of the eleven per-benchmark ratios —
what `summarizeResults` publishes as `meanExpressibilityBaseline`, and what the
0.80 exit criterion is scored against — is **0.59**. This matches the
`d-change-sets-v2` decision record in the maintainer's own spec
("spread 0.45–0.73 (mean ~0.59)"). Pooling all 119 changes rather than averaging
benchmarks also gives 0.59.

`BASELINE_TOTALS.expressibility` records all four statistics so the headline
cannot be quoted loosely later. The gap the epic set out to close was
**0.59 → 0.80**, not 0.55 → 0.80 — a slightly harder ask than its original prose
implied. Both #162 and #163 were corrected on 2026-07-26 to say 0.59.

> **Superseded 2026-07-30 (#225).** The 0.80 half of that sentence is withdrawn:
> the corpus tops out at 0.75. The gap actually closed was **0.59 → 0.71 of a
> 0.75 ceiling**, i.e. 0.74 of the available headroom. See
> [The ceiling, and why 0.80 was withdrawn](#the-ceiling-and-why-080-was-withdrawn).

## Why a change was hard — the cause breakdown

`expressibility.offSurface` says how much of the backlog the ladder failed to
absorb. It does not say **why**, and for years nothing did — which meant a
proposal to build a new op family could be argued from a share nobody had
computed.

Since issue #412 every non-spec-op corpus change carries a **cause**: what the
author was reaching for when a typed op would not do it. The vocabulary is
deliberately small — `interaction` (a user-operated list control),
`presentation` (how one field or row renders), `bespoke-ui`, `domain-rule`,
`integration`, `platform` — because it exists to answer *"is this layer a large
share of forced ownership?"* and a finer taxonomy answers that with a scatter of
ones. Each entry also records `confidence`: `stated` when the corpus text names
the capability, `inferred` when it was read out of an ambiguous phrase.

`internal/benchmarks/src/causes.ts` is the table and `causes.test.ts` is the
gate: a change with no cause fails the build, so a new hard ask cannot enter the
corpus without saying what made it hard. Four `cause.*` figures publish beside
`expressibility.offSurface`.

**It is a measurement, not a ratchet, and deliberately so.** Nine of the eleven
corpus ejects were authored one per benchmark to exercise the rung, with generic
reasons ("eject the Projects page for a bespoke layout"); they record that an
eject happened, not what forced it. A bar over that bucket would be measuring
authoring convention. The coverage test is the enforcement instead.

### The trap this breakdown exposes, for anyone absorbing a slot fill

[The ceiling](#the-ceiling-and-why-080-was-withdrawn) converts **off-surface
asks only**, on the principle stated there: every eject and every slot fill was
*authored as such*, and reclassifying one is not a platform gain. But
`expressibility@baseline` scores the frozen set by today's kinds and does not
know about that principle.

So a program that absorbs a block of frozen **slot fills** raises the published
headline while leaving the ceiling where it is — and can drive
`expressibility@baseline` above `expressibility.ceiling`, and `headroomCaptured`
past 1.00. That is not a hypothetical: the first cause breakdown found a
candidate program whose full delivery would take the headline to 0.81 against a
0.75 ceiling.

If you are absorbing slot fills rather than off-surface asks, **resolve this
before the first one lands.** Either widen the ceiling's convertible set to name
what your program intends to absorb, or state that your program is deliberately
not scored by expressibility. Shipping a headline above its own published
ceiling is the exact class of defect this file exists to prevent.

## For an L2 primitive author

Landing a child of #163 looks like this:

1. Build the op family and the runtime derivation behind it.
2. Reclassify a **pre-existing** frozen ask in its benchmark from `off-surface`
   to the new typed op. Do not add a new benchmark ask to demonstrate it.
3. Write a corpus note with `kind: reclassification`, naming the op that now
   expresses it.
4. Watch `expressibility@baseline` rise. That number rising is your evidence;
   `@current` rising on its own is not.
5. The moat-gap tests will now be red. Source a harder ask in the same product
   area from a real product or a dogfood session, land it with a
   `kind: corpus-hardening` note, and raise `MOAT_GAP_BAR` to the new floor.

Step 5 is not optional overhead. It is what makes step 4 mean anything.
