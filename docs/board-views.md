# Board views — Kanban columns, manual order and WIP limits


"Can it do a Kanban board" is a question buyers ask out loud, and it sounds like
a feature. It is three things the spec already knows how to say:

- **the columns** are an enum field's declared options,
- **the order within a column** is a manual-ordering key,
- **a drag** is an update of that enum field.

Two ops declare it, and they live in different layers on purpose:

| Op | Layer | What it declares |
| --- | --- | --- |
| `page.addBoard` | page | the board: which column groups the cards, which key orders them, whether they move |
| `data.setFieldLimits` | data | per-value row caps — the WIP limit |

```jsonc
// The board: status is the column set, boardRank is the order within one.
{ "op": "page.addBoard",
  "args": { "pageId": "pg-issues", "blockId": "blk-issues-board",
    "board": { "groupField": "status", "rankField": "boardRank",
               "titleField": "title", "cardFields": ["priority"],
               "move": true } } }

// The limit: three in progress, three in review. Note it names the FIELD.
{ "op": "data.setFieldLimits",
  "args": { "entityId": "e-issue", "fieldId": "fld-issue-status",
            "limits": { "in-progress": 3, "in-review": 3 } } }
```

A board **replaces** the page's list rather than sitting beside it, like the
date-arranged views (`date-views.md`): the block says "these rows, arranged like
this", and rendering both is two answers to one question.

Everything the board names is checked when the op lands, not when the page
renders: the fields exist on the page's backing entity, the grouping field really
is an `enum` **with declared options**, the rank field really is a rank key, and
a card field is not the rank key wearing a hat.

## The columns are declared, never inferred

`page.addBoard` refuses a grouping field with no `options`. The alternative —
columns built from the values present in the table — fails in both directions:
the board gains a column the first time somebody typo's one, and loses "Done" on
the day the team ships everything in it. The empty column is the most important
one on a board.

## The WIP limit lives on the field, not on the board

This is the load-bearing decision in the whole feature.

A limit the *board* enforces is not a limit. The same column is written by the
REST API, by an MCP tool, by the record's own form, and by a script somebody
wrote last quarter — and none of them has ever loaded the page that draws the
number. So the cap is declared on the field and enforced in `opCreate` /
`opUpdate`, which every one of those paths goes through:

```
POST /api/issue { "status": "in-progress" }   → 422 { fieldErrors, limit: {...} }
```

The board draws `3 / 3`, marks the column full, and refuses the drop *as an
affordance* — to say why before a round trip. That refusal is decoration. The
server's is the rule.

Two consequences worth stating:

- **A cap bounds arrivals, not edits.** A write that leaves the column where it
  is — renaming a card, reordering it — is never refused, or a full column would
  become a read-only column.
- **The scope is the writer's tenant.** On an org-scoped resource the cap counts
  that org's rows; otherwise it counts the table. Anything narrower — per
  swimlane, per assignee, per sprint — is not expressible (see the line below).

## Manual order is a key, not a position

`rank: true` marks a `string` field as a manual-ordering key. It is emitted with
a **database default**, so every row has a key the moment the column exists —
including rows that predate the board. That is not a nicety: with a nullable rank
column there is an unordered region, and no single-row write can place a card
relative to rows that have no position at all.

The key is a decimal fraction written without its `0.` — `"375"` means 0.375 —
compared as a plain string. Digits only, because the comparison happens in
Postgres under whatever collation the deployment has, and `0-9` orders
identically under every one of them.

Between any two keys there is always another, so **a move is one row's write**.
That is what makes concurrent reordering safe:

- Two people dropping a card into the *same gap* compute the same key. Both
  writes land; the tie is broken by primary key, so everyone sees the same order.
  Nothing is lost and no repair migration exists to run.
- Two people dropping into *different gaps* never interact.
- There is no renumbering pass, so there is no half-renumbered state to observe.

The alternative — an integer `position` column — has the opposite properties: one
insert rewrites every row below it, and two concurrent inserts interleave those
rewrites.

## Moving a card writes nothing new

The board reports a row and a destination. `boardMoveValues` turns that into
plain values, and the values are submitted to the record's **own edit route** —
the same route, action and encoding `<DynamicForm>` posts to. So a drag runs the
identical permission check, validation, WIP-limit enforcement and audit entry as
editing the field in the form. There is no board endpoint to secure separately.

A drag can only ever write the board's own declared columns, and only ever to a
destination the spec declares — so it cannot become a way to put an arbitrary
string in the grouping column.

## Keyboard, not drag-only

Every card is a focus stop. With `move` on, the arrow keys move the focused card:
left/right to the adjacent column at the same depth, up/down one place within its
own column. Each move is announced in a live region, because the result appears
somewhere other than the focus. A column's count is visible text *and* a spoken
sentence that says "full" in words — a limit conveyed by a red border only is a
limit half the people looking at the board cannot see.

## Where the line is drawn

A board is **presentation over declared data**. Everything below is deliberately
out of scope, and each is still a live off-surface ask in the benchmark corpus:

| Not this | Why | Corpus ask |
| --- | --- | --- |
| Swimlanes, per-lane or per-cell limits | a cap is on a *value*; scoping it to another column's value is a different declaration, and a board groups by one field | `ch-swimlane-policy` |
| Columns that are rows of another entity | the options are spec so an empty column still draws; sourcing them from a table inverts which layer owns the value list | `ch-stage-automation` |
| Anything happening *because* a card moved | a move is a value change; notifications, timers and downstream records are not board business | `ch-stage-automation` |
| A refusal naming which card should move first | that needs an ordering policy over the blocked lane, and the spec expresses no policies | `ch-swimlane-policy` |

Drawing the line explicitly is the point: a board component that grows an
automation engine is how a view primitive turns into a product nobody chose to
build.

## Known limits

- **A board reads a capped 500 rows and does not page.** Grouping happens after
  the read, so a windowed query would need a per-column limit the store cannot
  express. The cap is stated on screen rather than silently truncating.
- **The WIP check is check-then-write, not a database constraint.** Two writers
  racing into the last slot can both observe `current = limit - 1` and both
  commit, leaving the column one over. Closing that window needs a serializable
  transaction around the count or a partial unique index per slot, and neither is
  expressible in the additive DDL the vocabulary emits. The failure mode is a
  column one card over its limit, which the board shows and a person can fix by
  moving a card — not corruption.
- **A board arranges the rows of the page it is on**, like the date views.
- **Drag-and-drop is HTML5 DnD**, so it is mouse-and-desktop only; the keyboard
  path is the accessible one. Touch drag is not implemented — on a phone a card
  moves through its edit form.
