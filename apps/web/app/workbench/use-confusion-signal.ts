/**
 * Client-side focus-thrash capture — the genuinely-new half of
 * implicit confusion feedback. Server-recorded telemetry today is
 * GET-only (`view`/`focus` stamped once per route load, see `telemetry.ts`'s
 * module note); it can't see a maintainer bouncing in and out of the same
 * field. This hook watches real browser focus/blur events on the focused
 * node's pane and reports the pattern — not every event.
 *
 * Batching by design: nothing is posted per keystroke or per focus/blur. The
 * hook only ever fires one network call per target, the instant the cycle
 * count crosses the threshold (`isFocusThrash` in `confusion-signals.ts`) —
 * signal, not noise, and cheap on the wire. The server applies its own gate
 * again (`submitConfusionSignal` in `workbench.server.ts`) before it ever
 * touches the `Feedback` log, so a tampered or replayed client post below the
 * floor is dropped silently.
 */
import { useCallback, useRef } from 'react'
import { useFetcher } from 'react-router'
import { isFocusThrash } from './confusion-signals'

export interface ConfusionTarget {
	kind: string
	id: string
}

const WINDOW_MS = 30_000
const THRESHOLD = 3

/** Wire the returned `onFocus` onto the pane that renders `target` (React's
 *  synthetic focus event bubbles, unlike the native DOM one, so one handler
 *  on the pane's root element sees every focus inside it). */
export function useConfusionSignal(target: ConfusionTarget | null) {
	const fetcher = useFetcher()
	const timestamps = useRef<number[]>([])
	const trackedKey = useRef<string | null>(null)
	const sentKey = useRef<string | null>(null)
	const key = target ? `${target.kind}:${target.id}` : null

	const onFocus = useCallback(() => {
		if (!target || !key) return
		// A newly-focused node starts a clean slate — thrash is about *this*
		// node, not a running total across the whole session. Checked here
		// (rather than a useEffect) so the reset and the first tick of the new
		// target's tally land in the same handler call, in order.
		if (trackedKey.current !== key) {
			trackedKey.current = key
			timestamps.current = []
		}
		const now = Date.now()
		timestamps.current.push(now)
		if (sentKey.current === key) return // already signaled this target
		if (
			isFocusThrash(timestamps.current, now, {
				windowMs: WINDOW_MS,
				threshold: THRESHOLD,
			})
		) {
			sentKey.current = key
			fetcher.submit(
				{
					intent: 'confusion-signal',
					kind: target.kind,
					id: target.id,
					cycles: String(timestamps.current.length),
				},
				{ method: 'post' },
			)
		}
	}, [target, key, fetcher])

	return { onFocus }
}
