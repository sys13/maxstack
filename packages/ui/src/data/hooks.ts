/**
 * The typed data-access hooks (Plan v5 task 33) — a react-query-style layer over
 * Sprout's REST + the `QueryClient` cache. `useList`/`useOne` read; `useCreate`/
 * `useUpdate`/`useDelete` write, with **optimistic** cache updates and an
 * **undoable** delete (mutate the cache now, show an undo toast, commit on
 * timeout — react-admin's signature feel). `<ResourceList>`/`<Show>` consume
 * these internally, but they're equally the public API for a hand-written slot:
 * `const { data } = useList('post')` and you have a fetched, cached, paginated
 * list in one line.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { useDataProvider, useQueryClient } from './data-context.tsx'
import type { GetListParams, GetListResult, RecordId } from './data-provider.ts'
import { type NotifyFn, useNotify } from './notifications.tsx'
import type { QueryClient, QueryKey } from './query-client.ts'

/** The primary key hooks assume. Sprout's `from-spec` always names it `id`
 * (a uuid), but a hook can override for a bespoke backend. */
const DEFAULT_ID = 'id'

type AnyRecord = Record<string, unknown>

const listKey = (resource: string, params?: GetListParams): QueryKey => [
	'list',
	resource,
	params ?? {},
]
const oneKey = (resource: string, id: RecordId): QueryKey => [
	'one',
	resource,
	id,
]
const matchList =
	(resource: string) =>
	(key: QueryKey): boolean =>
		key[0] === 'list' && key[1] === resource
const matchResource =
	(resource: string) =>
	(key: QueryKey): boolean =>
		(key[0] === 'list' || key[0] === 'one') && key[1] === resource

// --- read -------------------------------------------------------------------

export interface QueryResult<T> {
	data: T | undefined
	error: Error | undefined
	/** First load with no data yet. */
	isLoading: boolean
	/** Any fetch in flight, including a background refetch. */
	isFetching: boolean
	refetch: () => void
}

/** Internal: bind a React component to a `QueryClient` key + fetcher. */
function useQuery<T>(
	client: QueryClient,
	key: QueryKey,
	fetcher: () => Promise<T>,
	enabled: boolean,
): QueryResult<T> {
	const hash = JSON.stringify(key)
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hash` is the stable identity of `key`; `client` is stable.
	const subscribe = useCallback(
		(cb: () => void) => client.subscribe(key, cb),
		[client, hash],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: same — snapshot depends only on the key's identity.
	const getSnapshot = useCallback(() => client.getState<T>(key), [client, hash])
	const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetch on key change or when enabling; `fetcher` is re-created each render but its request is determined by `key`.
	useEffect(() => {
		if (enabled) client.fetch(key, fetcher)
	}, [client, hash, enabled])

	// biome-ignore lint/correctness/useExhaustiveDependencies: force-refetch the current key.
	const refetch = useCallback(() => {
		client.fetch(key, fetcher, { force: true })
	}, [client, hash])

	return {
		data: state.data,
		error: state.error,
		isLoading: state.status === 'loading',
		isFetching: state.isFetching,
		refetch,
	}
}

export interface UseListResult<T> extends QueryResult<T[]> {
	total: number
}

export function useList<T = AnyRecord>(
	resource: string,
	params?: GetListParams,
	options: { enabled?: boolean } = {},
): UseListResult<T> {
	const dp = useDataProvider()
	const client = useQueryClient()
	const query = useQuery<GetListResult<T>>(
		client,
		listKey(resource, params),
		() => dp.getList(resource, params) as Promise<GetListResult<T>>,
		options.enabled ?? true,
	)
	return {
		data: query.data?.data,
		total: query.data?.total ?? 0,
		error: query.error,
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		refetch: query.refetch,
	}
}

export function useOne<T = AnyRecord>(
	resource: string,
	id: RecordId | undefined,
	options: { enabled?: boolean } = {},
): QueryResult<T> {
	const dp = useDataProvider()
	const client = useQueryClient()
	return useQuery<T>(
		client,
		oneKey(resource, id ?? ''),
		() => dp.getOne(resource, id as RecordId) as Promise<T>,
		(options.enabled ?? true) && id != null,
	)
}

// --- infinite list (task 40's infinite-scroll variant) ------------------------

export interface UseInfiniteListOptions {
	/** Page size (default 25). */
	perPage?: number
	enabled?: boolean
}

export interface UseInfiniteListResult<T> {
	/** Every loaded page, concatenated in order. */
	data: T[]
	total: number
	error: Error | undefined
	/** First page in flight with nothing loaded yet. */
	isLoading: boolean
	/** A further page in flight (`loadMore` was called). */
	isFetchingMore: boolean
	/** Any fetch in flight, including background refetches. */
	isFetching: boolean
	hasMore: boolean
	loadMore: () => void
	/** Force-refetch every loaded page. */
	refetch: () => void
}

/**
 * The accumulating dual of `useList` — feed `<ResourceList onLoadMore hasMore>`
 * (or any load-more UI) with pages that stack instead of replace. Each page is
 * registered in the shared `QueryClient` under the standard list key, so the
 * mutation hooks' optimistic patches (`setQueriesData`) and invalidations hit
 * infinite lists exactly like paged ones. Changing `params` (or `perPage`)
 * resets back to one page.
 *
 * `hasMore` is a heuristic when the backend doesn't report a real total
 * (Sprout's list endpoint returns a bare array): a full last page means "ask
 * again". A reported total (`X-Total-Count`) makes it exact.
 */
export function useInfiniteList<T = AnyRecord>(
	resource: string,
	params?: Omit<GetListParams, 'pagination'>,
	options: UseInfiniteListOptions = {},
): UseInfiniteListResult<T> {
	const dp = useDataProvider()
	const client = useQueryClient()
	const perPage = options.perPage ?? 25
	const enabled = options.enabled ?? true
	// The query's identity: same reset/refetch semantics as useQuery's key hash.
	const baseHash = JSON.stringify([resource, params ?? {}, perPage])
	// The page stack, reset *synchronously* when the query identity changes
	// (derive-during-render, not an effect — an effect would let this render's
	// fetch effect request stale deep pages of the new query first).
	const [pages, setPages] = useState({ hash: baseHash, count: 1 })
	if (pages.hash !== baseHash) setPages({ hash: baseHash, count: 1 })
	const pageCount = pages.hash === baseHash ? pages.count : 1

	// biome-ignore lint/correctness/useExhaustiveDependencies: `baseHash` is the stable identity of `params`/`perPage`.
	const pageParams = useCallback(
		(page: number): GetListParams => ({
			...(params ?? {}),
			pagination: { page, perPage },
		}),
		[baseHash],
	)
	const keys = useMemo(
		() =>
			Array.from({ length: pageCount }, (_, i) =>
				listKey(resource, pageParams(i + 1)),
			),
		[resource, pageParams, pageCount],
	)

	// Bind all page keys through one version counter: any page's state change
	// bumps it, and the derived views below memoize on it.
	const versionRef = useRef(0)
	const subscribe = useCallback(
		(cb: () => void) => {
			const bump = () => {
				versionRef.current++
				cb()
			}
			const unsubs = keys.map((k) => client.subscribe(k, bump))
			return () => {
				for (const u of unsubs) u()
			}
		},
		[client, keys],
	)
	const getVersion = useCallback(() => versionRef.current, [])
	const version = useSyncExternalStore(subscribe, getVersion, getVersion)

	// Fetch whatever isn't landed/in flight (client.fetch de-dupes per key).
	useEffect(() => {
		if (!enabled) return
		keys.forEach((key, i) => {
			client.fetch(key, () => dp.getList(resource, pageParams(i + 1)))
		})
	}, [client, dp, resource, keys, pageParams, enabled])

	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the pages' change counter, not a value the memo reads.
	const states = useMemo(
		() => keys.map((k) => client.getState<GetListResult<T>>(k)),
		[client, keys, version],
	)
	const data = useMemo(
		() => states.flatMap((s) => s.data?.data ?? []),
		[states],
	)
	const total = states.reduce((t, s) => Math.max(t, s.data?.total ?? 0), 0)
	const error = states.find((s) => s.error)?.error
	const isLoading = states[0]?.status === 'loading'
	const isFetchingMore = states.some((s, i) => i > 0 && s.status === 'loading')
	const isFetching = states.some((s) => s.isFetching)
	const lastLoaded = [...states].reverse().find((s) => s.data !== undefined)
	const hasMore =
		lastLoaded?.data != null &&
		(lastLoaded.data.data.length >= perPage || data.length < total)

	const loadMore = useCallback(() => {
		setPages((p) => ({ ...p, count: p.count + 1 }))
	}, [])
	const refetch = useCallback(() => {
		keys.forEach((key, i) => {
			client.fetch(key, () => dp.getList(resource, pageParams(i + 1)), {
				force: true,
			})
		})
	}, [client, dp, resource, keys, pageParams])

	return {
		data,
		total,
		error,
		isLoading,
		isFetchingMore,
		isFetching,
		hasMore,
		loadMore,
		refetch,
	}
}

// --- write ------------------------------------------------------------------

export interface MutationState {
	isLoading: boolean
	error: Error | undefined
}

export interface MutationOptions<T> {
	onSuccess?: (data: T) => void
	onError?: (error: Error) => void
	/** Auto-toast the outcome through `useNotify` (default `true`; a no-op anyway
	 * when no `<NotificationProvider>` is mounted). Set `false` to stay silent —
	 * e.g. when the caller shows its own confirmation. */
	notify?: boolean
	/** Success toast text (defaults per hook: "Created." / "Saved."). */
	successMessage?: string
	/** Error toast text (default: the thrown error's message). */
	errorMessage?: string
}

const IDLE_MUTATION: MutationState = { isLoading: false, error: undefined }

/**
 * What a mutation hook returns: the tuple **and** the named object.
 *
 * `useList` returns `{ data, isLoading, error }`; the mutation hooks returned
 * `[fn, state]`. Two conventions in one module, and the cost is entirely
 * predictable: anyone — human or agent — who reads one example before writing
 * the next pattern-matches off `useList`, writes `const { create } =
 * useCreate(…)`, and discovers the mismatch through a broken render rather than
 * a type error.
 *
 * Either convention is defensible; being both across hooks is what costs. So
 * both *forms of the same value* work here, and the object form — the one
 * `useList` already taught — is the documented one:
 *
 *   const { create, isLoading } = useCreate<Book>('book')   // preferred
 *   const [create, state] = useCreate<Book>('book')         // still fine
 */
export type MutationResult<Fn, Name extends string> = [Fn, MutationState] &
	MutationState &
	Record<Name, Fn>

function mutationResult<Fn, Name extends string>(
	name: Name,
	fn: Fn,
	state: MutationState,
): MutationResult<Fn, Name> {
	const pair = [fn, state] as [Fn, MutationState]
	return Object.assign(pair, { [name]: fn }, state) as MutationResult<Fn, Name>
}

/** Shared success/error toast convention for `useCreate`/`useUpdate` — the write
 * dual of `useDelete`'s undo toast, so every mutation confirms itself. */
function notifyOutcome(
	notify: NotifyFn,
	options: {
		notify?: boolean
		successMessage?: string
		errorMessage?: string
	},
	defaultSuccess: string,
): { success: () => void; failure: (error: Error) => void } {
	const enabled = options.notify !== false
	return {
		success: () => {
			if (enabled)
				notify(options.successMessage ?? defaultSuccess, { type: 'success' })
		},
		failure: (error: Error) => {
			if (enabled)
				notify(options.errorMessage ?? error.message, { type: 'error' })
		},
	}
}

export function useCreate<T = AnyRecord>(resource: string) {
	const dp = useDataProvider()
	const client = useQueryClient()
	const notify = useNotify()
	const [state, setState] = useState<MutationState>(IDLE_MUTATION)

	const create = useCallback(
		async (values: AnyRecord, options: MutationOptions<T> = {}): Promise<T> => {
			const toast = notifyOutcome(notify, options, 'Created.')
			setState({ isLoading: true, error: undefined })
			try {
				const created = (await dp.create(resource, values)) as T
				client.invalidate(matchList(resource))
				setState(IDLE_MUTATION)
				options.onSuccess?.(created)
				toast.success()
				return created
			} catch (e) {
				const error = e instanceof Error ? e : new Error(String(e))
				setState({ isLoading: false, error })
				options.onError?.(error)
				toast.failure(error)
				throw error
			}
		},
		[dp, client, resource, notify],
	)

	return mutationResult('create', create, state)
}

export function useUpdate<T = AnyRecord>(
	resource: string,
	config: { idField?: string } = {},
) {
	const dp = useDataProvider()
	const client = useQueryClient()
	const notify = useNotify()
	const [state, setState] = useState<MutationState>(IDLE_MUTATION)
	const idField = config.idField ?? DEFAULT_ID

	const update = useCallback(
		async (
			id: RecordId,
			values: AnyRecord,
			options: MutationOptions<T> = {},
		): Promise<T> => {
			const toast = notifyOutcome(notify, options, 'Saved.')
			setState({ isLoading: true, error: undefined })
			// Snapshot the single record for rollback, then optimistically patch it
			// plus every cached list. Lists roll back by refetch (invalidate) on error.
			const prevOne = client.getQueryData<T>(oneKey(resource, id))
			client.setQueriesData<GetListResult<AnyRecord>>(
				matchList(resource),
				(old) => {
					if (!old) return old as never
					return {
						...old,
						data: old.data.map((r) =>
							r[idField] === id ? { ...r, ...values } : r,
						),
					}
				},
			)
			client.setQueryData<AnyRecord>(oneKey(resource, id), (old) => ({
				...(old ?? {}),
				...values,
				[idField]: id,
			}))

			try {
				const updated = (await dp.update(resource, id, values)) as T
				client.setQueryData(oneKey(resource, id), () => updated)
				client.invalidate(matchList(resource))
				setState(IDLE_MUTATION)
				options.onSuccess?.(updated)
				toast.success()
				return updated
			} catch (e) {
				// Roll the optimistic patch back.
				if (prevOne !== undefined)
					client.setQueryData(oneKey(resource, id), () => prevOne)
				client.invalidate(matchList(resource))
				const error = e instanceof Error ? e : new Error(String(e))
				setState({ isLoading: false, error })
				options.onError?.(error)
				toast.failure(error)
				throw error
			}
		},
		[dp, client, resource, idField, notify],
	)

	return mutationResult('update', update, state)
}

export type DeleteMode = 'pessimistic' | 'optimistic' | 'undoable'

export interface DeleteOptions extends MutationOptions<{ id: RecordId }> {
	mode?: DeleteMode
	/** Undoable-mode commit delay / toast duration in ms (default 5000). */
	undoDelay?: number
	/** Undoable-mode toast text (default `"Deleted."`). */
	undoMessage?: string
}

export function useDelete(resource: string, config: { idField?: string } = {}) {
	const dp = useDataProvider()
	const client = useQueryClient()
	const notify = useNotify()
	const [state, setState] = useState<MutationState>(IDLE_MUTATION)
	const idField = config.idField ?? DEFAULT_ID

	/** Optimistically drop the row from every cached list; return a restore fn.
	 * Restore is a refetch (invalidate) rather than a captured snapshot — the
	 * server is the source of truth, and this also reconciles any concurrent
	 * change made during the undo window. */
	const removeFromLists = useCallback(
		(id: RecordId): (() => void) => {
			client.setQueriesData<GetListResult<AnyRecord>>(
				matchList(resource),
				(old) => {
					if (!old) return old as never
					if (!old.data.some((r) => r[idField] === id)) return old
					return {
						data: old.data.filter((r) => r[idField] !== id),
						total: Math.max(0, old.total - 1),
					}
				},
			)
			return () => client.invalidate(matchList(resource))
		},
		[client, resource, idField],
	)

	const remove = useCallback(
		async (id: RecordId, options: DeleteOptions = {}): Promise<void> => {
			const mode = options.mode ?? 'pessimistic'

			if (mode === 'pessimistic') {
				setState({ isLoading: true, error: undefined })
				try {
					await dp.delete(resource, id)
					client.invalidate(matchResource(resource))
					setState(IDLE_MUTATION)
					options.onSuccess?.({ id })
				} catch (e) {
					const error = e instanceof Error ? e : new Error(String(e))
					setState({ isLoading: false, error })
					options.onError?.(error)
					throw error
				}
				return
			}

			// optimistic + undoable both drop the row from the UI immediately.
			const restore = removeFromLists(id)

			const commit = async () => {
				setState({ isLoading: true, error: undefined })
				try {
					await dp.delete(resource, id)
					client.invalidate(matchResource(resource))
					setState(IDLE_MUTATION)
					options.onSuccess?.({ id })
				} catch (e) {
					restore()
					const error = e instanceof Error ? e : new Error(String(e))
					setState({ isLoading: false, error })
					options.onError?.(error)
				}
			}

			if (mode === 'optimistic') {
				await commit()
				return
			}

			// undoable: hold the delete for `undoDelay`; the toast's Undo restores.
			const delay = options.undoDelay ?? 5000
			let undone = false
			const timer = setTimeout(() => {
				if (!undone) void commit()
			}, delay)
			notify(options.undoMessage ?? 'Deleted.', {
				type: 'info',
				undoable: true,
				duration: delay,
				onUndo: () => {
					undone = true
					clearTimeout(timer)
					restore()
				},
			})
		},
		[dp, client, resource, notify, removeFromLists],
	)

	return mutationResult('remove', remove, state)
}
