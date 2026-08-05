/**
 * The bulk-review host — the web surface's half of the model in
 * `@maxstack/spec`'s `bulk-review.ts`.
 *
 * Three things live here because they need the world rather than the spec:
 *
 *   - the **ownership facts** the risk model cannot see (which entities and pages
 *     the maintainer has ejected — a disk fact, read from the drift report);
 *   - the **batch id**, which needs randomness;
 *   - the **single persist**, which is what actually makes a batch atomic. The
 *     model folds the ops onto a private chain and never mutates its input; that
 *     is only worth anything if the caller then writes the result once. Two saves
 *     would give the atomicity straight back.
 */

import { pageDescriptor } from '@maxstack/mcp'
import {
	applyBulkReview,
	applyOp,
	type BulkReviewGroup,
	type BulkReviewPlan,
	batchSize,
	groupForBulkReview,
	hasGeneratedSinceBatch,
	isBatchUndoable,
	type OpId,
	type PendingProposal,
	pendingProposals,
	planBulkReview,
	planBulkUndo,
	type ReviewTarget,
	type RiskContext,
	riskContextFromOwnership,
	type SpecSystem,
} from '@maxstack/spec'
import { getPlatform } from '~/sprout.server'
import { loadGenerationWatermark, loadOwnershipDrift } from './drift.server'
import { recordEvent } from './telemetry.server'

/** The actor every bulk write stamps — declared in the write-path registry. */
const BULK_ACTOR = { surface: 'web' as const, path: 'web-bulk-review' }

/**
 * The ownership facts the risk model needs, read from the drift report.
 *
 * The manifest identifies an owned page by its **resource key** (`orders`), not by
 * its page id (`pg-orders`) — so the mapping back to spec ids is rebuilt through
 * `pageDescriptor`, the same function the generator used to mint those keys. That
 * is a deliberate choice over pattern-matching the id: if the key derivation ever
 * changes, this follows it instead of quietly failing to match and reporting
 * everything as unowned, which is the direction that would *lower* risk.
 *
 * A failure returns `{}` — with no `ownershipKnown`, which the risk model reads as
 * "assume everything is owned" and refuses to batch. That direction is the whole
 * point and it is the opposite of the intuitive one: the fields in a `RiskContext`
 * only ever *raise* risk, so an empty context is the most permissive answer
 * available, and a drift-report error returning one would silently unlock a batch.
 */
export async function ownershipContext(spec: SpecSystem): Promise<RiskContext> {
	try {
		const report = await loadOwnershipDrift()
		return riskContextFromOwnership(
			spec,
			report.owned,
			(page) => pageDescriptor(page).resource,
		)
	} catch {
		return {}
	}
}

// ===========================================================================
// Read
// ===========================================================================

export interface BulkReviewView {
	groups: BulkReviewGroup[]
	proposals: PendingProposal[]
	/** Pending proposals that may never be batched — the ones needing attention. */
	needsAttention: PendingProposal[]
	/** The most recent landed batch, when it is still undoable. */
	undoable: { batchId: string; size: number } | null
	/**
	 * The most recent landed batch when it is **no longer** undoable, and why.
	 *
	 * Stated rather than silently dropped: a reviewer who saw the
	 * button a minute ago and does not see it now has learned nothing except that
	 * the UI is unreliable. The expiry has a cause and the cause is actionable.
	 */
	undoWithheld: { batchId: string; size: number; reason: string } | null
}

/**
 * What the bulk-review pane renders: the pending population, grouped worst-risk
 * first, plus whichever batch is still reversible.
 */
export async function loadBulkReview(): Promise<BulkReviewView> {
	const spec = await getPlatform().spec.load()
	const context = await ownershipContext(spec)
	const proposals = pendingProposals(spec, context)
	const latest = latestBatchId(spec)
	// The workbench does not regenerate, but a `maxstack gen` in another terminal
	// leaves a watermark in the ownership manifest, and reading it one loader later
	// is enough. The old code passed the literal `false` here, so the
	// undo stayed on offer after generation had already turned those accepted rows
	// into files — the exact failure #199's undo exists to prevent.
	const generated =
		latest !== null &&
		hasGeneratedSinceBatch(spec, latest, await loadGenerationWatermark())
	const undoable =
		latest && isBatchUndoable(spec, latest, generated)
			? { batchId: latest, size: batchSize(spec, latest) }
			: null
	return {
		groups: groupForBulkReview(proposals),
		proposals,
		needsAttention: proposals.filter((p) => !p.risk.batchable),
		undoable,
		undoWithheld:
			latest && generated
				? {
						batchId: latest,
						size: batchSize(spec, latest),
						reason:
							'the project has been generated since it landed — those decisions are files on disk now',
					}
				: null,
	}
}

/** The most recent batch id in the op log, or null if no batch has landed. */
function latestBatchId(spec: SpecSystem): string | null {
	for (let i = spec.opLog.length - 1; i >= 0; i--) {
		const entry = spec.opLog[i]
		if (entry?.op.op === 'provenance.review' && entry.actor?.session) {
			return entry.actor.session
		}
	}
	return null
}

// ===========================================================================
// Preview
// ===========================================================================

/**
 * Plan a batch without landing it — the combined structural preview.
 *
 * The reviewer sees one summary of what the whole batch does together, plus every
 * target the plan refused and why. Refusals are the important half: a preview that
 * showed only what would happen would let a reviewer confirm 23 and land 20 without
 * noticing the difference.
 */
export async function previewBulkReview(
	targets: readonly ReviewTarget[],
	action: 'accept' | 'reject',
	batchId: string,
): Promise<BulkReviewPlan> {
	const spec = await getPlatform().spec.load()
	return planBulkReview(
		spec,
		targets,
		action,
		batchId,
		await ownershipContext(spec),
	)
}

// ===========================================================================
// Write
// ===========================================================================

/** Parse the multi-select form's `target` entries (`kind:parentId:id`). */
export function parseTargets(form: FormData): ReviewTarget[] {
	const out: ReviewTarget[] = []
	for (const raw of form.getAll('target')) {
		if (typeof raw !== 'string') continue
		const [kind, parentId, id] = raw.split(':')
		if (!kind || !id) continue
		out.push({
			kind: kind as ReviewTarget['kind'],
			id,
			...(parentId ? { parentId } : {}),
		})
	}
	return out
}

export interface BulkReviewResult {
	batchId: string
	landed: number
	refused: BulkReviewPlan['refused']
	summary: string
}

/**
 * Land a bulk decision.
 *
 * One `spec.save` for the whole batch, which is the half of atomicity that lives
 * out here: the model's fold is already all-or-nothing in memory, and persisting it
 * in a single write is what stops a crash mid-batch leaving a spec nobody reviewed.
 *
 * Records **one** telemetry event carrying the batch size, so #201 costs the batch
 * as one engaged decision over N proposals — which is exactly the measurement that
 * shows whether this feature worked.
 */
export async function submitBulkReview(
	form: FormData,
): Promise<BulkReviewResult> {
	const action = form.get('action')
	if (action !== 'accept' && action !== 'reject') {
		throw new Response(`bad bulk action: ${String(action)}`, { status: 400 })
	}
	const targets = parseTargets(form)
	if (targets.length === 0) {
		throw new Response('no targets selected', { status: 400 })
	}

	const platform = getPlatform()
	const spec = await platform.spec.load()
	const batchId = `batch-${crypto.randomUUID()}`
	const plan = planBulkReview(
		spec,
		targets,
		action,
		batchId,
		await ownershipContext(spec),
	)

	if (plan.ops.length > 0) {
		let n = 0
		await platform.spec.save(
			applyBulkReview(spec, plan, {
				origin: 'human',
				appliedAt: platform.now(),
				actor: BULK_ACTOR,
				opId: () => `${platform.nextOpId()}-b${++n}` as OpId,
			}),
		)
		// One event, `batchSize: N`. Per-proposal cost is engaged-time ÷ N, so this
		// is the line that makes bulk review measurable as an improvement.
		await recordEvent(action, {
			targetId: batchId,
			mode: 'bulk',
			batchSize: plan.included.length,
			detail: plan.combined.summary,
		})
	}

	return {
		batchId,
		landed: plan.ops.length,
		refused: plan.refused,
		summary: plan.combined.summary,
	}
}

/**
 * Undo a landed batch: reset every row it settled back to undecided.
 *
 * Re-planned from the op log at undo time rather than from anything remembered, so
 * a row somebody re-decided in between is left alone — the undo takes back the
 * batch's decisions, not whatever the current state happens to be.
 */
export async function submitBulkUndo(form: FormData): Promise<{
	batchId: string
	reset: number
	skipped: number
}> {
	const batchId = form.get('batchId')
	if (typeof batchId !== 'string' || !batchId) {
		throw new Response('missing batchId', { status: 400 })
	}

	const platform = getPlatform()
	const spec = await platform.spec.load()

	// Re-checked here and not only in the loader: the precondition can expire
	// between the render and the click, which is the whole shape of #245. A page
	// held open across a `maxstack gen` still has a live button, and the check
	// that matters is the one on the write.
	if (hasGeneratedSinceBatch(spec, batchId, await loadGenerationWatermark())) {
		throw new Response(
			`cannot undo batch ${batchId}: the project has been generated since it landed, so those decisions are files on disk. Reset the rows individually, then regenerate.`,
			{ status: 409 },
		)
	}

	const undo = planBulkUndo(spec, batchId)

	if (undo.ops.length > 0) {
		let next = spec
		let n = 0
		for (const op of undo.ops) {
			next = applyOp(next, op, {
				id: `${platform.nextOpId()}-u${++n}` as OpId,
				origin: 'human',
				appliedAt: platform.now(),
				// The undo carries the batch id too, so the trail reads as one story:
				// N decisions and their reversal, all under one session.
				actor: { ...BULK_ACTOR, session: batchId },
			})
		}
		await platform.spec.save(next)
	}

	return { batchId, reset: undo.ops.length, skipped: undo.skipped.length }
}
