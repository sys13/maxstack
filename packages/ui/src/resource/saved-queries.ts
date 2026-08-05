/**
 * Saved queries (Plan v5 task 40) — named filter+sort presets for a resource's
 * list, persisted to the task-42 preference store. The persisted shape is the
 * task-34 URL codec's flat param map (`{ search, 'filter.<col>': … }`), not the
 * structured `FilterValues` — the same wire shape the URL and the REST provider
 * speak, so a preset is trivially shareable as a link and survives codec-level
 * evolution the same way a bookmarked URL does.
 */

import { useCallback } from 'react'
import { useStore } from '../prefs/prefs-context.tsx'
import {
	filtersFromSearchParams,
	filtersToSearchParams,
} from './filter-params.ts'
import type { FilterValues } from './filterable.ts'
import type { SortState } from './ResourceList.tsx'

export interface SavedQuery {
	name: string
	/** Flat URL-codec params (`search`, `filter.<col>`, `filter.<col>.gte|lte`). */
	params: Record<string, string>
	sort?: SortState
}

export interface AppliedQuery {
	values: FilterValues
	sort?: SortState
}

export interface UseSavedQueriesResult {
	queries: SavedQuery[]
	/** Save (or overwrite, by name) the given filters+sort as a preset. */
	save: (name: string, values: FilterValues, sort?: SortState) => void
	remove: (name: string) => void
	/** Decode a preset back into controlled list state. */
	apply: (name: string) => AppliedQuery | undefined
	/** The preset equal to the current filters+sort, if any — drives an
	 * active-chip highlight and hides the redundant "save" affordance. */
	matching: (values: FilterValues, sort?: SortState) => SavedQuery | undefined
}

const NO_QUERIES: SavedQuery[] = []

const sameParams = (
	a: Record<string, string>,
	b: Record<string, string>,
): boolean => {
	const ka = Object.keys(a)
	return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

const sameSort = (a?: SortState, b?: SortState): boolean =>
	a?.field === b?.field && a?.dir === b?.dir

/**
 * Bind a resource's saved queries to the preference store, keyed
 * `savedQueries.<resource>`. Reactive like any `useStore` binding: saving from
 * one component updates every other subscriber.
 */
export function useSavedQueries(
	resource: string,
	options: { storeKey?: string } = {},
): UseSavedQueriesResult {
	const key = options.storeKey ?? `savedQueries.${resource}`
	const [queries, setQueries] = useStore<SavedQuery[]>(key, NO_QUERIES)

	const save = useCallback(
		(name: string, values: FilterValues, sort?: SortState) => {
			const trimmed = name.trim()
			if (!trimmed) return
			const entry: SavedQuery = {
				name: trimmed,
				params: filtersToSearchParams(values),
				...(sort ? { sort } : {}),
			}
			setQueries((prev) => [...prev.filter((q) => q.name !== trimmed), entry])
		},
		[setQueries],
	)

	const remove = useCallback(
		(name: string) => {
			setQueries((prev) => prev.filter((q) => q.name !== name))
		},
		[setQueries],
	)

	const apply = useCallback(
		(name: string): AppliedQuery | undefined => {
			const q = queries.find((entry) => entry.name === name)
			if (!q) return undefined
			return { values: filtersFromSearchParams(q.params), sort: q.sort }
		},
		[queries],
	)

	const matching = useCallback(
		(values: FilterValues, sort?: SortState) => {
			const params = filtersToSearchParams(values)
			return queries.find(
				(q) => sameParams(q.params, params) && sameSort(q.sort, sort),
			)
		},
		[queries],
	)

	return { queries, save, remove, apply, matching }
}
