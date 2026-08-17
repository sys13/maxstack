# Block-level slots — bespoke UI without ejecting

> [`ownership.md`](ownership.md). The ladder this sits on:
> [user-guide §5](user-guide.md#5-making-a-change).

Some things should stay hand-written. An animated exercise demo with form cues,
a flashcard study player with a flip animation and keyboard grading, a
home-screen widget — a platform that generated those would be a cage, and the
maintainers who want them would be fighting it within a week.

The platform's job is not to absorb them. It is to make them **cost less**.

Before block slots, wanting one custom card meant `maxstack eject <resource>`:
whole-file ownership of the route, permanently, including every derivation you
*did* want — the resolved foreign keys, the field metadata, the ordering, the
empty state, the create link. You paid a surface to change a region.

A block slot is that region, on its own.

## What a block slot is

Every page that renders a resource exposes a fixed set of **slot-bearing block
roles**. A slot is filled the moment the resource's user-owned
`routes/<resource>.slots.tsx` exports a function under the derived id. There is
nothing to declare in the spec, and nothing regenerates over your file.

| Role | Id | You receive | You take over |
|---|---|---|---|
| `header` | `<resource>__header` | `HeaderSlotProps` | The page header (title + primary action) |
| `list` | `<resource>__list` | `ListSlotProps` | The whole list region |
| `row` | `<resource>__row` | `RowSlotProps` | One row / card / entry inside the list |
| `field` | `<resource>__field__<name>` | `FieldSlotProps` | One field's cell, everywhere it renders |
| `empty` | `<resource>__empty` | `EmptySlotProps` | The empty state |

The list is **declared and versioned** — `BLOCK_SLOT_ROLES` /
`BLOCK_SLOT_ROLES_VERSION` in
`packages/maxstack-core/src/ownership/block-slots.ts`. "Every block is a slot"
would be a permanently-stable API surface the size of the renderer, so the set
is deliberately the roles the runtime actually renders today. Board cards,
calendar entries, detail panels and form sections join it — with a version bump
— when those blocks exist.

## Finding them

Three surfaces, one derivation (`slotInventory()`), so a human and an agent
cannot be told different things:

```
$ maxstack slots
Slots — bespoke UI without ejecting (block roles v2)
Ids are escaped to legal JS identifiers: - → _d, _ → _u, any other illegal
character → _z (so reading-item gives reading_ditem__header). The escape is
reversible rather than a fold, so two differently-spelled resources can never
collide on one id — this is correct, do not rename a resource to avoid it.

Exercises  /app/exercises
  ○ exerciseActions
  ○ exercise__header          (HeaderSlotProps)
  ○ exercise__list            (ListSlotProps)
  ● exercise__row             (RowSlotProps)
  ○ exercise__field__name     (FieldSlotProps)
  ○ exercise__empty           (EmptySlotProps)

1 of 6 filled (● filled · ○ available)
```

- **CLI** — `maxstack slots` (add `--json` for the machine-readable inventory).
- **MCP** — `query_spec {section: "slots"}`. Availability only: the MCP context
  has a spec store, not a filesystem, so `filled` is *absent* rather than
  `false`.
- **Workbench** — the Slots pane, whose fill state comes from the running app's
  own owned-code manifest, so it cannot disagree with what actually renders.

All three carry the same note about how an id is spelled, because a slot id is
an *exported function name*: `-` → `_d`, `_` → `_u`, any other illegal
character → `_z`, so the resource `reading-item` gives `reading_ditem__header`.
That is an escape, not a fold, and the reversibility is the point — folding `-`
to `_` would let `read-item` and `read_item` derive the same id, and two
resources sharing one slot export is a public API that silently means different
things in different projects. An escaped id is correct; do not rename a
resource to get a prettier one.

## Filling one

```
$ maxstack slots fill exercise__row
✔ created routes/exercise.slots.tsx
  exercise__row(props: RowSlotProps) — it is yours; edit freely.
  Regeneration will never overwrite this file.
```

Or just write the export yourself; the id is the whole contract.

Block slots are **available, not scaffolded** — the generator never writes a
stub for one. Seeding every role on every resource would fill each project's
slot file with placeholders nobody asked for, so the file stays as small as
what you actually own.

The props are the point. `props.columns` carries the same `withMeta` metadata
the generated renderer reads — labels, formats, enum options, reference
targets, hidden flags — so a bespoke card reads the field library's knowledge
rather than re-deriving it:

```tsx
import type { RowSlotProps } from '@maxstack/ui'

export function exercise__row({ row, columns, href, isDemo }: RowSlotProps) {
	const cue = columns.find((c) => c.name === 'formCue')
	return (
		<article>
			<video src={String(row.demoUrl)} autoPlay loop muted />
			<h3>{String(row.name)}</h3>
			<p>{cue?.meta?.label}: {String(row.formCue)}</p>
		</article>
	)
}
```

Everything around it keeps regenerating: the route, the nav entry, the loader,
the ordering the spec declares, the links into create/edit, the empty state, the
sample-data marking.

## The `list` slot is a controller, not a payload

Replacing the whole list region is the biggest thing you can do without
ejecting, and it is the one place where a read-only prop bag would quietly cost
you the platform. So `ListSlotProps` hands over everything the generated list
is rendered with:

| You are given | So that |
|---|---|
| `rows`, `references`, `files`, `columns` | FKs are resolved and files are signed — neither is derivable in the browser |
| `actions`, `runAction`, `actionBusy` | A declared action (`view.addAction`) still runs, through the same audited endpoint REST and MCP use |
| `selectedIds`, `onSelectedChange` | A selection can drive a bulk run, and a run can clear it |
| `sort`, `onSort` | The ordering the loader honoured, and a way to ask for another. Sorting is server-side: your rows are one page of a table |
| `editable`, `onCellSave` | A cell saves through the record's own edit route |
| `creatable`, `onRowCreate` | A row is added through the page's own create route |
| `can` | You render no affordance the session is denied |
| `demoIds`, `rowHref`, `emptyState` | Sample rows stay marked, rows stay linked into CRUD, the empty state stays derived |

The split is the point: the platform keeps deciding *what may be written and by
whom*, and you decide only what it looks like. There is no write path a slot can
reach that the framework does not already secure — `runAction` posts the ids and
nothing else, and `onCellSave` and `onRowCreate` go to the routes the generated
forms submit to. `BulkActionBar` and `RowActionButtons` are exported from
`@maxstack/ui` if you want the stock controls back in your own layout.

```tsx
import { type ListSlotProps, RowActionButtons } from '@maxstack/ui'

export function exercise__list(props: ListSlotProps) {
	return (
		<ol className="exercise-reel">
			{props.rows.map((row) => (
				<li key={String(row.id)}>
					<video src={String(row.demoUrl)} autoPlay loop muted />
					<a href={props.rowHref(row)}>{String(row.name)}</a>
					<RowActionButtons
						actions={props.actions}
						rowId={String(row.id)}
						onRun={props.runAction}
						busy={props.actionBusy}
					/>
				</li>
			))}
		</ol>
	)
}
```

This was v2 of the role vocabulary. A `list` fill written against v1 keeps
working and simply ignores the new props — `maxstack drift` says which version
yours was authored against, which is how you find out there is more on offer.

## Slot ids are a public API

Once you have written into `exercise__row`, renaming it is a breaking change.
So the id derives from **stable spec identity** — resource, role, and (for
`field`) the field name — and never from generation order, block array index,
or block id. Reordering a page's blocks, installing a bundle, renaming a route,
or adding a field all leave every existing id exactly where it was.

Kebab-case resources are encoded rather than folded (`reading-item` →
`reading_ditem`), because folding `-` to `_` would let `read-item` and
`read_item` produce the same id — one exported function silently meaning two
different things in two different projects.

## The gate: no orphaned slots

The page-level invariant is "no dangling slot **references**": a generated
`render={slots.X}` with no export behind it. That breaks loudly.

Block slots make the mirror image possible, and it is worse because it is
silent: an **implementation with no host block**. Drop a field from a page's
selection and the `field` slot that renders it simply stops being called. The
app still works. Your bespoke UI is just gone.

So it fails the gate:

```
✖ validate failed:
  - orphaned slot "exercise__field__formCue" in routes/exercise.slots.tsx:
    no block or declared slot on the exercise page offers "exercise__field__formCue"
    any more. Restore the field/page it renders, or delete the export
    (run `maxstack slots` to see what is available).
```

`maxstack validate` checks it per project; the harness counts it per benchmark
(`orphanedBlockSlots`, alongside `danglingSlotRefs`) and gates the nightly on
zero. Only block-slot-shaped exports are gated — a slot file is your module and
may export helpers and sub-components too.

## Eject is still there

This lowers the cost of *not* ejecting. It does not remove the escape hatch:
`maxstack eject <resource>` still takes whole-file ownership of a route, and an
ejected route still short-circuits the generic page entirely. Some changes
really do want the whole file.
