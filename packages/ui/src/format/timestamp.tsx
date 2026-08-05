/**
 * A timestamp that renders the same on the server as it does on the first client
 * paint, and only then becomes local.
 *
 * # The bug
 *
 * `Date#toLocaleString()` resolves its locale and time zone from the **runtime**.
 * The Node process that server-renders has one; the browser that hydrates has the
 * viewer's. They disagree on nearly every input:
 *
 *     server:  2026-07-08, 8:00:00 p.m.
 *     client:  7/8/2026, 8:00:00 PM
 *
 * React 19 recovers by throwing the subtree away and client-rendering it, so the
 * final DOM looks right and only the console complains — which is exactly why
 * eight sites shipped with it. It is the same class as #138: **a client-only
 * `render()` can never catch this**, because the differing half is the server
 * snapshot, and a test that only renders on the client never produces one.
 *
 * # The shape
 *
 * `useSyncExternalStore` with a real `getServerSnapshot`, the same pattern
 * `prefs-context.tsx` uses and for the same reason. Three properties, in the order
 * they matter:
 *
 *   1. **The server snapshot and the first client render are byte-identical** —
 *      both are {@link utcStamp}, which pins locale and zone to values neither
 *      runtime can disagree about. Hydration therefore matches by construction
 *      rather than by luck about the runner's `TZ`.
 *   2. **It upgrades after mount** to the viewer's own locale, because a UTC
 *      timestamp is not what someone wants to read about their own audit trail.
 *      The subscribe callback fires once; there is nothing to poll.
 *   3. **The upgrade only ever adds precision.** The `<time dateTime>` attribute
 *      is the ISO string in both states, so machine readers and copy-paste get the
 *      unambiguous value regardless of which paint they caught.
 *
 * A `suppressHydrationWarning` would have been one line and would have hidden the
 * class rather than fixed it — the next instance lands on a subtree with a form in
 * it, React discards that too, and nothing fails.
 */

import { useCallback, useSyncExternalStore } from 'react'

/**
 * How much of the instant to show.
 *
 * It picks *both* renderings together, deliberately. Choosing them separately is
 * how a component ends up server-rendering a datetime and hydrating to a date — no
 * mismatch, because the swap happens after hydration, but a visible flicker from
 * one shape to another. One knob, two coherent outputs.
 */
export type Precision = 'datetime' | 'date'

/**
 * The deterministic form: ISO-ordered, UTC, no locale.
 *
 * `sv-SE` is not a style choice — it is the locale whose date format is already
 * ISO-8601, so this is `2026-07-08 20:00:00` on every runtime without hand-rolling
 * `padStart` arithmetic. The explicit `timeZone` is the load-bearing half: without
 * it, two machines in different zones still disagree.
 */
export function utcStamp(
	iso: string,
	precision: Precision = 'datetime',
): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return iso
	if (precision === 'date')
		return d.toLocaleDateString('sv-SE', { timeZone: 'UTC' })
	return `${d.toLocaleString('sv-SE', { timeZone: 'UTC' })} UTC`
}

/** The viewer's own rendering — only ever used after hydration. */
export function localStamp(
	iso: string,
	precision: Precision = 'datetime',
): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return iso
	return precision === 'date'
		? d.toLocaleDateString(undefined, {
				year: 'numeric',
				month: 'short',
				day: 'numeric',
			})
		: d.toLocaleString()
}

/**
 * Fires once, after mount. There is no external store here — the "change" being
 * subscribed to is *being on the client at all*, which happens exactly once, so
 * the subscribe function has nothing to do and never needs to notify.
 */
const subscribe = () => () => {}

/**
 * Has this component hydrated?
 *
 * Deliberately via `useSyncExternalStore` rather than `useState(false)` +
 * `useEffect`: the effect version renders the server value, then the local value,
 * as two client renders, and React only compares the *first* against the server
 * markup. Both work; only this one states the server snapshot explicitly, which is
 * the thing #138 turned out to hinge on.
 */
function useHydrated(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => true,
		// The server said "not yet", so the first client paint must say it too.
		() => false,
	)
}

export interface TimestampProps {
	/** ISO 8601 instant. Rendered verbatim in `dateTime` whatever the display. */
	iso: string
	/**
	 * Override the local rendering (the post-hydration one only — the server
	 * rendering stays deterministic, which is the point of the component).
	 */
	format?: (iso: string) => string
	/** Date and time (default), or date alone. */
	precision?: Precision
	className?: string
}

export function Timestamp({
	iso,
	format,
	precision = 'datetime',
	className,
}: TimestampProps) {
	const hydrated = useHydrated()
	const render = useCallback(
		(value: string) => (format ? format(value) : localStamp(value, precision)),
		[format, precision],
	)
	return (
		<time dateTime={iso} className={className}>
			{hydrated ? render(iso) : utcStamp(iso, precision)}
		</time>
	)
}
