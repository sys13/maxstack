/**
 * Agreement: the blast-radius derivation names the same tables and columns the
 * runtime actually builds.
 *
 * `packages/mcp/src/blast-radius.ts` repeats two rules the runtime's grounding
 * owns — `e-order` → `order`, and a field's name is its column — because
 * `@maxstack/mcp` may not import `apps/*` (the architecture boundary), and
 * `groundedEntityShapes` lives in the app.
 *
 * A duplicated rule is only acceptable when something fails on divergence. That
 * is this file, in the same shape as the spec↔features SSRF agreement test
 *: the duplicate is deliberate, and it is pinned rather than trusted.
 *
 * Why it has to be pinned rather than reasoned about: a blast-radius report is a
 * set of sentences a reviewer consents on the basis of. "The `order` table gains
 * a `total` column" is worthless — worse than nothing, because it is *specific*
 * — if the table it actually gains the column on is called something else. The
 * failure would be silent, plausible, and would only surface as confusion.
 */

import { deriveSurfaces } from '@maxstack/mcp'
import {
	applyOp,
	manual,
	newSpecSystem,
	type OpId,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { groundedEntityShapes } from '~/spec-sprout'

let n = 0
const meta = () => ({
	id: `op-agree${++n}` as OpId,
	origin: 'ai' as const,
	appliedAt: '2026-07-29',
	actor: { surface: 'harness' as const, path: 'blast-radius-agreement' },
})

/**
 * A spec exercising the naming rules rather than a happy path: a hyphenated
 * entity id, a mixed-case field name, and both provenance states, because the
 * accepted-or-all rule is part of what has to agree.
 */
function fixture(): SpecSystem {
	let spec = newSpecSystem(tasklyPRD)
	spec = applyOp(
		spec,
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-purchase-order',
					name: 'Purchase Order',
					provenance: manual(),
					fields: [
						{
							id: 'fld-total',
							name: 'grandTotal',
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
					],
				},
			},
		},
		meta(),
	)
	return spec
}

/** The `resource.column` pairs the blast-radius model claims exist. */
function claimedColumns(spec: SpecSystem): string[] {
	return deriveSurfaces(spec)
		.filter((s) => s.kind === 'column')
		.map((s) => s.id.replace(/^column:/, ''))
		.sort()
}

/** The `resource.column` pairs the runtime actually grounds. */
function groundedColumns(spec: SpecSystem): string[] {
	return groundedEntityShapes(spec)
		.flatMap((shape) => shape.fields.map((f) => `${shape.name}.${f.name}`))
		.sort()
}

describe('blast radius agrees with the runtime it is describing', () => {
	it('names the same tables', () => {
		const spec = fixture()
		const claimed = deriveSurfaces(spec)
			.filter((s) => s.kind === 'table')
			.map((s) => s.id.replace(/^table:/, ''))
			.sort()
		const grounded = groundedEntityShapes(spec)
			.map((shape) => shape.name)
			.sort()
		expect(claimed).toEqual(grounded)
		// Not vacuous: the fixture really does carry the entity under test.
		expect(claimed).toContain('purchase-order')
	})

	it('names the same columns, including the accepted-or-all subset', () => {
		// The subtle half. Grounding runs over `getAcceptedOrAll`, so on this fixture
		// (one accepted field, one suggested) the suggested column is NOT built. If
		// blast radius used a different rule it would promise the reviewer a column
		// that no table gets, or hide one that every table gets.
		const spec = fixture()
		expect(claimedColumns(spec)).toEqual(groundedColumns(spec))
		expect(claimedColumns(spec)).toContain('purchase-order.grandTotal')
		expect(claimedColumns(spec)).not.toContain('purchase-order.notes')
	})

	it('still agrees once the suggested column is accepted', () => {
		// And they have to keep agreeing *through* the transition, because the whole
		// product of this derivation is a before/after pair across exactly this move.
		const before = fixture()
		const after = applyOp(
			before,
			{
				op: 'provenance.review',
				args: {
					target: {
						kind: 'field',
						id: 'fld-notes',
						parentId: 'e-purchase-order',
					},
					action: 'accept',
				},
			},
			meta(),
		)
		expect(claimedColumns(after)).toEqual(groundedColumns(after))
		expect(claimedColumns(after)).toContain('purchase-order.notes')
	})

	it('agrees on a spec where nothing is accepted at all', () => {
		// The accepted-or-all fallback: with no accepted row anywhere, everything is
		// grounded. Both sides have to take that branch together, or the grounding
		// note in `blastRadius` would be attached to the wrong cases.
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
		expect(claimedColumns(spec)).toEqual(groundedColumns(spec))
		expect(claimedColumns(spec)).toContain('draft.title')
	})
})
