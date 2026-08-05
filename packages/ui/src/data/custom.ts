/**
 * The non-CRUD escape hatch (Plan v5 task 47). The typed CRUD hooks
 * (`useList`/`useOne`/…) cover the resource grid, but a real app also calls
 * custom endpoints (an RPC, a report, a search) and needs the *same* caching,
 * de-duping, and invalidation. `useCustomQuery` binds an arbitrary async fetcher
 * to a `QueryKey` in the shared `QueryClient`; `useMutation` runs an arbitrary
 * async action and can invalidate keys on success. `useCount`/`useAggregate` are
 * thin, typed views over an {@link AggregateProvider} for dashboard widgets and
 * the "N comments" counts task 38/49 need — feature-detected, so a plain REST
 * provider without aggregates simply reports unsupported instead of crashing.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useDataProvider, useQueryClient } from './data-context.tsx'
import type { GetListParams } from './data-provider.ts'
import type { QueryResult } from './hooks.ts'
import type { AggregateOp, AggregateProvider } from './memory-provider.ts'
import type { QueryClient, QueryKey } from './query-client.ts'

/**
 * Cache-bound custom query. Give it a stable `key` and a `fetcher`; it de-dupes,
 * caches, and re-renders exactly like `useList` — but the fetcher is yours, so it
 * fits any endpoint. Invalidate it by matching the same key from a mutation.
 */
export function useCustomQuery<T>(
	key: QueryKey,
	fetcher: () => Promise<T>,
	options: { enabled?: boolean } = {},
): QueryResult<T> {
	const client = useQueryClient()
	return useBoundQuery(client, key, fetcher, options.enabled ?? true)
}

/** Shared binding logic (a public twin of hooks.ts's internal `useQuery`). */
function useBoundQuery<T>(
	client: QueryClient,
	key: QueryKey,
	fetcher: () => Promise<T>,
	enabled: boolean,
): QueryResult<T> {
	const hash = JSON.stringify(key)
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hash` is the key's stable identity.
	const subscribe = useCallback(
		(cb: () => void) => client.subscribe(key, cb),
		[client, hash],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: snapshot depends only on the key.
	const getSnapshot = useCallback(() => client.getState<T>(key), [client, hash])
	const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch on key change / enable.
	useEffect(() => {
		// The rejection is already captured in query state; swallow it here so a
		// failing custom fetcher doesn't surface as an unhandled rejection.
		if (enabled) client.fetch(key, fetcher).catch(() => {})
	}, [client, hash, enabled])

	// biome-ignore lint/correctness/useExhaustiveDependencies: force-refetch the current key.
	const refetch = useCallback(() => {
		client.fetch(key, fetcher, { force: true }).catch(() => {})
	}, [client, hash])

	return {
		data: state.data,
		error: state.error,
		isLoading: state.status === 'loading',
		isFetching: state.isFetching,
		refetch,
	}
}

export interface UseMutationResult<A, R> {
	mutate: (args: A) => Promise<R>
	isLoading: boolean
	error: Error | undefined
	data: R | undefined
}

/**
 * Arbitrary async mutation with the CRUD hooks' ergonomics: pending state, error
 * capture, and `invalidateKeys` to refetch dependent queries on success.
 */
export function useMutation<A = void, R = unknown>(
	action: (args: A) => Promise<R>,
	options: {
		onSuccess?: (data: R, args: A) => void
		onError?: (error: Error, args: A) => void
		/** Query keys (or a matcher) to invalidate after a successful mutation. */
		invalidateKeys?: QueryKey[] | ((key: QueryKey) => boolean)
	} = {},
): UseMutationResult<A, R> {
	const client = useQueryClient()
	const [state, setState] = useState<{
		isLoading: boolean
		error: Error | undefined
		data: R | undefined
	}>({ isLoading: false, error: undefined, data: undefined })

	// biome-ignore lint/correctness/useExhaustiveDependencies: options captured at call time; action is the mutation identity.
	const mutate = useCallback(
		async (args: A): Promise<R> => {
			setState((s) => ({ ...s, isLoading: true, error: undefined }))
			try {
				const data = await action(args)
				setState({ isLoading: false, error: undefined, data })
				const inv = options.invalidateKeys
				if (inv) {
					const match =
						typeof inv === 'function'
							? inv
							: (key: QueryKey) => {
									const h = JSON.stringify(key)
									return inv.some((k) => JSON.stringify(k) === h)
								}
					client.invalidate(match)
				}
				options.onSuccess?.(data, args)
				return data
			} catch (e) {
				const error = e instanceof Error ? e : new Error(String(e))
				setState((s) => ({ ...s, isLoading: false, error }))
				options.onError?.(error, args)
				throw error
			}
		},
		[client, action],
	)

	return {
		mutate,
		isLoading: state.isLoading,
		error: state.error,
		data: state.data,
	}
}

/** Feature-detect the aggregate extension on a provider. */
function asAggregate(provider: unknown): AggregateProvider | null {
	if (
		provider &&
		typeof (provider as AggregateProvider).count === 'function' &&
		typeof (provider as AggregateProvider).aggregate === 'function'
	) {
		return provider as AggregateProvider
	}
	return null
}

/** Whether the wired provider supports aggregates. Lets a dashboard hide widgets
 * a REST-only backend can't serve. */
export function useSupportsAggregates(): boolean {
	return asAggregate(useDataProvider()) != null
}

/** Count of records matching an optional filter — the count endpoint tasks 38/49
 * need. Cached under a `['count', resource, params]` key. Throws (via the query
 * error state) if the provider has no aggregate support. */
export function useCount(
	resource: string,
	params?: GetListParams,
	options: { enabled?: boolean } = {},
): QueryResult<number> {
	const provider = useDataProvider()
	const client = useQueryClient()
	return useBoundQuery<number>(
		client,
		['count', resource, params ?? {}],
		async () => {
			const agg = asAggregate(provider)
			if (!agg) throw new Error('DataProvider does not support aggregates')
			return agg.count(resource, params)
		},
		options.enabled ?? true,
	)
}

/** A single numeric aggregate (sum/avg/min/max/count) over a column. */
export function useAggregate(
	resource: string,
	op: AggregateOp,
	field: string,
	params?: GetListParams,
	options: { enabled?: boolean } = {},
): QueryResult<number> {
	const provider = useDataProvider()
	const client = useQueryClient()
	return useBoundQuery<number>(
		client,
		['aggregate', resource, op, field, params ?? {}],
		async () => {
			const agg = asAggregate(provider)
			if (!agg) throw new Error('DataProvider does not support aggregates')
			return agg.aggregate(resource, op, field, params)
		},
		options.enabled ?? true,
	)
}
