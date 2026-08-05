/**
 * Storage abstraction. The engine (REST handlers, MCP executor) talks to a
 * `SproutStore`, never to a driver directly — so the same authorization and
 * validation logic runs over any backend (pglite in tests, Postgres in prod).
 */

import type { SearchHit, SearchIndexPlan } from './search.ts'

export interface ListOptions {
	limit?: number
	offset?: number
	/** Column to sort by. Ignored if the column is unknown to the resource. */
	orderBy?: string
	/** Sort direction when `orderBy` is set (default `asc`). */
	orderDir?: 'asc' | 'desc'
	/**
	 * Equality filters keyed by column name (`{ status: 'open' }`). Unknown
	 * columns are ignored — a stale filter never 500s. Powers `<FilterForm>`
	 * (task 34) and `<ReferenceManyField>`'s reverse-FK lookup (task 32).
	 */
	filter?: Record<string, string | number | boolean | null>
	/**
	 * Inclusive numeric/date range constraints keyed by column name
	 * (`{ costMonthly: { gte: 5, lte: 20 } }`). Each bound is optional, so an
	 * open-ended range (`{ gte: 5 }`) is `>= 5` with no upper bound. Unknown
	 * columns and blank bounds are ignored. This is the `>=`/`<=` store op the
	 * equality-only {@link filter} can't express — it powers `<FilterForm>`'s
	 * range facets (task 34) over `number`/`date` columns.
	 */
	range?: Record<string, RangeBound>
	/**
	 * Rows whose declared span **overlaps** a window.
	 *
	 * This is the predicate {@link range} cannot express, and the reason ranged
	 * calendars and timelines read a capped 500 rows instead of a window: an
	 * entry that *starts* before the window and *ends* inside it falls out of a
	 * range test on its start column alone, and `range` ANDs its per-column
	 * bounds, so adding a bound on the end column silently drops every row whose
	 * end is NULL — which is exactly the milestone rows a timeline deliberately
	 * keeps drawing. Silently dropping a row is the worst failure a calendar has,
	 * so the cap was chosen over a predicate that lies.
	 *
	 * The honest predicate needs both bounds *and* a null case, and it is one
	 * thing rather than two because the null case is not a separate feature: a
	 * row with no end is a **point at its start**, so it is in the window when its
	 * start is, and a row with an end is in the window when the two spans
	 * intersect. Written out:
	 *
	 * ```
	 *   (end IS NULL     AND start >= from AND start <= to)
	 *   OR (end IS NOT NULL AND start <= to  AND end   >= from)
	 * ```
	 *
	 * AND-ed with everything else, like `filter` and `range` — a store may never
	 * widen a read, only narrow one.
	 */
	overlaps?: OverlapWindow
	/** Case-insensitive substring match applied across {@link searchFields}. */
	search?: string
	/** The text columns `search` scans; empty/omitted → `search` is a no-op. */
	searchFields?: string[]
	/** Soft delete escape hatch: a `softDelete: true` resource
	 * filters `deletedAt IS NULL` by default on every read op; pass `true` here
	 * to see soft-deleted rows too (e.g. an admin "trash" list). No effect on a
	 * resource that isn't soft-deletable. */
	includeDeleted?: boolean
}

/** One column's inclusive range bound. Either end may be omitted (open range).
 * Values are the raw comparands drizzle passes to `>=`/`<=` — numbers for
 * numeric columns, ISO strings for `date` (timestamp) columns. */
export interface RangeBound {
	gte?: string | number
	lte?: string | number
}

/**
 * A window two columns are tested against together. See
 * {@link ListOptions.overlaps} for the predicate and why it is not two ranges.
 *
 * `endColumn` naming a column the resource does not have makes the whole clause
 * a no-op, matching `filter`/`range`'s unknown-column rule — a stale view never
 * 500s. That direction is safe here for the same reason it is there: dropping
 * the clause **widens** the read to the cap that already applied, and every
 * authorization filter is AND-ed separately.
 */
export interface OverlapWindow {
	/** The column a span begins at. Required — a window with no start is a range. */
	startColumn: string
	/** The column a span ends at. A NULL here means "a point at `startColumn`". */
	endColumn: string
	from: string | number
	to: string | number
}

export type Row = Record<string, unknown>

/**
 * A parameterized SELECT. Structurally `StoreBackend.query`, so a store built
 * over a backend passes it straight through.
 */
export type RawQueryRunner = (
	text: string,
	params?: readonly unknown[],
) => Promise<Record<string, unknown>[]>

/** What a caller asks of {@link SproutStore.search}, beyond the query itself. */
export interface SearchOptions {
	limit?: number
	offset?: number
	/**
	 * Equality filters, AND-ed **after** the text match. `opSearch` forces the
	 * tenant and soft-delete scopes through here, so nothing in the search half
	 * can widen them — the same ordering rule `opList` states about its filters.
	 */
	filter?: Record<string, string | number | boolean | null>
	/**
	 * Inclusive `>=`/`<=` bounds, same dialect as {@link ListOptions.range}.
	 *
	 * Carried here so a resource's filter facets keep working *while* a search
	 * term is active. A search path that silently ignored the facets the user had
	 * set would show rows they had just filtered out, which reads as the filters
	 * being broken rather than as search overriding them.
	 */
	range?: Record<string, RangeBound>
}

export interface SproutStore {
	list(resource: string, opts?: ListOptions): Promise<Row[]>
	/**
	 * Ranked full-text search over a declared index.
	 *
	 * **Optional on purpose.** A store with no way to run the ranking query does
	 * not silently fall back to `list({search})` — an unanchored `ILIKE` scan
	 * returning rows in table order is a different feature, and quietly
	 * substituting it would mean the platform reports "search works" while
	 * ranking, stemming and word boundaries are all absent. Absent here,
	 * `opSearch` refuses with `UnsupportedOperationError`, which reads as a 422
	 * saying so.
	 */
	search?(
		resource: string,
		plan: SearchIndexPlan,
		query: string,
		opts?: SearchOptions,
	): Promise<SearchHit[]>
	/** Matching-row count under exactly {@link search}'s predicates. */
	searchCount?(
		resource: string,
		plan: SearchIndexPlan,
		query: string,
		opts?: SearchOptions,
	): Promise<number>
	/**
	 * Count matching rows without fetching them — powers `<ReferenceManyCount>`'s
	 * child count (task 38: "N comments" without loading the comments). Honors the
	 * same `filter`/`range`/`search` as {@link list} (ordering/paging ignored), so
	 * `count(child, { filter: { [fk]: parentId } })` counts a parent's children.
	 */
	count(resource: string, opts?: ListOptions): Promise<number>
	get(resource: string, id: string): Promise<Row | null>
	/**
	 * Fetch many rows by primary key in one round-trip — the batch primitive
	 * `<ReferenceField>` uses to resolve a list's FKs without an N+1 (task 32).
	 * Order is unspecified; callers key by id. An empty `ids` returns `[]`.
	 */
	getMany(resource: string, ids: readonly string[]): Promise<Row[]>
	create(resource: string, data: Row): Promise<Row>
	update(resource: string, id: string, data: Row): Promise<Row | null>
	delete(resource: string, id: string): Promise<boolean>
}
