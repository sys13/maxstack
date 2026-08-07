# Ownership — slots, eject, and the never-clobber writer

This is the implementation design for `packages/maxstack-core/src/ownership/`,
the Phase 2 "safe change-over-time" machinery.
It is *new work built on* the eject reference spec
(the archive design) and the
provenance reference spec (the data-layer
invariants), not another archive extraction.

Phase 2 "ships the hard guarantees first, then runs both candidate mechanisms
side by side". The design stands up on **one small
target** — a resource list page with one slot — end to end.

This is the *design* document for the machinery. The user-facing change ladder
these mechanisms serve (spec-op — including the theme/`page.setBlockVariant`
presentation ops → slot-fill → eject → regeneration-as-diff) is
stated canonically in [user-guide §5](user-guide.md#5-making-a-change).

## The hard guarantees, true under either mechanism

- **Ownership manifest** (`manifest.ts`) — `.generated.routes.json`, one entry
  per file with `ownership: 'generated' | 'ejected' | 'user'` plus a content
  hash. Reimplements saaskit-one-ejectable's flat `string[]` as per-entry
  ownership so regeneration can tell a stale generated file from a hand-touched
  one.
- **Never-clobber writer + eject** (`write.ts`) — every write consults the
  manifest; `ejected`/`user` files are never overwritten. `eject` copies
  with a banner, strips the generated banner, and flips ownership — **including
  when it ejects in place**, which is the default (`maxstack eject <id>` with no
  `--to`): the file being rewritten there is the framework's own, so swapping
  `AUTO-GENERATED … DO NOT EDIT` for `EJECTED — you own this file now` clobbers
  nothing and stops the file claiming something the manifest just made false. A *different* destination that already exists is still left
  untouched. Filesystem
  is an injected `Fs` port (`memfs.ts` is the in-memory double + CLI dry-run
  backend), so L2 keeps no hard `node:fs` dependency.
- **The ownership drift report** (`drift.ts`) — the other half of
  the eject bargain. Never-clobber answers "will you touch my file?"; this
  answers "what am I missing by owning it?" Every `ejected`/`user` entry is
  compared against what the generator would emit today and classified
  (`in-sync` / `drifted` / `authored` / `underived` / `missing`), with a unified
  diff for the drifted ones. Every family the generator emits is derived, not
  just pages, so each entry carries the seam it came from and
  `underived` explains itself in that seam's terms. It never writes and never
  fails a gate — drift is
  the cost of owning a file, made visible, not an error. Surfaced by
  `maxstack drift`, the `ownership_drift` MCP tool and the workbench's Ownership
  pane, all over the same fold. See
  [`upgrade-safety.md`](upgrade-safety.md#3-ownership-drift--the-eject-tax-itemized).
- **ts-morph generator-side emission** (`emit.ts`) — replaces the string
  `.replace('pages: []', …)` splice that broke every prior generation.
  `addRouteToManifest` inserts a route through the AST array node: structural,
  idempotent, and immune to anchor-string corruption (there is a test that
  proves a comment containing the old anchor survives). `emitResourcePage`
  emits a deterministic, slot-bearing route module.
- **Regeneration-safety suite** (`regen.ts`) — `checkRegenSafety` (file-level
  never-clobber + ownership-preserved) and `checkProvenanceInvariants`
  (data-level manual-survives + grounds-on-accepted, kept structural so L2
  needn't import the L1 spec package). §6: "100%, not a target."

## Mechanism (a) — the ladder: cross-file extension slots

The `<Slot>` runtime lives in `@maxstack/ui` (`slots/Slot.tsx`); the generator
wires it. A generated page renders `<Slot name="afterList" render={slots.…} />`
from a **stable user-owned `*.slots.tsx` file**. Part-generated /
part-hand-written at the *module boundary* — the user owns their slot file
whole, the generated file regenerates freely, **no AST merge**. The generator
writes the slot stub exactly once (`writeUserFileOnce`), then never touches it.

The end-to-end example (`packages/ui/src/slots/example/`) is its own
case: a "bulk-archive" button that needs a slot, not a spec op. A render test
proves the generated page + user slot file compose; a generate test proves a
regeneration with a changed title leaves the user-edited slot file
byte-identical.

### Block-level slots

The seam above is *page*-level: a slot exists because someone put a
`slot:<name>` block in the spec, and wanting one custom card meant ejecting the
whole surface. `block-slots.ts` adds a second kind, **derived** rather than
declared: every resource page exposes a fixed, versioned set of slot-bearing
block roles (`header`, `list`, `row`, `field`, `empty`), and a slot is filled
the moment the same user-owned `*.slots.tsx` exports the derived id
(`exercise__row`, `task__field__dueDate`).

Three properties carry the design, and each has a test:

- **Ids derive from spec identity alone** — resource + role (+ field), never
  generation order or block index — because a filled id is a public API.
- **Available, not scaffolded.** The generator never seeds a block-slot stub;
  `maxstack slots fill <id>` (`fillBlockSlot`) writes the one you ask for,
  append-only. Otherwise every project's slot file would carry a placeholder
  per role per resource.
- **Orphans are gated.** The dangling-*reference* check has a mirror image that
  block slots make possible — an *implementation* with no host block, which
  fails silently. `orphanedSlots()` fails `maxstack validate`, and the harness
  counts `orphanedBlockSlots` per benchmark.

Full user-facing treatment: [`block-slots.md`](block-slots.md).

### The non-page seams, and who emits them

Schedules, external sources
([`external-sources.md`](external-sources.md)), import parsers
([`imports.md`](imports.md)) and bespoke live surfaces ([`live.md`](live.md))
each generate the same two-file shape as a page: a **framework-owned registry**
(`jobs/schedules.generated.ts` &co) plus a **user-owned stub written once**.

`maxstack gen` emits all four, from the same descriptor projections
`maxstack drift` derives its targets from (`scheduleDescriptors` and friends in
`@maxstack/mcp`) — so the CLI, the drift report and the harness cannot disagree
about what a seam is. That agreement is pinned over the whole corpus by
`apps/maxstack/src/lib/seam-derivation.test.ts`, because the harness keeps its
own copy of those projections (the boundary policy forbids it importing
`@maxstack/mcp`).

Each generator's **absence rule** holds throughout: a project that declared no
schedule grows no `jobs/` directory to prove it — and, since the absence rule
runs in both directions, a project that *stops* declaring one loses the registry
it grew. Undeclare one schedule of three and the registry is re-emitted with the
survivors; undeclare the last one and the registry is deleted along with the
manifest entry the runtime imports it through. The handler, refiner, parser or
surface itself is **never** deleted: it is your code, and losing its registration
is what stops it running. `gen` prints a line naming each one, so an unwired
handler is something you were told about rather than a file that went quiet.

The registries reach the runtime through the same Bar 2 seam owned slot code
does — `owned.generated.tsx` re-exports each one (`OWNED_SCHEDULE_HANDLERS`,
`OWNED_SOURCE_REFINERS`, `OWNED_IMPORT_PARSERS`, `OWNED_LIVE_SURFACES`), so a
handler somebody filled in actually runs instead of dead-lettering against an
empty registry. All four are consumed today:

| registry | what reads it |
| --- | --- |
| `OWNED_SCHEDULE_HANDLERS` | the job queue (`sprout.server.ts`) |
| `OWNED_IMPORT_PARSERS` | an upload to a `format: 'custom'` importer |
| `OWNED_SOURCE_REFINERS` | the source runner (`sources.server.ts`) |
| `OWNED_LIVE_SURFACES` | the bespoke-surface host (`live-surface.tsx`) |

The last two were exported and read by nothing until later, because there
was nothing to read them: `registerSourceHandlers` was called nowhere and no
surface rendered a slotted channel's component. Those were missing *execution
paths* rather than missing wiring, which is why closing them was a feature and
not a fix — see [`external-sources.md`](external-sources.md) for what triggers a
run and [`live.md`](live.md) for where a bespoke surface composes into a page.

## Mechanism (b) — regeneration-as-diff (bet B)

`regenerateAsDiff` re-derives affected files and returns a **reviewable unified
diff** (via `diff`) instead of overwriting. Protected (ejected/user) files are
surfaced but never proposed for overwrite — never-clobber enforced before a
write is even contemplated. `applyReviewedDiff` lands the batch **only if the
injected validate gate passes**; a failing gate rolls back to a no-op (nothing
was written yet).

## The comparison

Both mechanisms enforce the same regen-safety floor. The ladder makes user
customization structural (own a whole slot/ejected file); regeneration-as-diff
makes it reviewable (approve a diff, hand edits preserved). Whole-file eject is
the hard guarantee under either. The Phase 2.5 dogfood + the harness
eject/edit-rate signal decide which is load-bearing.

## Not yet wired (follow-ups)

- Drive the generator from a real Sprout resource + `mconfig` page (currently a
  hand-built `PageDescriptor`); today's small target is the list page.
- A `node:fs/promises` `Fs` adapter + the `maxstack eject`/`gen` CLI verbs over
  this core (the verbs are documented stubs — task 5).
- Multi-line array formatting from ts-morph's printer (routes manifest emits a
  single-line array; correct, not pretty — Biome would reformat in a real
  project).

## Interpreting an ownership-safety failure (CI)

The `ownership-safety` job in `.github/workflows/ci.yml` runs on
every PR and guards the two product promises independently of the main
validate gate:

1. **Ownership invariant unit suite** — `pnpm --filter @maxstack/core test`.
   A failure here means a change broke never-clobber, manifest, eject, or
   emit behavior directly; the vitest output names the invariant.
2. **Regen-safety eval** — the maintainer's regeneration sweep
   across every benchmark. It exits non-zero when any benchmark's
   `regenSafetyPassRate` drops below 1.0 (a regeneration clobbered or dropped
   a user/ejected file) or a deterministic generator drifted between runs.

Triage from the uploaded artifacts:

- `ownership-safety-results` — the JSON summary (uploaded on every run). Find
  the failing benchmark id in `results[]`: `regenSafetyPassRate < 1` means a
  clobber; `deterministic: false` means drift.
- `ownership-safety-trees` (failure only) — each benchmark's generated tree
  under `<benchmark-id>/`. Diff the flagged files against the benchmark's
  expectations to see exactly what a regeneration would have destroyed.

A red `ownership-safety` job is never noise: either fix the regression or, if
the benchmark's expectations were legitimately changed, update them in the
same PR with the reasoning in the description.
