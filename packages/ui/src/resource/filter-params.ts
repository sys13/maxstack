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

const FILTER_PREFIX = 'filter.'
const SEARCH_KEY = 'search'

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
