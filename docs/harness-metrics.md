# Harness metrics — how the platform is measured

> The harness that implements everything below lives in the maintainer's own
> repository rather than here, because it is measurement machinery rather
> than part of the framework — the benchmark corpus, the eval pipeline, the
> metrics log and every command on this page run there, not in this tree.
> This document is the method and the findings; see
> [measurement.md](measurement.md) for what the numbers do and do not say.

The measurement protocol the `maxstack eval` pipeline implements and the trend
dashboard reads.

Two goals, in order (the program plan §5, `d-north-star`, `d-speed-at-every-size`):

1. **Speed to a working app at any size** — time to a running app reported at
   *both* ends of the size range, with leverage (working application derived per
   typed declaration) as the mechanism behind it, measured as a **curve against
   the size of the app**.
2. **Safe iteration** — the effort and success rate of landing the Nth change
   with the regeneration-safety suite still green.

This page is ordered to match. Goal #2 was the headline until 2026-07-30 and its
machinery is unchanged and fully in service; it simply is not the opening claim
any more. Goal #1 dropped its scale-qualification on 2026-08-04
(`d-speed-at-every-size`): small benchmarks are first-class cells to be reported
beside the large ones, not noise to be averaged into a median — which makes the
instrument gap below *wider*, not narrower, since it now has two ends to serve.
Goal #1 also acquired a hard precondition on the same date
(`d-speed-needs-a-control-arm`): no duration claim ships without a no-MAXSTACK
control arm, which only head-to-head version 2 supplies.

> **Where the instrument is behind the strategy.** Everything below measures
> goal #2 well, and goal #1 at the size of the *published* corpus, which is
> eleven small apps. A leverage *median* across small benchmarks is precisely
> the statistic that hides how leverage behaves at size. The curve is measured
> and charted, and since #253 there is one genuinely large app on the axis — but
> it sits on the far side of a declared [corpus
> boundary](corpus-integrity.md#the-declared-corpus-versions), so no shape is
> published and the published leverage figures remain what they have always
> been: a first-build ratio on small apps. What the large app measured, including
> the part that does not flatter the thesis, is in
> [The leverage curve](#the-leverage-curve) below.

## Leverage, and how it holds up at size

Leverage is a ratio of two things counted from the same run:

| Side | What it counts | Field |
| --- | --- | --- |
| Denominator | Declarations the author actually writes: entities + fields + pages + blocks + acceptance tests | `FirstBuildCost.spec.declarations` |
| Numerator | Generated non-blank, non-comment lines **plus** the artifacts Sprout derives at runtime | `generated.lines + derived.total` |

```
artifactsPerDeclaration = (generated.lines + derived.total) / spec.declarations
```

**Only platform-derived output counts.** The agent fills the e2e suites during
the first build, and those files land in the same tree as the generated routes —
so measuring the tree wholesale counted model prose as platform output. That was
about 20% of the numerator, and it made the published figure depend on how
verbose the model felt: a keyed run and a `MOCK_AI` run would have disagreed on
the same spec, costing the measure the determinism that is its whole point.
`measureGeneratedTree` now takes the set of model-authored paths and excludes
them, reporting the count as `generated.excludedFiles` rather than dropping them
silently. This moved the published median from 7.2 to 6.0, and the `count`
endpoint being wired moved it up again — the current value is `leverage.median`
in the published-stats artifact, not a figure typed here.

The runtime half matters more than the file half. The generated tree is route
scaffolding; the admin screens, REST API, forms, validation, and MCP tools are
composed at request time from the same declaration and never land as a file to
count.

### The leverage curve

**This is the number the platform now exists to move, and it is not yet
published.** A median hides the shape; the shape is the claim. Plotted as
artifacts-per-declaration against spec size, the thesis is that the curve stays
**flat or rises** as an app grows from three entities to twenty, because each
new declaration lands into layers that already exist — while the rival approach
bends the wrong way, since every new feature is written against a codebase that
has already accumulated.

Three things were required. Two are built:

- **`leverageCurve` on the summary — built** (issue #254).
  `EvalSummary.leverageCurve` is the per-benchmark `(declarations, artifactsPerDeclaration)` series, sorted
  ascending by `declarations` and not by run order, and the trend dashboard
  draws it as a `leverage vs app size` card alongside the time series. It is a
  re-projection of the fields the rows already carry, so it cannot disagree with
  the published medians.
- **A deliberately large benchmark — built** (issue #253). `clientcruise`: 30
  entities, 167 fields, 23 pages, 11 cross-wired bundles, 288 authored
  declarations, ported from a shipped multi-tenant Customer-Success SaaS. It is
  **not in the published corpus** — it lands as declared [corpus version
  2](corpus-integrity.md#the-declared-corpus-versions) and reports beside.
- **Time to a coherent large app — still not built.** `first-build.ts` already
  brackets empty tree → running app, and now brackets it on a large app too, but
  per `d-retire-5min` a duration without its scale is the same defect as a ratio
  without its denominator, and separately a wall-clock figure has no publishable
  form: the publication rules forbid one outright because it moves between
  runs on identical code.

#### What the curve actually shows

With real spread on the x axis for the first time, **the thesis does not hold on
this measurement**:

| | Published corpus (v1) | `clientcruise` (v2, beside) |
| --- | --- | --- |
| Declarations | 20–60 | **288** |
| Artifacts per declaration | 5.5–8.3, median 6.2 | **4.1** |
| Files-only floor | 0.9–5.4, median 3.2 | **1.4** |

Leverage **falls** as the app gets larger on this denominator, comparing the
benchmarks as they are authored — it does not stay flat and it does not rise.
Both qualifiers are load-bearing, and the second one turned out to be the whole
story: see *the confound, separated* below, where a like-for-like comparison
reverses the direction. That is written here rather than tuned away, because
it is the outcome most worth knowing early, and a benchmark adjusted until the
curve looked good would be the corpus-softening failure mode with the axis
relabelled.

*On this denominator* is doing real work in that sentence, and the next section
is why: most of the fall is the denominator, and what is left does not behave
like a size effect. The headline stays as written because the measurement says
what it says; the reading underneath it is the part that has moved.

#### The same numerator, per entity — and what it does to that reading

The mechanism above is arithmetic and it is checkable, so it was checked. The
runtime half of the numerator is derived **per entity** (a REST surface, MCP
tools, admin screens) with a handful of things per field, while the denominator
counts an entity and one of its fields as the same unit. So the ratio falls as
tables get wider, and big apps have wider tables — 2.3 fields per entity across
the small corpus, 5.6 on `clientcruise`.

`EvalSummary` therefore reports the same numerator over **entities** as well,
and the two together say something neither says alone:

| | declarations | artifacts / declaration | artifacts / entity |
| --- | --- | --- | --- |
| hand-authored (10) | 20–29 | 5.5–8.3 | **41–58** |
| `saas-starter` | 60 | 3.9 | **38.8** |
| `clientcruise` | 288 | 4.1 | **39.4** |

`clientcruise` is fourteen times `blog`'s size and derives 39.4 artifacts per
entity against `blog`'s 41.0 — **4% apart**. On this denominator the curve is
close to flat, and within the two assembled specs the *larger* one is marginally
*higher* (39.4 against 38.8), which is the opposite of what a size penalty looks
like.

**Neither number is the answer; the pair brackets it.** Per-declaration charges
the author for every field and credits the platform for almost none of them, so
it understates leverage on wide tables. Per-entity ignores that a wide entity is
more authoring work, so it overstates it. The true shape is between −34% and −4%
across a fourteen-fold size increase, and reporting one of those without the
other would be picking a denominator to get an answer.

#### The confound, separated — and it was neither suspect (issue #269)

Both suspects were testable without building anything, and both were tested.

**Assembly is refuted.** `clientcruise` is 24 hand-authored domain entities on a
bundle-assembled shell, so the same spec rebuilt with **zero bundles** — the
tenant table hand-authored, which is what a developer not using bundles does —
is a *paired* control: same domain, same author, same composition, assembly the
only variable. Issue #269 pre-registered the predictions before the run.

| | entities | bundles | per declaration | per entity |
| --- | --- | --- | --- | --- |
| assembled | 30 | 11 | 4.1 | **39.4** |
| bundle-free control | 25 | 0 | 4.2 | **38.9** |

Removing eleven bundles moves per-entity leverage by **1.3%**, and *downward* —
the wrong direction for the assembly hypothesis, which predicted the control
would land in the hand-authored 41–58 band.

**What it actually was: slot density.** Every one of the eleven small benchmarks
declares **two block slots**. Both large ones declare **none**. A slot makes the
generator emit scaffolding, so it is worth roughly 8 artifacts per entity on a
three-entity app and nothing at all on an app with no slots.

Strip the slots from the *small* benchmarks — the direction that can only make
them look worse, which is exactly why it is the trustworthy test:

| | per entity, as authored | per entity, slot-free |
| --- | --- | --- |
| small apps (mean of 10) | 41.0 | **33.4** |
| `saas-starter` | 38.8 | 38.8 (has none) |
| `clientcruise` | 39.4 | 39.4 (has none) |

**Like for like, leverage does not fall with size on this corpus — it rises.**
39.4 against 33.4. The corpus was comparing slotted small apps against slot-free
large ones and reading the difference as a size effect.

Reproduced by the harness's assembly-control arms, whose tests assert the
orderings rather than the numbers. Read the deltas and not the absolutes: those
arms measure through the page generator alone, without the seams a full eval
also generates, so they are internally consistent and are **not** the published
figures.

> **The trap this must not become.** The fix is not to add slots to
> `clientcruise` until the curve looks right — that is corpus-softening with the
> axis relabelled, forbidden by [corpus integrity](corpus-integrity.md) in those
> words. What is reported is that the comparison is not like-for-like and which
> way that biases it. No benchmark was edited.

#### What is still not separated

**Two things, and they are smaller than the confound was.**

The controls hold **domain** fixed, so they separate assembly and slot density
from everything else — but "everything else" still contains size *and* whatever
is particular to this one domain. A large hand-authored benchmark from a
different domain (#253's original ask) remains the way to tell those apart, and
it now has a much sharper question to answer than when it was proposed.

There is also a **measurement-definition question this surfaced and does not
settle**: a block slot is a file the *maintainer* owns and writes code into, and
the numerator currently credits the platform for the scaffolding around it.
`measureGeneratedTree` already excludes model-authored e2e suites from the
numerator on exactly that reasoning. Whether slot scaffolding belongs on the
same footing is a decision about what leverage means, not a bug, and it is left
open rather than quietly resolved — note that resolving it *against* slots would
lower every small benchmark and widen the large app's lead.

The older reading follows, retained because it is what the out-of-sample fit
said before the controls existed: Both points below the hand-authored band are the two
*bundle-assembled* specs, and a bundle's fields count as authored declarations
while much of what a bundle derives is infra DDL rather than pages. A fitted
check sharpens the direction without settling it: modelling artifacts from
entities and fields on the ten small hand-authored apps and predicting the two
assembled ones **out of sample** leaves both about 30% below the line — but by
*similar* amounts at very different sizes (−35% at 60 declarations, −28% at 288,
and the ordering holds under every model variant tried). A size penalty would
deepen with size. This one does not.

That is consistent with a roughly constant assembly effect and inconsistent with
a size effect, and it is **not** proof of either: the fit has ten points and two
parameters, its in-sample residuals span −10%…+29%, and there are exactly two
large specs, both assembled. A large **hand-authored** benchmark is still the
clean separator.

> One methodological note, recorded because it nearly went the other way. The
> first version of that check fitted the model on **all twelve** benchmarks and
> predicted `clientcruise` to within 1%, which read as a clean result and was
> circular — `clientcruise`'s values are roughly five times larger than any
> other's, so it dominated the least squares and largely predicted itself. The
> leave-one-out reversed the conclusion. A fit that includes the point it is
> explaining explains nothing.

**Nothing about the curve is published, and after #253 the reason is sharper
than "not enough spread".** The point that gives the axis spread sits on the far
side of a declared corpus boundary, and a slope fitted across that boundary would
be a trend drawn over a comparability break — the exact reading the boundary
exists to forbid. The eventual published figure is still the curve's **verdict**
— flat-or-rising, yes/no, the analogue of `dayFifty.generationTrendOk` — with a
`field`, an evidence page and a run id, exactly as
the publication rules require. It ships when a corpus
version containing large apps is deliberately frozen and published, not before.
On today's evidence that verdict would be **no**.

#### Expressibility gaps the large benchmark surfaced

Composition only breaks at size, and a small-app corpus structurally could not
have surfaced these. Four were found by *running* it, not by anticipating them.
One has since been absorbed and is struck through rather than removed:

| Ask | What the vocabulary cannot say |
| --- | --- |
| A tag on five kinds of record | no many-to-many; `reference` names exactly one entity |
| A role granted over one record | the same single-target limit, from the permission side |
| ~~A readable name on a billing row~~ | **Absorbed** by #216: a bundle field may be declared *open* over candidate entities and a project narrows it with `data.setFieldReference`. Struck rather than deleted — an ask a primitive absorbs is reclassified in place, never removed, or the table stops being a record of what was once true |
| Re-uploading a day corrects it | `imports.declare` takes one `upsertFieldId`; the natural key is `(customer, feature, day)`, and a `date` is refused as a key. `maxRows` also ceilings at 50,000, below a month of the source product's own export |
| A page per account for that account | `PortalSpec.filter` is a `{fieldId, equals}` pair fixed at declaration time — "whichever tenant is looking" has no declaration |
| Two roles, same record, different columns | permissions are per resource and per operation, never per field |
| One ranked list across five tables | a search index is declared per entity |
| Nightly columnar files from object storage | `sources.declare` models an HTTP endpoint; `imports.declare` models a person uploading a file |

### First-build cost, as measured today

The harness's first-build pass measures the phase before any change
lands: empty tree → running app. It is bracketed inside `runBenchmark` around
`spec → generate → e2e scaffold+fill`, so it covers exactly what a first-time
user experiences and none of the change set that follows.

## Safe iteration — `time-to-Nth-safe-change`

> The wall-clock and success rate of landing a *change* to an already-live app
> (new field, new page, altered behavior) with the regeneration-safety suite
> still 100% green. — the program plan §5

Operationally, per benchmark:

- **N is a curve, not a fixed count.** Each benchmark carries an *ordered* change
  set biased toward long-lived apps under sustained change (risk #7). The harness
  lands the changes in order and records the cumulative cost to reach the **Nth
  safely-landed change** — one `TimeToNthPoint` per change
  (one `TimeToNthPoint` per change, in the harness's metrics module). Plotting cost-vs-N is the point: a single
  scalar would hide *where* in an app's life the maintainer cost spikes.

- **A change counts toward N only if it *landed and was safe*.** "Safe" = the
  regeneration-safety suite (`checkRegenSafety`: file never-clobber +
  ownership-preserved) found zero violations across the change's regeneration.
  A change that fails to land (e.g. a validate-gate-rejected regen-diff) does not
  advance N. A change that lands with a real safety violation is a §5
  **non-negotiable** failure: `firstUnsafeAt` records the first such n, and the
  nightly `maxstack eval` exits non-zero.

- **`safeChangeRate` = safe landings / changes attempted** — the change success
  rate.

## Normalizing change difficulty across kinds

Different change kinds are not equally cheap, so the raw count can't be compared
across benchmarks. Each change is weighted by **how much ownership it left
behind** — what stops regenerating, and what the system stops understanding
about your app (`CHANGE_WEIGHTS` / `changeWeight`):

| Change kind            | Weight | What it left behind                                        |
| ---------------------- | :----: | ---------------------------------------------------------- |
| spec op (`apply-op`)   |   1    | Nothing — a typed edit to the spec                         |
| spec op (`regen-diff`) |   1    | Nothing — a spec edit landed as a reviewed diff (bet B)    |
| slot fill              |   3    | Code the system can't read, in a file that still regenerates |
| eject                  |   5    | A whole file that stops regenerating, yours from now on    |
| off-surface            |   8    | No seam to land in at all; the platform absorbed none      |

The ordering (`spec op < slot-fill < eject < off-surface`) is the invariant:
cheaper = less left outside the system's comprehension.

### Why ownership, and why `regen-diff` moved from 2 to 1

The table used to ask *"how much did the maintainer still do by hand?"* That
stopped being one question once agents wrote most of the code, because it could
mean **authoring** (who typed it — now near-free), **review** (real, but paid
once), or **ownership** (paid every time anyone touches the app afterwards).

It measures ownership, because ownership is what the central claim rests on:
*still fast on day fifty* is a statement about accumulated ownership, not about
how long the first edit took.

Read that way the old table was a blend. `apply-op` and `regen-diff` both edit
the spec — nothing leaves the system either way, so their ownership cost is
identically zero — yet they were weighted apart. That gap was authoring effort,
left over from when authoring and ownership rose together. Corrected on
2026-08-10; `WEIGHT_SCALE.version` is 2, and the frozen corpus baseline stores
v1 weights, which `changeWeightV1` exists to verify against.

Rungs 3 and up already tracked ownership correctly and are unchanged. So is
`residualDifficulty` (ejects and off-surface asks only), which means the
moat-gap bar is unaffected by the recalibration.

## The iteration-cost headline number: `weightPerSafeChange`

`totalWeight / safeChangeCount` — **normalized maintainer cost per safe change**.
The proxy the dashboard watches fall over time. The nightly
summary surfaces `maxWeightPerSafeChange` (the worst benchmark) as the aggregate
gate.

Worked from a real run rather than invented, because this is the number the
marketing page quotes and an unreproducible figure is worse than none. The
`taskly` benchmark's ordered change set lands 7 spec ops (6 `apply-op`, 1
`regen-diff`), 3 slot fills and 1 eject; its 2 off-surface asks do not land:

```
op(1×6) + regen-diff(1) + slot(3×3) + eject(5)   21
──────────────────────────────────────────────  = ── = 1.91
                11 safe changes                   11
```

The two unlanded off-surface changes contribute neither weight nor a safe
landing, which is why `safeChangeRate` is 0.85 while `regenSafetyPassRate` is 1.

Reproduce it with `MOCK_AI=1 pnpm --filter @maxstack/harness eval` — the weighted
cost is generator-deterministic, so it does not need an API key and does not move
between runs.

**Aggregates are not quoted on this page.** They used to be ("11 benchmarks
green, `weightPerSafeChange` 2.4–2.78, `expressibilityRatio` 0.45–0.73"), and
every one of those figures was false within a few releases while this sentence
went on asserting them. They now live in
the published-stats artifact, generated from the metrics DB by
`pnpm stats:publish` and re-derived by the validate gate (issue #205) — so a
number that moves either updates or turns the build red. Read that file, or the
trend dashboard for the series over time.

### Why not wall-clock as the CI gate?

Wall-clock ms is the metric's literal unit and *is* recorded
(`ChangeOutcome.wallClockMs`, `TimeToNth.totalMs`), but under `MOCK_AI` it is
≈0 and noisy — useless as a CI regression gate. The weighted cost is
deterministic and CI-stable; wall-clock becomes meaningful (and reported
alongside) once the live `AiClient` transport lands. The eval loop takes its
clock via an injected `now()` so tests pin it.

## The derived surface, verified

The runtime half of the leverage numerator is a per-resource constant, so it is
the half most able to inflate the published figure quietly.

**Every per-resource count below was verified by probing a real running app**
([evidence](evidence/first-build-surface-verification.md)) and is drift-guarded
in `first-build.test.ts`:

| Derived per resource | Count | Verified how |
| --- | --- | --- |
| REST operations | 7 | list, getMany, create, count, get, update, delete — all probed 200/201 |
| MCP operations | 5 | list/get/create/update/delete, reachable for every entity. Named `list_task`/… when probed; since issue #320 the vocabulary is fixed (`list_records`, `get_record`, …) and takes the resource as an argument, because 5 names × 134 entities is a 299KB `tools/list` clients refuse. Same five operations per entity either way. |
| Admin screens | 3 | `/admin/task`, `/admin/task/new`, `/admin/task/<id>` all 200 |
| Form fields + validators | 2 per declared field | detail page rendered every declared field's label |

**Count what is reachable, not what is exported.** The first version of this
table said 8 REST endpoints, from counting `*Handler` exports in
`sprout/api.ts`. Two of those eight — `countHandler` and `restoreHandler` — were
wired to no route at all: `/api/task/count` fell through to `opGet('count')` and
500d, and restore was simply unreachable. That inflated the published figure by
two per entity until a live probe caught it, and the count was cut to 6.

Both are wired now, and the count went to **7**, not back to 8:

- `count` is universal — every declared entity gets `GET /api/:resource/count`,
  so it counts.
- `restore` is reachable but conditional. `registerSpecEntities` never sets
  `softDelete`, so on a plain declared entity `POST /api/:resource/:id/restore`
  answers 422 forever. A route the declaration cannot actually buy is not a
  per-entity artifact — the same rule that excludes the admin trash screen,
  which is registered but has nothing to show without soft delete. A drift test
  asserts `from-spec.ts` still never sets `softDelete`, so if that changes, the
  constant is forced up deliberately rather than drifting.

The lesson generalizes past this table: the fix for an inflated number is to
build the thing the number claimed, not to find a reading that makes the old
number true.

`FirstBuildCost.leverage` is the **files-only floor** — the same ratio with the
runtime half excluded, roughly half the full figure. Both are published
(`leverageFloor.median` beside `leverage.median` in
the published-stats artifact): quote the floor alongside the
headline, because it is the conservative reading and it costs nothing to publish
both.

### What this deliberately does not claim

**There is no speedup multiple here.** The benchmark set has no no-MAXSTACK
control, so "N× faster than an agent on a blank repo" is not in evidence and must
not be derived from these fields. Leverage is a statement about how much the
platform expands one authored declaration — a different, checkable claim. Adding
a control arm is the honest way to earn a speedup number, and it is not built.

### Tokens

`FirstBuildCost.tokens` reports what the agent actually spent, split from the
change set's tokens (`BenchmarkResult.changeSetTokens`) by diffing the client's
cumulative counter around each phase. Both transports report provider-billed
counts; the Anthropic path bills before inspecting the response, so a refusal or
an empty completion still shows its cost.

Under `MOCK_AI` the mock reports a deterministic `ceil(chars / 4)` estimate and
sets `estimated: true`, which propagates to `EvalSummary.tokensEstimated`.
**A summary with `tokensEstimated: true` is not a source for a published token
figure.** The artifact says so itself rather than relying on whoever reads it to
remember which run produced it. As of this writing the nightly runs keyless, so
every recorded token count is an estimate; a real figure needs a keyed run.

### Wall-clock

`FirstBuildCost.wallClockMs` is recorded and never gated, for the same reason as
[wall-clock per change](#why-not-wall-clock-as-the-ci-gate): ≈0 under the mock,
noisy everywhere else.

## The determinism-baseline suite

Two properties of the **zero-LLM oracle** (the program plan §L4A, decision #5),
implemented in the harness's determinism suite and folded into every
`maxstack eval` run:

- **Determinism (hard gate).** Same spec ⇒ **byte-identical** generation, every
  run. `checkDeterminism` regenerates a benchmark twice and diffs the generated
  files (the AI-authored `e2e/` suites are excluded — LLM output is legitimately
  non-byte-stable). `allDeterministic` is a non-negotiable gate like
  regen-safety: `maxstack eval` exits non-zero if the generators drift. The
  dashboard surfaces it as a `stable`/`DRIFT` tile.

- **AI must beat the deterministic baseline (decision #5, concretely).** The
  **baseline** is the zero-LLM scaffold (deterministic generators + placeholder
  test bodies); its capability is `scoreSuiteContent` — assertions that do more
  than a bare navigation (`expect(` calls minus the placeholder
  `toContainText('')`). The AI path **beats** the baseline only when it scores
  *strictly higher* (`beatsBaseline`). Because the baseline is human-authored
  deterministic code the AI never touches, it is an **independent yardstick the
  AI cannot weaken** — the anti-circularity mechanism for the test-quality axis.
  Under `MOCK_AI` the placeholder mock *ties* the baseline
  (`beatsBaseline: false`): the honest signal that a *keyed* run is what must
  clear the bar. This is a **measured** field, not a mock gate.

## The metrics DB

Each `maxstack eval` run is one `EvalSummary`. `maxstack eval --record <file>` appends
it to an **append-only JSON-lines log** (the harness's metrics store) — the
minimum-mechanism "metrics DB": one line per run, newest last, no schema server.
`trend(runs)` folds the history into per-benchmark series
(`expressibilityRatio`, `regenSafetyPassRate`, `weightPerSafeChange`,
`safeChangeRate` over time) — the exact input the trend dashboard renders.

### The cold-start history

The entry claim gets its own append-only lineage, `cold-start.jsonl`
(the harness's cold-start runner), written by
`pnpm --filter @maxstack/harness cold-start -- --record <file>` and accumulated
by the nightly exactly as `metrics.jsonl` is. Separate from the eval history on
purpose: a cold start and an `EvalSummary` answer different questions, and one
file holding both shapes would make every reader discriminate on a tag. See
the cold-start method note — including why a fast run with an
empty cache is refused rather than published.

## The trend dashboard

`maxstack eval dashboard --in <jsonl> --out <html>`
(`pnpm --filter @maxstack/harness dashboard`) renders the metrics DB into **one
self-contained HTML page** (the harness's dashboard renderer): inline CSS +
inline SVG line charts, no scripts, no external requests, theme-aware. Per
benchmark it plots the three tracked numbers over time — cost/safe-change
(goal #2's proxy, read *down*), the expressibility ratio, and regen-safety (with
the 1.0 floor) — plus a headline gates row from the latest run.
`renderDashboard(runs)` is pure, so it unit-tests without a browser.

Leading that grid is the one card whose axis is **not** time: `leverage vs app
size` (#254) plots the latest run's `leverageCurve` — artifacts per declaration
against authored declarations, one point per benchmark. It is a cross-section of
the corpus at one moment rather than a history, which is why it reads the latest
run and not the whole JSONL. It draws no trend line, no target and no verdict,
and carries the reason as rendered text so a screenshot of it cannot lose the
caveat. A run recorded before the series existed simply omits the card.

A run of a later [corpus version](corpus-integrity.md#the-declared-corpus-versions)
(`maxstack eval --corpus 2`) puts the large benchmark on the same axes — behind a
dashed **version-break rule**, as its own series, never joined to the published
line, with its size and the comparability break rendered underneath. Joining them
would be a trend drawn across a comparability boundary.

One gap remains, plus one deliberate omission. The other charts plot **against
time**, which is the right axis for goal #2 and the wrong one for goal #1 — that
half is covered by the card above, but its published side is still eleven small
apps wide, so the *shape* is not a claim. And the expressibility
chart used to carry a 0.8 target line, which was removed — 0.80 is now a
headroom-captured target, not a ratio target, and drawing it on the ratio axis
reproduced exactly the unreachable-target defect `d-expressibility-headroom`
exists to record.

The JSONL history is append-only and grows one point per recorded run
(`maxstack eval --record metrics.jsonl`), with the dashboard rendered from the
accumulated history rather than a single run.

> **The nightly that used to fill it is gone** (2026-08-04,
> `d-remove-the-ritual-keep-the-checks`). `nightly-eval.yml` restored
> `metrics.jsonl` from the Actions cache each night, appended a MOCK_AI run, and
> — where an `ANTHROPIC_API_KEY` secret existed — a keyed one too. That was
> continuous instrumentation for a platform with no external user, and the keyed
> job spent real credits nightly to do it. **The history is now discontinuous by
> design**: points accrue when someone records a run, and on the release path via
> `stats:capture`, which is the only moment a number is published. A gap in the
> trend is therefore expected and is not evidence of a stalled platform. What
> survives nightly is `nightly-cold-start.yml`, kept because the funnel's first
> impression *is* a cold start (`d-speed-at-every-size`).

### The dangling-slot gate

`maxstack eval` also folds in `danglingSlotRefs` per benchmark and the
`noDanglingSlots` aggregate gate (task 15): a generated `<Slot render={slots.X}>`
with no matching user render fn is a real render bug, so the CLI exits non-zero on
any dangling ref (like regen-safety and determinism) and the dashboard surfaces a
`slot refs` tile. See the regeneration ledger (`maxstack regen-cost`) for the loop that
added it.
