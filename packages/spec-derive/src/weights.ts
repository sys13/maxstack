/**
 * The per-kind difficulty table, and the cost denominator built on it.
 *
 * A change is not one unit of work. Landing a typed spec-op is cheap; filling a
 * slot costs a component; ejecting costs a file you now own forever; an ask the
 * platform has no seam for costs the most of all. `changeWeight` turns that
 * ordering into a number.
 *
 * It lives beside `priority.ts` because that is what consumes it: the review
 * queue divides demand by cost, so an expensive candidate sinks in the product
 * queue precisely because it is expensive.
 */

import type { ExampleChange } from './types.ts'

/**
 * Normalized difficulty weight per change kind. The keys are the `kind`
 * (`:via` for spec ops) so the table doubles as documentation.
 *
 * A typed spec op costs 1 (fully expressed as an op); a regeneration-as-diff
 * edit costs 2 (agent produced a reviewed diff); a slot fill costs 3 (the user
 * writes code into a slot); an eject costs 5 (the user takes whole-file
 * ownership and pays the eject tax); an off-surface ask costs 8 (the platform
 * gave no op and no slot, so the maintainer was forced off the surface with no
 * guidance — the most expensive class, and the moat gap).
 */
export const CHANGE_WEIGHTS = {
	'spec-op:apply-op': 1,
	'spec-op:regen-diff': 2,
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
