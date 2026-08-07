/**
 * `<ResourceList>` — the display dual of `<DynamicForm>`: infer a table's
 * columns from Sprout introspection and render rows through the semantic field
 * library, with zero hand-written column JSX (Plan v5 task 31).
 *
 * What it infers from `ColumnMetadata`:
 *   - `hidden` columns are skipped; the primary key is skipped by default
 *     (an override can force it back).
 *   - `sortable` columns get clickable, toggling sort headers. Sorting is
 *     client-side by default; pass `onSort` (+ `sort`) to drive the server's
 *     `table` ordering op instead.
 *   - each cell renders via `<Field>`, so dates/emails/enums/etc. present
 *     correctly without per-column code.
 *
 * The eject seam: any cell is overridable through the `columns` prop
 * (`columns={{ author: MyCell }}`) — and because that prop takes a plain
 * component, a user-owned slot file can supply it, keeping the infer-then-eject
 * workflow intact.
 *
 * Data is a prop (`rows`) — this component is pure presentation. The typed
 * data-access hooks that fetch/paginate/mutate are task 33; `<ResourceList>`
 * will consume them internally there without changing this public surface.
 */

import {
	type ComponentType,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	humanizeLabel,
	type IntrospectedColumn,
} from '../fields/field-semantics.ts'
import { Field } from '../fields/fields.tsx'
import { FileProvider, type FileResolution } from '../fields/file-context.tsx'
import {
	ReferenceProvider,
	type ReferenceResolution,
} from '../fields/reference-context.tsx'
import { cn } from '../lib/cn.ts'
import type { RowSlotProps } from '../slots/block-slots.ts'
import { addTheFirst, EmptyState } from './EmptyState.tsx'
import { EditableCell } from './edit-in-place.tsx'
import {
	type CellRenderer,
	type ColumnOverrides,
	type IntrospectedResource,
	normalizeOverride,
	type ResourceCapabilities,
	type Row,
} from './resource-types.ts'

export type SortDir = 'asc' | 'desc'
export interface SortState {
	field: string
	dir: SortDir
}

/** Context handed to `bulkActions` — the current selection + a way to clear it
 * after an action runs. */
export interface BulkActionContext {
	selectedIds: string[]
	selectedRows: Row[]
	clear: () => void
	/** The session's capabilities (as passed to `can`), so a bulk toolbar can
	 * gate its own actions — e.g. only render Delete when `can.delete`. */
	can: ResourceCapabilities
}

/** No restrictions — the default when a route supplies no `can`. */
const ALL_ALLOWED: ResourceCapabilities = {
	read: true,
	create: true,
	update: true,
	delete: true,
}

export interface ResourceListProps {
	resource: IntrospectedResource
	rows: Row[]
	/** Batch-resolved FK display values (core's `resolveReferences`) — makes
	 * reference columns render the referenced record's title, not its id. */
	references?: ReferenceResolution
	/** Loader-resolved signed URLs for this page's file columns, keyed by storage
	 * key. A file column stores a key; only the server can sign it. */
	files?: FileResolution
	/** Per-column cell/label overrides — the eject seam. */
	columns?: ColumnOverrides
	/**
	 * Bespoke row body — the block-level `<resource>__row` slot.
	 * The table keeps its ordering, selection, pagination, empty state and row
	 * links; the row's cells become one full-width region the user owns, so the
	 * column headers (which no longer describe what is rendered) are suppressed.
	 * A component rather than a render function so a slot can hold state.
	 */
	renderRow?: ComponentType<RowSlotProps>
	/** Render the primary-key column too (skipped by default). */
	showPrimaryKey?: boolean
	/** Loading state → skeleton rows instead of data. */
	loading?: boolean
	/** Rows to show in the skeleton (default 5). */
	skeletonRows?: number
	/** Shown when there are no rows and not loading. */
	emptyState?: ReactNode
	/** A per-row detail/edit link. */
	rowHref?: (row: Row) => string
	/** Label for the row link column (default "Edit"). */
	rowActionLabel?: string
	/**
	 * Per-row controls rendered in a trailing cell — buttons, a `<form>`, a
	 * confirm/undo pair, anything that acts on *this* row.
	 *
	 * `bulkActions` is not a substitute: it acts on a selection, so an action
	 * whose meaning is per-row (accept *this* suggestion and its children;
	 * approve *this* one thing) has nowhere to go. Before this existed the
	 * workbench rendered its tables and then a *detached* list of right-aligned
	 * buttons underneath, positionally lined up with the rows — which is to say,
	 * not lined up with anything at all once a row wrapped or a filter changed
	 * the count. The action belongs in the row, in the DOM, next to the thing it
	 * acts on.
	 */
	rowActions?: (row: Row) => ReactNode
	/** The RR `<Link>` (or `<a>`) component for row links; defaults to `<a>`. */
	linkComponent?: LinkLike
	// --- sorting (controlled; omit for client-side default) ---
	sort?: SortState
	onSort?: (next: SortState) => void
	// --- edit-in-place ---
	/** Column names whose cells edit inline (click → type-appropriate editor).
	 * Needs `onCellSave`; suppressed when `can.update` is false. A `columns`
	 * render override on the same column wins. */
	editable?: string[]
	/** Persist one cell's change — typically task 33's `useUpdate` in one line:
	 * `(row, name, v) => update(String(row.id), { [name]: v })` (which already
	 * gives optimistic lists, rollback, and toasts). */
	onCellSave?: (
		row: Row,
		column: string,
		value: unknown,
	) => void | Promise<void>
	// --- pagination (controlled; omit + set pageSize for client-side default) ---
	pageSize?: number
	page?: number
	total?: number
	onPageChange?: (page: number) => void
	// --- infinite scroll (replaces the pager; wire to `useInfiniteList`) ---
	/** Load the next page — renders a "Load more" footer plus an auto-load
	 * sentinel (IntersectionObserver) instead of page controls. */
	onLoadMore?: () => void
	hasMore?: boolean
	/** Disables the footer + sentinel while the next page is in flight. */
	isFetchingMore?: boolean
	// --- selection + bulk actions ---
	/** Add a leading checkbox column with a select-all header. */
	selectable?: boolean
	/** Controlled selection (primary-key strings); omit for internal state. */
	selectedIds?: string[]
	onSelectedChange?: (ids: string[]) => void
	/** Toolbar rendered above the table while a selection exists. */
	bulkActions?: (ctx: BulkActionContext) => ReactNode
	/**
	 * Primary keys created by the demo seeder. Those rows get a
	 * `demo` chip in their first visible cell, so sample data is never mistaken
	 * for the user's own — the gating requirement of the one-command start, and
	 * the reason a seeded row can be told apart at all: it carries no marker
	 * column, by design, so the id set has to come from outside.
	 * Omit (or pass empty) and nothing renders.
	 */
	demoIds?: readonly string[]
	/** The session's per-action capabilities. When `update` and `delete` are both
	 * denied there's nothing to select, so the selection column is suppressed; the
	 * flags are also handed to `bulkActions` so a toolbar can strip its own
	 * actions. Omit for an unrestricted list. */
	can?: ResourceCapabilities
	className?: string
}

/**
 * A router's link component, structurally. Exported because an *ejected* route
 * module has to render its own "+ New" link and cannot import the host router
 * (it compiles inside the vendored runtime but is written to be independent of
 * it) — so the runtime hands one down as {@link OwnedRouteProps.Link}.
 */
export type LinkLike = (props: {
	to: string
	children: ReactNode
	className?: string
}) => ReactNode

const DefaultLink: LinkLike = ({ to, children, className }) => (
	<a href={to} className={className}>
		{children}
	</a>
)

interface ResolvedColumn {
	column: IntrospectedColumn
	label: string
	render?: CellRenderer
	sortable: boolean
}

function resolveColumns(
	resource: IntrospectedResource,
	overrides: ColumnOverrides,
	showPrimaryKey: boolean,
): ResolvedColumn[] {
	const out: ResolvedColumn[] = []
	for (const column of resource.columns) {
		const override = normalizeOverride(overrides[column.name])
		const isPk = column.name === resource.primaryKey
		// hidden: explicit override wins, else metadata, else the PK default.
		const hidden =
			override.hidden ??
			(column.meta?.hidden === true || (isPk && !showPrimaryKey))
		if (hidden) continue
		out.push({
			column,
			label: override.label ?? column.meta?.label ?? humanizeLabel(column.name),
			render: override.render,
			sortable: column.meta?.sortable === true,
		})
	}
	return out
}

function compareValues(a: unknown, b: unknown): number {
	if (a === b) return 0
	if (a === null || a === undefined) return -1
	if (b === null || b === undefined) return 1
	if (typeof a === 'number' && typeof b === 'number') return a - b
	if (typeof a === 'boolean' && typeof b === 'boolean')
		return a === b ? 0 : a ? 1 : -1
	return String(a).localeCompare(String(b))
}

/**
 * The sample-data marker. Text, not just a color: "obviously
 * seeded" has to survive a monochrome screenshot and a color-blind reader, and
 * the `title` says what to do about it.
 */
function DemoChip() {
	return (
		<span
			title="Sample data loaded by `maxstack demo` — remove it with `maxstack demo --clear`"
			className="mr-2 inline-flex items-center rounded border border-warning/50 bg-warning/10 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-warning"
		>
			demo
		</span>
	)
}

const HEADER_CLASS =
	'border-b border-border px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground'

export function ResourceList({
	resource,
	rows,
	references,
	files,
	columns = {},
	renderRow: RenderRow,
	showPrimaryKey = false,
	loading = false,
	skeletonRows = 5,
	emptyState,
	rowHref,
	rowActionLabel = 'Edit',
	rowActions,
	linkComponent,
	sort,
	onSort,
	editable,
	onCellSave,
	pageSize,
	page,
	total,
	onPageChange,
	onLoadMore,
	hasMore = false,
	isFetchingMore = false,
	selectable = false,
	selectedIds,
	onSelectedChange,
	bulkActions,
	demoIds,
	can,
	className,
}: ResourceListProps) {
	const Link = linkComponent ?? DefaultLink
	const caps = can ?? ALL_ALLOWED
	// Selection exists to drive bulk actions; with neither update nor delete
	// permitted there's nothing a selection could do, so drop the column entirely.
	const canSelect = selectable && (caps.update || caps.delete)
	// Edit-in-place: only meaningful with a save handler and update permission.
	const editableSet = useMemo(
		() => new Set(caps.update && onCellSave ? (editable ?? []) : []),
		[caps.update, onCellSave, editable],
	)
	const cols = useMemo(
		() => resolveColumns(resource, columns, showPrimaryKey),
		[resource, columns, showPrimaryKey],
	)
	const demoSet = useMemo(() => new Set(demoIds ?? []), [demoIds])

	// Sorting: controlled via `sort`/`onSort`, else internal client-side state.
	const [localSort, setLocalSort] = useState<SortState | null>(null)
	const activeSort = sort ?? localSort
	const controlledSort = onSort != null
	function toggleSort(field: string) {
		const nextDir: SortDir =
			activeSort?.field === field && activeSort.dir === 'asc' ? 'desc' : 'asc'
		const next = { field, dir: nextDir }
		if (controlledSort) onSort(next)
		else setLocalSort(next)
	}

	// Pagination: controlled via `page`/`total`/`onPageChange`, else internal.
	const [localPage, setLocalPage] = useState(0)
	const controlledPage = onPageChange != null
	const currentPage = page ?? localPage

	const displayRows = useMemo(() => {
		let out = rows
		// Client-side sort only when uncontrolled (a controlled parent already
		// returns sorted rows from the server).
		if (!controlledSort && activeSort) {
			const { field, dir } = activeSort
			out = [...out].sort((ra, rb) => {
				const c = compareValues(ra[field], rb[field])
				return dir === 'asc' ? c : -c
			})
		}
		if (!controlledPage && pageSize) {
			const start = currentPage * pageSize
			out = out.slice(start, start + pageSize)
		}
		return out
	}, [rows, controlledSort, activeSort, controlledPage, pageSize, currentPage])

	const totalCount = total ?? rows.length
	const totalPages = pageSize
		? Math.max(1, Math.ceil(totalCount / pageSize))
		: 1
	function goto(p: number) {
		const clamped = Math.min(Math.max(p, 0), totalPages - 1)
		if (controlledPage) onPageChange(clamped)
		else setLocalPage(clamped)
	}

	// Selection: controlled via `selectedIds`/`onSelectedChange`, else internal.
	// Keyed by primary-key string; select-all toggles the currently visible page.
	const rowId = (row: Row) => String(row[resource.primaryKey])
	const [localSelected, setLocalSelected] = useState<string[]>([])
	const controlledSelected = onSelectedChange != null
	const selected = selectedIds ?? localSelected
	const selectedSet = useMemo(() => new Set(selected), [selected])
	function setSelected(ids: string[]) {
		if (controlledSelected) onSelectedChange(ids)
		else setLocalSelected(ids)
	}
	function toggleRow(id: string) {
		setSelected(
			selectedSet.has(id)
				? selected.filter((x) => x !== id)
				: [...selected, id],
		)
	}
	const pageIds = displayRows.map(rowId)
	const allSelected =
		pageIds.length > 0 && pageIds.every((id) => selectedSet.has(id))
	function toggleAll() {
		const onPage = new Set(pageIds)
		if (allSelected) setSelected(selected.filter((id) => !onPage.has(id)))
		else setSelected([...new Set([...selected, ...pageIds])])
	}
	const pk = resource.primaryKey
	const selectedRows = useMemo(
		() => rows.filter((r) => selectedSet.has(String(r[pk]))),
		[rows, selectedSet, pk],
	)
	function clearSelection() {
		setSelected([])
	}

	if (!loading && rows.length === 0) {
		return (
			<div className={className}>
				{emptyState ?? (
					<EmptyState
						title="No records yet"
						description={addTheFirst(resource)}
					/>
				)}
			</div>
		)
	}

	return (
		<ReferenceProvider value={references ?? {}}>
			<FileProvider value={files ?? {}}>
				<div className={className}>
					{canSelect && bulkActions && selected.length > 0 ? (
						<div
							className="mb-3 flex items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
							role="toolbar"
							aria-label="Bulk actions"
						>
							<span className="font-medium">{selected.length} selected</span>
							<div className="flex items-center gap-2">
								{bulkActions({
									selectedIds: selected,
									selectedRows,
									clear: clearSelection,
									can: caps,
								})}
							</div>
							<button
								type="button"
								onClick={clearSelection}
								className="ml-auto text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
							>
								Clear selection
							</button>
						</div>
					) : null}
					<div className="overflow-x-auto rounded-lg border border-border">
						<table className="w-full border-collapse">
							{/* A bespoke row owns the whole row region, so per-column
							    headers would label cells that no longer exist. */}
							<thead hidden={RenderRow !== undefined}>
								<tr className="bg-muted/50">
									{canSelect ? (
										<th className={cn(HEADER_CLASS, 'w-10')}>
											<input
												type="checkbox"
												aria-label="Select all"
												checked={allSelected}
												onChange={toggleAll}
											/>
										</th>
									) : null}
									{cols.map((c) => {
										const sorted = activeSort?.field === c.column.name
										const arrow = sorted
											? activeSort?.dir === 'asc'
												? ' ↑'
												: ' ↓'
											: ''
										return (
											<th key={c.column.name} className={HEADER_CLASS}>
												{c.sortable ? (
													<button
														type="button"
														onClick={() => toggleSort(c.column.name)}
														className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground"
													>
														{c.label}
														<span aria-hidden>{arrow}</span>
													</button>
												) : (
													c.label
												)}
											</th>
										)
									})}
									{rowHref ? <th className="border-b border-border" /> : null}
									{rowActions ? (
										<th className={cn(HEADER_CLASS, 'text-right')}>Actions</th>
									) : null}
								</tr>
							</thead>
							<tbody>
								{loading
									? Array.from({ length: skeletonRows }).map((_, i) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows are positional and static
											<tr key={i} aria-hidden data-testid="skeleton-row">
												{canSelect ? (
													<td className="border-b border-border/50 px-3 py-2" />
												) : null}
												{cols.map((c) => (
													<td
														key={c.column.name}
														className="border-b border-border/50 px-3 py-2"
													>
														<span className="block h-4 w-24 animate-pulse rounded bg-muted" />
													</td>
												))}
												{rowHref ? (
													<td className="border-b border-border/50" />
												) : null}
												{rowActions ? (
													<td className="border-b border-border/50" />
												) : null}
											</tr>
										))
									: displayRows.map((row) => {
											const id = String(row[resource.primaryKey])
											if (RenderRow) {
												return (
													<tr key={id} className="hover:bg-muted/30">
														{canSelect ? (
															<td className="border-b border-border/50 px-3 py-2 align-top">
																<input
																	type="checkbox"
																	aria-label={`Select row ${id}`}
																	checked={selectedSet.has(id)}
																	onChange={() => toggleRow(id)}
																/>
															</td>
														) : null}
														<td
															colSpan={
																cols.length +
																(rowHref ? 1 : 0) +
																(rowActions ? 1 : 0)
															}
															className="border-b border-border/50 px-3 py-2"
														>
															<RenderRow
																resource={resource}
																columns={cols.map((c) => c.column)}
																row={row}
																href={rowHref ? rowHref(row) : ''}
																isDemo={demoSet.has(id)}
															/>
														</td>
													</tr>
												)
											}
											return (
												<tr key={id} className="hover:bg-muted/30">
													{canSelect ? (
														<td className="border-b border-border/50 px-3 py-2">
															<input
																type="checkbox"
																aria-label={`Select row ${id}`}
																checked={selectedSet.has(id)}
																onChange={() => toggleRow(id)}
															/>
														</td>
													) : null}
													{cols.map((c, colIndex) => {
														const value = row[c.column.name]
														return (
															<td
																key={c.column.name}
																className="border-b border-border/50 px-3 py-2 text-sm"
															>
																{/* The chip rides the first visible cell rather
															    than its own column: a whole extra column
															    would shift every list's layout for a state
															    most projects are never in. */}
																{colIndex === 0 && demoSet.has(id) ? (
																	<DemoChip />
																) : null}
																{c.render ? (
																	c.render({ value, row, column: c.column })
																) : editableSet.has(c.column.name) ? (
																	<EditableCell
																		value={value}
																		column={c.column}
																		onSave={(next) =>
																			// biome-ignore lint/style/noNonNullAssertion: editableSet is empty without onCellSave
																			onCellSave!(row, c.column.name, next)
																		}
																	/>
																) : (
																	<Field value={value} column={c.column} />
																)}
															</td>
														)
													})}
													{rowHref ? (
														<td className="border-b border-border/50 px-3 py-2 text-right">
															<Link
																to={rowHref(row)}
																className="text-sm font-medium underline-offset-4 hover:underline"
															>
																{rowActionLabel}
															</Link>
														</td>
													) : null}
													{rowActions ? (
														<td className="border-b border-border/50 px-3 py-2 text-right align-middle whitespace-nowrap">
															<div className="inline-flex items-center justify-end gap-1.5">
																{rowActions(row)}
															</div>
														</td>
													) : null}
												</tr>
											)
										})}
							</tbody>
						</table>
					</div>

					{onLoadMore ? (
						<div className="mt-3 flex flex-col items-center gap-1">
							{hasMore ? (
								<>
									<button
										type="button"
										onClick={onLoadMore}
										disabled={isFetchingMore}
										className={cn(
											'rounded-md border border-border px-3 py-1 text-sm',
											isFetchingMore && 'opacity-50',
										)}
									>
										{isFetchingMore ? 'Loading…' : 'Load more'}
									</button>
									<LoadMoreSentinel
										enabled={!isFetchingMore}
										onVisible={onLoadMore}
									/>
								</>
							) : (
								<span className="text-sm text-muted-foreground">
									{rows.length} of {totalCount} loaded
								</span>
							)}
						</div>
					) : pageSize && totalPages > 1 ? (
						<nav
							className="mt-3 flex items-center justify-between text-sm"
							aria-label="Pagination"
						>
							<button
								type="button"
								disabled={currentPage <= 0}
								onClick={() => goto(currentPage - 1)}
								className={cn(
									'rounded-md border border-border px-3 py-1',
									currentPage <= 0 && 'opacity-50',
								)}
							>
								← Prev
							</button>
							<span className="text-muted-foreground">
								Page {currentPage + 1} of {totalPages}
							</span>
							<button
								type="button"
								disabled={currentPage >= totalPages - 1}
								onClick={() => goto(currentPage + 1)}
								className={cn(
									'rounded-md border border-border px-3 py-1',
									currentPage >= totalPages - 1 && 'opacity-50',
								)}
							>
								Next →
							</button>
						</nav>
					) : null}
				</div>
			</FileProvider>
		</ReferenceProvider>
	)
}

/** The auto-load half of infinite scroll: an invisible marker after the Load
 * more button that fires `onVisible` when scrolled into view. Falls back to
 * button-only where `IntersectionObserver` doesn't exist (jsdom, old SSR
 * shims). The callback rides a ref so re-renders don't re-observe. */
function LoadMoreSentinel({
	enabled,
	onVisible,
}: {
	enabled: boolean
	onVisible: () => void
}) {
	const ref = useRef<HTMLDivElement>(null)
	const onVisibleRef = useRef(onVisible)
	onVisibleRef.current = onVisible
	useEffect(() => {
		const el = ref.current
		if (!enabled || !el || typeof IntersectionObserver === 'undefined') return
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) onVisibleRef.current()
		})
		observer.observe(el)
		return () => observer.disconnect()
	}, [enabled])
	return <div ref={ref} data-testid="load-more-sentinel" aria-hidden />
}
