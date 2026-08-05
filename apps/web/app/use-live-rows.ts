/**
 * The client half of a declared live channel — the hook every
 * derived surface uses to stop being a snapshot.
 *
 * ## What it is deliberately not
 *
 * **Not a state manager and not a merge algorithm.** It keeps an ordered list of
 * rows and replaces or drops one when a message names it. There is no conflict
 * resolution here beyond last-write-wins, by recorded decision
 * (`d-live-last-write-wins`): a `row` message is the row, and it wins. If two
 * people edited the same field, the server already decided which write landed,
 * and inventing a client-side reconciliation would be a second, unreviewed
 * answer to the same question.
 *
 * **Not a source of truth.** The loader's rows are. This hook starts from them
 * and re-seeds from them whenever they change, so a navigation, a revalidation
 * or a form submission always wins over whatever the stream had accumulated.
 *
 * ## The fallback is the point
 *
 * `EventSource` gives us reconnection for free, but reconnection is not enough:
 * the channel may be **paused**, over its **subscriber ceiling**, or the caller
 * may have been **shed** for exceeding its rate. In all three the server closes
 * with a stated reason, and reconnecting in a loop would be the worst possible
 * response — it is the failure mode where a shed client re-establishes a
 * connection it was just told to stop making.
 *
 * So a stated close switches to polling `?poll=1`, which is the *same op with
 * the same bound* on the server (`pollLive` → `opList`). The surface gets slower
 * and stays correct. `permission-revoked` is the exception: it stops entirely,
 * because polling would fail the identical check.
 */

import { useEffect, useRef, useState } from 'react'

/** A row as a live surface handles it: whatever the projection sent, plus an id. */
export type LiveRow = Record<string, unknown>

interface LiveState {
	rows: LiveRow[]
	/** True while the stream is down and rows are arriving by poll instead. */
	polling: boolean
	/** The last stated close reason, for a surface that wants to say why. */
	closed?: string
}

/** How long between polls when the stream is unavailable. Matches the server's. */
const POLL_INTERVAL_MS = 5_000

/** Merge one pushed row into an ordered list, replacing in place if present. */
function upsert(rows: LiveRow[], primaryKey: string, next: LiveRow): LiveRow[] {
	const id = next[primaryKey]
	const at = rows.findIndex((r) => r[primaryKey] === id)
	if (at === -1) return [...rows, next]
	const copy = [...rows]
	copy[at] = next
	return copy
}

/**
 * Subscribe a derived surface to a declared channel.
 *
 * `channelKey` being `undefined` is the common case and costs nothing: the hook
 * returns the loader's rows unchanged and opens no connection, which is what
 * makes declaring a channel opt-in rather than a tax every page pays.
 */
export function useLiveRows(
	initial: LiveRow[],
	primaryKey: string,
	channelKey: string | undefined,
	opts: { scope?: string | undefined } = {},
): LiveState {
	const [state, setState] = useState<LiveState>({
		rows: initial,
		polling: false,
	})
	// The loader is the source of truth. Re-seeding on every change is what makes
	// a navigation or a revalidation win over accumulated stream state.
	const seed = useRef(initial)
	useEffect(() => {
		seed.current = initial
		setState((s) => ({ ...s, rows: initial }))
	}, [initial])

	useEffect(() => {
		if (!channelKey || typeof window === 'undefined') return
		const query = opts.scope ? `?scope=${encodeURIComponent(opts.scope)}` : ''
		const url = `/api/live/${encodeURIComponent(channelKey)}${query}`
		let source: EventSource | undefined
		let timer: ReturnType<typeof setInterval> | undefined
		let stopped = false

		const poll = async () => {
			const sep = query ? '&' : '?'
			const res = await fetch(`${url}${sep}poll=1`)
			if (!res.ok || stopped) return
			const body = (await res.json()) as { rows: LiveRow[] }
			setState((s) => ({ ...s, rows: body.rows, polling: true }))
		}

		const fallBackToPolling = (reason?: string) => {
			source?.close()
			source = undefined
			if (stopped || timer) return
			setState((s) => ({
				...s,
				polling: true,
				...(reason ? { closed: reason } : {}),
			}))
			void poll()
			timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
		}

		source = new EventSource(url)
		source.onmessage = (event) => {
			const message = JSON.parse(event.data) as
				| { type: 'row'; id: string; row: LiveRow }
				| { type: 'remove'; id: string }
				| { type: 'presence' }
			setState((s) => {
				if (message.type === 'row')
					return { ...s, rows: upsert(s.rows, primaryKey, message.row) }
				if (message.type === 'remove')
					return {
						...s,
						rows: s.rows.filter((r) => r[primaryKey] !== message.id),
					}
				return s
			})
		}
		// A STATED close. Reconnecting here would be the worst possible response —
		// a shed client re-establishing the connection it was just told to stop
		// making — so this switches to polling instead. Except for a revoked
		// permission, where polling would fail the identical check.
		source.addEventListener('close', (event) => {
			const { reason } = JSON.parse((event as MessageEvent).data) as {
				reason: string
			}
			if (reason === 'permission-revoked') {
				stopped = true
				source?.close()
				setState((s) => ({ ...s, polling: false, closed: reason }))
				return
			}
			fallBackToPolling(reason)
		})
		// An unstated error is a transport problem. `EventSource` retries on its
		// own, so this does NOT close the source — it starts polling alongside, and
		// the poll simply stops mattering once the stream comes back.
		source.onerror = () => setState((s) => ({ ...s, polling: true }))

		return () => {
			stopped = true
			source?.close()
			if (timer) clearInterval(timer)
		}
	}, [channelKey, primaryKey, opts.scope])

	return state
}
