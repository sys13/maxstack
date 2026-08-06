# Workbench — the review-first surface

The workbench is the review-first canvas at `/workbench` (`apps/web`) over the
live platform spec, plus interaction telemetry flowing. The spec and the telemetry
log are **disk-backed** (`MAXSTACK_DATA_DIR`, defaulting to `.maxstack/` in
dev — `data-dir.server.ts`; stores in `@maxstack/mcp` `createFileSpecStore` +
the JSONL telemetry host), so the workbench, the MCP tools, and a headless
script share one durable project. Accept/reject lands through the
**`provenance.review` spec-op**, so every review is an op-log audit entry.
`maxstack demo` drives the whole loop through it reproducibly.

The agent is the primary interface, so the workbench stays a review surface —
the place a human grounds truth — not a product of its own. That constraint
holds. What did *not* hold was the sentence that used to open this document:
"three panes, and this is the workbench's final scope". Panes were added one at
a time, each reasonable on its own, until there were eleven and the result was
**a set of panels rather than a place** — see
[what needs you](#what-needs-you), which is now the top of the surface
and the answer to "where do I start".

## Why it is deliberately small

Every pane is a **pure fold** of the spec or a thin wrapper over an
already-shipped platform primitive (generators, the ledger). That discipline
was adopted while it was still an open question whether the workbench should
be a product in its own right or only the human end of an agent-driven loop —
so the surface could shrink to the review floor without stranding bespoke
machinery. That question is settled, and the discipline stands: the workbench
renders and reviews; it owns no machinery. It is the platform's stated thesis
(§1: "review is a first-class activity, not just generation") rendered
visible. The one the design
corespec-style conversational scoping.

## What needs you

Above every pane, and the only thing on the surface that is *ordered*.

`attentionReport` (`packages/mcp/src/attention.ts`) answers "what should I look at
first?" as data: one list, worst first, every item naming what it is, why it
outranks the next one, and where to go. The ranking is not a display preference —
it encodes which mistakes are unrecoverable:

| Rank | Category | Why it is there |
| --- | --- | --- |
| 1 | **public exposure that would change** | the only damage done the instant it lands; data that reached the internet has reached it |
| 2 | **removals** | a dropped column is dropped data |
| 3 | **proposals that cannot be batched** | the ones a reviewer would otherwise clear without reading |
| 4 | **latent exposure** | declared-but-not-live public surfaces — one op from rank 1, with no review in between |
| 5 | **drift on owned files** | the platform has moved underneath code it may not touch |
| 6 | **everything else** | routine proposals, available upgrades |

Three rules it holds to:

- **Nothing here is a count.** "17 pending" is a number, not attention; nobody can
  act on a badge. The report names specific rows, and the count sits underneath as
  context.
- **The routine majority is one line.** Those are the rows bulk review exists to
  make cheap; listing them individually would put them back in the way.
- **What could not be checked is on screen.** An empty report from a host that
  could not look is indistinguishable from a real all-clear, and the second is the
  dangerous mistake. `unavailable` names every unevaluated category, and the
  headline **refuses** to say "nothing needs you" when anything went unchecked.

### Blast radius — what a spec diff does not say

A reviewer deciding on `data.addField` is not deciding about a line in a JSON
document. They are deciding whether a column appears, whether a form grows an
input, whether a REST endpoint accepts a new key, and whether a value becomes
readable by the public internet. `blastRadius`
(`packages/mcp/src/blast-radius.ts`) derives the **surfaces a spec produces** and
diffs that inventory between the current spec and a hypothetical one with the
pending ops applied in memory. One line of spec becomes named consequences:

```
$ maxstack review --section blast-radius

  If you accept everything pending: adds 2; changes 2

  adds (2):
    `order.sku`            string
    `order.viewerRole`     string
  changes (2):
    the `order` table                                1 column  →  3 columns
    `/api/order` (list, create, update, delete)      total  →  sku, total, viewerRole
```

It deliberately does **not** run the generators: emitting code for two specs and
diffing it would be slower, would answer at file granularity ("routes.ts changed"),
and would make the reviewer read a diff to find the fact.

**The accepted-or-all trap.** Grounding runs over `getAcceptedOrAll`, and so does
this, because the question is "what will the runtime build" rather than "what would
a reasonable runtime build". While nothing in a collection is accepted, every
suggested row in it is *already* being built — so accepting one changes no derived
surface, and the honest answer is "no change to what gets built". `groundingNote`
says so and names the collections in that state. It is **per collection, not per
spec**: an accepted entity whose fields are all suggested has its fields in
fallback while its entity list is not. The first version checked the whole spec, so
the explanation vanished exactly when it was most needed — found by running
`maxstack review` against a real project, not by reasoning about it.

**Exposure** is built *on* `portalExposureReport`, not beside it: that function's
docblock states the rule ("two implementations of a security boundary is one more
than is safe") and it is the one pinned by the agreement test asserting a portal
response's keys equal exactly the fields it reports as readable. What the blast
radius adds is the question that report deliberately does not answer — **liveness**.
It covers every *declared* portal, paused included, because it answers "what could
be exposed"; a diff needs "what is exposed right now", so rows are filtered to
`activePortals`. That filter is what makes the transition visible: a paused portal
publishes nothing until somebody un-pauses it, and then every field it names shows
up as newly public. Everything not live is reported as **latent exposure** with its
reason, never omitted.

### Three surfaces, one ordering

| | Entry point |
| --- | --- |
| Workbench | `AttentionPane`, above every other pane |
| Terminal | `maxstack review [--section exposure\|blast-radius] [--json]` |
| Agent (MCP) | the `workbench` tool, same three sections |

The workbench is the best surface, never the only one, and that rule is
load-bearing rather than ceremonial: the exposure view — the single most
important thing a human should review — once had **no** CLI verb and **no**
MCP tool, while a route comment claimed both existed. A public-boundary report you
can only see by opening Chrome is one that does not get seen.

The ordering is computed once and rendered three times. A "most important thing"
that differs by surface is not a most important thing. That happened once,
when two hosts each computed their own answer to one question. Disk facts (drift,
upgrades, ownership) arrive through `PlatformContext.attention`, because the shared
layer has a spec and nothing else; a host wiring less gets a narrower report that
*says* it is narrower.

### Hydration is a standing hazard on this surface

A `getServerSnapshot` mismatch once shipped green here, because a client-only
`render()` never calls `getServerSnapshot` at all. Server-render tests are
therefore mandatory on this surface, and
`apps/web/app/workbench/panes.hydration.test.tsx` drives a real `renderToString`
followed by a real `hydrateRoot`.

The assertion is on **`onRecoverableError`** — not `console.error`, not the final
DOM. React 19 recovers from a mismatch by client-rendering the subtree and still
lands on correct-looking markup, so a DOM assertion passes either way, which is
precisely how this class hides. Every pane is server-rendered with no state and no
effects; on the attention pane that is a requirement rather than restraint, since a
stranded subtree in the first thing on the page is a maintainer reading a stale list
of what needs them. The tests earned their place on the first run, catching the pane
rendering literal `**` in its headline.

### Loading must never mutate

Easy to violate by accident: the public-exposure
and removal categories are computed by **applying** every pending accept to a
projection of the spec. Had that projection ever reached `spec.save`, opening the
page would settle every review in the queue — the worst bug this surface could
have, and one that would look like the feature working. The projection is
in-memory, its ops are stamped `actor.path: 'attention-hypothetical'` so a leak
would be findable by name, and two tests in `review-cost-wiring.test.ts` assert the
spec *and* the op log are untouched after a load.

### Extending it

1. **New attention category** → add it to `ATTENTION_KINDS` *in severity position*;
   the rank is derived from that array, so adding one means deciding what it
   outranks. Do not append by default.
2. **New host fact** → optional on `AttentionInputs`, with a matching `unavailable`
   line. A category that can be absent has to say when it is.
3. **New derived surface** → add to `SURFACE_KINDS`, again in severity position,
   and give `deriveSurfaces` a case. If the runtime owns the naming rule, pin it
   with an agreement test rather than duplicating it quietly
   (`apps/web/app/blast-radius.agreement.test.ts`).
4. **New pane** → server-render it and add it to the hydration test. Client state
   needs a reason, not a default.

## What the rest of it does

The original three panes, all a **pure fold** of the live platform `SpecSystem` —
the same singleton the MCP tools mutate, so the workbench and an agent conversation
see one source of truth:

1. **Spec zoom (left)** — the three layers as one tree (product → data → pages →
   pricing), every row badged with its derived provenance state, with per-layer
   counts. Each top-level node is a **zoom link** (`?focus=<id>`): clicking it
   swaps the center pane to that node's detail. The altitude ladder from goals
   down to fields — and, for a page, down to the emitted code.
2. **Review queue / detail (center)** — with no focus, the **review queue**:
   every *undecided* AI suggestion across the data / page / pricing layers
   (high-priority first), each row with Accept / Reject. This is the
   suggest→accept queue the provenance flags (`isSuggested` / `isAccepted`)
   already carry. Accept makes a suggestion grounding truth; reject is a
   **soft-reject** (`isAccepted = false`), never a delete. With a node focused,
   the pane shows its **detail**: an entity's fields + the pages derived from it
   (the spec→UI link); a page's blocks, the entity it renders, its acceptance
   criteria (`e2eTests`), and a **live preview** of the page the ownership
   `page` generator emits for it — the emitted modules evaluated through the
   real `<Slot>` runtime (`workbench/preview.server.ts`), not just their
   source.
3. **Decisions + activity (right)** — the append-only decision ledger split into
   open and resolved. Open decisions are an **alternatives browser**: the
   options with their pros/cons, a radio to pick one (recommended pre-selected),
   a rationale box, and Resolve — which appends a `resolved` entry via the
   settled `resolveDecision` ledger primitive (append-only; the pending entry is
   never rewritten). Below it, the **interaction-telemetry feed**: a running
   count by kind and the newest-first activity stream.

## Shape (so a later phase can extend or delete it cleanly)

- `app/workbench/view-model.ts` — **pure, unit-tested.** `buildWorkbench(spec)`
  → `{ queue, tree, decisions, counts }`. `applyReviewAction(spec, ref, action)`
  transitions one provenanced row immutably (via the settled `accept`/`reject`
  transitions in `@maxstack/spec`, **not** a new spec-op — provenance decisions
  are distinct from structural spec-ops). Locates nested rows by
  `{kind, id, parentId}` and throws on a stale ref.
- `app/workbench/workbench.server.ts` — the seam to the platform context:
  `loadWorkbench(focusId)` (view + detail + live preview via the `page`
  generator), `submitReview` (`load → applyReviewAction → save`), `submitResolve`
  (`resolveDecision` on the ledger). Each read/write appends a telemetry event.
- `app/workbench/telemetry.ts` + `telemetry.server.ts` — the append-only
  interaction-event log (§5 "events flowing"). Pure JSONL serialize/parse +
  summarize (mirrors the harness metrics DB shape); the server host appends to
  `<data-dir>/telemetry.jsonl` when the app has a data dir (the dev default),
  falling back to an in-memory `globalThis` log under unit tests.
- `app/workbench/drift.server.ts` + `drift-pane.tsx` — the **Ownership pane**: what the maintainer owns, what it was derived from, and how far
  it has drifted, over the same `ownershipDrift()` fold `maxstack drift` and the
  `ownership_drift` MCP tool render. Read from the project's own app directory
  rather than the running bundle's owned-code manifest — the opposite of the
  slots pane, deliberately: "does this fill render?" is a question only the
  bundle can answer, and "how far has the file on disk fallen behind?" is a
  question only the file can. The loader's `Fs` throws on `write`, so
  "informational, never applied" is structural.
- `app/routes/workbench.tsx` — loader + `action` + the three-pane render. Plain
  `<Form method="post">` per row/decision, no client JS beyond React Router's.

## Decision recorded here (not re-litigating a settled one)

Accept/reject is modeled as a **provenance transition**, not a structural
spec-op. The structural op vocabulary is deliberately additive (§3-L1);
accepting a suggestion changes its provenance, not the spec's structure. The
provenance module ships `accept`/`reject` for exactly this. The system-level
`provenance.review` op is a thin, validated wrapper that applies the *same
settled transition* and records it in the spec's op log (`change: 'review'`,
origin `human` from the workbench, `ai` when an agent drives it via MCP) — it
exists so the decision *trail* (who accepted what, when) is as durable and
diffable as every other mutation. Reject remains a soft-reject, never a
delete.
