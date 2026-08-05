/**
 * The query-string dialect of the REST collection surface, parsed once.
 *
 * `GET /api/:resource` and `GET /api/:resource/count` are the same question
 * asked two ways — "which rows" and "how many of them" — so they must agree on
 * what the query string means. Keeping the parse here is what makes that a
 * property of the code rather than of two route files staying in sync.
 */

import type { ListOptions } from '@maxstack/core'

/**
 * Parse the selection half of the dialect: `?search=` + `?searchField=`
 * (repeatable, for FK autocomplete), `?filter.<col>=` equality, and
 * `?filter.<col>.gte=` / `.lte=` inclusive range bounds on numeric/date
 * columns. Nothing here narrows to a page — see {@link parseListQuery}.
 */
export function parseFilterQuery(url: URL): ListOptions {
	const search = url.searchParams.get('search') ?? undefined
	const searchFields = url.searchParams.getAll('searchField')
	// Column identifiers carry no dots, so a trailing `.gte`/`.lte` is unambiguous.
	const filter: Record<string, string> = {}
	const range: Record<string, { gte?: string; lte?: string }> = {}
	for (const [key, value] of url.searchParams) {
		if (!key.startsWith('filter.')) continue
		const rest = key.slice('filter.'.length)
		const bound = /\.(gte|lte)$/.exec(rest)
		if (bound) {
			const col = rest.slice(0, -4)
			const entry = range[col] ?? {}
			entry[bound[1] as 'gte' | 'lte'] = value
			range[col] = entry
		} else {
			filter[rest] = value
		}
	}
	return {
		search,
		searchFields: searchFields.length > 0 ? searchFields : undefined,
		filter: Object.keys(filter).length > 0 ? filter : undefined,
		range: Object.keys(range).length > 0 ? range : undefined,
	}
}

/** {@link parseFilterQuery} plus the paging/ordering a list also takes. */
export function parseListQuery(url: URL): ListOptions {
	return {
		...parseFilterQuery(url),
		limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
		offset: Number.parseInt(url.searchParams.get('offset') ?? '0', 10),
		orderBy: url.searchParams.get('orderBy') ?? undefined,
		orderDir: url.searchParams.get('orderDir') === 'desc' ? 'desc' : undefined,
	}
}
