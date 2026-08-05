/**
 * Global search (Plan v5 task 44) — `useGlobalSearch` fans a query out across
 * registered resources via each one's search fields (tasks 32/34), groups the
 * hits by resource, and links each to its detail page. It reuses the task-33
 * data provider (`getList` with `search`/`searchFields`) and the task-41 registry
 * (which resources exist, their labels + paths), so a resource becomes searchable
 * simply by being registered with a set of `searchFields` — no per-resource
 * wiring. Debounced, cancellation-safe (a stale response never clobbers a newer
 * one), and gated by capabilities so a role only searches what it can read.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useDataProvider } from '../data/data-context.tsx'
import {
	type ResourceRegistry,
	resourceBasePath,
} from '../registry/resource-registry.ts'
import type { ResourceCapabilities, Row } from '../resource/resource-types.ts'

/** A resource made searchable: which fields to search and how to label a hit. */
export interface SearchableResource {
	name: string
	/** Columns to search (passed as `searchFields`). Empty → server default. */
	searchFields?: string[]
	/** Field to show as a result's title (default: first search field, else `id`). */
	titleField?: string
	/** Max hits to fetch per resource (default 5). */
	limit?: number
}

export interface SearchHit {
	resource: string
	id: string
	title: string
	href: string
	row: Row
}

export interface SearchGroup {
	resource: string
	label: string
	hits: SearchHit[]
}

export interface UseGlobalSearchResult {
	query: string
	setQuery: (q: string) => void
	groups: SearchGroup[]
	isSearching: boolean
	/** Flat hits in group order — convenient for keyboard navigation. */
	flat: SearchHit[]
	clear: () => void
}

export interface GlobalSearchOptions {
	registry: ResourceRegistry
	searchables: SearchableResource[]
	/** Per-resource capabilities; a resource the session can't read is skipped. */
	capabilities?: Record<string, ResourceCapabilities>
	/** Debounce in ms before firing (default 200). */
	debounce?: number
	/** Minimum query length before searching (default 1). */
	minLength?: number
}

function titleOf(row: Row, searchable: SearchableResource): string {
	const field = searchable.titleField ?? searchable.searchFields?.[0]
	const v = field ? row[field] : undefined
	if (v != null && String(v).trim() !== '') return String(v)
	return String(row.id ?? '')
}

export function useGlobalSearch(
	options: GlobalSearchOptions,
): UseGlobalSearchResult {
	const {
		registry,
		searchables,
		capabilities,
		debounce = 200,
		minLength = 1,
	} = options
	const dp = useDataProvider()
	const [query, setQuery] = useState('')
	const [groups, setGroups] = useState<SearchGroup[]>([])
	const [isSearching, setIsSearching] = useState(false)
	// Monotonic token so a slow earlier request can't overwrite a newer result.
	const runId = useRef(0)

	const clear = useCallback(() => {
		setQuery('')
		setGroups([])
		setIsSearching(false)
		runId.current++
	}, [])

	// biome-ignore lint/correctness/useExhaustiveDependencies: dp/registry/searchables are stable per mount; re-running on `query` is the intent.
	useEffect(() => {
		const q = query.trim()
		if (q.length < minLength) {
			setGroups([])
			setIsSearching(false)
			return
		}
		const id = ++runId.current
		setIsSearching(true)
		const timer = setTimeout(async () => {
			const visible = searchables.filter((s) => {
				if (!registry.get(s.name)) return false
				const caps = capabilities?.[s.name]
				return caps ? caps.read : true
			})
			const results = await Promise.all(
				visible.map(async (s) => {
					try {
						const { data } = await dp.getList(s.name, {
							search: q,
							searchFields: s.searchFields,
							pagination: { page: 1, perPage: s.limit ?? 5 },
						})
						return { s, rows: data }
					} catch {
						return { s, rows: [] as Row[] }
					}
				}),
			)
			if (id !== runId.current) return // superseded
			const next: SearchGroup[] = results
				.filter((r) => r.rows.length > 0)
				.map(({ s, rows }) => ({
					resource: s.name,
					label: registry.get(s.name)?.pluralLabel ?? s.name,
					hits: rows.map((row) => {
						const rid = String(row.id ?? '')
						return {
							resource: s.name,
							id: rid,
							title: titleOf(row, s),
							href: `${resourceBasePath(s.name)}/${rid}`,
							row,
						}
					}),
				}))
			setGroups(next)
			setIsSearching(false)
		}, debounce)

		return () => clearTimeout(timer)
	}, [query, minLength, debounce])

	const flat = groups.flatMap((g) => g.hits)
	return { query, setQuery, groups, isSearching, flat, clear }
}
