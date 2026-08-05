import {
	type EntitySpec,
	type LedgerEntry,
	manual,
	newSpecSystem,
	type PageSpec,
	type PricingTier,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import {
	applyReviewAction,
	buildDetail,
	buildWorkbench,
	collectReviewItems,
	countStates,
} from './view-model'

// A spec exercising every provenance state across all three provenanced layers.
function fixture(): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)

	const order: EntitySpec = {
		id: 'e-order',
		name: 'Order',
		description: 'A customer order',
		provenance: suggested({ suggestedDescription: 'AI: a customer order' }),
		fields: [
			{
				id: 'fld-total',
				name: 'total',
				type: 'number',
				required: true,
				provenance: manual(),
			},
			{
				id: 'fld-note',
				name: 'note',
				type: 'string',
				required: false,
				provenance: suggested({ priority: 'high' }),
			},
		],
	}
	spec.data.entities.push(order)

	const checkout: PageSpec = {
		id: 'pg-checkout',
		name: 'Checkout',
		route: '/checkout',
		entityId: 'e-order',
		e2eTests: ['a signed-in user can place an order'],
		provenance: suggested(),
		blocks: [{ id: 'blk-form', type: 'form', provenance: manual() }],
	}
	spec.pages.pages.push(checkout)

	const pro: PricingTier = {
		id: 'tr-pro',
		name: 'Pro',
		priceMonthly: 20,
		features: ['everything'],
		provenance: suggested(),
	}
	spec.pricing.tiers.push(pro)

	return spec
}

describe('collectReviewItems', () => {
	it('walks every provenanced row across all layers in a stable order', () => {
		const items = collectReviewItems(fixture())
		expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
			'entity:e-order',
			'field:fld-total',
			'field:fld-note',
			'page:pg-checkout',
			'block:blk-form',
			'tier:tr-pro',
		])
	})

	it('derives display state from provenance and prefers accepted prose', () => {
		const order = collectReviewItems(fixture()).find((i) => i.id === 'e-order')
		expect(order?.state).toBe('suggested')
		// accepted description wins over the AI draft
		expect(order?.description).toBe('A customer order')
	})
})

describe('buildWorkbench', () => {
	it('queues one row per top-level node, folding undecided children in', () => {
		const { queue } = buildWorkbench(fixture())
		// One row per entity/page/tier — never per field/block. e-order rises
		// because its pending child fld-note is high priority.
		expect(queue.map((i) => i.id)).toEqual(['e-order', 'pg-checkout', 'tr-pro'])
		const order = queue.find((r) => r.id === 'e-order')
		// fld-note folds into the entity's decision; manual fld-total never does.
		expect(order?.pendingChildren.map((c) => c.id)).toEqual(['fld-note'])
	})

	it('queues a settled node again when a new child suggestion lands on it', () => {
		const spec = applyReviewAction(
			fixture(),
			{ kind: 'entity', id: 'e-order' },
			'accept',
			{
				id: 'op-q1',
				origin: 'human',
				appliedAt: '2026-07-09',
				actor: { surface: 'web', path: 'web-submit-review' },
			} as const,
			true, // cascade: settles fld-note too
		)
		// A later AI pass suggests a new field on the accepted entity…
		spec.data.entities[0]?.fields.push({
			id: 'fld-coupon',
			name: 'coupon',
			type: 'string',
			required: false,
			provenance: suggested(),
		})
		const { queue } = buildWorkbench(spec)
		// …so the entity re-enters the queue carrying just that pending field.
		const order = queue.find((r) => r.id === 'e-order')
		expect(order?.state).toBe('accepted')
		expect(order?.pendingChildren.map((c) => c.id)).toEqual(['fld-coupon'])
	})

	it('groups the tree by layer with per-layer provenance counts', () => {
		const { tree } = buildWorkbench(fixture())
		const data = tree.find((l) => l.layer === 'data')
		expect(data?.counts).toMatchObject({
			suggested: 2, // e-order, fld-note
			manual: 1, // fld-total
			total: 3,
		})
		// entities carry their fields as children
		expect(data?.items[0]?.children.map((c) => c.id)).toEqual([
			'fld-total',
			'fld-note',
		])
	})

	it('reports total provenance counts across the whole spec', () => {
		expect(buildWorkbench(fixture()).counts).toEqual({
			suggested: 4,
			accepted: 0,
			rejected: 0,
			manual: 2,
			total: 6,
		})
	})

	it('splits the decision ledger into pending and resolved', () => {
		const spec = fixture()
		const pending: LedgerEntry = {
			id: 'd-scope',
			question: 'Ship pricing in v1?',
			options: [
				{ id: 'yes', description: 'yes', pros: [], cons: [] },
				{ id: 'no', description: 'no', pros: [], cons: [] },
			],
			chosenOptionId: null,
			rationale: '',
			status: 'pending',
			decidedAt: null,
			origin: 'ai',
			recordedAt: '2026-07-09',
		}
		spec.ledger = [pending]
		const { decisions } = buildWorkbench(spec)
		expect(decisions.pending.map((d) => d.id)).toEqual(['d-scope'])
		expect(decisions.resolved).toEqual([])
	})
})

describe('applyReviewAction', () => {
	const meta = (n: number) =>
		({
			id: `op-r${n}`,
			origin: 'human',
			appliedAt: '2026-07-09',
			actor: { surface: 'web', path: 'web-submit-review' },
		}) as const

	it('accepts a nested field immutably, leaving the input untouched', () => {
		const spec = fixture()
		const next = applyReviewAction(
			spec,
			{ kind: 'field', id: 'fld-note', parentId: 'e-order' },
			'accept',
			meta(1),
		)
		const before = spec.data.entities[0]?.fields[1]?.provenance.isAccepted
		const after = next.data.entities[0]?.fields[1]?.provenance.isAccepted
		expect(before).toBeNull() // undecided, unchanged
		expect(after).toBe(true) // accepted in the new system
	})

	it('records the review as an op-log audit entry (who, what, when)', () => {
		const next = applyReviewAction(
			fixture(),
			{ kind: 'field', id: 'fld-note', parentId: 'e-order' },
			'accept',
			meta(1),
		)
		expect(next.opLog).toHaveLength(1)
		expect(next.opLog[0]).toMatchObject({
			id: 'op-r1',
			origin: 'human',
			appliedAt: '2026-07-09',
			diff: {
				op: 'provenance.review',
				change: 'review',
				layer: 'data',
				targetId: 'fld-note',
				parentId: 'e-order',
				summary: 'Accept field "fld-note"',
			},
		})
	})

	it('rejects a top-level entity as a soft-reject (isAccepted false, not deleted)', () => {
		const next = applyReviewAction(
			fixture(),
			{ kind: 'entity', id: 'e-order' },
			'reject',
			meta(1),
		)
		expect(next.data.entities).toHaveLength(1) // still there
		expect(next.data.entities[0]?.provenance.isAccepted).toBe(false)
	})

	it('drops the accepted item out of the queue after accepting it', () => {
		const next = applyReviewAction(
			fixture(),
			{ kind: 'tier', id: 'tr-pro' },
			'accept',
			meta(1),
		)
		expect(buildWorkbench(next).queue.map((i) => i.id)).not.toContain('tr-pro')
	})

	it('throws on a stale ref instead of silently no-op-ing', () => {
		expect(() =>
			applyReviewAction(
				fixture(),
				{ kind: 'entity', id: 'e-missing' },
				'accept',
				meta(1),
			),
		).toThrow(/no entity "e-missing"/)
	})
})

describe('countStates', () => {
	it('is empty for no items', () => {
		expect(countStates([])).toEqual({
			suggested: 0,
			accepted: 0,
			rejected: 0,
			manual: 0,
			total: 0,
		})
	})
})

describe('buildDetail (spec zoom)', () => {
	it('returns null for no focus or an unknown id', () => {
		expect(buildDetail(fixture(), null)).toBeNull()
		expect(buildDetail(fixture(), 'e-nope')).toBeNull()
	})

	it('zooms an entity to its fields and the pages derived from it', () => {
		const detail = buildDetail(fixture(), 'e-order')
		expect(detail?.kind).toBe('entity')
		expect(detail?.rows.map((r) => r.label)).toEqual([
			'total: number',
			'note: string?',
		])
		// the checkout page renders e-order → shows up as a derived page
		expect(detail?.derivedPages.map((r) => r.label)).toEqual([
			'Checkout (/checkout)',
		])
		expect(detail?.previewPageId).toBeUndefined() // entities emit no code
	})

	it('zooms a page to its blocks, its entity link, and its acceptance criteria', () => {
		const detail = buildDetail(fixture(), 'pg-checkout')
		expect(detail?.kind).toBe('page')
		expect(detail?.rows.map((r) => r.label)).toEqual([
			'renders entity: Order',
			'block: form',
		])
		expect(detail?.acceptanceCriteria).toEqual([
			'a signed-in user can place an order',
		])
		// a page is the one node the live preview can generate code for
		expect(detail?.previewPageId).toBe('pg-checkout')
	})

	it('zooms a tier to its features', () => {
		const detail = buildDetail(fixture(), 'tr-pro')
		expect(detail?.kind).toBe('tier')
		expect(detail?.subtitle).toBe('$20/mo')
		expect(detail?.rows.map((r) => r.label)).toEqual(['everything'])
	})
})
