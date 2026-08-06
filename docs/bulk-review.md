# Bulk review

> Companion to [write-paths.md](write-paths.md) — who may settle a review.

A bulk accept is the most dangerous control in this product. Everything else the
platform offers makes *doing* something cheaper; this one makes **not looking**
cheaper. So the design question is not "how do we add checkboxes" but "how do we
make the safe majority cheap without making the dangerous minority sweepable".

## The shape of the answer

**Risk defaults to `high`, and every rule can only lower it.** A proposal is
unbatchable until something recognises it as routine. This is the opposite of the
natural implementation — a list of dangerous patterns, everything else fine — and
the reason is coverage: a heuristic that has to recognise danger fails open on
every case nobody thought of, and L1/L2 will keep adding cases.

Consequences of that choice, all deliberate:

- Only five artifact kinds are understood at all (`entity`, `field`, `page`,
  `block`, `tier`). Flags, schedules and sources are excluded *by omission*, not
  by a rule — a flag gates what users can see and a schedule runs code on a
  clock, and neither is something to accept twenty of.
- A sixth kind added to the spec is unbatchable the day it lands, with no code
  change and no gate to remember.

**Access-control-shaped names are refused by name.** Sixteen fragments (`role`,
`permission`, `scope`, `admin`, `owner`, `public`, `visib`, `password`, `secret`,
`token`, `apikey`, `api_key`, `auth`, `acl`, `grant`, `privile`) make a field
high-risk regardless of context. Enumerated in the test rather than sampled,
because this heuristic runs in the conservative direction and its coverage is
what decides whether an authz change can ride into a batch.

**Portal exposure re-classifies everything under it.** The same `data.addField`
is routine on an internal entity and a disclosure decision on one a portal
already publishes. Risk is contextual, so the classifier reads the spec,
not just the target.

### Ownership: the trap that is worth reading

Ownership facts (`RiskContext`) only ever **raise** risk — owning a generated
surface is what makes a change to it unbatchable, because the platform will not
update your file for you and accepting it in a batch diverges your file from the
spec silently.

That asymmetry means **an empty context is the most permissive input available,
not the safest one.** A host whose manifest read just threw and returned `{}`
would be *unlocking* batches on exactly the projects it knew least about. So:

```ts
interface RiskContext {
  ownedEntityIds?: readonly string[]
  ownedPageIds?: readonly string[]
  ownershipKnown?: boolean   // did you actually READ the manifest?
}
```

Without `ownershipKnown`, the model assumes everything is owned and batches
nothing, saying so in the finding. A host that genuinely read the manifest and
found nothing owned makes that claim explicitly, by passing `true` with empty
lists. Only `riskContextFromOwnership` sets the flag, and only after the read
succeeded.

This was a real bug, caught by a test, after three files had already been
commented with the wrong direction. If you are extending `RiskContext`, the
question to ask about any new field is *"does absence of this make the queue
narrower or wider?"* — and if wider, it needs the same treatment.

## One model, three surfaces

The classification lives in `packages/spec/src/base/bulk-review.ts` and every
surface calls it:

| Surface | Entry point | Can settle? |
| --- | --- | --- |
| Workbench | `BulkReviewPane` → `web-bulk-review` | yes |
| Terminal | `maxstack review --accept <selector>` | yes |
| Agent (MCP) | `review_queue` | **no** |

`review_queue` is read-only on purpose. An agent settling its own proposals is
not review, it is a rubber stamp with a protocol in front of it — so the tool
reports what is waiting and how cheaply it could be cleared, names the surfaces
that *do* decide (in the payload, not just the description), and stops there.

Three surfaces sharing the model is not a nicety. The first version had only the
web host reading the ownership manifest, and the two surfaces then gave different
answers about the same five proposals. A risk model that says yes on one surface
and no on another is not a risk model — a reviewer just uses whichever one says
yes. `riskContextFromOwnership()` exists so that cannot happen again.

## What the surfaces refuse to offer

- **No select-all, anywhere.** A control that grows silently as an agent proposes
  more is a rubber stamp with extra steps. The CLI refuses `all` and `*` by name
  rather than guessing.
- **No `--force`, no confirm-through.** The model refuses a high-risk proposal a
  place in a batch; a flag that overrode that would make the classification
  decorative.
- **No checkbox at all** for an unbatchable member — not a disabled one. A
  present-but-refused affordance teaches people to look for the way round it, and
  a `<label>` wrapping no control announces a form field that does not exist.
- **Needs-attention above the batchable groups**, never filtered out. These are
  the proposals a reviewer would otherwise not notice they were skipping.
- **`N of M` selectable, never a binary.** One access-control field among twenty
  routine ones must not turn its neighbours back into twenty individual
  decisions — that is precisely the case bulk review exists for. Hence
  `batchableCount` alongside the per-member `batchable`.

## Refusal, not omission

`planBulkReview` **refuses** rather than skips: anything the model will not batch
comes back in `plan.refused` with the reason, and both surfaces print it. A batch
that quietly did less than you asked is worse than one that says what it left
behind, because the reviewer's mental model of "the queue is clear" is what makes
the next batch dangerous.

The combined effect is stated **before** the action and in the button's own
label ("Accept 12 fields on e-order"), because the confirmation people actually
read is the one written on the thing they are about to press.

## The cascade answers to the same rules

The workbench's per-row Accept has a `cascade` option that settles a parent and
its children together. That **is** a bulk accept, so it is classified like one:
if the subtree holds anything unbatchable, the cascade is refused with a 409
naming what it would have settled, and the individual decision stays available.

Found by driving the real surface: clicking a queue row's Accept settled three
proposals including an access-control field, while the bulk pane two sections
below refused that same field by name. A risk signal the adjacent button ignores
is worse than no signal — it manufactures false confidence, because the reviewer
has been shown a surface that appears to be protecting them.

## Undo

Every op in a batch carries the batch id as its `actor.session`, so the
batch is reconstructible from the op log alone — there is no second ledger to
keep in step. `planBulkUndo` derives the reversal from the trail and:

- resets only rows **that batch** settled, leaving anything re-decided since
  alone (it takes back the batch's decisions, not whatever the state is now);
- records the reversal as ops of its own rather than mutating quietly;
- is offered only while nothing downstream has consumed the decisions — once
  `maxstack gen` has run, resetting the spec would leave generated artifacts that
  neither the spec nor the tree describes. (The web host currently hardcodes that
  precondition.)

## Extending this

1. New artifact kind → it is unbatchable until you add it to `UNDERSTOOD_KINDS`
   *and* give it a classification rule. Do those together or not at all.
2. New `RiskContext` field → ask whether absence widens the queue. If it does,
   gate it behind a "did we actually read this" flag as above.
3. New surface → call `pendingProposals`/`classifyReviewRisk` with a real
   context. Passing nothing type-checks and is wrong — that bug shipped here once.
4. New way to settle a review → it is a write path, so it needs a registry entry
   with a written `acceptRationale`. See [write-paths.md](write-paths.md).

## Known gaps

- `riskContextFromOwnership` maps only `family: 'page'`; owned
  schedule/source/import/live slots do not raise risk yet.
- The web host's undo offer can outlive its precondition.
