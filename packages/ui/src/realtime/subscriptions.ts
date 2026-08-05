/**
 * The realtime subscription seam (Plan v5 task 45). A `SubscriptionProvider` is a
 * transport the app implements (polling, SSE, or WebSocket) that pushes change
 * events for a resource; `useSubscription` binds one to the task-33 `QueryClient`
 * so a push *invalidates* the affected queries and the list/detail refresh live —
 * no manual refetch. Kept a thin seam exactly like the data provider: the poll
 * implementation ships here (`createPollingSubscription` over `getList`), and
 * swapping to SSE/WS is one object with no component change.
 */

import { useEffect } from 'react'
import { useDataProvider, useQueryClient } from '../data/data-context.tsx'
import type { DataProvider, RecordId } from '../data/data-provider.ts'
import type { QueryClient, QueryKey } from '../data/query-client.ts'

/** A change pushed by the transport. `ids` narrows the invalidation when known. */
export interface ChangeEvent {
	resource: string
	type: 'created' | 'updated' | 'deleted'
	ids?: RecordId[]
}

/** The transport contract. `subscribe` starts delivering events for `resource`
 * and returns an unsubscribe. */
export interface SubscriptionProvider {
	subscribe(
		resource: string,
		onChange: (event: ChangeEvent) => void,
	): () => void
}

/**
 * Bind a subscription to the cache: on any pushed change for `resource`,
 * invalidate its list + affected `one` queries so observed views refetch. Returns
 * nothing — it's an effect. `enabled: false` pauses it (e.g. tab hidden).
 */
export function useSubscription(
	provider: SubscriptionProvider,
	resource: string,
	options: { enabled?: boolean } = {},
): void {
	const client = useQueryClient()
	const enabled = options.enabled ?? true

	useEffect(() => {
		if (!enabled) return
		const unsubscribe = provider.subscribe(resource, (event) => {
			invalidateForEvent(client, event)
		})
		return unsubscribe
	}, [provider, resource, enabled, client])
}

function invalidateForEvent(client: QueryClient, event: ChangeEvent): void {
	const matchList = (key: QueryKey) =>
		key[0] === 'list' && key[1] === event.resource
	if (event.ids && event.ids.length > 0) {
		const ids = new Set(event.ids.map(String))
		client.invalidate(
			(key) =>
				matchList(key) ||
				(key[0] === 'one' &&
					key[1] === event.resource &&
					ids.has(String(key[2]))),
		)
	} else {
		client.invalidate(
			(key) =>
				matchList(key) || (key[0] === 'one' && key[1] === event.resource),
		)
	}
}

export interface PollingOptions {
	/** Poll interval in ms (default 5000). */
	interval?: number
	/** Field to detect changes on (default `updatedAt`); falls back to a length +
	 * id-set comparison when absent. */
	watchField?: string
	/** Injected timer fns (tests pass fakes; defaults to global setInterval). */
	setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
	clearInterval?: (handle: ReturnType<typeof setInterval>) => void
}

/**
 * A `SubscriptionProvider` that polls `getList` and emits an `updated` event when
 * the result changes — the zero-infrastructure default (no server push needed).
 * A real deployment swaps this for an SSE/WS provider without touching
 * `useSubscription` or any component.
 */
export function createPollingSubscription(
	dataProvider: DataProvider,
	options: PollingOptions = {},
): SubscriptionProvider {
	const interval = options.interval ?? 5000
	const watchField = options.watchField ?? 'updatedAt'
	const setIntervalFn =
		options.setInterval ??
		((fn, ms) => setInterval(fn, ms) as ReturnType<typeof setInterval>)
	const clearIntervalFn = options.clearInterval ?? ((h) => clearInterval(h))

	/** A cheap fingerprint of a list result to detect any change. */
	const fingerprint = (rows: Record<string, unknown>[]): string =>
		`${rows.length}:${rows
			.map((r) => `${r.id}@${watchField in r ? r[watchField] : ''}`)
			.join(',')}`

	return {
		subscribe(resource, onChange) {
			let last: string | null = null
			let stopped = false
			const poll = async () => {
				try {
					const { data } = await dataProvider.getList(resource, {})
					const fp = fingerprint(data)
					if (last !== null && fp !== last && !stopped) {
						onChange({ resource, type: 'updated' })
					}
					last = fp
				} catch {
					// transient fetch error — keep polling
				}
			}
			void poll()
			const handle = setIntervalFn(() => void poll(), interval)
			return () => {
				stopped = true
				clearIntervalFn(handle)
			}
		},
	}
}

/** Convenience: subscribe using a polling transport over the wired data provider,
 * in one hook. `<ResourceList resource>` becomes live with a single line. */
export function usePollingSubscription(
	resource: string,
	options: PollingOptions & { enabled?: boolean } = {},
): void {
	const dp = useDataProvider()
	const client = useQueryClient()
	const enabled = options.enabled ?? true
	const { interval, watchField } = options
	// Recreate the transport only when the interval/field change.
	useEffect(() => {
		if (!enabled) return
		const provider = createPollingSubscription(dp, { interval, watchField })
		const unsubscribe = provider.subscribe(resource, (event) =>
			invalidateForEvent(client, event),
		)
		return unsubscribe
	}, [dp, client, resource, enabled, interval, watchField])
}
