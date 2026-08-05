/**
 * The review-queue view-model — the triage inbox and its dual-view
 * toggle, as a pure fold over gated {@link Issue}s. All ordering and
 * aggregation live here so the React component stays presentational and this
 * stays unit-testable (node vitest); the component receives plain data.
 *
 * The dual view is the epic's punchline: **one ranked list, read from two ends.**
 *   - **product**  orders by `computePriority` score — high-demand asks that are
 *     cheap to serve rise. This is the product roadmap.
 *   - **platform** orders by `costWeight` descending — the asks the platform has
 *     no cheap way to express (off-surface, weight 8) rise to the top. This is
 *     the convenience-library backlog: exactly the demand the moat should absorb
 *     next. Same issues, same scores, inverted lens.
 *
 * Imported only server-side (the workbench loader), so pulling the harness loop
 * functions here never reaches the client bundle — the component imports types.
 */

import {
	deriveProvenanceState,
	type ProvenanceState,
	type ReviewTarget,
} from '@maxstack/spec'
import {
	type Issue,
	issueKey,
	issueToCandidates,
} from '@maxstack/spec-derive/clustering'
import {
	CHANGE_WEIGHTS,
	computePriority,
	type RankedCandidate,
} from '@maxstack/spec-derive/priority'

export type QueueView = 'product' | 'platform'

/** One triage row — an issue, its headline candidate's ranking, and its gate state. */
export interface QueueItem {
	issueId: string
	/** Stable coordinate-set key — what a triage decision is recorded against. */
	key: string
	title: string
	question: string
	rationale: string
	/** The review gate state — drives which accept/reject buttons show. */
	state: ProvenanceState
	targets: ReviewTarget[]
	feedbackCount: number
	/** The top-ranked candidate's score + per-factor breakdown, or null when the
	 *  issue has no proposed candidate yet (baseline clusters). Null sinks last. */
	headline: RankedCandidate | null
	/** Whether the headline candidate carries an actual typed `SpecOp` (issue
	 *  #11's Land step only knows how to apply `spec-op`/`apply-op` changes). */
	landable: boolean
	/** Whether this issue has already been landed (`land.server.ts`) — the UI
	 *  badges it and hides the Land action once true. */
	landed: boolean
}

export interface QueueStats {
	total: number
	byState: Record<ProvenanceState, number>
	/** Issues whose best candidate can only resolve off-surface — the moat gap. */
	moatGap: number
}

export interface ReviewQueueModel {
	view: QueueView
	items: QueueItem[]
	stats: QueueStats
}

const OFF_SURFACE = CHANGE_WEIGHTS['off-surface']

/** The best (highest product-score) candidate for an issue, or null if it has none. */
function headlineOf(issue: Issue): RankedCandidate | null {
	const ranked = computePriority(issueToCandidates(issue))
	return ranked[0] ?? null
}

function toItem(issue: Issue, landedKeys: ReadonlySet<string>): QueueItem {
	const key = issueKey(issue)
	const headline = headlineOf(issue)
	return {
		issueId: issue.id,
		key,
		title: issue.title,
		question: issue.question,
		rationale: issue.rationale,
		state: deriveProvenanceState(issue.provenance),
		targets: issue.targets,
		feedbackCount: issue.feedbackIds.length,
		headline,
		landable:
			headline?.change.kind === 'spec-op' && headline.change.via === 'apply-op',
		landed: landedKeys.has(key),
	}
}

/** Product lens: highest score first; a missing headline sinks to the bottom. */
function byProduct(a: QueueItem, b: QueueItem): number {
	const sa = a.headline?.score ?? -1
	const sb = b.headline?.score ?? -1
	return sb - sa || (a.issueId < b.issueId ? -1 : 1)
}

/** Platform lens: most expensive-to-express first (the moat backlog); ties fall
 *  back to product score. A missing headline (no candidate) sinks to the bottom. */
function byPlatform(a: QueueItem, b: QueueItem): number {
	const ca = a.headline?.factors.costWeight ?? -1
	const cb = b.headline?.factors.costWeight ?? -1
	return (
		cb - ca ||
		(b.headline?.score ?? -1) - (a.headline?.score ?? -1) ||
		(a.issueId < b.issueId ? -1 : 1)
	)
}

const EMPTY_STATE: Record<ProvenanceState, number> = {
	suggested: 0,
	accepted: 0,
	rejected: 0,
	manual: 0,
}

function statsOf(items: readonly QueueItem[]): QueueStats {
	const byState = { ...EMPTY_STATE }
	let moatGap = 0
	for (const it of items) {
		byState[it.state]++
		if (it.headline?.factors.costWeight === OFF_SURFACE) moatGap++
	}
	return { total: items.length, byState, moatGap }
}

/**
 * Fold gated issues into the ranked queue for one view. Pure and deterministic:
 * the same issues + view always produce the same order. Does not mutate input.
 */
export function buildReviewQueue(
	issues: readonly Issue[],
	view: QueueView = 'product',
	landedKeys: ReadonlySet<string> = new Set(),
): ReviewQueueModel {
	const items = issues.map((issue) => toItem(issue, landedKeys))
	items.sort(view === 'platform' ? byPlatform : byProduct)
	return { view, items, stats: statsOf(items) }
}
