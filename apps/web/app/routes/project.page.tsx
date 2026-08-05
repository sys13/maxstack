/**
 * The generic project list page (task 21) — mounted at `:page`, resolved to a
 * spec page at request time by `resolveProjectResource`. Backed by the same
 * Sprout `listHandler` the admin uses (the spec→Sprout bridge), so a generated
 * app's pages list real rows and link into working create/edit flows.
 */

import type { SproutColumn } from '@maxstack/core'
// The narrow subpath, not the `ownership` barrel: the barrel re-exports the
// code generators, which import ts-morph — a TypeScript compiler. Since issue
// #251 the whole project surface is one route module, so every client chunk
// that reaches this file reaches whatever it imports, and in dev (no
// tree-shaking) that meant serving ts-morph to the browser.
import {
	type BlockSlotRole,
	blockSlotId,
} from '@maxstack/core/ownership/block-slots'
import type { BoardDrop } from '@maxstack/ui'
import {
	Alert,
	addDays,
	addTheFirst,
	BoardView,
	CalendarView,
	CardGrid,
	type ColumnOverrides,
	dayKeyOf,
	daysInMonth,
	type EmptySlotProps,
	EmptyState,
	FeedList,
	type FieldSlotProps,
	type HeaderSlotProps,
	heatmapGrid,
	isDayKey,
	type ListSlotProps,
	monthGrid,
	monthStart,
	ResourceList,
	type RowSlotProps,
	Slot,
	TimelineView,
	weekGrid,
} from '@maxstack/ui'
import type { ComponentType } from 'react'
import { Form, Link, useFetcher } from 'react-router'
import { boardMoveValues } from '~/board-move'
import { inlineEditValues } from '~/inline-edit'
import { hasLiveSurface, LiveSurface, withRowIds } from '~/live-surface'
import { OWNED_ROUTES, OWNED_SLOTS } from '~/owned.generated'
import { pageNoun } from '~/page-noun'
import { pagePath } from '~/page-path'
import { ProjectFrame } from '~/project-nav'
import type { ProjectRoute } from '~/project-routes'
import { ROW_EDIT_ENCTYPE, rescheduleValues, rowEditRoute } from '~/reschedule'
import { useLiveRows } from '~/use-live-rows'

/**
 * Columns worth showing: skip the primary key and hidden fields, cap at 6.
 *
 * A spec-declared field selection (`page.setBlockFields`) wins
 * outright: exactly those columns, in the order given, uncapped — the point of
 * the op is to say "show these", so neither the 6-column cap nor the source
 * column order may quietly reorder or drop one. Names that no longer exist on
 * the resource are skipped rather than fatal, so a spec/DB skew renders a
 * thinner list instead of a 500.
 */
export function tableColumns(
	resource: { primaryKey: string; columns: SproutColumn[] },
	fields?: string[] | null,
): SproutColumn[] {
	const visible = resource.columns.filter(
		(c) => c.name !== resource.primaryKey && c.meta.hidden !== true,
	)
	if (fields && fields.length > 0)
		return fields
			.map((name) => visible.find((c) => c.name === name))
			.filter((c) => c !== undefined)
	return visible.slice(0, 6)
}

/**
 * How wide a timeline's axis is, in days.
 *
 * A timeline has no natural period the way a month grid does — a Gantt chart is
 * not "a month" — so the window is chosen here rather than declared, and a
 * quarter is the choice: long enough that a project plan is legible in one
 * screen, short enough that the query is a window rather than the whole table.
 * Paging steps by exactly this, so moving forward and back returns to where it
 * started.
 */
export const TIMELINE_WINDOW_DAYS = 91

/** The axis a timeline draws, given where the viewer has paged to. Exported
 * because the loader queries it and the component draws it, and the two must be
 * the same window — a chart whose axis and query disagree shows a bar-shaped
 * hole at one edge. */
export function timelineWindow(anchor: string): { from: string; to: string } {
	const from = monthStart(anchor)
	return { from, to: addDays(from, TIMELINE_WINDOW_DAYS - 1) }
}

/**
 * How many rows a view reads, and which window of them.
 *
 * **Every date-arranged view is windowed**. It used to be only the
 * single-day calendar: anything with a declared end column — a multi-day entry,
 * every timeline bar — read a capped 500 rows ordered by its start column and
 * said so on screen when it hit the cap.
 *
 * The reason was real. An entry that *starts* before the window and *ends*
 * inside it falls out of a range test on its start column alone, and
 * `ListOptions.range` ANDs its per-column bounds — so adding a bound on the end
 * column silently drops every row whose end is NULL, which is exactly the
 * milestone rows the views deliberately keep drawing. A calendar that silently
 * drops a row is the worst failure a calendar has, so the cap was chosen over a
 * predicate that lies.
 *
 * The predicate now exists and does not lie: `ListOptions.overlaps` tests both
 * bounds *and* the null case in one clause, treating a row with no end as a
 * point at its start. So a ranged view asks for exactly the days it draws, and
 * paging is another query rather than a bigger one.
 *
 * The cap stays as the second bound, and the truncation notice with it: a window
 * bounds *how far* a view reads, not *how many* rows are in it, and a thousand
 * overlapping bars in one quarter is still a thousand rows. A truncated chart
 * looks exactly like a complete one, so it still says so.
 */
export function viewListOptions(
	view: NonNullable<ProjectRoute['view']>,
	anchor: string,
): {
	limit: number
	orderBy?: string
	orderDir?: 'asc'
	range?: Record<string, { gte?: string; lte?: string }>
	overlaps?: {
		startColumn: string
		endColumn: string
		from: string
		to: string
	}
} {
	// A board is ordered by its rank key, not by a date — and when it declares
	// none, by nothing at all: the page's own list order is what a board with no
	// manual ordering shows.
	if (view.kind === 'board') {
		return {
			limit: viewLimit(view),
			...(view.rankField
				? { orderBy: view.rankField, orderDir: 'asc' as const }
				: {}),
		}
	}
	const field = view.kind === 'calendar' ? view.dateField : view.startField
	const base = {
		limit: viewLimit(view),
		orderBy: field,
		orderDir: 'asc' as const,
	}
	// A timeline's window is its axis — see `timelineWindow`. The two are the
	// same function call so the query and the drawing cannot disagree.
	if (view.kind === 'timeline') {
		const { from, to } = timelineWindow(anchor)
		return {
			...base,
			overlaps: {
				startColumn: view.startField,
				endColumn: view.endField,
				from,
				// Inclusive of the whole last day, on the calendar's reasoning below.
				to: addDays(to, 1),
			},
		}
	}
	const days =
		view.display === 'week'
			? weekGrid(anchor)
			: view.display === 'heatmap'
				? heatmapGrid(anchor)
				: monthGrid(anchor)
	const first = days[0] as string
	// Inclusive of the whole last day: the bound is the start of the day after,
	// so a 23:30 entry on the final day is inside the window.
	const last = addDays(days.at(-1) as string, 1)
	// A calendar with a declared end column spans days, so it needs the overlap
	// predicate; one without is a point per row, and a plain range says that
	// exactly. Two shapes rather than one because a point is not a degenerate
	// span here: the end column does not exist to test.
	if (view.endField)
		return {
			...base,
			overlaps: {
				startColumn: field,
				endColumn: view.endField,
				from: first,
				to: last,
			},
		}
	return { ...base, range: { [field]: { gte: first, lte: last } } }
}

/**
 * The row cap a view reads under.
 *
 * Since issue #219 every *date* view is windowed, so its cap stopped meaning
 * "how far back this reads" and now means only "how many rows may one window
 * hold" — one number for all of them, at what these charts can still draw
 * legibly. It used to be two, and the lower one was the honest admission that a
 * ranged view read an arbitrary slice of the whole table.
 *
 * A board is left where it was. It has no time axis and therefore no window, so
 * its cap is still the only bound on what it reads, and raising it would be a
 * load change with nothing in this issue behind it.
 */
export function viewLimit(view: NonNullable<ProjectRoute['view']>): number {
	return view.kind === 'board' ? 500 : 1000
}

/**
 * The day the grid is centred on: `?on=YYYY-MM-DD` when the viewer has paged,
 * else today **in the view's declared timezone**. Not the server's zone, and not
 * the browser's — the same rule the rest of the view follows.
 */
export function anchorDay(
	request: Request,
	view: ProjectRoute['view'],
): string {
	const asked = new URL(request.url).searchParams.get('on')
	if (asked && isDayKey(asked)) return asked
	// A board has no timezone because it has no days; UTC is a placeholder for a
	// value it never reads.
	const timezone = view && view.kind !== 'board' ? view.timezone : 'UTC'
	return dayKeyOf(new Date(), timezone) ?? '1970-01-01'
}

/** RR `<Link>` adapted to the ui `linkComponent` contract. */
const link = ({
	to,
	children,
	className,
}: {
	to: string
	children: React.ReactNode
	className?: string
}) => (
	<Link to={to} className={className}>
		{children}
	</Link>
)

import type { loader } from './project.page.server'

export default function ProjectListPage({
	loaderData,
}: {
	loaderData: Awaited<ReturnType<typeof loader>>
}) {
	const {
		page,
		nav,
		title,
		theme,
		primaryKey,
		columns,
		rows: loadedRows,
		references,
		files,
		demoAvailable,
		demoIds,
		demoRows,
		anchor,
		truncated,
		liveKey,
		liveSlot,
		can,
		editable,
	} = loaderData
	// Declared live queries updating derived surfaces. The loader's
	// rows stay the source of truth — the hook re-seeds from them on every
	// navigation and revalidation — and pushed changes are merged on top. With no
	// declared channel this opens no connection and returns them unchanged, so
	// every surface below is written against one `rows` either way and none of
	// them knows whether the page is live.
	const live = useLiveRows(loadedRows, primaryKey, liveKey)
	const rows = live.rows
	// Declared *and* filled. `liveSlot` is the declaration; `hasLiveSurface` is
	// whether this build carries the component `maxstack gen` wrote the stub for.
	// Both are required, and they are separate facts: a channel can be declared
	// in a spec whose project has not been regenerated yet.
	const liveSurface = hasLiveSurface(liveSlot?.key) ? liveSlot : undefined
	// The reschedule fetcher. It posts to the record's own edit
	// route, in the record's own encoding — the same action `<DynamicForm>`
	// submits to — so a drag has no write path of its own to secure.
	const move = useFetcher()
	// The inline-edit fetcher. Its own fetcher rather than the
	// move one above: they never appear on the same page (a view replaces the
	// list), and sharing one would make that coincidence load-bearing. It posts
	// to the record's own edit route, in the record's own encoding — the same
	// action `<DynamicForm>` submits to — so a cell edit has no write path of
	// its own to secure.
	const cellEdit = useFetcher()

	// Bar 2: if the project ejected this page's route, its owned module fully
	// replaces the generic list — the ejected TSX executes in the deployed app.
	const OwnedRoute = page.resource ? OWNED_ROUTES[page.resource] : undefined
	if (OwnedRoute) {
		return (
			<ProjectFrame pages={nav} title={title} theme={theme} demoRows={demoRows}>
				<OwnedRoute />
			</ProjectFrame>
		)
	}

	const ownedSlots = page.resource ? OWNED_SLOTS[page.resource] : undefined

	/**
	 * Block-level slots. Nothing here is declared in the spec: the
	 * id is derived from the resource and the block role, and a slot is filled
	 * the moment the resource's user-owned slot file exports that name. So one
	 * bespoke region costs a slot fill instead of ejecting the whole surface —
	 * every region *not* filled keeps regenerating right beside it.
	 */
	function blockSlot<P>(
		role: BlockSlotRole,
		field?: string,
	): ComponentType<P> | undefined {
		if (!page.resource) return undefined
		const id = blockSlotId({ resource: page.resource, role, field })
		return ownedSlots?.[id] as ComponentType<P> | undefined
	}
	const HeaderSlot = blockSlot<HeaderSlotProps>('header')
	const ListSlot = blockSlot<ListSlotProps>('list')
	const RowSlot = blockSlot<RowSlotProps>('row')
	const EmptySlot = blockSlot<EmptySlotProps>('empty')
	// A field slot replaces one cell wherever the list renders it — threaded
	// through the `columns` override seam the list components already expose,
	// so it composes with the table, card and feed variants identically.
	const fieldSlots: ColumnOverrides = {}
	for (const column of columns) {
		const Cell = blockSlot<FieldSlotProps>('field', column.name)
		if (Cell) fieldSlots[column.name] = (ctx) => <Cell {...ctx} />
	}

	const newHref = pagePath(page.slug, 'new')
	// A `mode: "replace"` slot renders *instead of* the default list, so "make
	// this page look different" is a spec change rather than an eject.
	// Note the gate is "the slot module exports this name", which a freshly
	// scaffolded stub already satisfies — so the table goes away as soon as the
	// block is generated, not when real content lands. The stub therefore
	// renders a visible placeholder rather than null (see `emit.ts`), so that
	// window is self-explanatory instead of a blank page.
	const listReplaced = Boolean(
		page.replacesList && ownedSlots?.[page.replacesList],
	)
	// `name` is the identifier every structural consumer keys on; `label` is the
	// entity's declared display name, the noun for one row. Both
	// travel together so a component that renders copy never has to invent one
	// from whatever name is nearest.
	const resourceShape = {
		name: page.resource ?? '',
		label: page.resourceLabel ?? undefined,
		primaryKey,
		columns,
	}
	/** What to call one row here — the entity, never the page. */
	const noun = pageNoun(page)
	// Shared across all list variants (table/cards/feed): a page
	// with no rows is never a dead end. A filled `empty` block slot owns this
	// region instead — the one place a product's voice matters most and the
	// generated copy is most obviously generic.
	const emptyState = EmptySlot ? (
		<EmptySlot
			resource={resourceShape}
			columns={columns}
			newHref={newHref}
			demoAvailable={demoAvailable}
		/>
	) : (
		<EmptyState
			title="Nothing here yet"
			description={
				demoAvailable
					? `Add the first ${noun}, or load sample data to see the app in action.`
					: addTheFirst(resourceShape)
			}
			action={
				<>
					<Link
						to={pagePath(page.slug, 'new')}
						className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground no-underline shadow transition-colors hover:bg-primary/90"
					>
						{/* The ENTITY, not the page. Two pages can back one
						entity — a book app whose `/` is "Shelf" and `/reading-list`
						is "Reading list" would otherwise offer two differently
						labelled buttons that create the same thing, and neither
						noun is the one being created. This is the first string
						every generated app shows, so it names what the click
						makes. An entity-less page has no resource and creates
						nothing; `resourceNoun` falls back to the same generic
						word the description above already uses. */}
						+ Add the first {noun}
					</Link>
					{demoAvailable ? (
						<Form method="post" action="/onboarding/seed">
							<input
								type="hidden"
								name="redirectTo"
								value={pagePath(page.slug)}
							/>
							<button
								type="submit"
								className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium transition-colors hover:bg-accent"
							>
								Load demo data
							</button>
						</Form>
					) : null}
				</>
			}
		/>
	)
	// The block's spec-declared presentation (page.setBlockVariant): the same
	// introspection + rows feed whichever component the variant names, so a
	// redesign is a spec op, not an eject.
	const rowHref = (row: Record<string, unknown>) =>
		pagePath(page.slug, String(row[primaryKey]))
	const listProps = {
		resource: resourceShape,
		rows,
		references,
		files,
		rowHref,
		linkComponent: link,
		emptyState,
		// `demoIds` marks sample rows. All three variants carry it
		// now: the default table renders its own chip, and the card/feed variants
		// pass it through to a filled `row` slot as `isDemo`, so taking a row
		// bespoke cannot silently un-mark seeded data.
		demoIds,
		// One filled `field` slot replaces that cell everywhere the list renders
		// it, through the same per-column override seam the eject path uses.
		columns: fieldSlots,
		renderRow: RowSlot,
	}
	return (
		<ProjectFrame pages={nav} title={title} theme={theme} demoRows={demoRows}>
			<section data-resource={page.resource}>
				{HeaderSlot ? (
					<HeaderSlot
						resource={resourceShape}
						columns={columns}
						title={page.name}
						newHref={newHref}
					/>
				) : (
					<header className="mb-4 flex items-center justify-between">
						<h1 className="text-2xl font-semibold">{page.name}</h1>
						<Link
							to={newHref}
							className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground no-underline shadow transition-colors hover:bg-primary/90"
						>
							+ New
						</Link>
					</header>
				)}

				{/* The admin's inferred table — enum chips, resolved FK titles, and
				    formatted dates come from the shared field library.
				    A filled `replace` slot takes over this region and owns its own
				    empty state; the header's "+ New" stays either way, so a page with
				    no rows is never a dead end.

				    A filled `list` block slot does the same thing without
				    a spec declaration: the bespoke player/board/widget gets the rows
				    already loaded, ordered, and with FK titles and signed file URLs
				    resolved — the derivation stays the platform's, only the rendering
				    is the user's. That is the whole "cost 3 instead of 5". */}
				{/* A filled bespoke live surface wins this region outright (issue
				    #236). It is the most specific statement a project can make about
				    how the region renders — `slot: true` says "this surface is
				    genuinely not a table with a subscription attached" — so it takes
				    precedence over the declared view and over the generic variants.
				    The rows handed over are the same `rows` every branch below sees:
				    already loaded, gated, projected and live. An unfilled or
				    ungenerated slot renders nothing here and the page falls through
				    to the surface it would otherwise have shown, because a missing
				    bespoke component must degrade to the generic one rather than to
				    a blank page. */}
				{liveSurface ? (
					<LiveSurface
						channelKey={liveSurface.key}
						rows={withRowIds(rows, liveSurface.primaryKey)}
						// Presence is bounded to one row by declaration, and a list is not
						// a row — so a list surface is handed an empty room rather than a
						// wider one somebody would have to remember to bound.
						present={[]}
						truncated={false}
						polling={live.polling}
					/>
				) : page.view ? (
					<>
						<ArrangedView
							view={page.view}
							resource={resourceShape}
							rows={rows}
							anchor={anchor}
							truncated={truncated}
							slug={page.slug}
							rowHref={rowHref}
							emptyState={emptyState}
							demoIds={demoIds}
							onSubmit={(values, id) =>
								move.submit(values as Parameters<typeof move.submit>[0], {
									method: 'post',
									action: rowEditRoute(page.slug, id),
									encType: ROW_EDIT_ENCTYPE,
								})
							}
						/>
						<WriteRefusal data={move.data} />
					</>
				) : listReplaced ? null : ListSlot ? (
					<ListSlot
						resource={resourceShape}
						columns={columns}
						rows={rows}
						references={references}
						files={files}
						rowHref={rowHref}
						emptyState={emptyState}
					/>
				) : page.variant === 'cards' ? (
					<CardGrid
						{...listProps}
						primaryField={page.fields?.[0]}
						secondaryFields={page.fields ?? undefined}
					/>
				) : page.variant === 'feed' ? (
					<FeedList
						{...listProps}
						primaryField={page.fields?.[0]}
						secondaryFields={page.fields ?? undefined}
					/>
				) : (
					<>
						<ResourceList
							{...listProps}
							// Inline editing is the table's alone. A card and a
							// feed row are compositions, not cells: there is no rectangle a
							// click could turn into an editor without inventing one, and
							// inventing one is how a presentation variant grows a write path
							// of its own.
							editable={editable}
							// The affordance follows the permission (task 22/35). The wall is
							// `opUpdate` either way — this only keeps the list from offering an
							// editor whose every save would be refused.
							can={can}
							onCellSave={(row, name, value) => {
								const values = inlineEditValues(
									columns,
									editable,
									row,
									name,
									value,
								)
								if (!values) return
								// The same cast the move fetcher makes: `submit`'s JSON
								// target is typed as a JSON value while a cell's parsed
								// value is `unknown`. The wire encoding is JSON either
								// way, and the server re-validates every key it receives.
								cellEdit.submit(
									values as Parameters<typeof cellEdit.submit>[0],
									{
										method: 'post',
										action: rowEditRoute(page.slug, String(row[primaryKey])),
										encType: ROW_EDIT_ENCTYPE,
									},
								)
							}}
						/>
						<WriteRefusal data={cellEdit.data} />
					</>
				)}

				{page.slots.map((name) => {
					const render = ownedSlots?.[name]
					// A filled slot executes its owned component; an unfilled one shows
					// the authoring hint (its content lives in the user's slot file).
					return render ? (
						<Slot key={name} name={name} render={render} />
					) : (
						<p key={name} className="mt-6 text-xs text-muted-foreground">
							Extension slot <code>{name}</code> — fill it in the page's
							user-owned slot file.
						</p>
					)
				})}
			</section>
		</ProjectFrame>
	)
}

/**
 * A page's arranged view — the calendar/heatmap/timeline or
 * board block, plus the two things a *route* has to supply that the components
 * deliberately do not own: where the viewer is in time (the anchor and its
 * paging links), and what a move actually writes.
 *
 * `onSubmit` is only ever reached with values `rescheduleValues` produced, and
 * those are only ever the view's own declared date columns. It submits them to
 * the record's edit route, so the update runs the identical validation,
 * permission check and audit entry as saving the same field in the form. There
 * is no reschedule endpoint to secure separately, by construction.
 */
/**
 * What the server said when it refused a write from a list surface — a board or
 * calendar move, or an inline cell edit.
 *
 * A WIP limit, a validation rule and a permission check are all enforced in
 * `opUpdate`, so any of them comes back as a 4xx from the record's own edit
 * route — the same refusal a form submission gets. Surfacing it matters because
 * the optimistic thing already happened on screen: the card looks moved and the
 * cell looks saved, and without this the page would quietly snap back on the
 * next load with no explanation of why.
 *
 * One component for both because there is one write path. If a refusal needed
 * different words depending on which gesture caused it, that would be the tell
 * that the gestures had stopped sharing a path.
 */
function WriteRefusal({ data }: { data: unknown }) {
	const body = data as
		| { error?: string; fieldErrors?: Record<string, string[]> }
		| undefined
	const message =
		body?.error ?? Object.values(body?.fieldErrors ?? {}).flat()[0]
	if (!message) return null
	return (
		<Alert variant="destructive" role="alert" className="mt-2">
			{message}
		</Alert>
	)
}

function ArrangedView({
	view,
	resource,
	rows,
	anchor,
	truncated,
	slug,
	rowHref,
	emptyState,
	demoIds,
	onSubmit,
}: {
	view: NonNullable<ProjectRoute['view']>
	resource: { name: string; primaryKey: string; columns: SproutColumn[] }
	rows: Record<string, unknown>[]
	anchor: string
	truncated: boolean
	slug: string
	rowHref: (row: Record<string, unknown>) => string
	emptyState: React.ReactNode
	demoIds: readonly string[]
	onSubmit: (values: Record<string, string>, id: string) => void
}) {
	// The cap is now the *only* thing that truncates: every date view queries a
	// window, so the rows that are missing are the ones that did not
	// fit in the window the viewer is looking at, not the ones outside it. The
	// notice stays, and stays loud, because a truncated chart looks exactly like
	// a complete one.
	const notice = truncated ? (
		<p className="mt-2 text-muted-foreground text-xs">
			Showing the first {rows.length} records in this period — there are more,
			and they are not drawn.
		</p>
	) : null

	// A board is the one arrangement with no time axis: cards move between the
	// declared values of a column, and their order inside one is a rank key.
	if (view.kind === 'board') {
		const onBoardMove = view.move
			? (row: Record<string, unknown>, drop: BoardDrop) => {
					const values = boardMoveValues(
						view,
						row,
						drop,
						rows,
						resource.primaryKey,
					)
					if (values) onSubmit(values, String(row[resource.primaryKey]))
				}
			: undefined
		return (
			<>
				<BoardView
					resource={resource}
					rows={rows}
					groupField={view.groupField}
					rankField={view.rankField}
					titleField={view.titleField}
					cardFields={view.cardFields}
					rowHref={rowHref}
					linkComponent={link}
					emptyState={emptyState}
					onMove={onBoardMove}
					demoIds={demoIds}
				/>
				{notice}
			</>
		)
	}

	const onMove = view.reschedule
		? (row: Record<string, unknown>, day: string) => {
				const values = rescheduleValues(view, row, day)
				if (values) onSubmit(values, String(row[resource.primaryKey]))
			}
		: undefined

	// Paging is plain links, so a date view works without JavaScript and every
	// window is a URL somebody can bookmark or send.
	const step = (n: number) => {
		// A timeline has no natural period, so it steps by its own axis width
		//. Before that it had no paging at all: the axis spanned
		// whatever the capped row set happened to contain, so "earlier" was not a
		// place a viewer could go.
		if (view.kind === 'timeline')
			return `${pagePath(slug)}?on=${addDays(monthStart(anchor), n * TIMELINE_WINDOW_DAYS)}`
		if (view.display === 'week')
			return `${pagePath(slug)}?on=${addDays(anchor, n * 7)}`
		if (view.display === 'heatmap')
			return `${pagePath(slug)}?on=${addDays(anchor, n * 364)}`
		// A month step lands on a month boundary rather than 28 days away, so
		// paging forward and back returns to where it started.
		const start = monthStart(anchor)
		return `${pagePath(slug)}?on=${n > 0 ? addDays(start, daysInMonth(start)) : addDays(start, -1)}`
	}
	const paging = (
		<nav
			className="mb-2 flex items-center gap-3 text-sm"
			aria-label="Change period"
		>
			<Link to={step(-1)} className="no-underline hover:underline">
				← Earlier
			</Link>
			<Link to={pagePath(slug)} className="no-underline hover:underline">
				Today
			</Link>
			<Link to={step(1)} className="no-underline hover:underline">
				Later →
			</Link>
		</nav>
	)

	if (view.kind === 'timeline')
		return (
			<>
				{paging}
				<TimelineView
					resource={resource}
					rows={rows}
					startField={view.startField}
					endField={view.endField}
					titleField={view.titleField}
					dependsOnField={view.dependsOn}
					timezone={view.timezone}
					// The axis is the window the loader queried, not the extent of the
					// rows that came back. Deriving it from the data made the chart
					// rescale every time a row moved, and made "earlier" meaningless.
					window={timelineWindow(anchor)}
					rowHref={rowHref}
					linkComponent={link}
					emptyState={emptyState}
					onMove={onMove}
					demoIds={demoIds}
				/>
				{notice}
			</>
		)

	return (
		<>
			{paging}
			<CalendarView
				resource={resource}
				rows={rows}
				dateField={view.dateField}
				endField={view.endField}
				titleField={view.titleField}
				display={view.display}
				timezone={view.timezone}
				anchor={anchor}
				rowHref={rowHref}
				linkComponent={link}
				emptyState={emptyState}
				onMove={onMove}
				demoIds={demoIds}
			/>
			{notice}
		</>
	)
}
