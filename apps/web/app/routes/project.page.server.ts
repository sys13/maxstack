/**
 * The list page's loader.
 *
 * Separate from the component because these four surfaces stopped being route
 * modules: the router mounts one splat that resolves what a path means and
 * delegates here. A route module gets its `loader` export stripped from the
 * client bundle; a plain module does not, so a loader left beside a component
 * would drag `~/sprout.server` and friends into the browser — which is a build
 * error, and would have been a data leak if it were not.
 */

import {
	type ListOptions,
	listHandler,
	opAggregate,
	opSearch,
	type SproutResource,
} from '@maxstack/core'
import { AGGREGATE_LIMIT_DEFAULT, type AggregateFilter } from '@maxstack/spec'
import { activeFilterCount } from '@maxstack/ui'
import { data } from 'react-router'
import { inlineEditableFields } from '~/inline-edit'
import { liveQueryKeyFor, liveSlotFor } from '~/live.server'
import {
	type ProjectRouteArgs,
	projectChrome,
	resolveProjectResource,
} from '~/project.server'
import {
	demoSeedManifest,
	getContext,
	getSprout,
	hasDemoData,
	referenceFieldOptions,
	resolveCapabilities,
	resolveRowFiles,
	resolveRowReferences,
} from '~/sprout.server'
import {
	anchorDay,
	listControls,
	viewLimit,
	viewListOptions,
} from './project.page'

/**
 * An aggregate's declared `where` clauses as a store filter.
 *
 * Spec-declared, never request-derived — which is what makes it safe to hand
 * straight to the read. `opAggregate` spreads the tenant, soft-delete and
 * portal scopes *over* whatever arrives here, so a declaration cannot widen the
 * read even if a spec file names the tenant column itself.
 */
function declaredFilter(
	where: readonly AggregateFilter[] | undefined,
): ListOptions['filter'] {
	if (!where || where.length === 0) return undefined
	return Object.fromEntries(where.map((w) => [w.field, w.equals]))
}

/** The tracked demo ids for one resource, or `[]` when nothing was seeded. */
async function demoRowIds(resource: string): Promise<string[]> {
	const manifest = await demoSeedManifest()
	return manifest.rows[resource] ?? []
}

export async function loader({ request, params }: ProjectRouteArgs) {
	const resolved = await resolveProjectResource(params.page, request)
	const ctx = await getContext(request)
	// A date-arranged view reads the same rows through the same
	// handler as the list; only *which* rows and in what order differ, because
	// a calendar is a window on a date column rather than the first page of one.
	const declared = resolved.page.view
	// An aggregate is the one view that reads no rows, so it is split off here
	// before anything row-shaped runs. Everything below — the anchor day, the
	// window, the row cap, the facets — is a question about *which rows*, and an
	// aggregate has no answer to any of them. `PageRowView` is the type that
	// makes forgetting this a compile error rather than a chart that quietly
	// triggered a windowed list read.
	const view = declared?.kind === 'aggregate' ? null : declared
	const aggregate = declared?.kind === 'aggregate' ? declared : null
	const anchor = anchorDay(request, view)
	// Search, facets, ordering **and the columns they are derived from**, all
	// resolved together — see `listControls`, which is where the reasoning and
	// the tests live. The columns come back rather than going in because which
	// columns a page renders is itself a function of the request: a relation the
	// URL filters by joins them, which is what makes a related-records "view all"
	// link expressible without permitting a filter on an unrendered column.
	const { columns, filters, sort, searchFields } = listControls(
		new URL(request.url),
		resolved.introspection,
		resolved.page.fields,
		view,
	)
	// The resource *as this page shows it* — the visible columns, not the whole
	// table. Every list control below derives from this one object: which
	// columns the search box scans, which facets the filter bar offers, which
	// headers sort, and which columns the CSV carries. One rule, and it is
	// statable: **a page controls exactly the columns it renders**.
	//
	// That is also the security boundary. `search`, `filter.*`, `sort` and `dir`
	// all arrive from the query string of a page an end user is looking at, and
	// ordering or filtering by a column they were never shown is a comparison
	// oracle over its values (the same attack `assertPortalReadShape` refuses in
	// core, arriving through a different door). Deriving the allow-list from the
	// rendered columns closes it without a declaration.
	const shown: SproutResource = { ...resolved.introspection, columns }
	const { registry } = await getSprout()
	// A declared full-text index upgrades this exact search box in place: same
	// URL, same `?search=`, same page underneath — the rows just come back
	// ranked, stemmed and word-aware instead of in table order from an
	// unanchored ILIKE. Same rule the admin follows, so the two surfaces cannot
	// drift on what "search" means. A blank query still lists: an empty search
	// box means "show me everything", which is the one thing a search endpoint
	// deliberately does not do.
	const ranked =
		registry.get(resolved.resource)?.config.search && filters.search?.trim()
			? await opSearch(ctx, resolved.resource, filters.search, {
					limit: 100,
					filter:
						Object.keys(filters.filter).length > 0 ? filters.filter : undefined,
					range:
						filters.range && Object.keys(filters.range).length > 0
							? filters.range
							: undefined,
				})
			: null
	// The grouped read, under `opAggregate`'s gate: the permission check, the
	// tenant scope and the soft-delete scope are applied to the aggregate
	// *query*, not to a page of rows summed afterwards. Every name reaching it
	// comes from the block's declaration and is resolved against the registry
	// there; nothing from this request contributes a column name.
	const buckets = aggregate
		? await opAggregate(
				ctx,
				resolved.resource,
				{
					groupColumn: aggregate.groupField,
					bucket: aggregate.bucket,
					fn: aggregate.fn,
					measureColumn: aggregate.measureField,
					limit: aggregate.limit ?? AGGREGATE_LIMIT_DEFAULT,
				},
				{ filter: declaredFilter(aggregate.where) },
			)
		: null
	const res = aggregate
		? { status: 200, body: [] }
		: ranked
			? { status: 200, body: ranked.map((hit) => hit.row) }
			: await listHandler(ctx, resolved.resource, {
					...(view
						? viewListOptions(view, anchor)
						: {
								limit: 100,
								// A sort the viewer chose wins over the spec-declared `order`,
								// which is the page's *default* ordering rather than its only
								// one. With no `?sort=` the declared order is exactly what it
								// always was.
								orderBy: sort?.field ?? resolved.page.order?.field,
								orderDir: sort?.dir ?? resolved.page.order?.direction,
								search: filters.search,
								searchFields:
									searchFields.length > 0 ? searchFields : undefined,
								filter:
									Object.keys(filters.filter).length > 0
										? filters.filter
										: undefined,
								range:
									filters.range && Object.keys(filters.range).length > 0
										? filters.range
										: undefined,
							}),
				})
	if (res.status !== 200) throw data(res.body, { status: res.status })
	// Derived values — computed fields evaluated per row, rollups
	// aggregated in SQL — already rode out of `listHandler` on the op context.
	const rows = res.body as Record<string, unknown>[]
	const chrome = await projectChrome()
	return {
		page: resolved.page,
		nav: resolved.nav,
		title: chrome.title,
		theme: chrome.theme,
		// Sample-data notice — the frame renders it on every surface.
		demoRows: chrome.demoRows,
		primaryKey: resolved.primaryKey,
		columns,
		rows,
		// The list-control state, read back off the URL with the same codec the
		// bar encodes with, so the two can never drift. Narrowed to the page's own
		// columns before it gets here — what comes back is what was *honoured*,
		// not what was asked for, which is what the bar must render to stay
		// truthful about the rows below it.
		filters,
		// Ranked search orders by relevance, so it *replaces* a chosen ordering
		// rather than composing with it. Reporting the sort anyway would draw an
		// arrow on a header the rows are not ordered by, which is the one thing a
		// sort indicator must never do.
		sort: ranked ? undefined : sort,
		// The option sets for reference facets (the referenced records) — the one
		// thing a facet cannot derive from the schema alone. Skipped entirely when
		// the page shows no FK column, so an ordinary list does not pay a query
		// for a control it will not render.
		referenceOptions: view ? {} : await referenceFieldOptions(ctx, shown),
		// What this session may do to this resource (task 22/35). The server
		// enforces it either way — `opUpdate` is the wall, not this — but a list
		// that offers an inline editor to a viewer whose every save will 403 is a
		// UI that lies. List-level, so an `owner` rule reads as denied here and is
		// re-checked per row on the write.
		can: await resolveCapabilities(ctx, resolved.resource),
		// The cells this list edits in place: declared by the block,
		// then narrowed to the columns that can actually be edited. Narrowed on the
		// server so the client never receives a name it is not allowed to write —
		// though the write itself is gated where every other write is.
		editable: inlineEditableFields(
			resolved.introspection.columns,
			resolved.page.editable,
		),
		// FK columns render the referenced record's title, not its raw id — the
		// same batched resolution the admin list uses.
		references: await resolveRowReferences(ctx, resolved.introspection, rows),
		files: resolveRowFiles(resolved.introspection, rows, ctx.user?.id ?? null),
		// Empty-state guidance (task 63 / issue #60): only offer "load demo data"
		// when a bundle actually has sample rows for this project.
		// A filtered list that matched nothing is not an empty app: offering "load
		// demo data" there answers a question nobody asked and hides the one the
		// user has ("clear the filter"). The component renders the no-matches
		// state instead, and this stays false so it cannot offer the seed button.
		demoAvailable:
			rows.length === 0 && activeFilterCount(filters) === 0
				? await hasDemoData()
				: false,
		// Which of these rows are sample data. A seeded row is an
		// ordinary row — no marker column, by design — so the id set is the only
		// thing that can tell them apart, and it has to reach the list component.
		demoIds: resolved.page.resource
			? await demoRowIds(resolved.page.resource)
			: [],
		// The grouped result an `aggregate` block draws, or `null` on every other
		// page. Resolved on the server under the read gate, which is why the block
		// takes buckets as props rather than fetching them: the client half of a
		// dashboard widget would be a second read path with a second access story.
		buckets,
		// The day the grid is drawn around, resolved on the server:
		// "today" is a question about the *declared* zone, and answering it in the
		// browser would hydrate a different grid than the one that was rendered.
		anchor,
		// Whether the row set hit the cap a timeline (or a multi-day calendar)
		// reads under — surfaced rather than silently swallowed, since a truncated
		// chart looks exactly like a complete one.
		truncated: view ? rows.length >= viewLimit(view) : false,
		// The declared live channel for this resource, if it has one.
		// This is what makes a derived list, board, calendar or timeline update
		// without a refresh: the surface subscribes when a key comes back and stays
		// a plain snapshot when it does not, so declaring a channel is opt-in
		// rather than a tax every page pays. A PAUSED channel still yields its key
		// — the client subscribes, is refused with a reason, and polls the same op
		// — which is what makes pausing safe rather than a silent stop.
		liveKey: resolved.page.resource
			? await liveQueryKeyFor(resolved.page.resource)
			: undefined,
		// The bespoke live surface this resource declared, if it declared one
		//. A `slot: true` query channel says the surface is genuinely
		// bespoke — a drag-and-drop board, a threaded reader — and the platform's
		// job is to hand the user's component the rows it already gates and
		// projects rather than to grow a vocabulary for drag targets. The generic
		// list, board and calendar keep regenerating right beside it for every
		// resource that did not.
		liveSlot: resolved.page.resource
			? await liveSlotFor(resolved.page.resource, 'query')
			: undefined,
	}
}
