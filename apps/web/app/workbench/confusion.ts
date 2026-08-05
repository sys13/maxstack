/**
 * Implicit confusion feedback, synthesized from interaction telemetry — the
 * *implicit* arm of the Capture stage.
 *
 * Issue #9 captures feedback a human deliberately gives; this reads it *between
 * the lines* of what the maintainer did. The key insight of the epic is that
 * telemetry and feedback anchor to the **same** {@link ReviewTarget}
 * coordinates — so a churn signal in the interaction log (repeated focus/reject
 * on one node with no resolution) folds cleanly into a `telemetry`-sourced
 * {@link Feedback} row that sits in the exact same queue as an explicit report.
 *
 * Pure and unit-testable, like `telemetry.ts` and `feedback.ts`. The event
 * `targetId` is a bare id (that's all the telemetry log stores), so recovering
 * the full coordinate needs the spec — injected as a {@link resolveTarget} seam
 * rather than reached for here, keeping the fold pure. Today the source is the
 * workbench's own interaction log (the only telemetry that exists); the same
 * fold applies unchanged to end-user runtime telemetry once apps have sessions.
 */

import type { Feedback, ReviewTarget } from '@maxstack/spec'
import type { WorkbenchEvent } from './telemetry'

/** Events that read as *friction* on a node — the raw material of confusion. */
const FRICTION_KINDS: readonly WorkbenchEvent['kind'][] = ['focus', 'reject']

/** Events that read as the user having *found their footing* — they cancel a
 *  node's confusion signal (you don't stay confused about what you just resolved). */
const RESOLUTION_KINDS: readonly WorkbenchEvent['kind'][] = [
	'accept',
	'resolve',
]

export interface ConfusionOptions {
	/** Recover the full coordinate for a telemetry `targetId` (spec lookup in
	 *  prod, a stub in tests); a target that can't be resolved is skipped. */
	resolveTarget: (targetId: string) => ReviewTarget | undefined
	/** Which spec generation these interactions happened against. */
	specVersion: string
	/** Minimum friction events on one node before it reads as confusion (default 3). */
	threshold?: number
}

/** The per-target tally the fold accumulates. */
interface Tally {
	targetId: string
	friction: number
	resolved: boolean
	/** The most recent friction event's timestamp — the synthesized `at`. */
	lastAt: string
}

/**
 * Fold an interaction log into synthesized confusion {@link Feedback}. A node
 * emits one confusion row when it accrued ≥ `threshold` friction events (focus
 * / reject) and was never resolved — sustained fiddling that never landed.
 * Severity scales with the churn: ≥ 2× threshold reads `high`, else `med`.
 * Deterministic given the event order; emits in first-friction-seen order.
 */
export function synthesizeConfusion(
	events: readonly WorkbenchEvent[],
	options: ConfusionOptions,
): Feedback[] {
	const threshold = options.threshold ?? 3
	const tallies = new Map<string, Tally>()

	for (const e of events) {
		const targetId = e.targetId
		if (!targetId) continue
		const tally = tallies.get(targetId) ?? {
			targetId,
			friction: 0,
			resolved: false,
			lastAt: e.at,
		}
		if (FRICTION_KINDS.includes(e.kind)) {
			tally.friction++
			tally.lastAt = e.at
		}
		if (RESOLUTION_KINDS.includes(e.kind)) tally.resolved = true
		tallies.set(targetId, tally)
	}

	const out: Feedback[] = []
	for (const tally of tallies.values()) {
		if (tally.resolved || tally.friction < threshold) continue
		const target = options.resolveTarget(tally.targetId)
		if (!target) continue // can't anchor it → don't fabricate a coordinate
		out.push({
			id: `tel-confusion-${tally.targetId}`,
			at: tally.lastAt,
			source: 'telemetry',
			target,
			kind: 'confusion',
			body: `Synthesized from telemetry: ${tally.friction} focus/reject events on this node with no resolution — likely confusion.`,
			specVersion: options.specVersion,
			severity: tally.friction >= threshold * 2 ? 'high' : 'med',
		})
	}
	return out
}
