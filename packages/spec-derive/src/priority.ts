/**
 * `computePriority()` — the demand × cost fusion that ranks the review queue
 * (the keystone of the review-&-feedback-loop epic #8, Prioritize
 * stage).
 *
 * The whole point of the epic is that *one* number orders the product backlog
 * and the platform backlog at the same time. The formula:
 *
 *   score = (reach × severity × confidence) / costWeight
 *
 * - **costWeight** is the existing {@link CHANGE_WEIGHTS} from `metrics.ts` —
 *   the same per-kind difficulty table built to measure the platform moat. A
 *   candidate that keeps resolving to `off-surface` (weight 8) is *divided down*
 *   here: it sinks in the product queue precisely because it is expensive, while
 *   the very same weight makes it rise to the top of the platform backlog when
 * the list is read from the other end (dual-view toggle). Product
 *   prioritization and the convenience-library roadmap are the same ranked list.
 * - **reach** is the demand proxy — feedback count / affected sessions (raw
 *   count until the runtime has sessions, per issue #9).
 * - **severity** orders the feedback kinds: `bug > confusion > request`
 *   ({@link SEVERITY_WEIGHTS}); `praise` carries none (not actionable).
 * - **confidence** (0..1) is how sure the clustering step is that
 *   this candidate actually resolves the demand it was folded from.
 *
 * Pure and unit-testable in isolation, exactly like `metrics.ts` — this ships
 * before any capture UI so we can see whether the fused ranking *feels right*
 * before building on it.
 */

import type { ExampleChange } from './types.ts'
import { changeWeight } from './weights.ts'

// Re-exported so consumers of the pure `priority` subpath get the cost
// denominator without pulling the eval barrel (and its node/anthropic deps).
export { CHANGE_WEIGHTS } from './weights.ts'

/**
 * The feedback kinds ordered by actionable severity — `bug > confusion >
 * request`. `praise` scores 0: it is real signal for morale but
 * carries no work to prioritize, so it never lifts a candidate up the queue.
 * Keyed by the `Feedback['kind']` taxonomy so the table doubles as the mapping.
 */
export const SEVERITY_WEIGHTS = {
	bug: 3,
	confusion: 2,
	request: 1,
	praise: 0,
} as const

/** A feedback kind that can drive severity (see {@link SEVERITY_WEIGHTS}). */
export type SeverityKind = keyof typeof SEVERITY_WEIGHTS

/**
 * One candidate competing for the review queue: a proposed change plus the
 * demand signals it was folded from. The change supplies its own `costWeight`
 * for free via {@link changeWeight}.
 */
export interface PriorityCandidate {
	id: string
	/** The candidate change — its kind fixes the cost denominator. */
	change: ExampleChange
	/** Demand proxy: feedback count / affected sessions. Clamped to ≥ 0. */
	reach: number
	/** The most severe feedback kind folded into this candidate. */
	severity: SeverityKind
	/** Clustering's confidence this candidate resolves the demand (0..1). */
	confidence: number
}

/** The per-factor breakdown, so the UI can explain *why* a candidate ranks where it does. */
export interface PriorityFactors {
	/** The demand proxy actually used (clamped). */
	reach: number
	/** The resolved numeric severity weight ({@link SEVERITY_WEIGHTS}). */
	severity: number
	/** The confidence actually used (clamped to 0..1). */
	confidence: number
	/** The cost denominator ({@link changeWeight} of the candidate's change). */
	costWeight: number
}

/** A scored candidate — the score plus the factors that produced it. */
export interface RankedCandidate {
	id: string
	change: ExampleChange
	/** `(reach × severity × confidence) / costWeight`. Higher ranks first. */
	score: number
	factors: PriorityFactors
}

/** Clamp a possibly-dirty demand count to a non-negative finite number. */
function cleanReach(reach: number): number {
	return Number.isFinite(reach) && reach > 0 ? reach : 0
}

/** Clamp confidence into the unit interval (a cluster can't be >100% sure). */
function cleanConfidence(confidence: number): number {
	if (!Number.isFinite(confidence)) return 0
	if (confidence < 0) return 0
	if (confidence > 1) return 1
	return confidence
}

/**
 * Score one candidate against the fusion formula. Pure — the returned
 * {@link RankedCandidate.factors} carry every input that fed the score so the
 * queue UI can render the breakdown without recomputing.
 */
export function scoreCandidate(candidate: PriorityCandidate): RankedCandidate {
	const reach = cleanReach(candidate.reach)
	const severity = SEVERITY_WEIGHTS[candidate.severity]
	const confidence = cleanConfidence(candidate.confidence)
	// costWeight is CHANGE_WEIGHTS (≥ 1), so the divide is always safe.
	const costWeight = changeWeight(candidate.change)
	const score = (reach * severity * confidence) / costWeight
	return {
		id: candidate.id,
		change: candidate.change,
		score,
		factors: { reach, severity, confidence, costWeight },
	}
}

/**
 * Rank the candidates highest-score-first — the review queue's default order.
 * Ties break by raw `reach` (a widely-felt issue beats a niche one at equal
 * score), then by `id` so the sort is total and deterministic (CI-stable, like
 * the rest of the harness). Does not mutate the input.
 */
export function computePriority(
	candidates: readonly PriorityCandidate[],
): RankedCandidate[] {
	return candidates
		.map(scoreCandidate)
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.factors.reach - a.factors.reach ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		)
}
