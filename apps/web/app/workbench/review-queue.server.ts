/**
 * The review-queue host — assembles the live triage inbox for the workbench
 * loader. Ties the loop together server-side:
 *
 *   deriveIssues (issues.server.ts: feedback → cluster → propose → gate)
 *        └─ buildReviewQueue (dual-view rank, landed badges)
 *
 * The clustering/propose details (baseline vs an explicitly-triggered AI
 * snapshot, the heuristic Propose fallback) live in `issues.server.ts`, shared
 * with the Land step (`land.server.ts`) so both derive the *same* Issues from
 * the same feedback — this module only ranks and persists triage.
 */

import { type ReviewDecision, recordDecision } from './issue-review.server'
import { deriveIssues, heuristicPropose } from './issues.server'
import { allLandedKeys } from './land.server'
import {
	buildReviewQueue,
	type QueueView,
	type ReviewQueueModel,
} from './review-queue'

// Re-exported for `review-queue.server.test.ts` (heuristicPropose was
// historically imported from here) and any other existing caller.
export { heuristicPropose }

const DECISIONS: readonly ReviewDecision[] = ['accept', 'reject', 'clear']

/** Parse `?queue=` into a view, defaulting to the product roadmap. */
export function parseQueueView(raw: string | null): QueueView {
	return raw === 'platform' ? 'platform' : 'product'
}

/**
 * Handle a triage submission: one `decision` (accept/reject/clear) applied to
 * every submitted `issueKey` — so the same handler serves a single row and a
 * bulk action, and `clear` is the Undo. Silently ignores an unknown decision.
 */
export async function submitTriage(form: FormData): Promise<void> {
	const decision = String(form.get('decision'))
	if (!DECISIONS.includes(decision as ReviewDecision)) return
	const keys = form.getAll('issueKey').map(String).filter(Boolean)
	for (const key of keys) {
		await recordDecision(key, decision as ReviewDecision)
	}
}

/** Build the live review queue for one view, applying persisted triage and
 *  landed badges. */
export async function loadReviewQueue(
	view: QueueView = 'product',
): Promise<ReviewQueueModel> {
	const issues = await deriveIssues()
	const landed = await allLandedKeys()
	return buildReviewQueue(issues, view, landed)
}
