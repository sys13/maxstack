/**
 * The client half of a declared `presence` channel, given a host by
 * issue #236.
 *
 * ## Why this is a POST loop and not a stream
 *
 * SSE is one-directional, which is the honest cost of the transport choice
 * `api.live.$key.tsx` records. A presence entry has to be *refreshed* — a tab
 * that crashed sends no goodbye, and the only thing that removes it is the TTL
 * the declaration names — so the client has to talk, and the way it talks is a
 * tiny `POST`. The response is the current list, so one request both keeps the
 * entry alive and reads the room; there is no second endpoint and no second
 * shape that could disagree with it.
 *
 * ## The identity is never sent
 *
 * Deliberately absent from every request this makes. The server derives it from
 * the session (`liveIdentityOf`), because a client that could name its own
 * presence identity could name somebody else's, and "who is viewing this" would
 * become "who says they are viewing this".
 *
 * ## The interval beats the TTL, and that is arithmetic rather than a guess
 *
 * A heartbeat slower than the declared TTL produces a list that flickers: the
 * entry expires between beats and everybody watching sees people leave and
 * rejoin. A third of the TTL means two beats may be lost before an entry does,
 * which is the ordinary amount of packet loss rather than an unusual amount.
 */

import { useEffect, useState } from 'react'

/** One entry: an identity and a join time. There is nothing else on it. */
export interface LivePresent {
	identity: string
	since: number
}

export interface LivePresenceState {
	present: LivePresent[]
	/** True when more people are here than the channel reports by name. */
	truncated: boolean
}

/** The floor on the heartbeat interval, so a 1-second TTL cannot ask a browser
 * for three requests a second. */
const MIN_HEARTBEAT_MS = 5_000

/** How often to beat, given the declared TTL. See the module comment. */
export function heartbeatIntervalMs(ttlSeconds: number | undefined): number {
	if (!ttlSeconds || ttlSeconds <= 0) return MIN_HEARTBEAT_MS
	return Math.max(MIN_HEARTBEAT_MS, Math.round((ttlSeconds * 1000) / 3))
}

/**
 * Join a presence channel for one row, and report who else is here.
 *
 * `channelKey` being `undefined` costs nothing and makes no request — the same
 * opt-in shape `useLiveRows` has, for the same reason: a page with no declared
 * channel must not pay for the feature.
 *
 * The `DELETE` on unmount is the clean-tab-close path. It is best-effort by
 * construction — a closing tab may never send it — which is exactly why the TTL
 * exists and why this is an optimization rather than the mechanism.
 */
export function useLivePresence(
	channelKey: string | undefined,
	rowId: string | undefined,
	ttlSeconds?: number,
): LivePresenceState {
	const [state, setState] = useState<LivePresenceState>({
		present: [],
		truncated: false,
	})

	useEffect(() => {
		if (!channelKey || !rowId || typeof window === 'undefined') return
		const url = `/api/live/${encodeURIComponent(channelKey)}?row=${encodeURIComponent(rowId)}`
		let stopped = false

		const beat = async () => {
			try {
				const res = await fetch(url, { method: 'POST' })
				if (!res.ok || stopped) return
				const body = (await res.json()) as LivePresenceState
				setState({
					present: body.present ?? [],
					truncated: body.truncated ?? false,
				})
			} catch {
				// A failed beat is a beat: the entry expires on the server's own TTL and
				// the next one re-joins. Surfacing a transport blip as "nobody is here"
				// would be a worse lie than a slightly stale list.
			}
		}

		void beat()
		const timer = setInterval(
			() => void beat(),
			heartbeatIntervalMs(ttlSeconds),
		)
		return () => {
			stopped = true
			clearInterval(timer)
			void fetch(url, { method: 'DELETE' }).catch(() => {})
		}
	}, [channelKey, rowId, ttlSeconds])

	return state
}
