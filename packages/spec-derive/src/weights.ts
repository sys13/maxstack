/**
 * The per-kind difficulty table, and the cost denominator built on it.
 *
 * A change is not one unit of work. Landing a typed spec-op is cheap; filling a
 * slot costs a component; ejecting costs a file you now own forever; an ask the
 * platform has no seam for costs the most of all. `changeWeight` turns that
 * ordering into a number.
 *
 * **What the number measures is ownership** — what stops regenerating, and what
 * the system stops understanding about your app — rather than how long the edit
 * took to write. Those two used to rise together and no longer do, now that
 * agents author most changes. Ownership is the one that keeps costing after the
 * change lands, so it is the one that should sink a candidate in the queue.
 *
 * Settled 2026-08-10; the internal corpus scale in `@maxstack/benchmarks` is
 * kept in step with this table deliberately, since two tables of the same name
 * disagreeing is worse than either value being wrong.
 *
 * It lives beside `priority.ts` because that is what consumes it: the review
 * queue divides demand by cost, so an expensive candidate sinks in the product
 * queue precisely because it is expensive.
 */

import type { ExampleChange } from './types.ts'

/**
 * Normalized **ownership** cost per change kind. The keys are the `kind`
 * (`:via` for spec ops) so the table doubles as documentation.
 *
 * A spec op costs 1 whether it was a typed op or a reviewed regeneration diff —
 * both edit the spec, and neither leaves anything behind that the system stops
 * understanding. A slot fill costs 3: code now exists that the system cannot
 * read, though the file around it still regenerates. An eject costs 5: a whole
 * file stops regenerating and is yours from then on. An off-surface ask costs 8:
 * no op and no slot, so there was no seam to land in — the most expensive class,
 * and the moat gap.
 */
export const CHANGE_WEIGHTS = {
	'spec-op:apply-op': 1,
	'spec-op:regen-diff': 1,
	'slot-fill': 3,
	eject: 5,
	'off-surface': 8,
} as const

/** The difficulty weight of one change (see {@link CHANGE_WEIGHTS}). */
export function changeWeight(change: ExampleChange): number {
	if (change.kind === 'spec-op') {
		return change.via === 'apply-op'
			? CHANGE_WEIGHTS['spec-op:apply-op']
			: CHANGE_WEIGHTS['spec-op:regen-diff']
	}
	if (change.kind === 'slot-fill') return CHANGE_WEIGHTS['slot-fill']
	if (change.kind === 'off-surface') return CHANGE_WEIGHTS['off-surface']
	return CHANGE_WEIGHTS.eject
}

/**
 * The change kinds the ladder does **not** absorb cheaply: the maintainer either
 * took whole-file ownership (`eject`) or got no help at all (`off-surface`).
 * Their summed weight is the corpus's **residual difficulty** — the quantity
 * #180's rising bar refuses to let fall by editing the backlog.
 */
export function isResidual(kind: ExampleChange['kind']): boolean {
	return kind === 'eject' || kind === 'off-surface'
}
