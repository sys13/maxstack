/**
 * The write-path invariant suite, spec layer.
 *
 * The load-bearing sentence of the positioning is that the maintainer stays in
 * charge of every change. What that reduces to, mechanically, is four properties
 * — and every one of them was true by accident before this file existed:
 *
 *   (a) **Attribution.** Every landed op records who landed it: author kind
 *       (`origin`) plus which author (`actor`). No unattributed writes.
 *   (b) **Suggest is not accept.** A validate or a preview never mutates the spec
 *       it was handed, however deep inside it an `applyOp` lives.
 *   (c) **Accept is a review.** Only `provenance.review` moves an existing row
 *       from undecided to accepted. No op smuggles an acceptance sideways.
 *   (d) **Regen never eats manual work.** A manual row survives every sequence.
 *
 * These are asserted here over the op engine, and per-surface in each write
 * path's own `write-path.invariant.test.ts`. `scripts/check-write-paths.mjs`
 * refuses a write path that no such suite names, so a new way to write the spec
 * cannot land silently uncovered.
 *
 * Deliberately NOT asserted: that an agent's applied op stays out of grounding
 * until a human clicks accept. Issue #70 settled that MCP-applied rows land
 * accepted, because undecided rows are invisible to the runtime and an agent
 * whose work never appears is an agent that does not work. Review here is a
 * **record, not a gate** — the promise is that every change is attributable,
 * visible and revertible, and that is what these tests pin. Asserting the
 * blocking version would be asserting a behaviour the platform does not have.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import { OP_SURFACES, opActorSchema } from './actor.ts'
import type { OpId } from './ids.ts'
import { manual, suggested } from './provenance.ts'
import {
	type ApplyMeta,
	applyOp,
	type SpecOp,
	validateOp,
	validateOpDryRun,
} from './spec-ops.ts'
import { collectSpecSystemErrors } from './spec-system.schema.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

const base = (): SpecSystem => newSpecSystem(tasklyPRD)

let n = 0
const meta = (origin: 'ai' | 'human' = 'ai'): ApplyMeta => ({
	id: `op-inv-${++n}` as OpId,
	origin,
	appliedAt: '2026-07-29',
	actor: { surface: 'harness', path: 'spec-invariant-suite' },
})

/** An entity whose rows land undecided — a review-queue candidate. */
const undecidedEntity: SpecOp = {
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-invoice',
			name: 'Invoice',
			provenance: suggested(),
			fields: [
				{
					id: 'fld-total',
					name: 'total',
					type: 'number',
					required: true,
					provenance: suggested(),
				},
			],
		},
	},
}

/** The same entity, hand-authored: accepted and regen-protected. */
const manualEntity: SpecOp = {
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-ledger',
			name: 'Ledger',
			provenance: manual(),
			fields: [
				{
					id: 'fld-balance',
					name: 'balance',
					type: 'number',
					required: true,
					provenance: manual(),
				},
			],
		},
	},
}

// ===========================================================================
// (a) Attribution — no unattributed writes
// ===========================================================================

describe('invariant (a): every landed op is attributed', () => {
	it('stamps origin AND actor onto the op-log entry', () => {
		const spec = applyOp(base(), undecidedEntity, meta('ai'))
		const entry = spec.opLog.at(-1)
		expect(entry?.origin).toBe('ai')
		expect(entry?.actor).toEqual({
			surface: 'harness',
			path: 'spec-invariant-suite',
		})
	})

	it('leaves no op-log entry unattributed, whatever the op', () => {
		let spec = base()
		for (const op of [undecidedEntity, manualEntity]) {
			spec = applyOp(spec, op, meta())
		}
		spec = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'entity', id: 'e-invoice' },
					action: 'accept',
					cascade: true,
				},
			},
			meta('human'),
		)
		expect(spec.opLog).toHaveLength(3)
		for (const entry of spec.opLog) {
			expect(entry.actor, `op ${entry.id} landed unattributed`).toBeDefined()
			expect(opActorSchema.safeParse(entry.actor).success).toBe(true)
		}
	})

	it('refuses to load a spec whose op-log actor is malformed', () => {
		// The audit trail is a file in the maintainer's repo, so it can arrive
		// hand-edited or hand-merged. A surface that does not exist has to fail the
		// validator rather than sit in the log looking like an answer.
		const spec = applyOp(base(), undecidedEntity, meta())
		const entry = spec.opLog[0]
		if (!entry) throw new Error('expected an op-log entry')
		entry.actor = { surface: 'telepathy' as never }
		const errors = collectSpecSystemErrors(spec)
		expect(errors.some((e) => /malformed actor/.test(e))).toBe(true)
	})

	it('accepts a spec whose op-log predates attribution', () => {
		// An entry written before #200 genuinely has no actor. Synthesizing one
		// would put a fabricated provenance record in an audit trail, so absent
		// stays legal — and the *validator* has to agree, or every project written
		// before this change becomes unloadable.
		const spec = applyOp(base(), undecidedEntity, meta())
		const entry = spec.opLog[0]
		if (!entry) throw new Error('expected an op-log entry')
		delete entry.actor
		expect(collectSpecSystemErrors(spec)).toEqual([])
	})

	it('only knows the surfaces the registry is allowed to name', () => {
		// `scripts/check-write-paths.mjs` reads this array out of actor.ts by regex
		// to validate the registry. If the shape drifts the checker fails loudly, but
		// this pins the contents so a surface cannot be quietly added without a test
		// run noticing.
		expect([...OP_SURFACES]).toEqual([
			'mcp',
			'cli',
			'web',
			'bundle',
			'codemod',
			'harness',
		])
	})
})

// ===========================================================================
// (b) Suggest is not accept — `validate-op-dry-run`
// ===========================================================================

describe('write path "validate-op-dry-run": a validate never writes', () => {
	it('leaves the input system byte-identical', () => {
		const spec = base()
		const before = structuredClone(spec)
		validateOpDryRun(spec, undecidedEntity, 'ai')
		expect(spec).toEqual(before)
	})

	it('adds nothing to the op log, even though it applies internally', () => {
		// `validateOpDryRun` genuinely calls `applyOp` — that is how it finds the
		// errors a save would raise. The property is that the result is
		// thrown away, which is invisible from the outside and therefore worth a test.
		const spec = base()
		validateOpDryRun(spec, undecidedEntity, 'ai')
		validateOpDryRun(spec, manualEntity, 'human')
		expect(spec.opLog).toHaveLength(0)
		expect(spec.data.entities).toHaveLength(0)
	})

	it('does not write even when the op is invalid', () => {
		const spec = base()
		const before = structuredClone(spec)
		const errors = validateOpDryRun(
			spec,
			{
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
			} as SpecOp,
			'ai',
		)
		expect(errors.length).toBeGreaterThan(0)
		expect(spec).toEqual(before)
	})

	it('blesses exactly what a real apply then accepts', () => {
		// The point of sharing one validator: propose can never bless a payload
		// apply rejects. Asserted rather than assumed, because the two calls having
		// drifted apart is precisely the bug #71 fixed and nothing pinned it.
		const spec = base()
		expect(validateOpDryRun(spec, undecidedEntity, 'ai')).toEqual([])
		expect(() => applyOp(spec, undecidedEntity, meta())).not.toThrow()
	})
})

// ===========================================================================
// (c) Accept is a review — only provenance.review settles a row
// ===========================================================================

describe('invariant (c): only provenance.review flips undecided → accepted', () => {
	/** Every (row id → isAccepted) pair in a spec, for before/after comparison. */
	const acceptanceMap = (spec: SpecSystem): Map<string, boolean | null> => {
		const out = new Map<string, boolean | null>()
		for (const e of spec.data.entities) {
			out.set(e.id, e.provenance.isAccepted)
			for (const f of e.fields) out.set(f.id, f.provenance.isAccepted)
		}
		for (const p of spec.pages.pages) {
			out.set(p.id, p.provenance.isAccepted)
			for (const b of p.blocks) out.set(b.id, b.provenance.isAccepted)
		}
		for (const t of spec.pricing.tiers) out.set(t.id, t.provenance.isAccepted)
		return out
	}

	it("leaves every existing row's acceptance untouched across a non-review op", () => {
		let spec = applyOp(base(), undecidedEntity, meta())
		const before = acceptanceMap(spec)
		// A whole batch of structural ops, none of them a review.
		spec = applyOp(spec, manualEntity, meta())
		spec = applyOp(
			spec,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-invoice',
					field: {
						id: 'fld-due',
						name: 'due',
						type: 'date',
						required: false,
						provenance: suggested(),
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
						id: 'pg-invoices',
						name: 'Invoices',
						route: '/invoices',
						entityId: 'e-invoice',
						provenance: suggested(),
						blocks: [{ id: 'blk-t', type: 'table', provenance: suggested() }],
					},
				},
			},
			meta(),
		)
		const after = acceptanceMap(spec)
		for (const [id, value] of before) {
			expect(after.get(id), `op batch changed acceptance of "${id}"`).toBe(
				value,
			)
		}
	})

	it('flips it when — and only when — a review says so', () => {
		let spec = applyOp(base(), undecidedEntity, meta())
		expect(spec.data.entities[0]?.provenance.isAccepted).toBeNull()
		spec = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'entity', id: 'e-invoice' },
					action: 'accept',
					cascade: true,
				},
			},
			meta('human'),
		)
		expect(spec.data.entities[0]?.provenance.isAccepted).toBe(true)
		expect(spec.data.entities[0]?.fields[0]?.provenance.isAccepted).toBe(true)
	})

	it('never lets a cascade overwrite a settled or manual decision', () => {
		// The cascade is the bulk-review primitive, so "one
		// decision covers the subtree" must not mean "one decision overwrites the
		// subtree". A rejected child stays rejected; a manual child stays manual.
		let spec = applyOp(base(), undecidedEntity, meta())
		spec = applyOp(
			spec,
			{
				op: 'data.addField',
				args: {
					entityId: 'e-invoice',
					field: {
						id: 'fld-hand',
						name: 'hand',
						type: 'string',
						required: false,
						provenance: manual(),
					},
				},
			},
			meta('human'),
		)
		spec = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'field', id: 'fld-total', parentId: 'e-invoice' },
					action: 'reject',
				},
			},
			meta('human'),
		)
		spec = applyOp(
			spec,
			{
				op: 'provenance.review',
				args: {
					target: { kind: 'entity', id: 'e-invoice' },
					action: 'accept',
					cascade: true,
				},
			},
			meta('human'),
		)
		const fields = spec.data.entities[0]?.fields ?? []
		expect(
			fields.find((f) => f.id === 'fld-total')?.provenance.isAccepted,
		).toBe(false)
		const hand = fields.find((f) => f.id === 'fld-hand')?.provenance
		expect(hand?.isAccepted).toBe(true)
		expect(hand?.isAddedManually).toBe(true)
	})
})

// ===========================================================================
// (d) The property test — over sequences, not single ops
// ===========================================================================

describe('property: any sequence of agent ops preserves the invariants', () => {
	/**
	 * A deterministic pseudo-random walk over the op vocabulary. Seeded rather than
	 * `Math.random()` so a failure is reproducible from the reported seed — an
	 * unreproducible property failure is a flake nobody can act on, which is worse
	 * than no property test.
	 */
	const lcg = (seed: number) => () => {
		seed = (seed * 1103515245 + 12345) % 2147483648
		return seed / 2147483648
	}

	/** The ops an *agent* can author — deliberately excluding provenance.review,
	 *  which is the human decision the sequence must not be able to fake. */
	function agentOp(i: number, pick: () => number): SpecOp | null {
		const r = pick()
		if (r < 0.4) {
			return {
				op: 'data.addEntity',
				args: {
					entity: {
						id: `e-gen${i}`,
						name: `Gen${i}`,
						provenance: suggested(),
						fields: [
							{
								id: `fld-gen${i}`,
								name: 'label',
								type: 'string',
								required: false,
								provenance: suggested(),
							},
						],
					},
				},
			}
		}
		if (r < 0.7) {
			return {
				op: 'page.addPage',
				args: {
					page: {
						id: `pg-gen${i}`,
						name: `Gen${i}`,
						route: `/gen${i}`,
						entityId: 'e-anchor',
						provenance: suggested(),
						blocks: [
							{ id: `blk-gen${i}`, type: 'table', provenance: suggested() },
						],
					},
				},
			}
		}
		return {
			op: 'data.addField',
			args: {
				entityId: 'e-anchor',
				field: {
					id: `fld-anchor${i}`,
					name: `extra${i}`,
					type: 'number',
					required: false,
					provenance: suggested(),
				},
			},
		}
	}

	/** The spec every walk starts from: one accepted anchor entity to reference,
	 *  one manual field that must survive, one undecided field that must not be
	 *  settled by anything the walk does. */
	function seed(): SpecSystem {
		return applyOp(
			base(),
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-anchor',
						name: 'Anchor',
						provenance: manual(),
						fields: [
							{
								id: 'fld-kept',
								name: 'kept',
								type: 'string',
								required: false,
								provenance: manual(),
							},
							{
								id: 'fld-pending',
								name: 'pending',
								type: 'string',
								required: false,
								provenance: suggested(),
							},
						],
					},
				},
			},
			meta('human'),
		)
	}

	for (const s of [1, 7, 42, 1337, 90210]) {
		it(`holds over a 30-op agent walk (seed ${s})`, () => {
			const pick = lcg(s)
			let spec = seed()
			let landed = 0
			for (let i = 0; i < 30; i++) {
				const op = agentOp(i, pick)
				if (!op) continue
				// Only land what validates — an agent's invalid op is rejected, which is
				// itself the platform working, and forcing it through would test nothing.
				if (validateOp(spec, op).length > 0) continue
				spec = applyOp(spec, op, meta('ai'))
				landed++
			}
			// The walk has to actually do something, or the assertions below are vacuous.
			expect(landed).toBeGreaterThan(5)

			const anchor = spec.data.entities.find((e) => e.id === 'e-anchor')
			const fields = anchor?.fields ?? []

			// (c) the undecided row the agent never reviewed is still undecided
			expect(
				fields.find((f) => f.id === 'fld-pending')?.provenance.isAccepted,
				'an agent-only sequence settled a pending review',
			).toBeNull()

			// (d) the manual row is untouched, flags and all
			expect(fields.find((f) => f.id === 'fld-kept')?.provenance).toEqual(
				manual(),
			)

			// (a) every entry is attributed, and no review appears in the log
			for (const entry of spec.opLog) {
				expect(entry.actor?.surface).toBeDefined()
				expect(entry.op.op).not.toBe('provenance.review')
			}

			// the spec is still valid — a walk that corrupts it proves nothing
			expect(collectSpecSystemErrors(spec)).toEqual([])
		})
	}
})
