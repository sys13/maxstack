/**
 * The URL codec for list filters (Plan v5 task 34) — makes a filtered list
 * shareable and bookmarkable. It's deliberately framework-agnostic: it moves a
 * `FilterValues` to and from a flat `Record<string, string>` / `URLSearchParams`
 * using the *same* wire shape the REST provider and Sprout's list endpoint speak
 * (`?search=`, `?filter.<col>=`), so a route can hand the params straight to
 * react-router's `useSearchParams` and to the loader's query without a mapping
 * layer. Keeping it out of the components (which stay controlled) means the UI
 * package never imports a router.
 */

import { EMPTY_FILTERS, type FilterValues } from './filterable.ts'
import type { SortState } from './ResourceList.tsx'

const FILTER_PREFIX = 'filter.'
const SEARCH_KEY = 'search'
const SORT_KEY = 'sort'
const DIR_KEY = 'dir'

type ParamsLike =
	| URLSearchParams
	| Record<string, string>
	| Iterable<[string, string]>

/** Encode filters as a flat param map (`{ search, 'filter.priority': 'high',
 * 'filter.cost.gte': '5' }`). Empty/blank values are omitted so a cleared filter
 * drops out of the URL. */
export function filtersToSearchParams(
	values: FilterValues,
): Record<string, string> {
	const out: Record<string, string> = {}
	const search = values.search?.trim()
	if (search) out[SEARCH_KEY] = search
	for (const [key, value] of Object.entries(values.filter)) {
		if (value != null && value !== '') out[`${FILTER_PREFIX}${key}`] = value
	}
	for (const [key, range] of Object.entries(values.range ?? {})) {
		if (range.gte != null && range.gte !== '')
			out[`${FILTER_PREFIX}${key}.gte`] = range.gte
		if (range.lte != null && range.lte !== '')
			out[`${FILTER_PREFIX}${key}.lte`] = range.lte
	}
	return out
}

/** Iterate any params-like source as `[key, value]` pairs. */
function* entriesOf(params: ParamsLike): Iterable<[string, string]> {
	if (params instanceof URLSearchParams) {
		yield* params.entries()
	} else if (Symbol.iterator in Object(params)) {
		yield* params as Iterable<[string, string]>
	} else {
		yield* Object.entries(params as Record<string, string>)
	}
}

/** Decode a param source back into `FilterValues` (the inverse of
 * {@link filtersToSearchParams}). Params that aren't `search`/`filter.*` — a
 * `page` cursor, say — are ignored, so filter state coexists with other URL
 * state. */
export function filtersFromSearchParams(params: ParamsLike): FilterValues {
	const filter: Record<string, string> = {}
	const range: Record<string, { gte?: string; lte?: string }> = {}
	let search: string | undefined
	for (const [key, value] of entriesOf(params)) {
		if (key === SEARCH_KEY) {
			if (value) search = value
		} else if (key.startsWith(FILTER_PREFIX)) {
			const col = key.slice(FILTER_PREFIX.length)
			// A trailing `.gte`/`.lte` marks a range bound (column names carry no
			// dots, so the suffix is unambiguous); anything else is equality.
			const bound = /\.(gte|lte)$/.exec(col)
			if (bound) {
				if (value !== '') {
					const name = col.slice(0, -4)
					const entry = range[name] ?? {}
					entry[bound[1] as 'gte' | 'lte'] = value
					range[name] = entry
				}
			} else if (col && value !== '') {
				filter[col] = value
			}
		}
	}
	const hasRange = Object.keys(range).length > 0
	return search === undefined && Object.keys(filter).length === 0 && !hasRange
		? EMPTY_FILTERS
		: { search, filter, ...(hasRange ? { range } : {}) }
}

/**
 * Encode a chosen sort as URL params (`?sort=title&dir=desc`).
 *
 * Sort lives in the URL for the same reason filters do: a list somebody sorted
 * and then linked to has to arrive sorted. It is a *separate* codec from
 * {@link filtersToSearchParams} because the two are set independently — picking
 * a facet must not reset the ordering, and clicking a header must not clear the
 * filters — so a caller merges both maps into the one param set.
 *
 * `undefined` yields an empty map, so "no explicit sort" drops out of the URL
 * and the page falls back to its spec-declared `order`.
 */
export function sortToSearchParams(
	sort: SortState | undefined,
): Record<string, string> {
	if (!sort?.field) return {}
	return { [SORT_KEY]: sort.field, [DIR_KEY]: sort.dir }
}

/**
 * Decode `?sort=&dir=` back into a {@link SortState}, or `undefined`.
 *
 * `allowed` is required, not optional, and that is the point: the field arrives
 * from the query string, and an `ORDER BY` over a column the page does not
 * render is a comparison oracle over a value the viewer was never shown — a few
 * dozen requests reconstruct its ordering exactly. So a name that is not in the
 * page's own sortable set is dropped rather than passed to the store, which
 * would silently ignore it *for a column that does not exist* and honour it for
 * a hidden one that does.
 */
export function sortFromSearchParams(
	params: ParamsLike,
	allowed: readonly string[],
): SortState | undefined {
	let field: string | undefined
	let dir: string | undefined
	for (const [key, value] of entriesOf(params)) {
		if (key === SORT_KEY) field = value
		else if (key === DIR_KEY) dir = value
	}
	if (!field || !allowed.includes(field)) return undefined
	return { field, dir: dir === 'desc' ? 'desc' : 'asc' }
}

/**
 * Drop every filter naming a column outside `allowed` — the filter half of the
 * same rule {@link sortFromSearchParams} applies to ordering. An equality
 * filter on a column the page does not show answers "is this row's `salary`
 * equal to X?" one guess at a time, and a range bound does it in binary search.
 */
export function narrowFilters(
	values: FilterValues,
	allowed: readonly string[],
	/**
	 * The **declared** operator sets per column (#414) — see
	 * `declaredFilterOperators`. A column absent from the map declared nothing
	 * and keeps every spelling it has honoured since #342; a column present in it
	 * keeps only the spellings it named, so `operators: ["eq"]` drops a `.gte`
	 * bound somebody typed into the URL instead of quietly answering it.
	 *
	 * This narrows *within* `allowed` rather than beside it: a declaration can
	 * never re-admit a column the page does not render.
	 */
	operators: Record<string, readonly string[]> = {},
): FilterValues {
	const permitted = new Set(allowed)
	const offers = (column: string, operator: 'eq' | 'range'): boolean => {
		const declared = operators[column]
		return declared === undefined || declared.includes(operator)
	}
	const filter: Record<string, string> = {}
	for (const [key, value] of Object.entries(values.filter))
		if (permitted.has(key) && offers(key, 'eq')) filter[key] = value
	const range: Record<string, { gte?: string; lte?: string }> = {}
	for (const [key, value] of Object.entries(values.range ?? {}))
		if (permitted.has(key) && offers(key, 'range')) range[key] = value
	const hasRange = Object.keys(range).length > 0
	return values.search === undefined &&
		Object.keys(filter).length === 0 &&
		!hasRange
		? EMPTY_FILTERS
		: { search: values.search, filter, ...(hasRange ? { range } : {}) }
}
