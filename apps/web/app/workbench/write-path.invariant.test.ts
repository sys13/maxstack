/**
 * The write-path invariant suite, web surface.
 *
 * Four paths:
 *
 *   `web-submit-review`  the accept/reject form — the human review surface, and
 *                        the only path whose entire purpose is settling somebody
 *                        else's suggestion
 * `web-record-intent` the "what are you trying to build?" box —
 *                        the maintainer's own sentence, landed as a product-layer
 *                        requirement. The one write here that is not about a row
 *                        somebody was shown, which is exactly why it is asserted
 *                        to settle nothing
 *   `web-diff-preview`   `computeHypotheticalSpec` — the "if accepted" render
 *                        behind the structural diff pane. A read dressed as an
 *                        apply
 *   `web-demo-seed`      the demo spec the workbench boots against with no
 *                        project on disk
 *
 * The pairing of the first two is the point. They both call `applyOp` with a
 * `provenance.review`-shaped intent, and exactly one of them is allowed to reach
 * disk. That distinction is invisible in the type system — both return a
 * `SpecSystem` — so it is asserted here or it is asserted nowhere.
 *
 * `web-demo-seed` is stamped `harness` rather than `web` on purpose, and that is
 * tested: seeded rows must never read as somebody's real work in a surface whose
 * whole job is telling the maintainer what is theirs.
 *
 * Registry: scripts/write-paths.config.json. Policy: docs/write-paths.md.
 */

import {
	applyOp,
	type EntitySpec,
	manual,
	newSpecSystem,
	type OpId,
	opActorSchema,
	type SpecOp,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { computeHypotheticalSpec } from './diff-preview.server'
import { draftIntent, MAX_INTENT_LENGTH } from './intent'
import { applyReviewAction } from './view-model'

/** The actor the workbench form stamps — the real literal from workbench.server. */
const REVIEW_ACTOR = { surface: 'web' as const, path: 'web-submit-review' }

let n = 0
const reviewMeta = () => ({
	id: `op-rev-${++n}` as OpId,
	origin: 'human' as const,
	appliedAt: '2026-07-29',
	actor: REVIEW_ACTOR,
})

/** An entity with one undecided field, one manual field, one undecided self. */
function fixture(): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	const order: EntitySpec = {
		id: 'e-order',
		name: 'Order',
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
	return spec
}

// ===========================================================================
// web-submit-review — the one path whose job is to accept
// ===========================================================================

describe('write path "web-submit-review"', () => {
	it('attributes the review to the web surface and its write path', () => {
		const next = applyReviewAction(
			fixture(),
			{ kind: 'field', id: 'fld-note', parentId: 'e-order' },
			'accept',
			reviewMeta(),
		)
		const entry = next.opLog.at(-1)
		expect(entry?.op.op).toBe('provenance.review')
		expect(entry?.origin).toBe('human')
		expect(entry?.actor).toEqual(REVIEW_ACTOR)
		expect(opActorSchema.safeParse(entry?.actor).success).toBe(true)
	})

	it('is what actually moves a row from undecided to accepted', () => {
		const spec = fixture()
		expect(spec.data.entities[0]?.fields[1]?.provenance.isAccepted).toBeNull()
		const next = applyReviewAction(
			spec,
			{ kind: 'field', id: 'fld-note', parentId: 'e-order' },
			'accept',
			reviewMeta(),
		)
		expect(next.data.entities[0]?.fields[1]?.provenance.isAccepted).toBe(true)
		// Immutable: the input the loader still holds is unchanged.
		expect(spec.data.entities[0]?.fields[1]?.provenance.isAccepted).toBeNull()
	})

	it('records a reject as a decision, never as a delete', () => {
		// A rejected suggestion has to stay visible — a reviewer who rejects
		// something and finds it gone cannot tell rejection from a bug, and cannot
		// change their mind.
		const before = fixture()
		const next = applyReviewAction(
			before,
			{ kind: 'entity', id: 'e-order' },
			'reject',
			reviewMeta(),
		)
		expect(next.data.entities).toHaveLength(before.data.entities.length)
		expect(next.data.entities[0]?.provenance.isAccepted).toBe(false)
		expect(next.opLog.at(-1)?.actor).toEqual(REVIEW_ACTOR)
	})

	it('leaves an audit entry for every decision, including a cascade', () => {
		let spec = fixture()
		spec = applyReviewAction(
			spec,
			{ kind: 'entity', id: 'e-order' },
			'accept',
			reviewMeta(),
			true,
		)
		expect(spec.opLog).toHaveLength(1)
		const entry = spec.opLog[0]
		expect(entry?.diff.change).toBe('review')
		expect(entry?.diff.summary).toMatch(/undecided nested rows/)
		expect(entry?.actor).toEqual(REVIEW_ACTOR)
	})

	it('cannot overwrite a manual row via a cascade', () => {
		// The cascade is the primitive bulk review is built on, so "one decision
		// covers the subtree" must never mean "one decision overwrites the subtree".
		const next = applyReviewAction(
			fixture(),
			{ kind: 'entity', id: 'e-order' },
			'reject',
			reviewMeta(),
			true,
		)
		const total = next.data.entities[0]?.fields[0]?.provenance
		expect(total).toEqual(manual())
	})
})

// ===========================================================================
// web-record-intent — the one write here that is not about somebody's row
// ===========================================================================

describe('write path "web-record-intent"', () => {
	/** The real literal from intent.server.ts. */
	const INTENT_ACTOR = { surface: 'web' as const, path: 'web-record-intent' }

	const intentMeta = () => ({
		id: `op-int-${++n}` as OpId,
		origin: 'human' as const,
		appliedAt: '2026-07-31',
		actor: INTENT_ACTOR,
	})

	/** What `submitIntent` lands, minus the platform IO around it. */
	function record(spec: SpecSystem, story: string): SpecSystem {
		const draft = draftIntent(spec, story)
		if (!draft.ok) throw new Error(draft.message)
		return applyOp(
			spec,
			{ op: 'prd.addRequirement', args: { requirement: draft.requirement } },
			intentMeta(),
		)
	}

	it('attributes the intent to the person who typed it', () => {
		const next = record(fixture(), 'a place to log client visits')
		const entry = next.opLog.at(-1)
		expect(entry?.op.op).toBe('prd.addRequirement')
		// `human`, not `ai`: the maintainer's goal must not end up attributed to
		// whichever agent later writes the code for it.
		expect(entry?.origin).toBe('human')
		expect(entry?.actor).toEqual(INTENT_ACTOR)
		expect(opActorSchema.safeParse(entry?.actor).success).toBe(true)
	})

	it('stores the sentence verbatim, and invents no acceptance criteria', () => {
		const story = 'see who on my team is behind on follow-ups'
		const requirement = record(fixture(), story).product.requirements.at(-1)
		expect(requirement?.userStory).toBe(story)
		// An acceptance criterion nobody wrote is a test an agent will happily
		// satisfy instead of the thing the maintainer actually meant.
		expect(requirement?.acceptanceCriteria).toEqual([])
	})

	it('settles nothing', () => {
		// The invariant this path exists to be checked against. It is the only write
		// on this surface a person reaches without first being shown a row to decide
		// about, so "recording a goal cannot clear somebody's queue" is asserted
		// rather than assumed.
		const before = fixture()
		const after = record(before, 'let clients book their own visits')
		expect(after.opLog).toHaveLength(before.opLog.length + 1)
		expect(after.opLog.at(-1)?.op.op).toBe('prd.addRequirement')
		expect(after.data.entities).toEqual(before.data.entities)
		expect(after.pages).toEqual(before.pages)
	})

	it('does not mutate the spec the loader still holds', () => {
		const spec = fixture()
		const snapshot = structuredClone(spec)
		record(spec, 'a dashboard for the team')
		expect(spec).toEqual(snapshot)
	})

	it('gives two similar sentences distinct ids', () => {
		// `prd.addRequirement` refuses a duplicate id, so a collision would surface
		// to the maintainer as an op error for having said a similar thing twice.
		let spec = record(fixture(), 'a place to log client visits')
		spec = record(spec, 'a place to log client visits again')
		spec = record(spec, 'a place to log client visits')
		const ids = spec.product.requirements.map((r) => r.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('refuses an empty sentence rather than writing a blank requirement', () => {
		const empty = draftIntent(fixture(), '   ')
		expect(empty.ok).toBe(false)
		const huge = draftIntent(fixture(), 'x'.repeat(MAX_INTENT_LENGTH + 1))
		expect(huge.ok).toBe(false)
	})
})

// ===========================================================================
// web-diff-preview — a read dressed as an apply
// ===========================================================================

describe('write path "web-diff-preview"', () => {
	const addPage: SpecOp = {
		op: 'page.addPage',
		args: {
			page: {
				id: 'pg-orders',
				name: 'Orders',
				route: '/orders',
				entityId: 'e-order',
				provenance: suggested(),
				blocks: [{ id: 'blk-t', type: 'table', provenance: suggested() }],
			},
		},
	}

	it('never mutates the spec it previews against', () => {
		const spec = fixture()
		const before = structuredClone(spec)
		const { spec: hypothetical, error } = computeHypotheticalSpec(spec, addPage)
		expect(error).toBeNull()
		expect(hypothetical).not.toBeNull()
		expect(spec).toEqual(before)
	})

	it('shows the change in the hypothetical while the real spec has none', () => {
		const spec = fixture()
		const { spec: hypothetical } = computeHypotheticalSpec(spec, addPage)
		expect(hypothetical?.pages.pages.map((p) => p.id)).toContain('pg-orders')
		expect(spec.pages.pages.map((p) => p.id)).not.toContain('pg-orders')
		expect(spec.opLog).toHaveLength(0)
	})

	it('degrades to an error rather than throwing on a stale click', () => {
		// The queue is derived from a spec that may have moved on since it rendered,
		// so a click can arrive for an op that no longer validates.
		const { spec, error } = computeHypotheticalSpec(fixture(), {
			op: 'data.addField',
			args: {
				entityId: 'e-nonexistent',
				field: {
					id: 'fld-x',
					name: 'x',
					type: 'string',
					required: false,
					provenance: suggested(),
				},
			},
		} as SpecOp)
		expect(spec).toBeNull()
		expect(error).toBeTruthy()
	})

	it('previews a review without performing it', () => {
		// The riskiest preview: previewing an *accept*. If this leaked, clicking
		// "show me what this would do" would do it.
		const spec = fixture()
		const before = structuredClone(spec)
		computeHypotheticalSpec(spec, {
			op: 'provenance.review',
			args: {
				target: { kind: 'entity', id: 'e-order' },
				action: 'accept',
				cascade: true,
			},
		})
		expect(spec).toEqual(before)
		expect(spec.data.entities[0]?.provenance.isAccepted).toBeNull()
	})

	it('stays write-free across a long browse of the queue', () => {
		const spec = fixture()
		const before = structuredClone(spec)
		for (let i = 0; i < 20; i++) {
			computeHypotheticalSpec(spec, {
				op: 'page.addPage',
				args: {
					page: {
						id: `pg-try${i}`,
						name: `Try${i}`,
						route: `/try${i}`,
						entityId: 'e-order',
						provenance: suggested(),
						blocks: [],
					},
				},
			})
		}
		expect(spec).toEqual(before)
	})
})

// ===========================================================================
// web-demo-seed — a rig, and it has to say so
// ===========================================================================

describe('write path "web-demo-seed"', () => {
	it('is declared on the harness surface, not the web one', async () => {
		// Imported lazily: sprout.server pulls the whole runtime, and this assertion
		// only needs the seeded spec's op log.
		const { getPlatform } = await import('../sprout.server')
		const spec = await getPlatform().spec.load()
		const seeded = spec.opLog.filter((e) => e.actor?.path === 'web-demo-seed')
		// Only present when the workbench booted against the demo spec (no project
		// on disk). When a real project is wired there is nothing seeded to check.
		if (seeded.length === 0) return
		for (const entry of seeded) {
			expect(entry.actor?.surface).toBe('harness')
			expect(entry.origin).toBe('ai')
		}
	})
})
