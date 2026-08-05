/**
 * A minimal, dependency-free query cache — the substrate the typed data hooks
 * (`useList`/`useOne`/`useCreate|Update|Delete`, Plan v5 task 33) are built on.
 * It is deliberately a tiny fraction of react-query: cache by serialized key,
 * de-dupe in-flight fetches, notify subscribers on change, and support the two
 * things the mutation hooks need — direct cache writes (optimistic updates) and
 * invalidation (refetch what's on screen).
 *
 * It is framework-agnostic on purpose: React binds to it through
 * `useSyncExternalStore` in `hooks.ts`, but the store itself has no React
 * import, which is what makes it straightforward to unit-test.
 */

export type QueryKey = readonly unknown[]

/** Stable string hash of a key. Objects are serialized with sorted keys so
 * `{ a, b }` and `{ b, a }` collide (params order must not fork the cache). */
export function serializeKey(key: QueryKey): string {
	return JSON.stringify(key, (_, value) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: value,
	)
}

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error'

export interface QueryState<T = unknown> {
	status: QueryStatus
	data?: T
	error?: Error
	/** True while a fetch is in flight (including a background refetch that
	 * already has `data`). `status === 'loading'` is the first-load subset. */
	isFetching: boolean
	updatedAt?: number
}

const IDLE: QueryState = Object.freeze({ status: 'idle', isFetching: false })

interface Entry {
	key: QueryKey
	state: QueryState
	listeners: Set<() => void>
	promise?: Promise<unknown>
	fetcher?: () => Promise<unknown>
}

export class QueryClient {
	private readonly entries = new Map<string, Entry>()

	private ensure(key: QueryKey): Entry {
		const hash = serializeKey(key)
		let entry = this.entries.get(hash)
		if (!entry) {
			entry = { key, state: IDLE, listeners: new Set() }
			this.entries.set(hash, entry)
		}
		return entry
	}

	getState<T>(key: QueryKey): QueryState<T> {
		return (this.entries.get(serializeKey(key))?.state ?? IDLE) as QueryState<T>
	}

	getQueryData<T>(key: QueryKey): T | undefined {
		return this.getState<T>(key).data
	}

	private setState(entry: Entry, patch: Partial<QueryState>): void {
		entry.state = { ...entry.state, ...patch }
		for (const listener of entry.listeners) listener()
	}

	/** Subscribe to a key's state. Creating the entry here (rather than on read)
	 * keeps `getState` side-effect-free, which `useSyncExternalStore` requires. */
	subscribe(key: QueryKey, listener: () => void): () => void {
		const entry = this.ensure(key)
		entry.listeners.add(listener)
		return () => {
			entry.listeners.delete(listener)
			// GC an idle, unobserved entry so a remount refetches from scratch.
			if (entry.listeners.size === 0 && !entry.promise)
				this.entries.delete(serializeKey(key))
		}
	}

	/** Fetch (de-duped). A second call while one is in flight returns the same
	 * promise unless `force` — that's how invalidation triggers a real refetch. */
	fetch<T>(
		key: QueryKey,
		fetcher: () => Promise<T>,
		opts: { force?: boolean } = {},
	): Promise<T> {
		const entry = this.ensure(key)
		entry.fetcher = fetcher as () => Promise<unknown>
		if (entry.promise && !opts.force) return entry.promise as Promise<T>
		// Only a fresh entry shows `loading`; a refetch keeps its data on screen.
		this.setState(entry, {
			isFetching: true,
			status: entry.state.data === undefined ? 'loading' : entry.state.status,
		})
		const promise = fetcher()
			.then((data) => {
				this.setState(entry, {
					status: 'success',
					data,
					error: undefined,
					isFetching: false,
					updatedAt: Date.now(),
				})
				return data
			})
			.catch((error: unknown) => {
				this.setState(entry, {
					status: 'error',
					error: error instanceof Error ? error : new Error(String(error)),
					isFetching: false,
				})
				throw error
			})
			.finally(() => {
				if (entry.promise === promise) entry.promise = undefined
			})
		entry.promise = promise
		return promise as Promise<T>
	}

	/** Write a key's data directly — the optimistic-update primitive. The updater
	 * receives the current data (may be `undefined`). No-ops if the key is
	 * unobserved (nothing to update, nothing cached to be stale). */
	setQueryData<T>(key: QueryKey, updater: (old: T | undefined) => T): void {
		const hash = serializeKey(key)
		const entry = this.entries.get(hash)
		if (!entry) return
		this.setState(entry, {
			data: updater(entry.state.data as T | undefined),
			status: 'success',
		})
	}

	/** Bulk variant of {@link setQueryData} across every entry whose key matches
	 * — used to patch a mutated row into all currently-cached list pages. */
	setQueriesData<T>(
		match: (key: QueryKey) => boolean,
		updater: (old: T | undefined) => T,
	): void {
		for (const entry of this.entries.values()) {
			if (match(entry.key))
				this.setState(entry, {
					data: updater(entry.state.data as T | undefined),
				})
		}
	}

	/** Refetch every observed matching query; drop unobserved ones so they
	 * refetch on next mount. This is how a mutation reconciles the cache. */
	invalidate(match: (key: QueryKey) => boolean): void {
		for (const [hash, entry] of this.entries) {
			if (!match(entry.key)) continue
			if (entry.listeners.size > 0 && entry.fetcher) {
				this.fetch(entry.key, entry.fetcher, { force: true })
			} else {
				this.entries.delete(hash)
			}
		}
	}
}
