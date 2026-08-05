/**
 * The host for a channel's bespoke live surface — the thing issue
 * #235 left `OWNED_LIVE_SURFACES` exported with nothing to read it.
 *
 * ## What the seam is, and what this adds
 *
 * `maxstack gen` writes `live/<key>.live.tsx` for every channel that declared
 * `slot: true` and re-exports the registry through the owned-code manifest. What
 * did not exist was anywhere that *renders* one: `project.page.tsx` subscribes
 * derived rows through `useLiveRows`, which updates a table, a board or a
 * calendar — and a bespoke surface is by definition none of those. This module
 * is the missing host, and it is deliberately about twenty lines of behaviour.
 *
 * ## The props are the contract, and the contract is honoured here
 *
 * The stub's `LiveProps` is generated per channel and is **structurally**
 * identical to {@link LiveSurfaceProps} — it has to be, because the registry
 * erases the component's type to `ComponentType<never>` and the host is the only
 * place that can supply props at all. Two consequences are handled here rather
 * than left to every caller:
 *
 *  - **`rows[].id` is a real string.** The generated stub declares `id: string`,
 *    but a channel's projection carries the resource's *primary key column*,
 *    which is not necessarily named `id`. Normalizing it here is what makes the
 *    generated type honest instead of accidentally correct.
 *  - **The registry may not have the key.** A channel declared but never
 *    generated (or generated in a project this build is not serving) renders
 *    nothing, and the caller falls back to the surface it would otherwise have
 *    shown. A missing bespoke surface must degrade to the generic one, never to
 *    a blank page.
 *
 * The agreement between the two type declarations is pinned by a case in
 * `live.agreement.test.ts` rather than by an import: `@maxstack/core`'s emitter
 * cannot import a type out of `apps/web`, so the duplicate is checked instead of
 * deleted — the posture `spec-sprout.ts` takes with `LiveKind`.
 *
 * ## It renders, and that is all it does
 *
 * No store, no registry, no user, no channel object — the same bound the
 * generated stub's header states. The rows arrive already loaded, gated and
 * projected by the ops; presence arrives already expired and capped by the
 * channel. There is nothing here that could widen either.
 */

import type { ComponentType } from 'react'
import { OWNED_LIVE_SURFACES } from '~/owned.generated'
import type { LivePresent } from '~/use-live-presence'

/**
 * The props every generated live surface is written against. Structurally the
 * `LiveProps` interface `emitLiveComponentStub` writes into the user's file.
 */
export interface LiveSurfaceProps {
	rows: { id: string; [field: string]: unknown }[]
	/** Who is here. Empty for a `query` channel — presence is bounded to a row,
	 * and a list is not a row. */
	present: LivePresent[]
	/** True when more people are here than the channel reports by name. */
	truncated: boolean
	/** True while the stream is down and rows are arriving by poll instead. */
	polling: boolean
}

/** Whether a channel key has a filled surface in this build. Exported so a host
 * can decide *between* surfaces before it renders either. */
export function hasLiveSurface(channelKey: string | undefined): boolean {
	return channelKey !== undefined && channelKey in OWNED_LIVE_SURFACES
}

/**
 * Give a row the `id` the generated props promise.
 *
 * The channel's projection includes the primary key column (`projectForLive`),
 * so this is a rename rather than a lookup — and it never removes the original
 * column, because a surface written against the declared column name is written
 * against something the declaration actually says.
 */
export function withRowIds(
	rows: readonly Record<string, unknown>[],
	primaryKey: string,
): LiveSurfaceProps['rows'] {
	return rows.map((row) => ({ ...row, id: String(row[primaryKey]) }))
}

export function LiveSurface({
	channelKey,
	...props
}: LiveSurfaceProps & { channelKey: string }) {
	const Surface = OWNED_LIVE_SURFACES[channelKey] as
		| ComponentType<LiveSurfaceProps>
		| undefined
	if (!Surface) return null
	return <Surface {...props} />
}
