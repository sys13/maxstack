/**
 * Shared Issue derivation — the exact
 * feedback → cluster → propose → gate fold both the review-queue loader
 * and the Land step need, kept in one place so they can never drift
 * (e.g. Land resolving a candidate against a differently-clustered Issue than
 * the one a maintainer actually saw and accepted).
 *
 * Split out of `review-queue.server` to avoid an import cycle: `land.server`
 * needs this same derivation, and `review-queue.server` needs `land.server`'s
 * `allLandedKeys` to badge landed rows — this module sits below both.
 */

import { type ReviewTarget, targetKey } from '@maxstack/spec'
import type { ExampleChange } from '@maxstack/spec-derive'
import {
	clusterFeedback,
	groupByTarget,
	type Issue,
	type ProposeFn,
} from '@maxstack/spec-derive/clustering'
import { loadAiClusterSnapshot } from './ai-cluster.server'
import { sourceFeedback } from './feedback-source.server'
import { applyDecisions, loadDecisions } from './issue-review.server'

/** Coordinate kinds whose asks the platform can usually express as a spec edit. */
const EXPRESSIBLE_KINDS: ReadonlySet<ReviewTarget['kind']> = new Set([
	'field',
	'entity',
	'tier',
])

/**
 * The heuristic Propose baseline: a field/entity/tier ask with no bug reads as
 * expressible via a regeneration-as-diff edit (cost 2); anything else reads as
 * off-surface (cost 8, the moat gap). Honest and constructible (no fabricated
 * spec ops).
 */
export const heuristicPropose: ProposeFn = (folded): ExampleChange[] => {
	const first = folded[0]
	if (!first) return []
	const target = first.target
	const key = targetKey(target)
	const hasBug = folded.some((f) => f.kind === 'bug')
	const expressible = EXPRESSIBLE_KINDS.has(target.kind) && !hasBug
	if (expressible) {
		return [
			{
				id: `cand-${key}`,
				description: `Adjust ${key} to address the feedback`,
				kind: 'spec-op',
				via: 'regen-diff',
				edit: { resource: target.parentId ?? target.id, title: target.id },
			},
		]
	}
	return [
		{
			id: `cand-${key}`,
			description: `No typed op for ${key} yet — off-surface`,
			kind: 'off-surface',
			resource: target.id,
			resolution: 'unexpressible',
		},
	]
}

/**
 * The live Issue set: feedback (captured, else demo) → clustered (an explicit
 * AI run's snapshot if one exists, else the always-on `groupByTarget`
 * baseline) → propose-filled → gated by persisted triage decisions. The same
 * fold `loadReviewQueue` and `landIssueCandidate` both build on.
 */
export async function deriveIssues(): Promise<Issue[]> {
	const feedback = await sourceFeedback()
	const aiClusters = await loadAiClusterSnapshot()
	const clustered = await clusterFeedback(feedback, {
		cluster: aiClusters ? () => aiClusters : groupByTarget,
		propose: heuristicPropose,
	})
	return applyDecisions(clustered, await loadDecisions())
}
