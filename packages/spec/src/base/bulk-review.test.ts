/**
 * Bulk review.
 *
 * The tests that matter here are the refusals. A bulk accept is the most dangerous
 * button in the product — it is the one that makes not-looking efficient — so what
 * needs pinning is not that it clears twenty field additions, but that it *cannot*
 * clear the access-control field, the portal-exposed entity, the flag, or the thing
 * this code has never heard of.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import {
	applyBulkReview,
	batchSize,
	classifyReviewRisk as classifyWithContext,
	groupForBulkReview,
	hasGeneratedSinceBatch,
	isBatchUndoable,
	pendingProposals as pendingWithContext,
	planBulkUndo,
	planBulkReview as planWithContext,
	type RiskContext,
	riskContextFromOwnership,
} from './bulk-review.ts'
import type { OpId } from './ids.ts'
import type { PortalSpec } from './portals.ts'
import { manual, suggested } from './provenance.ts'
import {
	type ApplyMeta,
	applyOp,
	type ReviewTarget,
	validateOp,
} from './spec-ops.ts'
import { collectSpecSystemErrors } from './spec-system.schema.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

const META: Omit<ApplyMeta, 'id'> = {
	origin: 'ai',
	appliedAt: '2026-07-29',
	actor: { surface: 'harness', path: 'bulk-review-test' },
}

let n = 0
const meta = (): ApplyMeta => ({ ...META, id: `op-b${++n}` as OpId })

/**
 * "We read the manifest and nothing is owned."
 *
 * The default for these tests, and it has to be stated rather than omitted: an
 * omitted context means *unknown* ownership, which the model treats as "assume
 * owned" and refuses to batch. That asymmetry is deliberate (see `RiskContext`)
 * and it is why these three wrappers exist — passing `{}` everywhere would have
 * quietly turned every batching test into a test of the refusal path.
 */
const KNOWN: RiskContext = {
	ownedEntityIds: [],
	ownedPageIds: [],
	ownershipKnown: true,
}

const classifyReviewRisk = (
	spec: SpecSystem,
	target: ReviewTarget,
	context: RiskContext = KNOWN,
) => classifyWithContext(spec, target, context)

const pendingProposals = (spec: SpecSystem, context: RiskContext = KNOWN) =>
	pendingWithContext(spec, context)

const planBulkReview = (
	spec: SpecSystem,
	targets: readonly ReviewTarget[],
	action: Parameters<typeof planWithContext>[2],
	batchId: string,
	context: RiskContext = KNOWN,
) => planWithContext(spec, targets, action, batchId, context)

/** The batch meta `applyBulkReview` takes. */
const batchMeta = {
	origin: 'human' as const,
	appliedAt: '2026-07-29',
	actor: { surface: 'web' as const, path: 'web-bulk-review' },
	opId: (i: number) => `op-batch-${i}`,
}

/**
 * A spec with a realistic mixture: an internal entity carrying plain fields and
 * one access-control-shaped field, a page with blocks, a portal-exposed entity, a
 * flag, and one hand-authored field nothing may touch.
 */
function fixture(): SpecSystem {
	let spec = newSpecSystem(tasklyPRD)
	spec = applyOp(
		spec,
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-order',
					name: 'Order',
					provenance: suggested(),
					fields: [
						{
							id: 'fld-total',
							name: 'total',
							type: 'number',
							required: true,
							provenance: suggested(),
						},
						{
							id: 'fld-notes',
							name: 'notes',
							type: 'string',
							required: false,
							provenance: suggested(),
						},
						{
							id: 'fld-role',
							name: 'viewerRole',
							type: 'string',
							required: false,
							provenance: suggested(),
						},
						{
							id: 'fld-hand',
							name: 'handWritten',
							type: 'string',
							required: false,
							provenance: manual(),
						},
					],
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-orders',
					name: 'Orders',
					route: '/orders',
					entityId: 'e-order',
					provenance: suggested(),
					blocks: [
						{ id: 'blk-table', type: 'table', provenance: suggested() },
						{ id: 'blk-form', type: 'form', provenance: suggested() },
					],
				},
			},
		},
		meta(),
	)
	return spec
}

const t = (
	kind: ReviewTarget['kind'],
	id: string,
	parentId?: string,
): ReviewTarget => ({ kind, id, ...(parentId ? { parentId } : {}) })

// ===========================================================================
// Risk — the refusals
// ===========================================================================

describe('risk classification is conservative', () => {
	it('calls a plain field on an unpublished entity low', () => {
		const risk = classifyReviewRisk(
			fixture(),
			t('field', 'fld-notes', 'e-order'),
		)
		expect(risk.level).toBe('low')
		expect(risk.batchable).toBe(true)
	})

	it('refuses a field whose name reads as access control', () => {
		const risk = classifyReviewRisk(
			fixture(),
			t('field', 'fld-role', 'e-order'),
		)
		expect(risk.level).toBe('high')
		expect(risk.batchable).toBe(false)
		expect(risk.findings.some((f) => /access control/.test(f.reason))).toBe(
			true,
		)
	})

	it('refuses every access-control-shaped name we know of', () => {
		// The heuristic runs in the conservative direction, so its coverage is what
		// decides whether an authz change can ride into a batch. Enumerated rather
		// than sampled.
		for (const name of [
			'role',
			'userRole',
			'permissions',
			'scopes',
			'isAdmin',
			'ownerId',
			'isPublic',
			'visibility',
			'passwordHash',
			'clientSecret',
			'accessToken',
			'apiKeyId',
			'authProvider',
			'acl',
			'grantedAt',
			'privilegeLevel',
		]) {
			let spec = fixture()
			spec = applyOp(
				spec,
				{
					op: 'data.addField',
					args: {
						entityId: 'e-order',
						field: {
							id: 'fld-probe',
							name,
							type: 'string',
							required: false,
							provenance: suggested(),
						},
					},
				},
				meta(),
			)
			const risk = classifyReviewRisk(spec, t('field', 'fld-probe', 'e-order'))
			expect(risk.level, `"${name}" was not classified high`).toBe('high')
		}
	})

	it('refuses anything on a portal-exposed entity', () => {
		let spec = fixture()
		spec = applyOp(
			spec,
			{
				op: 'portals.declare',
				args: {
					portal: {
						id: 'ptl-orders',
						key: 'orders',
						description: 'the public order tracker',
						entityId: 'e-order',
						audience: 'public',
						scope: 'collection',
						filter: { fieldId: 'fld-total', equals: 1 },
						readFields: ['fld-total'],
						writes: [],
						layout: 'table',
						paused: false,
						provenance: suggested(),
					},
				},
			},
			meta(),
		)
		// The same field that was `low` a moment ago is now a disclosure decision.
		const risk = classifyReviewRisk(spec, t('field', 'fld-notes', 'e-order'))
		expect(risk.level).toBe('high')
		expect(risk.findings.some((f) => /portal/.test(f.reason))).toBe(true)
	})

	it('refuses a kind it does not understand', () => {
		// A flag gates what users can see; a schedule runs code on a clock. Neither is
		// something to accept twenty of without reading.
		let spec = fixture()
		spec = applyOp(
			spec,
			{
				op: 'flags.declare',
				args: {
					flag: {
						id: 'flg-beta',
						key: 'beta-checkout',
						description: 'the new checkout',
						default: false,
						provenance: suggested(),
					},
				},
			},
			meta(),
		)
		const risk = classifyReviewRisk(spec, t('flag', 'flg-beta'))
		expect(risk.level).toBe('high')
		expect(risk.batchable).toBe(false)
	})

	it('refuses a target that no longer resolves', () => {
		const risk = classifyReviewRisk(
			fixture(),
			t('field', 'fld-gone', 'e-order'),
		)
		expect(risk.level).toBe('high')
		expect(risk.findings[0]?.reason).toMatch(/landed or removed/)
	})

	it('refuses what the maintainer owns, when the host can say so', () => {
		// The eject bargain: the platform will not add this to their file for them,
		// so accepting it in a batch diverges their file from the spec silently.
		const spec = fixture()
		const routine = classifyReviewRisk(spec, t('field', 'fld-notes', 'e-order'))
		expect(routine.level).toBe('low')

		const owned = classifyReviewRisk(spec, t('field', 'fld-notes', 'e-order'), {
			...KNOWN,
			ownedEntityIds: ['e-order'],
		})
		expect(owned.level).toBe('high')
		expect(owned.findings.some((f) => /you own/.test(f.reason))).toBe(true)
	})

	it('batches nothing at all when the host could not read the manifest', () => {
		// This test replaces one that asserted the opposite, and the correction is the
		// interesting part. The old version said "absent means could not tell us, so
		// risk is unchanged" — but these facts only ever RAISE risk, so leaving them
		// out is the most permissive input available, not a neutral one. A host whose
		// drift read threw and returned `{}` was therefore *unlocking* batches on the
		// exact projects where it knew least.
		//
		// So unknown now means "assume everything is owned". Knowing nothing is owned
		// is a different claim, and a host has to make it explicitly.
		const spec = fixture()
		const unknown = classifyReviewRisk(
			spec,
			t('field', 'fld-notes', 'e-order'),
			{},
		)
		expect(unknown.level).toBe('high')
		expect(unknown.batchable).toBe(false)
		expect(
			unknown.findings.some((f) => /which surfaces you own/.test(f.reason)),
		).toBe(true)

		// An empty-but-known context is a real answer, and gets its batches back.
		expect(
			classifyReviewRisk(spec, t('field', 'fld-notes', 'e-order'), KNOWN).level,
		).toBe('low')
	})

	it('always explains itself, including at low risk', () => {
		for (const target of [
			t('field', 'fld-notes', 'e-order'),
			t('entity', 'e-order'),
			t('block', 'blk-table', 'pg-orders'),
		]) {
			const risk = classifyReviewRisk(fixture(), target)
			expect(risk.findings.length).toBeGreaterThan(0)
			for (const f of risk.findings) expect(f.reason.length).toBeGreaterThan(10)
		}
	})
})

// ===========================================================================
// The pending population, and grouping
// ===========================================================================

describe('pendingProposals', () => {
	it('lists only undecided rows — never manual, never settled', () => {
		const ids = pendingProposals(fixture()).map((p) => p.target.id)
		expect(ids).toContain('fld-total')
		expect(ids).not.toContain('fld-hand') // manual
	})

	it('drops a row once it is decided', () => {
		let spec = fixture()
		spec = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: { target: t('field', 'fld-total', 'e-order'), action: 'accept' },
			},
			meta(),
		)
		expect(pendingProposals(spec).map((p) => p.target.id)).not.toContain(
			'fld-total',
		)
	})
})

describe('groupForBulkReview', () => {
	it('orders worst risk first, so the dangerous ones are not buried', () => {
		const groups = groupForBulkReview(pendingProposals(fixture()))
		expect(groups.length).toBeGreaterThan(1)
		// The field group contains `fld-role`, which is high — so it sorts first.
		expect(groups[0]?.risk).toBe('high')
	})

	it('marks a group unbatchable when any single member is', () => {
		const groups = groupForBulkReview(pendingProposals(fixture()))
		const fields = groups.find((g) => g.kind === 'field')
		expect(fields?.batchable).toBe(false)
		expect(fields?.targets.length).toBeGreaterThan(1)
	})

	it('groups nested rows under their parent, not by kind alone', () => {
		const groups = groupForBulkReview(pendingProposals(fixture()))
		const keys = groups.map((g) => g.key)
		expect(keys).toContain('field:e-order')
		expect(keys).toContain('block:pg-orders')
	})
})

// ===========================================================================
// Planning — what lands, and what is refused
// ===========================================================================

describe('planBulkReview', () => {
	it('includes the safe ones and refuses the dangerous one, by name', () => {
		const plan = planBulkReview(
			fixture(),
			[
				t('field', 'fld-total', 'e-order'),
				t('field', 'fld-notes', 'e-order'),
				t('field', 'fld-role', 'e-order'),
			],
			'accept',
			'batch-1',
		)
		expect(plan.included.map((p) => p.target.id)).toEqual([
			'fld-total',
			'fld-notes',
		])
		expect(plan.refused).toHaveLength(1)
		expect(plan.refused[0]?.target.id).toBe('fld-role')
		expect(plan.refused[0]?.reason).toMatch(/high risk/)
	})

	it('refuses rather than silently skips, so the count confirmed is the count that lands', () => {
		const plan = planBulkReview(
			fixture(),
			[
				t('field', 'fld-role', 'e-order'),
				t('field', 'fld-hand', 'e-order'),
				t('field', 'fld-nope', 'e-order'),
			],
			'accept',
			'batch-1',
		)
		expect(plan.included).toHaveLength(0)
		expect(plan.refused).toHaveLength(3)
		expect(plan.combined.proposals).toBe(0)
		expect(plan.combined.summary).toBe('nothing to apply')
	})

	it("refuses a manual row — it was never anybody's to review", () => {
		const plan = planBulkReview(
			fixture(),
			[t('field', 'fld-hand', 'e-order')],
			'accept',
			'batch-1',
		)
		expect(plan.refused[0]?.reason).toMatch(/already manual/)
	})

	it('refuses an already-settled row rather than re-deciding it', () => {
		let spec = fixture()
		spec = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: { target: t('field', 'fld-total', 'e-order'), action: 'accept' },
			},
			meta(),
		)
		const plan = planBulkReview(
			spec,
			[t('field', 'fld-total', 'e-order')],
			'accept',
			'batch-1',
		)
		expect(plan.refused[0]?.reason).toMatch(/already accepted/)
	})

	it('dedupes a double-submitted target without inflating the count', () => {
		const target = t('field', 'fld-total', 'e-order')
		const plan = planBulkReview(
			fixture(),
			[target, target, target],
			'accept',
			'batch-1',
		)
		expect(plan.included).toHaveLength(1)
		expect(plan.ops).toHaveLength(1)
	})

	it('emits one op per artifact, never one op for the batch', () => {
		// Provenance is per-artifact. A batch-shaped op would make the trail
		// say somebody reviewed "a batch" rather than which rows.
		const plan = planBulkReview(
			fixture(),
			[t('field', 'fld-total', 'e-order'), t('field', 'fld-notes', 'e-order')],
			'accept',
			'batch-1',
		)
		expect(plan.ops).toHaveLength(2)
		for (const op of plan.ops) {
			expect(op.op).toBe('provenance.review')
			if (op.op !== 'provenance.review') continue
			// No cascade: a batch's membership is exactly what was selected.
			expect(op.args.cascade).toBeUndefined()
		}
	})

	it('summarizes the combined effect as one thing to read', () => {
		const plan = planBulkReview(
			fixture(),
			[
				t('field', 'fld-total', 'e-order'),
				t('field', 'fld-notes', 'e-order'),
				t('block', 'blk-table', 'pg-orders'),
			],
			'accept',
			'batch-1',
		)
		expect(plan.combined.proposals).toBe(3)
		expect(plan.combined.byKind).toEqual({ field: 2, block: 1 })
		expect(plan.combined.touches).toEqual(['e-order', 'pg-orders'])
		expect(plan.combined.summary).toMatch(/Accept 3 proposals/)
		expect(plan.combined.summary).toMatch(/2 nodes/)
		expect(plan.combined.summary).toMatch(/worst risk/)
	})
})

// ===========================================================================
// Landing — atomic, and attributed as one unit
// ===========================================================================

describe('applyBulkReview', () => {
	it('settles every included row and leaves the input untouched', () => {
		const spec = fixture()
		const before = structuredClone(spec)
		const plan = planBulkReview(
			spec,
			[t('field', 'fld-total', 'e-order'), t('field', 'fld-notes', 'e-order')],
			'accept',
			'batch-1',
		)
		const next = applyBulkReview(spec, plan, batchMeta)

		expect(spec).toEqual(before)
		const fields = next.data.entities[0]?.fields ?? []
		expect(
			fields.find((f) => f.id === 'fld-total')?.provenance.isAccepted,
		).toBe(true)
		expect(
			fields.find((f) => f.id === 'fld-notes')?.provenance.isAccepted,
		).toBe(true)
		// Not included → not settled.
		expect(
			fields.find((f) => f.id === 'fld-role')?.provenance.isAccepted,
		).toBeNull()
	})

	it("leaves the caller's spec untouched when an op in the batch throws", () => {
		// All-or-nothing, structurally: the fold builds a private chain, so a throw
		// mid-batch discards it and the caller still holds exactly what it had. There
		// is no half-applied spec anywhere to roll back.
		const spec = fixture()
		const before = structuredClone(spec)
		const plan = planBulkReview(
			spec,
			[t('field', 'fld-total', 'e-order')],
			'accept',
			'batch-1',
		)
		// Corrupt the plan the way a stale queue would: a second op naming a row that
		// does not exist. `applyOp` throws on it.
		plan.ops.push({
			op: 'provenance.review',
			args: { target: t('field', 'fld-ghost', 'e-order'), action: 'accept' },
		})
		expect(() => applyBulkReview(spec, plan, batchMeta)).toThrow()
		expect(spec).toEqual(before)
		expect(spec.data.entities[0]?.fields[0]?.provenance.isAccepted).toBeNull()
	})

	it('stamps the batch id on every entry while keeping them per-artifact', () => {
		const spec = fixture()
		const plan = planBulkReview(
			spec,
			[t('field', 'fld-total', 'e-order'), t('field', 'fld-notes', 'e-order')],
			'accept',
			'batch-xyz',
		)
		const next = applyBulkReview(spec, plan, batchMeta)
		const landed = next.opLog.slice(spec.opLog.length)
		expect(landed).toHaveLength(2)
		for (const entry of landed) {
			expect(entry.actor?.session).toBe('batch-xyz')
			expect(entry.actor?.path).toBe('web-bulk-review')
			expect(entry.origin).toBe('human')
		}
		// Per-artifact: two entries naming two different rows.
		expect(landed.map((e) => e.diff.targetId)).toEqual([
			'fld-total',
			'fld-notes',
		])
	})

	it('leaves the spec valid', () => {
		const spec = fixture()
		const plan = planBulkReview(
			spec,
			[
				t('field', 'fld-total', 'e-order'),
				t('block', 'blk-table', 'pg-orders'),
			],
			'accept',
			'batch-1',
		)
		expect(
			collectSpecSystemErrors(applyBulkReview(spec, plan, batchMeta)),
		).toEqual([])
	})

	it('supports partial accept, with the remainder still queued', () => {
		const spec = fixture()
		const plan = planBulkReview(
			spec,
			[t('field', 'fld-total', 'e-order')],
			'accept',
			'batch-1',
		)
		const next = applyBulkReview(spec, plan, batchMeta)
		const stillPending = pendingProposals(next).map((p) => p.target.id)
		expect(stillPending).toContain('fld-notes')
		expect(stillPending).toContain('fld-role')
		expect(stillPending).not.toContain('fld-total')
	})
})

// ===========================================================================
// Undo
// ===========================================================================

describe('undo', () => {
	/** Land a two-row batch and return the resulting spec. */
	function landed(batchId = 'batch-undo'): SpecSystem {
		const spec = fixture()
		const plan = planBulkReview(
			spec,
			[t('field', 'fld-total', 'e-order'), t('field', 'fld-notes', 'e-order')],
			'accept',
			batchId,
		)
		return applyBulkReview(spec, plan, batchMeta)
	}

	it('returns every row the batch settled to undecided', () => {
		const spec = landed()
		const undo = planBulkUndo(spec, 'batch-undo')
		expect(undo.ops).toHaveLength(2)

		let next = spec
		for (const op of undo.ops) next = applyOp(next, op, meta())
		const fields = next.data.entities[0]?.fields ?? []
		expect(
			fields.find((f) => f.id === 'fld-total')?.provenance.isAccepted,
		).toBeNull()
		expect(
			fields.find((f) => f.id === 'fld-notes')?.provenance.isAccepted,
		).toBeNull()
		// Back in the queue, which is the point.
		expect(pendingProposals(next).map((p) => p.target.id)).toContain(
			'fld-total',
		)
	})

	it('records the undo in the trail rather than mutating quietly', () => {
		const spec = landed()
		const undo = planBulkUndo(spec, 'batch-undo')
		let next = spec
		for (const op of undo.ops) next = applyOp(next, op, meta())
		const resets = next.opLog.filter(
			(e) => e.op.op === 'provenance.review' && e.op.args.action === 'reset',
		)
		expect(resets).toHaveLength(2)
		expect(resets[0]?.diff.summary).toMatch(/Reset .*back to undecided/)
	})

	it('leaves out a row something else re-decided after the batch', () => {
		// The undo can only take back what the batch actually did. A row somebody
		// changed since is not the batch's decision any more.
		let spec = landed()
		spec = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: { target: t('field', 'fld-total', 'e-order'), action: 'reset' },
			},
			meta(),
		)
		const undo = planBulkUndo(spec, 'batch-undo')
		expect(undo.ops).toHaveLength(1)
		expect(undo.skipped).toHaveLength(1)
		expect(undo.skipped[0]?.reason).toMatch(/is now suggested/)
	})

	it('never resets a manual row', () => {
		// Un-deciding a hand-authored row is not an undo — nobody decided it — and it
		// would strip the regen protection `isAddedManually` exists to give.
		const spec = fixture()
		const before = structuredClone(spec)
		const next = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: { target: t('field', 'fld-hand', 'e-order'), action: 'reset' },
			},
			meta(),
		)
		const hand = next.data.entities[0]?.fields.find((f) => f.id === 'fld-hand')
		expect(hand?.provenance).toEqual(manual())
		expect(spec).toEqual(before)
	})

	it('does not undo an undo', () => {
		let spec = landed()
		const first = planBulkUndo(spec, 'batch-undo')
		for (const op of first.ops) spec = applyOp(spec, op, meta())
		// The resets landed under a different actor session, so they are not part of
		// the batch — but even if they were, a reset is skipped: undoing an undo is a
		// redo, which is a different feature.
		expect(planBulkUndo(spec, 'batch-undo').ops).toHaveLength(0)
	})

	it('is undoable until something has been generated', () => {
		const spec = landed()
		expect(isBatchUndoable(spec, 'batch-undo', false)).toBe(true)
		// After generation there is code on disk derived from the decision; taking it
		// back would leave the two out of step, which is worse than no undo.
		expect(isBatchUndoable(spec, 'batch-undo', true)).toBe(false)
		expect(isBatchUndoable(spec, 'batch-never-happened', false)).toBe(false)
	})

	describe('the generation watermark', () => {
		// `hasGenerated` used to be hardcoded `false` in the web host, so the undo
		// stayed on offer after a `maxstack gen` had already turned the accepted
		// rows into files. These pin the derivation that replaced the literal.

		it('is not generated-since when nothing has ever been generated', () => {
			// No watermark is "no generation recorded", not "unknown" — a project
			// with no generated tree has nothing an undo could contradict.
			expect(hasGeneratedSinceBatch(landed(), 'batch-undo', null)).toBe(false)
			expect(hasGeneratedSinceBatch(landed(), 'batch-undo', undefined)).toBe(
				false,
			)
		})

		it('compares the watermark against the batch’s last op, not its first', () => {
			const spec = landed()
			const last = spec.opLog.length - 1
			// The fixture's log already holds ops from before the batch, which is
			// what makes this a real test: the comparison has to find the batch's own
			// position rather than reading the log length.
			expect(last).toBeGreaterThan(0)
			// A generate that consumed the whole log covers the batch.
			expect(hasGeneratedSinceBatch(spec, 'batch-undo', last + 1)).toBe(true)
			// One that stopped at the batch's last op did NOT generate from it: the
			// watermark is a length, so `last` means ops 0..last-1 were consumed.
			// Getting this boundary backwards would withdraw every undo one batch
			// early — the failure that looks like the fix working.
			expect(hasGeneratedSinceBatch(spec, 'batch-undo', last)).toBe(false)
			expect(hasGeneratedSinceBatch(spec, 'batch-undo', 0)).toBe(false)
		})

		it('says no for a batch that never landed', () => {
			expect(hasGeneratedSinceBatch(landed(), 'batch-nope', 999)).toBe(false)
		})

		it('withdraws the undo offer once it is fed to isBatchUndoable', () => {
			// The two composed, which is how both hosts use them.
			const spec = landed()
			const count = spec.opLog.length
			expect(
				isBatchUndoable(
					spec,
					'batch-undo',
					hasGeneratedSinceBatch(spec, 'batch-undo', null),
				),
			).toBe(true)
			expect(
				isBatchUndoable(
					spec,
					'batch-undo',
					hasGeneratedSinceBatch(spec, 'batch-undo', count),
				),
			).toBe(false)
		})
	})

	it('counts the batch for the undo button', () => {
		expect(batchSize(landed(), 'batch-undo')).toBe(2)
		expect(batchSize(landed(), 'other')).toBe(0)
	})
})

/**
 * The portal review path.
 *
 * `activePortals` requires `isAccepted === true` and has no accepted-else-all
 * fallback, which is right: a suggestion must never put somebody's table on the
 * internet. But `portal` was missing from `REVIEW_TARGET_KINDS`, so the accept
 * that would make it live was refused by the op validator — an agent-proposed
 * portal published nothing, forever, with no path to a decision.
 *
 * These pin the whole round trip, because fixing only the validator would leave
 * the same dead end one step further along: a portal nobody can find in the queue
 * is as undecidable as one the validator refuses.
 */
// ===========================================================================
// Ownership derivation — every seam, not only pages
// ===========================================================================

/**
 * The five seams' owned-file ids, as the manifest records them.
 *
 * Real ops rather than hand-built collections: the whole failure this guards is a
 * mapping that stops matching what the other layers actually write, so a fixture
 * that bypasses `applyOp`'s validation would be testing the mapping against a
 * shape nothing produces.
 */
function seamFixture(): SpecSystem {
	let spec = fixture()
	spec = applyOp(
		spec,
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-invoice',
					name: 'Invoice',
					provenance: suggested(),
					fields: [
						{
							id: 'fld-inv-amount',
							name: 'amount',
							type: 'number',
							required: true,
							provenance: suggested(),
						},
						{
							id: 'fld-inv-ref',
							name: 'reference',
							type: 'string',
							required: false,
							provenance: suggested(),
						},
					],
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'schedules.declare',
			args: {
				schedule: {
					id: 'sch-invoice-run',
					key: 'invoice.recurring',
					description: 'Issue and send recurring invoices',
					timezone: 'America/New_York',
					recurrence: { kind: 'monthly', onDayOfMonth: 1, atTime: '09:00' },
					runAs: { kind: 'service', role: 'billing' },
					entityId: 'e-invoice',
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'sources.declare',
			args: {
				source: {
					id: 'src-fx',
					key: 'fx.rate',
					description: 'Fetch the day rate an invoice is denominated at.',
					mode: 'enrich',
					entityId: 'e-invoice',
					request: { url: 'https://example.test/fx/{reference}.json' },
					auth: { kind: 'none' },
					mapping: [{ from: 'rate', to: 'fld-inv-amount' }],
					limits: {
						requestsPerMinute: 60,
						timeoutMs: 5000,
						maxAttempts: 3,
						backoffMs: 1000,
					},
					triggers: [{ kind: 'create' }],
					inputField: 'fld-inv-ref',
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'imports.declare',
			args: {
				importer: {
					id: 'imp-invoices',
					key: 'invoices-csv',
					description: 'Import invoices from the old billing tool.',
					entityId: 'e-invoice',
					format: 'csv',
					columns: [
						{ column: 'Reference', fieldId: 'fld-inv-ref' },
						{ column: 'Amount', fieldId: 'fld-inv-amount' },
					],
					upsertFieldId: 'fld-inv-ref',
					maxRows: 5000,
					paused: false,
					provenance: manual(),
				},
			},
		},
		meta(),
	)
	// The live channel gets its own entity on purpose. A live channel *already*
	// raises risk on the entity it pushes ("a new column reaches every connected
	// client"), so declaring it over `e-invoice` would mask whether the schedule
	// mapping did anything — the before/after test below would pass either way.
	spec = applyOp(
		spec,
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-ledger',
					name: 'LedgerLine',
					provenance: suggested(),
					fields: [
						{
							id: 'fld-led-memo',
							name: 'memo',
							type: 'string',
							required: false,
							provenance: suggested(),
						},
					],
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'live.declare',
			args: {
				subscription: {
					id: 'lv-invoices',
					key: 'invoices',
					description: 'Push ledger changes to whoever has the ledger open.',
					entityId: 'e-ledger',
					kind: 'query',
					fields: ['fld-led-memo'],
					// `all` is capped at 100 — an unfiltered channel costs
					// writes × subscribers with nothing that shrinks it.
					scope: { kind: 'all' },
					maxSubscribers: 100,
					maxMessagesPerMinute: 120,
					slot: true,
					paused: false,
					provenance: manual(),
				},
			},
		},
		meta(),
	)
	return spec
}

/** `pageDescriptor(page).resource` for the fixture — the generator's minting. */
const resourceOf = (page: SpecSystem['pages']['pages'][number]) =>
	page.name.toLowerCase()

describe('riskContextFromOwnership reflects every seam', () => {
	it('maps an owned page and its backing entity', () => {
		const context = riskContextFromOwnership(
			seamFixture(),
			[{ id: 'orders', family: 'page' }],
			resourceOf,
		)
		expect(context.ownedPageIds).toEqual(['pg-orders'])
		expect(context.ownedEntityIds).toEqual(['e-order'])
		expect(context.ownershipKnown).toBe(true)
	})

	it('maps an owned schedule to the entity its job body reads', () => {
		// The gap #244 reports: this returned `{ownedEntityIds: []}`, so a field
		// added to `e-invoice` was classified as touching nothing anybody owns and
		// could be swept into a batch — while the maintainer's handler reads it.
		const context = riskContextFromOwnership(
			seamFixture(),
			[{ id: 'schedule:invoice.recurring:slot', family: 'schedule' }],
			resourceOf,
		)
		expect(context.ownedEntityIds).toEqual(['e-invoice'])
		// A schedule is not a page: owning its handler says nothing about routes.
		expect(context.ownedPageIds).toEqual([])
	})

	it('reads the same key with or without the :slot suffix', () => {
		const registryOwned = riskContextFromOwnership(
			seamFixture(),
			[{ id: 'schedule:invoice.recurring', family: 'schedule' }],
			resourceOf,
		)
		expect(registryOwned.ownedEntityIds).toEqual(['e-invoice'])
	})

	it('treats an owned seam registry as owning that whole seam', () => {
		// `schedules:registry` enumerates and wires every schedule, so a change to
		// any of them lands in a file the platform will not update. The broad read
		// is the conservative one, and this is the direction the model may err in.
		const context = riskContextFromOwnership(
			seamFixture(),
			[{ id: 'schedules:registry', family: 'schedule' }],
			resourceOf,
		)
		expect(context.ownedEntityIds).toEqual(['e-invoice'])
	})

	it('ignores a key that matches no declaration rather than guessing', () => {
		const context = riskContextFromOwnership(
			seamFixture(),
			[{ id: 'schedule:gone.away', family: 'schedule' }],
			resourceOf,
		)
		expect(context.ownedEntityIds).toEqual([])
		// Still `true`: the manifest was read. The claim is about the read, not
		// about whether every entry in it resolved.
		expect(context.ownershipKnown).toBe(true)
	})

	it('covers source, import and live the same way', () => {
		// Asserted against the declarations' own `entityId` rather than a literal,
		// so a seam that changes where it names its entity fails here instead of
		// silently dropping out of the risk model.
		const spec = seamFixture()
		const seams = [
			['source', spec.sources?.sources ?? []],
			['import', spec.imports?.importers ?? []],
			['live', spec.live?.subscriptions ?? []],
		] as const
		let checked = 0
		for (const [family, declarations] of seams) {
			// An empty collection here would make the loop below assert nothing while
			// reporting green — the uniform-pass twin of a uniform zero.
			expect(declarations.length).toBeGreaterThan(0)
			for (const declaration of declarations) {
				const context = riskContextFromOwnership(
					spec,
					[{ id: `${family}:${declaration.key}:slot`, family }],
					resourceOf,
				)
				expect(context.ownedEntityIds).toContain(declaration.entityId)
				checked++
			}
		}
		expect(checked).toBe(3)
	})

	it('actually refuses the batch it used to allow', () => {
		// The derivation is only interesting through its consequence. A field added
		// to the entity a maintainer's schedule handler reads was batchable, because
		// the mapping dropped the family before risk ever saw it.
		let spec = seamFixture()
		spec = applyOp(
			spec,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-invoice',
					field: {
						id: 'fld-inv-currency',
						name: 'currency',
						type: 'string',
						required: false,
						provenance: suggested(),
					},
				},
			},
			meta(),
		)
		const target = t('field', 'fld-inv-currency', 'e-invoice')
		const owned = [
			{ id: 'schedule:invoice.recurring:slot', family: 'schedule' },
		]

		const before = classifyWithContext(spec, target, KNOWN)
		expect(before.batchable).toBe(true)

		const after = classifyWithContext(
			spec,
			target,
			riskContextFromOwnership(spec, owned, resourceOf),
		)
		expect(after.batchable).toBe(false)
		expect(after.findings.map((f) => f.reason).join(' ')).toMatch(/own/i)
	})

	it('names every family the manifest can report', () => {
		// The tripwire the issue asks for: a sixth family cannot land without
		// somebody deciding what it means for risk. `other` is deliberately absent
		// — it is the manifest's "we do not recognise this", and a mapping that
		// guessed at it would be inventing ownership.
		const families = ['page', 'schedule', 'source', 'import', 'live']
		const spec = seamFixture()
		for (const family of families) {
			expect(() =>
				riskContextFromOwnership(
					spec,
					[{ id: `${family}:x`, family }],
					resourceOf,
				),
			).not.toThrow()
		}
		expect(families).toHaveLength(5)
	})
})

describe('an agent-proposed portal can be reviewed', () => {
	const PORTAL: Omit<PortalSpec, 'declaredAt' | 'provenance'> = {
		id: 'ptl-orders',
		key: 'orders',
		description: 'the public order tracker',
		entityId: 'e-order',
		audience: 'public',
		scope: 'collection',
		filter: { fieldId: 'fld-total', equals: 1 },
		readFields: ['fld-total'],
		writes: [],
		layout: 'table',
		paused: false,
	}

	/** A spec with one suggested portal — what an agent's `portals.declare` leaves. */
	function proposed(): SpecSystem {
		return applyOp(
			fixture(),
			{
				op: 'portals.declare',
				args: { portal: { ...PORTAL, provenance: suggested() } },
			},
			meta(),
		)
	}

	const portalOf = (spec: SpecSystem) =>
		spec.portals?.portals.find((p) => p.id === 'ptl-orders')

	it('reaches the review queue at all', () => {
		const found = pendingProposals(proposed()).find(
			(p) => p.target.kind === 'portal',
		)
		expect(found?.target.id).toBe('ptl-orders')
		// Labelled by key, because `/p/orders` is the thing that would become a URL
		// and `ptl-orders` is not.
		expect(found?.label).toBe('orders')
	})

	it('is high risk and refused a place in any batch', () => {
		// Deliberately NOT added to `UNDERSTOOD_KINDS`: the default-high rule
		// refuses it without anybody writing a rule, which is the conservative
		// direction working as designed.
		const risk = classifyReviewRisk(proposed(), t('portal', 'ptl-orders'))
		expect(risk.level).toBe('high')
		expect(risk.batchable).toBe(false)
		// And the reason names the actual consequence rather than the generic
		// "changes what runs or what users can see", which understates this one.
		expect(risk.findings.some((f) => /public URL/.test(f.reason))).toBe(true)
	})

	it('refuses to be swept along in a batch even when named directly', () => {
		const spec = proposed()
		const plan = planBulkReview(
			spec,
			[t('portal', 'ptl-orders')],
			'accept',
			'batch-portal',
		)
		expect(plan.ops).toHaveLength(0)
		expect(plan.refused.map((r) => r.target.id)).toEqual(['ptl-orders'])
	})

	it('can actually be accepted, and only then publishes', () => {
		// The whole point. Before #248 this op was rejected with `bad target kind
		// "portal"`, so `isAccepted` could never become true and the portal was
		// permanently dark.
		let spec = proposed()
		expect(portalOf(spec)?.provenance.isAccepted).toBeNull()

		spec = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'portal', id: 'ptl-orders' },
					action: 'accept',
				},
			},
			meta(),
		)
		expect(portalOf(spec)?.provenance.isAccepted).toBe(true)
		// Gone from the queue, because it has been decided.
		expect(pendingProposals(spec).some((p) => p.target.kind === 'portal')).toBe(
			false,
		)
	})

	it('can be rejected, and rejecting does not publish', () => {
		const spec = applyOp(
			proposed(),
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'portal', id: 'ptl-orders' },
					action: 'reject',
				},
			},
			meta(),
		)
		expect(portalOf(spec)?.provenance.isAccepted).toBe(false)
	})

	it('tags the decision with the portals layer', () => {
		const spec = applyOp(
			proposed(),
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'portal', id: 'ptl-orders' },
					action: 'accept',
				},
			},
			meta(),
		)
		const entry = spec.opLog.at(-1)
		expect(entry?.diff.layer).toBe('portals')
		expect(entry?.diff.targetId).toBe('ptl-orders')
	})

	it('still refuses a portal id that resolves to nothing', () => {
		// Being a known kind is not being a known row. The unresolvable-target path
		// has to keep saying "look at it" rather than accepting into the void.
		const errors = validateOp(proposed(), {
			op: 'provenance.review',
			args: { target: { kind: 'portal', id: 'ptl-nope' }, action: 'accept' },
		})
		expect(errors.join(' ')).toMatch(/no portal "ptl-nope"/)
	})
})
