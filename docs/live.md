# Live — declared subscriptions and bounded presence

Everything this platform derives is a **snapshot**. A live channel is the
declared exception: **rows pushed on change so a derived list, board or calendar
updates without a refresh, and a bounded report of who is looking at a record.**

Five ops:
`live.declare`, `live.setFields`, `live.setLimits`, `live.pause`, `live.remove`.

```
live.declare {
  subscription: {
    id: 'lv-task-board', key: 'task-board', entityId: 'e-task',
    description: 'Push task changes to whoever has the board open.',
    kind: 'query',
    fields: ['fld-task-title', 'fld-task-status', 'fld-task-owner'],
    scope: { kind: 'all' },
    maxSubscribers: 60, maxMessagesPerMinute: 120,
    slot: true, paused: false,
  }
}
```

That is `/api/live/task-board`: three columns of every task, pushed to at most
sixty connections at at most two a second each, with a user-owned file at
`live/task-board.live.tsx` for the bespoke board and a promise never to overwrite
it.

## The scope line

**We push changes and we report presence. That is the whole of it.**

Out of scope, and out as a **recorded decision** (`d-live-last-write-wins`, an
entry in the decision ledger of MAXSTACK's own spec — which, like the rest of
the self-hosting apparatus, lives in the maintainer's own repository rather than
here) rather than as an assumption somebody later "fixes":

- **Conflict resolution beyond last-write-wins.**
- **Cursor-level co-editing** — a per-pointer, per-frame ephemeral channel.
- **Intention-preserving concurrent edits** — that is OT or a CRDT.
- **Per-keystroke typing indicators** — the same ephemeral channel with a
  friendlier name.
- **Offline replication and convergent merge** — a subscriber that reconnects
  re-reads; it does not replay a divergent local log.

Real-time collaborative editing is a multi-year product whose replication model
reaches into every write path, every conflict, every offline resume and every
schema migration. That work names scope discipline as the entire risk of the
work, and it is right.

**The exclusion is structural, not documentary.** There is nowhere to put a
payload:

- `kind` is `query | presence` and there is no third. In particular no `event`
  and no `custom` kind that would let a caller push a message it composed —
  every message exists because a **row changed**, which is exactly what makes it
  authorizable as a read of that row. A caller-composed payload has no row to
  check and would need an access model of its own, and two access models is one
  more than is safe.
- A presence entry is `{ identity, since }`. A presence channel that declares any
  fields at all, or any scope wider than one row, is refused at validate time.

## Why SSE and not a WebSocket

The transport had to work in the existing single-container deploy or the change
had to be recorded. **It works, unchanged.**

| | SSE | WebSocket |
|---|---|---|
| Server | the HTTP server that already exists | a second server object |
| `react-router-serve` | a long-lived `GET` loader | no `upgrade` hook — replace the server entry |
| `docker run -p 3000:3000` | unchanged | needs the upgrade through whatever fronts it |
| Fly `[http_service]` | unchanged | upgrade must survive the proxy |
| Reconnection | `EventSource` + `Last-Event-ID`, free | a loop you write |
| Direction | server → client only | both |

The cost is real: SSE is one-directional, so a presence heartbeat is a separate
small `POST /api/live/:key?row=<id>` rather than a frame on the same socket. That
is acceptable for a primitive that never needed a client→server stream.

`X-Accel-Buffering: no` is on the response for the one proxy behaviour that
actually bites: without it an nginx-shaped proxy buffers the whole stream and it
arrives at the end, which looks exactly like the feature not working.

## Fan-out across instances

The subscriber table is still per process, and always will be: a subscriber is an
open socket held by *this* process, and no other process can write to it. What
used to be per process as well was the **announcement** — a write handled by
instance A reached nobody connected to instance B — and that is what moved.

`publishLiveChange` hands the change to a `Coordinator`, every instance hears it,
and each fans out over its own subscribers. Which coordinator you get is decided
by the store backend and nothing else — no flag, because a flag is a way for a
multi-instance deployment to run un-coordinated by accident, which is the state
this issue was filed about:

| Backend | Coordinator | What a live subscriber sees |
|---|---|---|
| Postgres | `LISTEN`/`NOTIFY` on `maxstack_coordination` | writes handled by **any** instance |
| pglite | in-process loop-back | writes handled by this instance — the only one that can exist |

pglite's in-process coordinator is the correct implementation, not a fallback:
pglite is embedded and single-writer, and the store puts an `O_EXCL` lock on the
data dir so a second process cannot open it. There is no second instance to
coordinate with.

Only an **id** crosses the wire, never a row. The receiving instance re-reads
through `opList` once per subscriber, which is the whole per-message
authorization design — a row on the wire would be a row read under the
publisher's identity and handed to whoever the receiver happens to be serving.

### The bound that remains: a `NOTIFY` is not replayed

An instance whose listener connection drops misses whatever was announced while
it was down. postgres.js reconnects and re-issues the `LISTEN`, and the
coordinator logs a warning saying there was a gap, but nothing replays the
missed announcements — so a subscriber on that instance is stale until its next
poll. **This is why every live surface keeps its polling fallback**, and it is
the line at which a real broker with an offset would start being worth its
deployment cost.

### What is proven, and where

The shared path is exercised only when `MAXSTACK_TEST_POSTGRES_URL` points at a
throwaway database — two connections is the entire subject, and pglite cannot
have two. CI's `validate` job runs a Postgres service container so that is the
default rather than an opt-in; a local `pnpm validate` without the variable has
**not** tested this path, only the shape around it.

## Per-message RBAC

A connection outlives the answer a connect-time gate gave. Somebody is removed
from a project, has a role changed, or has an api-key scope narrowed — and a
connect-time gate keeps pushing to them until they close the tab.

So `LiveChannel.publish` re-runs the gate for **every subscriber on every
change**, in two steps that answer two different questions:

| Step | Question | Failure |
|---|---|---|
| 1 | May this identity read this resource at all? (`canPerformAction`, row-less — the check `opList` makes) | **Disconnected** with `permission-revoked` |
| 2 | May this identity see *this row*, right now? (`liveRead` → `opList`) | A `remove` message; the connection stays open |

Step 1 disconnects rather than skipping, because leaving a revoked identity
holding an open socket that happens to receive nothing is a permission decision
that depends on nobody changing a row. Step 2 does not disconnect, because a row
somebody may not see is not a fact about their session.

A row that **becomes** visible is pushed — a card assigned to you appears. That
is asserted directly rather than left to be discovered.

Everything else is inherited rather than reimplemented, because step 2 goes
through `opList`: the resource's own rule, the api-key narrowing, the portal
narrowing and projection, the tenant filter, the soft-delete filter. A
soft-deleted row pushes a `remove`, never a row.

**The projection intersects.** A message carries the declared `fields` plus the
primary key. Under a portal identity `projectForPortal` has already dropped
everything outside the portal's allowlist, and `projectForLive` copies only keys
that survived — so the **narrower of the two declarations always wins**, without
either layer knowing about the other. A portal identity may subscribe only if its
portal grants `read` on that resource, which step 1 enforces through
`portalGrants`.

One consequence is worth stating rather than discovering: **a resource whose read
rule is the `owner` shortcut cannot carry a `query` channel.** A row-less `owner`
rule reads as denied — already how `opList` and `opSearch` behave — and a live
query channel is a list that moves. The subscriber is disconnected on the first
message instead of holding a socket that never delivers. Inventing "quietly push
the caller's own rows" would make the push path the one read surface with its own
access model.

## Backpressure: shed, never buffer

A subscriber over its declared `maxMessagesPerMinute` is **disconnected with a
reason**.

- An unbounded buffer is how one slow client takes the process down.
- A bounded buffer that silently drops leaves a subscriber whose view is wrong
  with nothing telling it so.
- Disconnect is the only honest option: the client reconnects and re-reads, which
  is a correct view rather than a stale one.

The window slides. A fixed bucket would let a subscriber spend a whole minute's
budget in the last second of one window and again in the first second of the
next — two minutes of fan-out in two seconds, which is the burst the ceiling
exists to stop.

A connection past `maxSubscribers` is **refused** with `channel-full`, not
queued: a queue for connections is a slower way to run out of file descriptors.

Both ceilings are **required and never defaulted**, on the argument
`SearchIndexSpec.indexed` and `ImporterSpec.maxRows` already make: how much load
a declaration puts on somebody's deployment is a decision about *their*
deployment.

`scope: 'all'` is allowed but capped at **100 subscribers**, and the number is
arguable so here is the argument. An unfiltered channel costs
`writes × subscribers` with no term that shrinks. A hundred is *the size of a
team, not the size of a customer base*: an internal ops dashboard, a support
console, an on-call board — the honest `all` cases, all bounded by headcount.
Anything customer-facing is bounded by signups, which is unbounded, and needs
`filtered`.

`live.setLimits` exists as its own op because "we are sending too much" and "we
are sending the wrong thing" are different problems found by different people.
Its diff prints the **product** of the two numbers, because neither factor alone
is what the process has to serialize and send, and a reviewer who has to multiply
is a reviewer who will not.

## The polling fallback

**A subscriber that cannot hold a stream open falls back to polling the ordinary
list endpoint — and it is the same op.**

`pollLive` and the push path both go through `liveRead`, which is the *only*
function in `sprout/live.ts` that reaches a row, and it calls `opList`. Same
gate, same bound, same projection. The two views cannot disagree, structurally
rather than by convention — which matters because the fallback engages when the
stream is broken, i.e. exactly when nobody is watching.

The client (`apps/web/app/use-live-rows.ts`) switches to polling on any **stated
close**: `paused`, `channel-full`, `rate-exceeded`, `scope-required`.
Reconnecting there would be the worst possible response — a shed client
re-establishing the connection it was just told to stop making.
`permission-revoked` is the exception: it stops entirely, because polling would
fail the identical check.

This is what makes `live.pause` safe to run at 3am. A paused channel makes the
app **slower, not broken**.

## What is generated, and what is not

Most channels emit **nothing at all**. A derived list, board, calendar or
timeline over an entity with a `query` channel simply updates, and the
declaration is the whole implementation. That is the honest half of the win, and
it is worth saying plainly rather than quietly, because the temptation is to emit
a component per channel so the generator looks busy.

`slot: true` says the surface is genuinely bespoke — a drag-and-drop board, a
threaded reader — and opens the seam:

| File | Owner | Rewritten? |
|---|---|---|
| `live/live.generated.ts` | framework | every regeneration |
| `live/<key>.live.tsx` | **you** | never |

The slot receives rows **already loaded, gated and projected**, plus the presence
list. It has no store, no registry, no user and no channel object, so there is
nothing it could read that the gate did not allow and nothing it could push that
the projection did not narrow. That is the importer layer's argument about a parser, and the source layer's
about a refiner, one step further out: the bespoke code never reaches the read
path at all.

### Where a bespoke surface composes into a page

A **page-level swap** — not a new block role, and not a
dedicated route. Which page depends on the channel's kind, because the two kinds
are bounded to different things:

| kind | host | what it is handed |
|---|---|---|
| `query` | the resource's **list page**, replacing the list region outright | the same live rows every other surface sees; `present: []`, because presence is bounded to one row and a list is not a row |
| `presence` | the resource's **record page** | the one row the channel follows, plus the current room from a heartbeat loop |

A filled query slot wins the region ahead of the declared view *and* the generic
variants: `slot: true` is the most specific statement a project can make about
how that region renders. A channel that is declared but not yet generated renders
nothing, and the page falls through to the surface it would otherwise have shown
— a missing bespoke component degrades to the generic one, never to a blank page.

The props are generated **per channel**, and the registry erases the component's
type, so nothing type-checks the join between the two. `withRowIds` normalizes
the resource's primary key into the `id: string` the stub promises (a resource
whose key is not called `id` would otherwise make that declaration a lie), and
`apps/web/app/live.agreement.test.ts` asserts the emitted `LiveProps` and the
host's `LiveSurfaceProps` still name the same four props.

**Generation never opens a connection, reads a clock, or reads a random source.**
A channel with a thousand subscribers, one that is paused, and one that has never
been opened all emit identical files —
`apps/maxstack/src/lib/live-determinism.test.ts` generates with the network
removed and asserts it, including that no timestamp and no connection id appears
anywhere in the tree. Either would turn every regeneration into a diff to review.

## Cardinality: one `query` and one `presence` per entity

`search.declare`'s argument, and it is the same one. Every write to the table
pays for every channel over it, so two answers to "what does following this table
mean" are two costs on every insert, forever, with nothing to say which one a
surface should read.

A portal and a document may be several per entity because they are **audiences**,
and an audience is chosen by the reader. A subscription's cost is chosen by
nobody.

## MCP

The `live.*` spec ops are available like every other op. **There is no streaming
tool**, and that is a consequence rather than a gap: a subscription's whole
guarantee is that every message is re-authorized for the identity still on the
other end, and over a request/response protocol there is no other end. An MCP
"subscribe" would be a poll wearing a stream's name, and the honest spelling of a
poll is `list_records` — which already exists, already goes through `opList`, and
already carries every scope a live message would.

## The corpus

Two frozen asks reclassified, both **split rather than claimed whole**
(invoicer's "view and pay" set the precedent):

| Ask | Absorbed | Returned at full weight |
|---|---|---|
| taskly `ch-realtime-board` — "a real-time collaborative board with presence cursors" | the pushing, the presence, the bespoke slot | `ch-offline-board-merge` — offline divergence + convergent merge + the per-pointer cursor channel |
| bookclub `ch-threaded-discussion` — "a threaded, live-typing discussion thread" | the threading, the pushing, the presence, the bespoke slot | `ch-post-coediting` — intention-preserving concurrent editing of one value + per-keystroke indication |

Both replacements are `unexpressible` **because of the decision record above**,
which is the strongest possible reason for it to be a record rather than an
assumption. Both keep `cluster: 'realtime'`: those two asks were the cluster's
only carriers, so a replacement anywhere else would have narrowed the corpus no
matter how hard it was.

`expressibility@baseline` is **unmoved at 0.71**. A slot fill is not a spec op,
and calling one one would claim work the platform did not do — a drag-and-drop
board and a threaded reader are genuinely bespoke and should stay that way. What
moved is each benchmark's own weight for that change, 8 → 3.
`MOAT_GAP_BAR.minUnexpressible` ratchets 18 → 20; residual difficulty returns to
exactly 231, so that floor is untouched.

## Reference

- Spec layer: `packages/spec/src/base/live.ts`
- Runtime: `packages/maxstack-core/src/sprout/live.ts`
- Generated seam: `packages/maxstack-core/src/ownership/live.ts`
- Transport: `apps/web/app/routes/api.live.$key.tsx`, `apps/web/app/live.server.ts`
- Client: `apps/web/app/use-live-rows.ts`
- Ops: [`spec-ops.md`](spec-ops.md) (generated)


## A query channel over an `owner`-read resource is refused

Declaring `kind: 'query'` over a resource whose `read` access is the `owner`
shortcut is refused when the channel is opened, with the reason and the
alternative.

It used to open, accept subscribers, and disconnect every one of them on the
first message. That behaviour was *correct* — a row-less `owner` rule evaluates
to denied, exactly as `opList` and `opSearch` do, and step 1 of the per-message
gate asks precisely that row-less question. Pushing "quietly, just the caller's
own rows" would make the push path the one read surface with its own access
model, which is the permission layer's finding
restated.

What was wrong was *when you found out*. Every other refusal in this layer names
its reason at declaration time; this one refused at runtime by closing sockets,
against the obvious mental model ("live over an owner-scoped table pushes me my
own rows").

If that is what you meant, declare the bound instead of relying on the read rule:

```ts
scope: { kind: 'filtered', fieldId: '<the owner column>' }
```

which is a channel the per-message gate can actually satisfy. If you meant a
shared feed, the resource needs a read rule a row-less check can pass.

The check lives in `@maxstack/core` (`liveDeclarationRefusal`) rather than in
`@maxstack/spec`, because it is not a spec fact: the read rule is on the
registry's `ResourceConfig`, which the spec layer cannot see — the same reason
there is no spec-layer tenancy check. `@maxstack/core` is the first layer holding
both halves.
