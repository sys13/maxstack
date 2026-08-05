/**
 * `maxstack review` — the review queue and bulk decisions, in the terminal
 *.
 *
 * and epic #167: the workbench must never be the only path. Bulk review
 * matters more than most surfaces here, because an agent driving a long unattended
 * session is exactly the situation that produces forty pending proposals — and a
 * queue only a human with a browser can clear is a queue that stays full.
 *
 * The refusals are the same refusals. This does not re-implement risk
 * classification, and it deliberately has no `--all` and no `--force`: the model
 * refuses a high-risk proposal a place in a batch, and a CLI flag that overrode
 * that would make the whole classification decorative.
 */

import {
	applyBulkReview,
	applyOp,
	classifyReviewRisk,
	groupForBulkReview,
	hasGeneratedSinceBatch,
	type OpId,
	type PendingProposal,
	pendingProposals,
	planBulkReview,
	planBulkUndo,
	type ReviewTarget,
	type RiskLevel,
} from '@maxstack/spec'
import { projectGenerationWatermark } from '../lib/generate.ts'
import { landSummary } from '../lib/land.ts'
import { resolveActor, resolveOrigin } from '../lib/origin.ts'
import { loadProject } from '../lib/project.ts'
import { ownershipRiskContext } from '../lib/review-risk.ts'

interface ReviewOptions {
	json?: boolean
	/** `--accept <selector>` / `--reject <selector>` — see {@link selectTargets}. */
	accept?: string
	reject?: string
	/** `--undo <batchId>` — reset every row that batch settled. */
	undo?: string
	origin?: string
	agent?: string
}

const RISK_MARK: Record<RiskLevel, string> = {
	high: '!!',
	medium: ' ~',
	low: '  ',
}

/**
 * Resolve a selector to targets.
 *
 * Two forms, and no third:
 *   `field:e-order`   every pending proposal of that kind under that parent
 *   `fld-total`       one proposal by id
 *
 * There is no `all` selector. A caller that wants every pending proposal has to
 * name the groups, which is the same restraint the pane has: a select-all that
 * grows as an agent proposes more is a rubber stamp with extra steps.
 */
function selectTargets(
	proposals: readonly PendingProposal[],
	selector: string,
): { targets: ReviewTarget[]; unmatched: string[] } {
	const targets: ReviewTarget[] = []
	const unmatched: string[] = []
	for (const token of selector.split(',').map((t) => t.trim())) {
		if (!token) continue
		if (token === 'all' || token === '*') {
			unmatched.push(
				`"${token}" — there is no select-all. Name the groups (e.g. field:e-order) so the batch is a decision rather than a habit.`,
			)
			continue
		}
		const [maybeKind, maybeParent] = token.split(':')
		const byGroup = maybeParent
			? proposals.filter(
					(p) =>
						p.target.kind === maybeKind && p.target.parentId === maybeParent,
				)
			: []
		if (byGroup.length > 0) {
			targets.push(...byGroup.map((p) => p.target))
			continue
		}
		const byId = proposals.filter((p) => p.target.id === token)
		if (byId.length > 0) {
			targets.push(...byId.map((p) => p.target))
			continue
		}
		unmatched.push(`"${token}" — no pending proposal matches`)
	}
	return { targets, unmatched }
}

/** Print the queue, worst risk first. */
function printQueue(proposals: readonly PendingProposal[]): void {
	if (proposals.length === 0) {
		console.log('review queue: empty — every proposal has been decided.')
		return
	}
	const groups = groupForBulkReview(proposals)
	console.log(`review queue: ${proposals.length} pending`)
	for (const group of groups) {
		// N of M, never a binary: one risky field among twenty must not read as
		// "individual review only" for all twenty.
		const flag =
			group.batchableCount === 0
				? 'individual review only'
				: `${group.batchableCount} of ${group.targets.length} batchable as "${group.kind}:${group.parentId ?? ''}"`
		console.log(
			`\n  ${group.label} (${group.targets.length}) · worst risk ${group.risk} · ${flag}`,
		)
		for (const [i, target] of group.targets.entries()) {
			const risk = group.assessments[i]
			console.log(`    ${RISK_MARK[risk?.level ?? 'high']} ${target.id}`)
			for (const finding of risk?.findings ?? []) {
				console.log(`         ${finding.reason}`)
			}
		}
	}
	const attention = proposals.filter((p) => !p.risk.batchable).length
	if (attention > 0) {
		console.log(
			`\n  ${attention} proposal${attention === 1 ? '' : 's'} marked !! cannot be cleared in a batch at any size.`,
		)
	}
}

export async function reviewCommand(
	dir: string | undefined,
	opts: ReviewOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const spec = await project.spec.load()
	// The same ownership facts the workbench reads, through the same derivation.
	// Not optional: without it this surface offered batches the workbench refused for
	// the same five proposals, which makes the risk classification worthless — a
	// reviewer would simply use whichever surface said yes.
	const context = await ownershipRiskContext(project, spec)
	const proposals = pendingProposals(spec, context)

	if (opts.undo) {
		// The undo is honest only while nothing downstream has consumed the
		// decision. Once `gen` has turned those accepted rows into
		// files, resetting the provenance puts the spec back and leaves the
		// artifacts in place — a project in a state neither the spec nor the tree
		// describes. Refusing is the lesser harm, and there is deliberately no flag
		// to override it: the reversal a `--force` would perform is not a reversal.
		const watermark = await projectGenerationWatermark(project)
		if (hasGeneratedSinceBatch(spec, opts.undo, watermark)) {
			console.log(
				`cannot undo batch ${opts.undo}: the project has been generated since it landed.\n` +
					'  Those decisions are already on disk as files, so resetting the rows would\n' +
					'  leave code derived from a decision the spec no longer records.\n' +
					'  Reset the rows individually, then run maxstack gen.',
			)
			return
		}
		const undo = planBulkUndo(spec, opts.undo)
		let next = spec
		let n = 0
		for (const op of undo.ops) {
			next = applyOp(next, op, {
				id: `op-undo-${++n}` as OpId,
				origin: resolveOrigin(opts.origin),
				appliedAt: new Date().toISOString().slice(0, 10),
				actor: {
					...resolveActor({ path: 'cli-review', agent: opts.agent }),
					session: opts.undo,
				},
			})
		}
		await project.spec.save(next)
		console.log(
			`✔ undid batch ${opts.undo}: ${undo.ops.length} row${undo.ops.length === 1 ? '' : 's'} back to undecided`,
		)
		for (const skip of undo.skipped) {
			console.log(`  skipped ${skip.target.id}: ${skip.reason}`)
		}
		return
	}

	const action = opts.accept ? 'accept' : opts.reject ? 'reject' : null
	if (!action) {
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						pending: proposals.length,
						groups: groupForBulkReview(proposals),
						needsAttention: proposals
							.filter((p) => !p.risk.batchable)
							.map((p) => ({ target: p.target, risk: p.risk })),
					},
					null,
					2,
				),
			)
			return
		}
		printQueue(proposals)
		console.log(
			'\n  clear a group:  maxstack review --accept field:e-order' +
				'\n  one proposal:   maxstack review --accept fld-total' +
				'\n  take it back:   maxstack review --undo <batchId>',
		)
		return
	}

	const selector = opts.accept ?? opts.reject ?? ''
	const { targets, unmatched } = selectTargets(proposals, selector)
	for (const problem of unmatched) console.log(`  ${problem}`)
	if (targets.length === 0) {
		console.log('nothing selected — nothing landed.')
		return
	}

	const batchId = `batch-${Date.now().toString(36)}-${targets.length}`
	const plan = planBulkReview(spec, targets, action, batchId, context)

	// The combined effect, stated before it happens — the same sentence the pane
	// puts on its button.
	console.log(plan.combined.summary)
	for (const refusal of plan.refused) {
		console.log(`  refused ${refusal.target.id}: ${refusal.reason}`)
	}
	if (plan.ops.length === 0) {
		console.log('nothing landed.')
		return
	}

	let n = 0
	const next = applyBulkReview(spec, plan, {
		origin: resolveOrigin(opts.origin),
		appliedAt: new Date().toISOString().slice(0, 10),
		actor: resolveActor({ path: 'cli-review', agent: opts.agent }),
		opId: () => `op-${batchId}-${++n}` as OpId,
	})
	await project.spec.save(next)

	console.log(
		`✔ ${action}ed ${plan.ops.length} proposal${plan.ops.length === 1 ? '' : 's'} as batch ${batchId}`,
	)
	console.log(landSummary({ spec: next, accepted: action === 'accept' }))
	console.log(`  take it back:  maxstack review --undo ${batchId}`)
}

/** Re-exported for the MCP tool, which answers the same question. */
export { classifyReviewRisk }
