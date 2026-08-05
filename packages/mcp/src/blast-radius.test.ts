/**
 * Derived blast radius.
 *
 * The assertions worth reading are the ones about *ordering* and about the two
 * cases where an honest answer looks like a broken one: a diff that is empty
 * because of the accepted-or-all grounding rule, and a portal that publishes
 * nothing until the moment it is accepted.
 */

import {
	applyOp,
	type EntitySpec,
	manual,
	newSpecSystem,
	type OpId,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import {
	blastRadius,
	deriveSurfaces,
	latentExposure,
	opEffect,
	SURFACE_KINDS,
} from './blast-radius.ts'

let n = 0
const meta = () => ({
	id: `op-br${++n}` as OpId,
	origin: 'ai' as const,
	appliedAt: '2026-07-29',
	actor: { surface: 'harness' as const, path: 'blast-radius-test' },
})

/** An entity with one accepted field, so the accepted-or-all rule is engaged. */
const order: EntitySpec = {
	id: 'e-order',
	name: 'Order',
	fields: [
		{
			id: 'fld-total',
			name: 'total',
			type: 'number',
			required: true,
			provenance: manual(),
		},
	],
	provenance: manual(),
}

/** A spec with a real accepted entity and a page carrying a form. */
function fixture(): SpecSystem {
	let spec = newSpecSystem(tasklyPRD)
	spec = applyOp(
		spec,
		{ op: 'data.addEntity', args: { entity: order } },
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
					provenance: manual(),
					blocks: [
						{ id: 'blk-form', type: 'form', provenance: manual() },
						{ id: 'blk-table', type: 'table', provenance: manual() },
					],
				},
			},
		},
		meta(),
	)
	return spec
}

// ===========================================================================
// The inventory
// ===========================================================================

describe('deriveSurfaces', () => {
	it('names the table, its columns, the route, the form, REST and the tools', () => {
		const kinds = new Set(deriveSurfaces(fixture()).map((s) => s.kind))
		// Every kind a spec of this shape can produce, so a kind silently dropping
		// out of the derivation fails here rather than showing up as a quiet gap in
		// the reviewer's picture.
		expect(kinds).toEqual(
			new Set(['table', 'column', 'route', 'form', 'rest', 'tool']),
		)
	})

	it('uses the resource name the runtime grounds, not the entity id', () => {
		const table = deriveSurfaces(fixture()).find((s) => s.kind === 'table')
		// `e-order` → `order`. The agreement test in apps/web pins this against
		// groundedEntityShapes(); here we only pin that the prefix is gone.
		expect(table?.id).toBe('table:order')
		expect(table?.label).toContain('`order`')
	})

	it('says nothing about a public boundary when there is no portal', () => {
		const surfaces = deriveSurfaces(fixture())
		expect(surfaces.some((s) => s.kind.startsWith('public'))).toBe(false)
	})
})

// ===========================================================================
// The diff
// ===========================================================================

describe('blastRadius', () => {
	it('reports a new column as a column, and as a change to the table and REST', () => {
		const before = fixture()
		const after = applyOp(
			before,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-order',
					field: {
						id: 'fld-notes',
						name: 'notes',
						type: 'string',
						required: false,
						provenance: manual(),
					},
				},
			},
			meta(),
		)
		const radius = blastRadius(before, after)

		expect(radius.added.map((s) => s.id)).toContain('column:order.notes')
		// The point of the whole file: a one-line spec edit is four consequences.
		// The table's column count, the REST payload and the form's inputs all move,
		// and a spec diff shows none of them.
		const changedIds = radius.changed.map((c) => c.surface.id)
		expect(changedIds).toContain('table:order')
		expect(changedIds).toContain('rest:order')
		expect(changedIds).toContain('form:/orders:blk-form')
		expect(radius.summary).toMatch(/adds 1/)
		expect(radius.touchesPublic).toBe(false)
	})

	it('reports a removal as a removal, and leads with it', () => {
		// The direction that destroys things. A dropped column is dropped data, and
		// "it was only a spec edit" does not change that, so it is named first.
		const before = fixture()
		const after: SpecSystem = structuredClone(before)
		const entity = after.data.entities.find((e) => e.id === 'e-order')
		if (entity) entity.fields = []

		const radius = blastRadius(before, after)
		expect(radius.removed.map((s) => s.id)).toContain('column:order.total')
		expect(radius.summary).toMatch(/^.*REMOVES/)
	})

	it('counts what did not move, so the size of a change is readable', () => {
		const spec = fixture()
		const radius = blastRadius(spec, spec)
		expect(radius.added).toEqual([])
		expect(radius.removed).toEqual([])
		expect(radius.changed).toEqual([])
		expect(radius.unchanged).toBeGreaterThan(0)
		expect(radius.summary).toBe('no change to what gets built')
	})
})

// ===========================================================================
// Public exposure — the reason this surface exists
// ===========================================================================

describe('public exposure', () => {
	/**
	 * Declare a portal over `e-order`.
	 *
	 * `provenance` is a parameter because the two states are the two halves of the
	 * story: `suggested()` is a portal that publishes nothing (portals are
	 * accepted-only by design), `manual()` is one that is live.
	 *
	 * This used to carry a note that `portal` was not in `REVIEW_TARGET_KINDS`, so
	 * an agent-proposed public surface had no accept path and the transition could
	 * only be exercised through `portals.pause(false)`. That was #248, and it is
	 * fixed — the accept is now a real op, and "accepting this portal puts a field
	 * on the public internet" is a test rather than a thing that could not be
	 * written. Both paths are exercised below; they are different transitions and
	 * the exposure view has to catch each.
	 */
	function withPortal(
		spec: SpecSystem,
		provenance = suggested(),
		paused = false,
	): SpecSystem {
		return applyOp(
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
						paused,
						provenance,
					},
				},
			},
			meta(),
		)
	}

	it('shows a suggested portal as publishing nothing yet', () => {
		// Portals are accepted-only by design (`activePortals`) — a suggestion must
		// never put a table on the internet. So the *before* side of an accept is
		// correctly silent.
		const surfaces = deriveSurfaces(withPortal(fixture()))
		expect(surfaces.some((s) => s.kind === 'public-field')).toBe(false)
	})

	it('reports accepting a suggested portal as fields crossing the public boundary', () => {
		// The natural test for this module, and the one #248 was blocking: the
		// reviewer is being asked to accept a row, and what they are actually
		// deciding is whether a column becomes readable by anyone with a URL. If the
		// derivation missed this transition, the queue's most consequential accept
		// would preview as nothing at all.
		const before = withPortal(fixture(), suggested())
		const after = applyOp(
			before,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'portal', id: 'ptl-orders' },
					action: 'accept',
				},
			},
			meta(),
		)
		const radius = blastRadius(before, after)

		expect(radius.touchesPublic).toBe(true)
		expect(radius.added.map((s) => s.id)).toContain('public-field:order.total')
		expect(radius.added[0]?.kind).toBe('public-field')
		expect(radius.summary).toMatch(/^changes public exposure/)
	})

	it('reports rejecting a suggested portal as touching nothing public', () => {
		// The other half, which is what makes the assertion above mean something: a
		// reject must not read as an exposure change.
		const before = withPortal(fixture(), suggested())
		const after = applyOp(
			before,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'portal', id: 'ptl-orders' },
					action: 'reject',
				},
			},
			meta(),
		)
		expect(blastRadius(before, after).touchesPublic).toBe(false)
	})

	it('reports un-pausing a portal as fields crossing the public boundary', () => {
		// Un-pausing takes no review — `portals.pause(false)` is one op and every
		// minted token survives it — so this is the transition most likely to publish
		// something nobody looked at, and the one the exposure view has to catch.
		const before = withPortal(fixture(), manual(), true)
		const after = applyOp(
			before,
			{ op: 'portals.pause', args: { portalId: 'ptl-orders', paused: false } },
			meta(),
		)
		const radius = blastRadius(before, after)

		expect(radius.touchesPublic).toBe(true)
		expect(radius.added.map((s) => s.id)).toContain('public-field:order.total')
		// Worst first: the public fact outranks every structural one, because a list
		// sorted by artifact type would bury the only item that cannot be undone.
		expect(radius.added[0]?.kind).toBe('public-field')
		expect(radius.summary).toMatch(/^changes public exposure/)
		expect(radius.added[0]?.detail).toContain('orders')
	})

	it('ranks a public field above every structural surface', () => {
		expect(SURFACE_KINDS[0]).toBe('public-field')
		expect(SURFACE_KINDS.indexOf('public-write')).toBeLessThan(
			SURFACE_KINDS.indexOf('table'),
		)
	})

	it('reports a suggested portal as latent exposure rather than as nothing', () => {
		const latent = latentExposure(withPortal(fixture()))
		expect(latent).toHaveLength(1)
		expect(latent[0]?.key).toBe('orders')
		expect(latent[0]?.reason).toMatch(/accepting it makes these fields public/)
	})

	it('reports a paused portal as latent, naming un-pausing as the risk', () => {
		// A paused portal reads as safe right up until somebody un-pauses it, and
		// that takes one op and no review.
		const latent = latentExposure(withPortal(fixture(), manual(), true))
		expect(latent[0]?.reason).toMatch(/un-pausing publishes it again/)
	})
})

// ===========================================================================
// The honest empty answer
// ===========================================================================

describe('the accepted-or-all rule', () => {
	it('explains an empty diff caused by nothing having been accepted yet', () => {
		// The case that looks like a bug. With nothing accepted, grounding already
		// includes every suggested row, so accepting one changes no derived surface.
		// A reviewer shown a blank diff with no explanation would reasonably conclude
		// the op was inert — which is the wrong lesson to teach on this surface.
		let spec = newSpecSystem(tasklyPRD)
		spec = applyOp(
			spec,
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-draft',
						name: 'Draft',
						provenance: suggested(),
						fields: [
							{
								id: 'fld-title',
								name: 'title',
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
		const accepted = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: { target: { kind: 'entity', id: 'e-draft' }, action: 'accept' },
			},
			meta(),
		)

		const radius = blastRadius(spec, accepted)
		expect(radius.added).toEqual([])
		// The note names the collections in fallback, not just the fact. Per
		// collection rather than per spec: an accepted entity whose fields are all
		// suggested has its fields in fallback while its entity list is not, and the
		// coarser check made the explanation vanish exactly when it was needed.
		expect(radius.groundingNote).toMatch(/nothing is accepted yet in/)
		expect(radius.groundingNote).toMatch(/entities/)
	})

	it('does not offer that explanation once something is accepted', () => {
		// Where the note would be false, it is absent. An explanation that shows up
		// on every empty diff would train people to ignore it.
		const spec = fixture()
		expect(blastRadius(spec, spec).groundingNote).toBeNull()
	})
})

// ===========================================================================
// The app-shaped answer on the apply path
// ===========================================================================

describe('opEffect', () => {
	it('answers in application terms when a modelled op moves a surface', () => {
		const before = fixture()
		const after = applyOp(
			before,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-order',
					field: {
						id: 'fld-note',
						name: 'note',
						type: 'string',
						required: false,
						provenance: manual(),
					},
				},
			},
			meta(),
		)
		const effect = opEffect(before, after, { op: 'data.addField' })
		expect(effect.coverage).toBe('modelled')
		expect(effect.changesBuiltApp).toBe(true)
		expect(effect.added.join(' ')).toContain('order.note')
	})

	it('says the application did not move — the sentence a spec diff cannot write', () => {
		// A suggested entity next to an accepted one is not grounded, so nothing is
		// built from it. The document grew; the app did not. That is the whole
		// point of the field: `false`, stated, rather than silence.
		const before = fixture()
		const after = applyOp(
			before,
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-draft',
						name: 'Draft',
						fields: [],
						provenance: suggested(),
					},
				},
			},
			meta(),
		)
		const effect = opEffect(before, after, { op: 'data.addEntity' })
		expect(effect.changesBuiltApp).toBe(false)
		expect(effect.summary).toMatch(/built application is unchanged/)
	})

	it('refuses to claim "no effect" for presentation, which it cannot see', () => {
		// setBlockVariant genuinely changes what renders, and this inventory tracks
		// structure only. Reporting `false` here would be a lie in the same
		// direction as the silence #263 opened about — a claim the layer cannot back.
		const spec = fixture()
		const effect = opEffect(spec, spec, { op: 'page.setBlockVariant' })
		expect(effect.coverage).toBe('presentation')
		expect(effect.changesBuiltApp).toBeNull()
		expect(effect.note).toMatch(/replace-mode slot renders instead/)
	})

	it('refuses to claim "no effect" for a layer it does not model', () => {
		const spec = fixture()
		const effect = opEffect(spec, spec, { op: 'schedules.declare' })
		expect(effect.coverage).toBe('unmodelled')
		expect(effect.changesBuiltApp).toBeNull()
		expect(effect.summary).toMatch(/does not model its layer/)
	})

	it('carries the grounding note, so "nothing changed" is never bare', () => {
		// Accepting into a collection where nothing is accepted changes no surface,
		// and the reason is the rule rather than the op. Without the note a caller
		// reads inertness and applies a second op it does not need.
		let before = newSpecSystem(tasklyPRD)
		before = applyOp(
			before,
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-draft',
						name: 'Draft',
						fields: [],
						provenance: suggested(),
					},
				},
			},
			meta(),
		)
		const effect = opEffect(before, before, { op: 'data.addField' })
		expect(effect.changesBuiltApp).toBe(false)
		expect(effect.note).toMatch(/nothing is accepted yet in/)
	})
})
