/**
 * **Typed props for block-level slots**.
 *
 * A page-level `<Slot>` is called with whatever the generated page threads into
 * it. A *block* slot replaces one region of a derived surface, so it needs the
 * same field knowledge the generated renderer has — otherwise a slot author
 * re-derives labels, formats, enum members and FK display values from raw row
 * objects, and "bespoke UI" quietly means "re-implement the field library".
 * That is the difference between a slot fill (weight 3) and an eject (weight
 * 5): the platform hands over the *rendering* and keeps the *derivation*.
 *
 * Every `column` here is an {@link IntrospectedColumn}, whose `meta` is exactly
 * what `withMeta` attached in the schema — labels, formats, `options` for
 * enums, `reference` targets, `hidden`. So a bespoke exercise card can read
 * `columns.find(c => c.name === 'videoUrl')?.meta.fileAccept` instead of
 * guessing.
 *
 * These types are structural and dependency-free on purpose: the ids that name
 * them live in `@maxstack/core`'s ownership layer, the shapes live here with
 * the components that supply them, and neither imports the other.
 */

import type { ReactNode } from 'react'
import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import type { FileResolution } from '../fields/file-context.tsx'
import type { ReferenceResolution } from '../fields/reference-context.tsx'
import type {
	ListActionDescriptor,
	RunAction,
} from '../resource/ListActions.tsx'
import type { SortState } from '../resource/ResourceList.tsx'
import type {
	IntrospectedResource,
	ResourceCapabilities,
	Row,
} from '../resource/resource-types.ts'

/** What every block slot on a resource page is given, whatever its role. */
export interface BlockSlotBaseProps {
	/** The introspected resource — `columns` carry their `withMeta` metadata. */
	resource: IntrospectedResource
	/** The columns this page renders, in order, after the spec field selection. */
	columns: IntrospectedColumn[]
}

/** `<resource>__header` — the page header region. */
export interface HeaderSlotProps extends BlockSlotBaseProps {
	/** The page heading the spec declares. */
	title: string
	/** Href of the generated "new record" action, so a bespoke header keeps it. */
	newHref: string
}

/**
 * `<resource>__list` — the whole list region. The bespoke-UI escape hatch that
 * does *not* cost an eject: rows arrive loaded, ordered by the spec's `order`,
 * with FK titles and signed file URLs already resolved, and the page frame,
 * nav, header and routing keep regenerating around it.
 *
 * ## It is a controller, not a payload (#398)
 *
 * Everything below the read state is the same rule #349 settled one rung up:
 * *an owned surface is handed exactly the props the framework's own list would
 * have rendered with, not a subset.* A slot that got only rows would silently
 * cost the project every interaction the platform declares — the actions of
 * `view.addAction`, the sort the loader honoured, inline edit and inline
 * create — and "bespoke UI" would quietly mean "re-implement the write path",
 * which is the eject this seam exists to avoid.
 *
 * So the split is ra-core's, and it is exact: the platform keeps **deriving**
 * (which actions exist, what a run posts to, what a cell edit validates
 * against, which ordering the rows are actually in) and hands over only the
 * **rendering**. Every handler here goes through the same audited server route
 * the generated list, the REST client and the MCP tool use. There is no write
 * path a slot can reach that the framework does not already secure.
 */
export interface ListSlotProps extends BlockSlotBaseProps {
	rows: Row[]
	/** Batch-resolved FK display values, keyed as the field library expects. */
	references: ReferenceResolution
	/** Loader-resolved signed URLs for file columns, keyed by storage key. */
	files: FileResolution
	/** The detail/edit href for a row — keeps bespoke rows linked into CRUD. */
	rowHref: (row: Row) => string
	/** Rendered when `rows` is empty, unless the `empty` slot is filled too. */
	emptyState: ReactNode
	/**
	 * Primary keys of rows `maxstack demo` seeded. The generated variants render
	 * a chip from this; a bespoke list that ignores it un-marks sample data,
	 * which is why it is handed over rather than left behind.
	 */
	demoIds: readonly string[]
	/**
	 * The session's per-op capabilities. Render no affordance this denies: the
	 * wall is the server either way, and an editor whose every save is refused
	 * is worse than no editor.
	 */
	can: ResourceCapabilities
	// --- declared actions (#417) ---
	/**
	 * The actions this resource declares, at both arities. `BulkActionBar` and
	 * `RowActionButtons` are exported from this package for a slot that wants
	 * the stock controls; `arity`, `choose` and `maxSelection` are here for one
	 * that does not.
	 */
	actions: ListActionDescriptor[]
	/**
	 * Aim a declared action at a set of ids. Posts to the action endpoint, which
	 * re-checks permission, cap and choice — the browser never says what to
	 * write. Clears the selection, as the generated list does.
	 */
	runAction: RunAction
	/** True while a run is in flight — disable the controls that started it. */
	actionBusy: boolean
	/** The current selection, as primary-key strings. */
	selectedIds: string[]
	/** Replace the selection. State lives in the page, so a run can clear it. */
	onSelectedChange: (ids: string[]) => void
	// --- ordering ---
	/**
	 * The ordering the rows are actually in, as the loader honoured it. Sorting
	 * is server-side because the rows are one page of a table: re-sorting what
	 * arrived would reorder the page rather than the list.
	 */
	sort: SortState | undefined
	/** Ask for a different ordering. Writes the URL the loader reads back. */
	onSort: (next: SortState) => void
	// --- inline write paths ---
	/** Field names `page.setBlockEditable` allows editing in place. */
	editable: string[]
	/**
	 * Save one cell, through the record's own edit route — the same action
	 * `<DynamicForm>` submits to, so a cell edit has no write path of its own.
	 */
	onCellSave: (row: Row, name: string, value: unknown) => void
	/** Field names `page.setBlockCreatable` allows filling on a new row. */
	creatable: string[]
	/**
	 * Add a row, through the page's existing create route (#444). Resolves once
	 * the server has replied, so a refused draft can stay on screen.
	 */
	onRowCreate: (draft: Record<string, unknown>) => Promise<void> | void
}

/** `<resource>__row` — one row/card/entry inside the generated list. */
export interface RowSlotProps extends BlockSlotBaseProps {
	row: Row
	/** The row's detail/edit href. */
	href: string
	/** True when this row came from `maxstack demo`. */
	isDemo: boolean
}

/** `<resource>__field__<name>` — one field's cell, everywhere it renders. */
export interface FieldSlotProps {
	/** The cell value, as it came out of the store. */
	value: unknown
	/** The whole row, for a cell that needs a sibling field. */
	row: Row
	/** This field's column, including its `withMeta` metadata. */
	column: IntrospectedColumn
}

/** `<resource>__empty` — the empty state for a resource with no rows. */
export interface EmptySlotProps extends BlockSlotBaseProps {
	/** Href of the "new record" action. */
	newHref: string
	/** True when a bundle has sample rows this project could seed. */
	demoAvailable: boolean
}
