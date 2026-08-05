# Upgrade safety (program gate G5)

> The apparatus that runs this sweep lives in the maintainer's own
> repository rather than here, because it is measurement machinery rather
> than part of the framework. This document is the method; see
> [measurement.md](measurement.md) for what the results do and do not say.

> A starter kit hands you auth, billing and teams wired on day one, and so do we.
> The difference is that ours can be moved forward afterwards. This document is
> how that stays true.

[`combination-safety.md`](combination-safety.md), which proves the same catalog
composes rather than upgrades.

## The failure mode

Versioned upgrade codemods are the *entire* structural difference between a
MAXSTACK bundle and a starter kit.
Before this gate, that difference was asserted in marketing copy and exercised by
four unit tests over a synthetic spec built in the test file itself.

**An upgrade path that has never been run against a real old project is a
hypothesis.** Two things go wrong there, and only one of them is loud:

- the codemod does not do what the release said it did — loud, eventually;
- the codemod does its job and *takes something of yours with it* — quiet, and
  the thing it takes is the file you ejected precisely because you did not trust
  a framework with it.

The second is the one the platform has the strongest reason to get wrong: a
bundle upgrade is the one moment where the generator has a legitimate-sounding
excuse to touch a file the user owns.

## What the gate asserts

the measurement harness, run by
the harness runner, by the `upgrade-safety` job on
every PR (a stated sample — see [Two tiers](#two-tiers-a-sample-per-pr-the-sweep-nightly)),
and in full by `nightly-safety`. It **fails the build; it does not warn**
(the validate gate is a ship gate, not advice).

It runs in two halves, because the two prove different things and neither alone
is enough.

### 1. Pinned fixtures — real old projects, with user modifications

the measurement harness holds committed **project trees**:
`maxstack.json`, a `spec/` directory in the ordinary v2 split format, an `app/`
tree, a `routes.ts` and a `.generated.routes.json` ownership manifest. The gate
reads those bytes. It does not re-derive them — a fixture regenerated on every
run is not a pinned old project, it is today's catalog wearing an old version
number, and it would go green against a codemod that does nothing.

Every fixture carries **user modifications**, because upgrading a pristine
project proves nothing about the promise we actually make:

| modification | what it tests |
| --- | --- |
| an **ejected** route module with a hand-written function appended | the day-fifty claim, at the point it is most likely to break |
| a **filled block slot** with real code in it | the cheaper rung of the ownership ladder survives too |
| a **manual entity and page** no bundle owns | `isAddedManually` — regeneration never deletes manual items |
| a **hand-added field on a bundle-owned entity** | the case a codemod for *that bundle* runs straight through |
| a **hand-edited `maxstack.json`** | the upgrade moves version pins and nothing else |

A fixture whose manifest marks nothing as owned is **refused**, not passed.

Per fixture the gate asserts, in this order:

1. **The fixture is what it claims to be.** Every change the version declared is
   genuinely *absent* from the pinned spec. Without this, a fixture accidentally
   captured at the new version sails through every other check below, because
   there is no migration left to run.
2. **The plan reaches the catalog** — an unbroken chain to the current version,
   multi-version jumps included. `billing-0.1.0` walks 0.1.0 → 0.2.0 → 0.3.0 in
   one `upgrade`; `billing-0.2.0` exercises the middle hop on its own, so it is
   never covered only from inside a longer chain.
3. **The change landed** and the spec still validates.
4. **Nothing the user owns moved a byte.** Byte-identical is the bar;
   "semantically equivalent" is not acceptable, consistent with the never-clobber
   gate.
5. **Ownership itself survived.** No manifest entry silently reverts to
   `generated` — a file left intact but re-marked is clobbered on the *next*
   regeneration, which is worse than clobbering it now, because it passes review
   and breaks later.
6. **Manual spec items survived**, and the hand-edited config keys are untouched
   apart from the version pins.
7. **It settles.** A second `planBundleUpgrades` finds nothing to do, re-applying
   the same plan changes nothing, and a second regeneration writes nothing. So
   `maxstack gen --upgrade` is safe to run twice and a partly-migrated project
   converges — which is the promise a codemod's idempotence is *for*.

The four calls the gate makes are the four `maxstack gen --upgrade` makes, in the same
order: `planBundleUpgrades` → `applyBundleUpgrades` → `bumpInstalledVersions` →
`generateResourcePage`. `bumpInstalledVersions` was extracted out of the CLI
command for exactly this reason. **A gate with its own upgrade path proves that
the gate's upgrade path works.**

### 2. The subset sweep — convergence under contention

The pinned set is small by construction: a fixture is a committed artifact, and
there is a real cost to having many. The interesting cross-bundle question is
combinatorial — does a codemod still converge when it runs inside a project
carrying fourteen other bundles contending over `user`, `organization` and the
audit sink?

So the same rewind-and-upgrade runs over prerequisite-closed catalog subsets. For
each, the gate installs at the oldest releasable versions, upgrades, installs the
same subset fresh at today's catalog, and asserts:

> **An upgraded project is the app a fresh install is.** Same entities, fields
> and pages (`specContentKey`), and a byte-identical generated tree, `routes.ts`
> and `schema.sql`.

Subsets with nothing to migrate are excluded: including them would inflate the
ratchet with points that are green by construction, which is the "green board
that means nothing" the combination gate's sampling section warns about. Today
three catalog bundles have moved (`audit`, `billing`, `members`), so the sweep is
**3976 of the lattice's 4047** closed subsets.

### 3. Ownership drift — the eject tax, itemized

Never-clobber answers *"will the platform touch my file?"* — no. That is the
right write behavior and a lousy reporting behavior: `regenerateAsDiff` reports a
protected file with an **empty patch**, which tells you the file is safe and says
nothing about the derivation it was copied from having moved three releases ago.

The eject tax is real and it is **deferred**. You pay it the day a framework
improvement lands in every generated route except yours. So the honest version of
the promise is not "eject and forget" — it is *"eject, and we will keep telling
you what you're missing, without ever acting on it."*

`ownershipDrift()` (`packages/maxstack-core/src/ownership/drift.ts`) compares
every `ejected` / `user` manifest entry against what the generator would emit for
it today, and classifies it:

| status | meaning |
| --- | --- |
| `in-sync` | byte-identical to the current derivation — owned, not yet diverged |
| `drifted` | diverged, with a unified diff (`current derivation → your file`) |
| `authored` | `user`-owned: seeded once and never derived again, so there is nothing to fall behind. A filled slot is *supposed* to differ from its stub |
| `underived` | the declaration it came from is gone, or it is a write-once seam that is never derived twice. Still yours, still runs, nothing to compare |
| `missing` | tracked as yours, not on disk |

**One derivation, three surfaces** — the same rule slot discovery follows.
`maxstack drift [--patches]`, the `ownership_drift` MCP tool, and the workbench's
Ownership pane all render `ownershipDrift()` over `regenTargets()`
(`packages/mcp/src/ownership.ts`), so a human and an agent cannot be told
different things about the same file.

**Every family, not just pages** (issue
). `regenTargets()` folds one
target per page **and** the framework-owned registry of every declared seam —
schedules, sources, imports, live channels — so an
ejected registry is compared rather than reported as an orphan. Each report entry
carries the `family` it came from (`page` / `schedule` / `source` / `import` /
`live` / `other`) and `underived` explains itself in that family's terms; it used
to assert that the page a file came from had been deleted, which is wrong for a
file that never came from one. The write-once half of each seam — a handler, a
refiner, a parser, a bespoke surface — is deliberately **not** derived: it is
never emitted twice, so diffing it against its own stub would manufacture drift
out of the feature working.

**What can move under an `authored` file.** Its bytes cannot fall behind, but the
block-slot role vocabulary its fills were written against is a versioned public
API. `maxstack slots fill` stamps `rolesVersion` on the manifest entry, and drift
compares that number rather than the file: a slot authored against roles v1 while
the platform is on v2 reports `rolesDrift` and says so in one line. Still
`authored`, still never patched, still nothing to apply.

**It is information, not a demand.** Nothing here writes, proposes a write, or
fails a gate — the workbench loader's `Fs` throws on `write`, so that is
structural rather than a promise in a docblock. Drift is not an error state: an
ejected file that has diverged is a file doing exactly what ejecting it was for.
The surfaces are pull, not push; `gen` and `upgrade` print at most **one line**
(`driftSummaryLine`) pointing at them, and only when there is something to say.

**The "needs your attention" path.** When an upgrade genuinely needs to change
something the user owns, the platform must surface it as a reviewable diff with
an explanation — never apply it, and never silently skip it. That is this report,
computed after the upgrade. It is tested against a *deliberately breaking*
derivation change (`drift.test.ts` § "the 'needs your attention' path"): the page
is renamed and moved, and the test asserts the file is byte-identical, the regen
review says `protected` and why, the drift report carries the patch and the
explanation, and the summary line is exactly one line.

### 4. Install, not only upgrade

An upgrade is not the only moment the generator runs over an ejected file:
`maxstack add <slug>` regenerates the whole tree, and a bundle with prerequisites
cascades several installs inside one command. That is the case with the most
writes and the least attention, so each fixture also gets a **cascading install**
after its upgrade — the uninstalled bundle whose install pulls in the most
prerequisites, chosen adversarially on the lattice gate's principle rather than
picked for convenience. Five of the six fixtures get a 3–4 bundle cascade;
`full-catalog-initial` already carries everything, which the run **states**
("no cascade available") rather than skipping silently.

## Reconstruction, stated rather than implied

The gate postdates the versions it tests. There is no archived 0.1.0 project to
check out, so the pinned fixtures were **reconstructed**: the catalog entry with
everything later versions introduced removed, installed through the ordinary
`validateBundleApply` → `applyBundle` path. That is a weaker claim than "we kept
a real 0.1.0 project around", and it is written down in
the measurement harness rather than left implied.

It is also a *decreasing* weakness. From that version forward, a version bump captures
its fixture while the old version is still current, which is the real thing.

The reconstruction is kept honest by refusing to derive it from the thing under
test:

- **`BUNDLE_INTRODUCTIONS`** declares what each released version added — written
  from the catalog entry and the release's issue, never from the codemod.
- **`BUNDLE_CODEMODS`** says how to get there.
- Nothing derives one from the other. `checkHistoryAgainstCodemods` requires an
  entry for every registered step *and* a step for every entry, and the gate
  asserts each declared introduction is absent before the upgrade and present
  after.

A codemod that migrates something nobody declared, or a declaration nothing
migrates, is a red test rather than a quiet pass. Deriving the old shape from the
codemod would have meant a codemod that adds the wrong field produces a fixture
missing the wrong field — green on a bug.

## Coverage, and the ratchet

A fixture must exist for every **(bundle, version) cell** a real project could be
sitting on:

- every bundle's `initialVersion` — a project installed the day the bundle
  shipped must still walk forward, which is bundle contract requirement 2 tested
  rather than declared. For a bundle that has never moved this is a *no-op*
  upgrade, and it is still worth a fixture: it is the case where an ejected file
  must survive a regeneration that had nothing to migrate;
- every codemod's `from`, so the adjacent step is exercised on its own.

That is **18 cells over 17 catalog entries**, covered by 6 fixtures.
`UPGRADE_RATCHET` records `{ cells, subsets, catalogSize }` and
`scripts/check-upgrade-ratchet.mjs` (the `governance` job) fails any PR that
lowers any of them. `cells` is the one with teeth: lowering it is how you would
delete the requirement that a release ships a fixture at the previous version.

**How a version bump is actually blocked.** Bumping `billing` to 0.4.0 adds a
required cell at `billing@0.3.0`. Today that cell is already covered — by the
`current-noop` fixture, which is captured at the catalog's *current* versions
precisely so that the day the catalog moves, a real project at yesterday's
version is already committed. Bump twice between captures, delete that fixture,
or add a brand-new bundle with no fixture at all, and coverage goes red. All
three are asserted in `upgrade.test.ts`.

## Two tiers: a sample per PR, the sweep nightly

The same shape
established for the lattice, deliberately rather than as a second convention.

| | PR tier (`--tier pr`) | Nightly (`--require-ratchet`) |
| --- | --- | --- |
| Fixtures (upgrade + cascading install + drift) | **all 6** — never sampled | all 6 |
| Coverage check | yes, hard | yes, hard |
| Subsets | **101 of 3976** (2.5%) | all 3976 |
| Selection | top of the *combination gate's* adversarial ranking, extended to a whole score band | none — everything |
| Can meet the G5 ratchet | **never** | yes, and must |
| Where | `validate`'s `upgrade.test.ts` + the `upgrade-safety` job | `nightly-safety` |

The fixture half is never sampled: it is the proof about real old projects, it is
the part a human reviews as bytes, and it runs in well under a second.

**Selection reuses `scoreSubset`.** Inventing a second adversarial notion would
mean two rankings drifting apart, and the signal is the same either way —
prerequisite depth, cross-references, and contention over `user` / `organization`
/ the audit sink. `UPGRADE_PR_TIER_TARGET` is 96 rather than the lattice's 256
because a point costs more here: three installs and two full renders, because
convergence is a claim about an upgraded project *versus* a fresh one.

**It says so.** Every run at either tier prints `describeUpgradeRun`:

```
upgrade [pr]: 6 pinned fixtures covering 18/18 (bundle, version) cells over 17 catalog entries
  fixtures: the COMPLETE set — coverage is a hard check, not a sample
  subsets: 101/3976 closed subsets carrying an upgradable bundle
  selection: the 101 highest-scoring points of the adversarial ranking (PR tier: top 96 by
    prerequisite depth and contention over user / organization / the audit sink, extended to
    the end of the score band so no band is cut mid-tie)
  SAMPLE, NOT THE FULL SWEEP — 3875 lower-scoring subsets were NOT checked (checked down to
    score 78, highest skipped 77); the full sweep and the G5 ratchet (3976 subsets, 18 cells
    over 17 bundles) run nightly
```

`meetsRatchet` is `false` on **every** sampled run unconditionally — not "false
because 101 < 3976", which would flip to true the day someone lowered the
recorded number — and `--require-ratchet` together with `--tier pr` or `--limit`
is a **usage error (exit 2)**, not a failed gate. There is no invocation that
evaluates the ratchet against a sample.

**What the split costs, stated rather than discovered later.** Between nightlies,
a convergence break confined to the low-scoring tail lands green and is caught
the next morning. The fixture half — the part that carries the never-clobber
promise — is *not* subject to that: it runs complete on every PR.

## Capturing a fixture

`the harness runner`, and commit the
result.

Run it **deliberately**: when a bundle takes a version bump and a project at the
old version needs to be preserved before the old version stops existing. Add the
new version to `BUNDLE_INTRODUCTIONS`, add a blueprint to `FIXTURE_BLUEPRINTS`,
capture, review the diff, commit.

Recapturing an existing fixture rewrites it from *today's* catalog rewound by the
declared history, so a non-empty diff is worth reading rather than rubber-
stamping: either the catalog moved or the declared history did, and one of those
means a fixture no longer describes a real old project.

## Interpreting a failure

The job uploads `upgrade-report.json` on every run (pass or fail), matching
`ownership-safety`'s behavior. The console output is the same information,
formatted.

- **`owned file "<path>" (ejected) changed across the upgrade`** — the headline
  failure. An upgrade touched something the user owns. The write went through
  `writeGenerated`, so either the manifest lost the entry or a generator wrote
  outside the writer; see [`ownership.md`](ownership.md).
- **`manifest entry "<id>" changed ownership ejected → generated`** — the file is
  intact *today*. Fix it before the next regeneration, which will overwrite it.
- **`upgrade did not introduce "<marker>"`** — the codemod is missing part of
  what its version declared. This is what caught `billing` 0.3.0 shipping the
  `usage_event` ledger without the `/usage` page that reads it: a project that
  said 0.3.0 and was not, in a state neither version recognized.
- **`"<path>" differs between an upgraded project and a fresh install`** — the
  convergence failure. An upgraded project and a fresh one are two different
  apps carrying the same version pin. Fix the codemod, or — if the difference is
  ordering rather than content — fix the *emitter*, the way the emitter sorted
  `specSchemaDdl`'s `ADD COLUMN` statements by column name. A codemod appends
  where a fresh install declares in the middle, and no migration can reorder a
  Postgres table, so an input-ordered emitter would have claimed a difference the
  platform can never remove.
- **`owned file "<path>" changed when installing "<slug>" (cascade: …)`** — the
  same failure on the install path rather than the upgrade path. The cascade in
  the message is the whole chain that ran inside the one `maxstack add`.
- **`the drift report accounts for N owned file(s) but the manifest has M`** — a
  file you own was silently omitted from the report about what you own, which is
  the one way a non-failing report can still lie.
- **`no fixture pins <slug>@<version>`** — a release without a fixture at the
  previous version. Capture one.
- **`pinned fixture already carries "<marker>"`** — the fixture is not at the
  version it claims. Usually a recapture that should have been a new fixture.

## Why this and the combination gate are two gates

They ask different questions about the same catalog, and passing one says nothing
about the other:

- **Combination safety**: does the catalog *compose*? Install any subset in any
  valid order and get the same app.
- **Upgrade safety**: does the catalog *move forward*? Take a project someone has
  lived in and carry it to the current version without touching what they own.

The commercial argument for a composable catalog is that a fixed starter kit you
delete from is not the same product. That claim needs both halves: composition
that is checked, and an upgrade path that has actually been run.
