/**
 * What needs the maintainer, in order.
 *
 * Almost every assertion here is about **ordering** or about **an absence being
 * visible**. That is deliberate: the individual categories are already tested
 * where they are derived, and the thing this module adds — and the thing that
 * would silently rot — is the claim that the first item on the list is the one
 * that matters most.
 */

import {
	applyOp,
	manual,
	newSpecSystem,
	type OpId,
	pendingProposals,
	type RiskContext,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import {
	ATTENTION_KINDS,
	attentionReport,
	specIfAllAccepted,
} from './attention.ts'

let n = 0
const meta = () => ({
	id: `op-at${++n}` as OpId,
	origin: 'ai' as const,
	appliedAt: '2026-07-29',
	actor: { surface: 'harness' as const, path: 'attention-test' },
})

/** A host that read the manifest and found nothing owned. */
const KNOWN: RiskContext = {
	ownedEntityIds: [],
	ownedPageIds: [],
	ownershipKnown: true,
}

/**
 * A project with a mixture: an access-shaped proposal on a portal-exposed entity,
 * and a routine proposal on an entity no portal touches.
 *
 * The two entities are not cosmetic. #199 classifies *anything* on an entity a
 * portal declares over as high-risk, paused or not — so putting the routine field
 * on `e-order` alongside the portal made every proposal unbatchable and the
 * "routine" category empty. The fixture has to contain a genuinely routine row for
 * the ordering assertions to mean anything.
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
					provenance: manual(),
					fields: [
						{
							id: 'fld-total',
							name: 'total',
							type: 'number',
							required: true,
							provenance: manual(),
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
					],
				},
			},
		},
		meta(),
	)
	spec = applyOp(
		spec,
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-note',
					name: 'Note',
					provenance: manual(),
					fields: [
						{
							id: 'fld-body',
							name: 'body',
							type: 'string',
							required: false,
							provenance: manual(),
						},
						{
							id: 'fld-tag',
							name: 'tag',
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
			op: 'portals.declare',
			args: {
				portal: {
					id: 'ptl-paused',
					key: 'archive',
					description: 'the paused public archive',
					entityId: 'e-order',
					audience: 'public',
					scope: 'collection',
					filter: { fieldId: 'fld-total', equals: 1 },
					readFields: ['fld-total'],
					writes: [],
					layout: 'table',
					paused: true,
					provenance: manual(),
				},
			},
		},
		meta(),
	)
	return spec
}

describe('the ordering is the product', () => {
	it('ranks public exposure above everything else', () => {
		// The ranking encodes which mistakes are unrecoverable, so it is asserted as a
		// property of the vocabulary rather than left to the sort's implementation.
		expect(ATTENTION_KINDS[0]).toBe('public-change')
		expect(ATTENTION_KINDS.indexOf('removal')).toBeLessThan(
			ATTENTION_KINDS.indexOf('unbatchable'),
		)
		expect(ATTENTION_KINDS.indexOf('unbatchable')).toBeLessThan(
			ATTENTION_KINDS.indexOf('routine'),
		)
		expect(ATTENTION_KINDS.at(-1)).toBe('routine')
	})

	it('puts a field crossing the public boundary at the top, above a risky proposal', () => {
		const spec = fixture()
		// Un-pausing the archive publishes `total`. There is also an access-control
		// field pending, which would otherwise be item one.
		const ifAccepted = applyOp(
			spec,
			{ op: 'portals.pause', args: { portalId: 'ptl-paused', paused: false } },
			meta(),
		)
		const report = attentionReport(spec, { risk: KNOWN, ifAccepted })

		expect(report.items[0]?.kind).toBe('public-change')
		expect(report.headline).toMatch(/public internet/)
		// And the risky proposal is still there, just below it.
		expect(report.items.some((i) => i.kind === 'unbatchable')).toBe(true)
	})

	it('puts the access-control proposal above the routine ones', () => {
		const report = attentionReport(fixture(), { risk: KNOWN })
		const first = report.items.findIndex((i) => i.kind === 'unbatchable')
		const routine = report.items.findIndex((i) => i.kind === 'routine')
		expect(first).toBeGreaterThanOrEqual(0)
		expect(first).toBeLessThan(routine)
		// Both proposals on the portal-exposed entity are unbatchable — the
		// access-control one by name, its neighbour because a portal declares over
		// that entity at all — and the routine one on `e-note` sits below both.
		const unbatchable = report.items
			.filter((i) => i.kind === 'unbatchable')
			.map((i) => i.title)
		expect(unbatchable.some((t) => /viewerRole/.test(t))).toBe(true)
		expect(unbatchable.some((t) => /tag/.test(t))).toBe(false)
	})

	it('collapses the routine majority into one item rather than listing them', () => {
		// These are the rows the surface exists to make cheap. Listing them
		// individually would put the routine majority back in the reviewer's way.
		const report = attentionReport(fixture(), { risk: KNOWN })
		const routine = report.items.filter((i) => i.kind === 'routine')
		expect(routine).toHaveLength(1)
		expect(routine[0]?.title).toMatch(/can be cleared in a batch/)
	})
})

describe('every item says why it is where it is', () => {
	it('carries a reason on every item, not just a category', () => {
		// A ranked list whose ranking cannot be explained is a ranking nobody trusts.
		const report = attentionReport(fixture(), { risk: KNOWN })
		expect(report.items.length).toBeGreaterThan(0)
		for (const item of report.items) {
			expect(item.because.length).toBeGreaterThan(20)
			expect(item.title.length).toBeGreaterThan(5)
		}
	})

	it('names specific rows rather than reporting a count', () => {
		// "17 pending" is a number, not attention. A maintainer cannot act on a badge.
		const report = attentionReport(fixture(), { risk: KNOWN })
		expect(report.items.some((i) => i.title.includes('viewerRole'))).toBe(true)
		// The count is still available, as context under the named items.
		expect(report.pending).toBeGreaterThan(0)
	})
})

describe('the headline is about the list, not a line inside it', () => {
	// The bug this fixes: `headline` was `items[0].title` verbatim, so all three
	// renderers — the pane, `maxstack review`, the `workbench` MCP tool — printed
	// the same sentence, then immediately printed it again as the first list item.
	it('never repeats any item title', () => {
		const report = attentionReport(fixture(), { risk: KNOWN, drift: [] })
		expect(report.items.length).toBeGreaterThan(1)
		for (const item of report.items)
			expect(report.headline).not.toBe(item.title)
	})

	it('names the worst category and what is behind it, not the worst row', () => {
		const report = attentionReport(fixture(), { risk: KNOWN })
		expect(report.items[0]?.kind).toBe('unbatchable')
		expect(report.headline).toMatch(/individual decision/)
		// The specific row is the list's job — the headline must not name it.
		expect(report.headline).not.toMatch(/viewerRole/)
		const rest = report.items.filter((i) => i.kind !== 'unbatchable').length
		if (rest > 0) expect(report.headline).toMatch(new RegExp(`${rest} more`))
	})

	it('carries the unchecked count on a non-empty report too', () => {
		// "nothing needs you" is not the only sentence that can mislead by omission:
		// a report that found two things and could not look at four categories is
		// also over-claiming if it says so with no qualifier.
		const report = attentionReport(fixture())
		expect(report.unavailable.length).toBeGreaterThan(0)
		expect(report.headline).toMatch(/could not be checked/)
	})
})

describe('an absence is visible', () => {
	it('names every category it could not evaluate', () => {
		// The failure this guards: an empty report from a host that could not look
		// reads exactly like an all-clear from one that did.
		const report = attentionReport(fixture())
		expect(report.unavailable.some((u) => u.startsWith('ownership'))).toBe(true)
		expect(report.unavailable.some((u) => u.startsWith('drift'))).toBe(true)
		expect(
			report.unavailable.some((u) => u.includes('accepting what is pending')),
		).toBe(true)
		expect(
			report.unavailable.some((u) => u.startsWith('module upgrades')),
		).toBe(true)
	})

	it('refuses to say "nothing needs you" when it could not check', () => {
		const empty = newSpecSystem(tasklyPRD)
		const partial = attentionReport(empty)
		expect(partial.headline).toMatch(/could not be checked/)
		expect(partial.headline).not.toMatch(/Nothing needs you/)
	})

	it('says "nothing needs you" only on a complete, clean report', () => {
		const empty = newSpecSystem(tasklyPRD)
		const full = attentionReport(empty, {
			risk: KNOWN,
			drift: [],
			upgrades: [],
			ifAccepted: empty,
		})
		expect(full.items).toEqual([])
		expect(full.unavailable).toEqual([])
		expect(full.headline).toMatch(/^Nothing needs you/)
	})

	it('treats unknown ownership as needing individual review, and says so', () => {
		// #199's conservative direction, surfaced: with no manifest every proposal is
		// unbatchable, which is right, but a reviewer needs to know it is because the
		// host could not look rather than because the rows are dangerous.
		const report = attentionReport(fixture())
		expect(report.items.some((i) => i.kind === 'unbatchable')).toBe(true)
		expect(report.items.some((i) => i.kind === 'routine')).toBe(false)
		expect(
			report.unavailable.some((u) => u.includes('which files you own')),
		).toBe(true)
	})
})

describe('host-supplied facts', () => {
	it('reports a drifted owned file, and ignores an in-sync one', () => {
		const report = attentionReport(fixture(), {
			risk: KNOWN,
			drift: [
				{ id: 'order', file: 'app/routes/order.tsx', drifted: true },
				{ id: 'story', file: 'app/routes/story.tsx', drifted: false },
			],
		})
		const drift = report.items.filter((i) => i.kind === 'drift')
		expect(drift).toHaveLength(1)
		expect(drift[0]?.where).toBe('app/routes/order.tsx')
	})

	it('reports an available upgrade as routine, not as urgent', () => {
		const report = attentionReport(newSpecSystem(tasklyPRD), {
			risk: KNOWN,
			drift: [],
			upgrades: [{ slug: 'billing', from: '0.2.0', to: '0.3.0' }],
			ifAccepted: newSpecSystem(tasklyPRD),
		})
		expect(report.items).toHaveLength(1)
		expect(report.items[0]?.kind).toBe('routine')
		expect(report.items[0]?.title).toMatch(/billing/)
	})

	it('leads with a removal when accepting would drop a column', () => {
		const spec = fixture()
		const ifAccepted: SpecSystem = structuredClone(spec)
		const entity = ifAccepted.data.entities.find((e) => e.id === 'e-order')
		if (entity)
			entity.fields = entity.fields.filter((f) => f.id !== 'fld-total')

		const report = attentionReport(spec, { risk: KNOWN, drift: [], ifAccepted })
		// Above the access-control proposal: dropped data outranks a risky addition.
		expect(report.items[0]?.kind).toBe('removal')
		expect(report.items[0]?.title).toMatch(/STOPS EXISTING/)
	})
})

// ===========================================================================
// The write path
// ===========================================================================

describe('the attention-hypothetical write path', () => {
	/**
	 * `specIfAllAccepted` is a declared **preflight** path in
	 * `scripts/write-paths.config.json`: it reaches `applyOp` and must never reach
	 * `spec.save`. The registry gate caught it as an undeclared path the moment it
	 * landed, which is the gate working — but a declaration is only worth the test
	 * behind it, so these assert the two properties the declaration claims.
	 */
	it('leaves the input system untouched', () => {
		const spec = fixture()
		const before = JSON.stringify(spec)
		specIfAllAccepted(spec, KNOWN)
		expect(JSON.stringify(spec)).toBe(before)
	})

	it('stamps every projected op so a leak into a real log is findable by name', () => {
		// If one of these ever reached a durable op log, the trail would say what it
		// was instead of reading like a review somebody performed.
		const projected = specIfAllAccepted(fixture(), KNOWN)
		const added = projected.opLog.slice(fixture().opLog.length)
		expect(added.length).toBeGreaterThan(0)
		for (const entry of added) {
			expect(entry.actor?.path).toBe('attention-hypothetical')
			expect(entry.actor?.surface).toBe('mcp')
		}
	})

	it('really does accept the pending rows in the projection', () => {
		// Otherwise the two assertions above pass over a no-op.
		const spec = fixture()
		const projected = specIfAllAccepted(spec, KNOWN)
		expect(pendingProposals(projected, KNOWN)).toEqual([])
		expect(pendingProposals(spec, KNOWN).length).toBeGreaterThan(0)
	})
})
