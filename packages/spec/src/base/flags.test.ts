/**
 * Flags as spec-as-data — the declaration, the four ops, and the
 * evaluation rule.
 *
 * The property that matters most here is the one determinism rests on: nothing
 * in this module can be reached from the generator, and evaluating a flag never
 * touches the spec. The "generation cannot depend on a flag's value" test lives
 * with the generator (`packages/mcp/src/generators.test.ts`), where it can fail
 * for the right reason.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import {
	evaluateFlag,
	evaluateFlags,
	type FlagSpec,
	findFlag,
	flagGates,
	listFlags,
	rolloutBucket,
} from './flags.ts'
import { manual } from './provenance.ts'
import {
	type ApplyMeta,
	applyOp,
	diffOp,
	type SpecOp,
	validateOp,
	validateOpDryRun,
} from './spec-ops.ts'
import { collectSpecSystemErrors } from './spec-system.schema.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

const base = (): SpecSystem => newSpecSystem(tasklyPRD)
const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: 'human',
	appliedAt: '2026-07-27',
})

interface DeclareOverrides {
	id?: string
	key?: string
	default?: boolean
	targeting?: FlagSpec['targeting']
}

const declare = (over: DeclareOverrides = {}): SpecOp => ({
	op: 'flags.declare',
	args: {
		flag: {
			id: (over.id ?? 'flg-checkout-v2') as FlagSpec['id'],
			key: over.key ?? 'checkout-v2',
			description: 'The rebuilt checkout flow.',
			default: over.default ?? false,
			...(over.targeting ? { targeting: over.targeting } : {}),
		},
	},
})

/** A spec with one declared flag and one page that can be gated on it. */
function withFlagAndPage(): SpecSystem {
	let spec = applyOp(base(), declare(), meta(1))
	spec = applyOp(
		spec,
		{
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-checkout',
					name: 'Checkout',
					route: '/checkout',
					blocks: [{ id: 'blk-checkout-table', type: 'table' }],
				},
			},
		},
		meta(2),
	)
	return spec
}

describe('flags.declare', () => {
	it('lands a declaration and stamps declaredAt from the op, not the author', () => {
		const spec = applyOp(base(), declare(), meta(1))
		const flag = findFlag(spec, 'checkout-v2')
		expect(flag?.id).toBe('flg-checkout-v2')
		expect(flag?.declaredAt).toBe('2026-07-27')
		expect(listFlags(spec)).toHaveLength(1)
		expect(collectSpecSystemErrors(spec)).toEqual([])
	})

	it('refuses a duplicate id or key', () => {
		const spec = applyOp(base(), declare(), meta(1))
		expect(validateOp(spec, declare())).toContain(
			'flags.declare: flag id "flg-checkout-v2" already exists',
		)
		expect(validateOp(spec, declare({ id: 'flg-other' })).join('\n')).toContain(
			'flag key "checkout-v2" already exists',
		)
	})

	it('refuses a key that is not a slug, and a flag with no description', () => {
		expect(
			validateOp(base(), declare({ key: 'Checkout V2' })).join('\n'),
		).toMatch(/must match/)
		const noDescription: SpecOp = {
			op: 'flags.declare',
			args: {
				flag: {
					id: 'flg-x',
					key: 'x',
					description: '   ',
					default: false,
				},
			},
		}
		expect(validateOp(base(), noDescription).join('\n')).toMatch(
			/needs a description/,
		)
	})

	it('refuses targeting on a flag that is already on for everyone', () => {
		const op = declare({ default: true, targeting: { roles: ['admin'] } })
		expect(validateOp(base(), op).join('\n')).toMatch(
			/targeting cannot narrow a flag whose default is true/,
		)
	})

	it('refuses an empty targeting list rather than storing a rule matching nobody', () => {
		const op = declare({ targeting: { roles: [] } })
		expect(validateOp(base(), op).join('\n')).toMatch(
			/targeting.roles is empty/,
		)
	})

	it('refuses a rolloutPercent outside 0–100 or non-integer', () => {
		expect(
			validateOp(base(), declare({ targeting: { rolloutPercent: 120 } })).join(
				'\n',
			),
		).toMatch(/rolloutPercent must be an integer 0–100/)
		expect(
			validateOp(base(), declare({ targeting: { rolloutPercent: 7.5 } })).join(
				'\n',
			),
		).toMatch(/rolloutPercent must be an integer 0–100/)
	})
})

describe('flags.setTargeting', () => {
	it('replaces targeting wholesale and clears it when omitted', () => {
		let spec = applyOp(base(), declare(), meta(1))
		spec = applyOp(
			spec,
			{
				op: 'flags.setTargeting',
				args: { flagId: 'flg-checkout-v2', targeting: { rolloutPercent: 10 } },
			},
			meta(2),
		)
		expect(findFlag(spec, 'checkout-v2')?.targeting).toEqual({
			rolloutPercent: 10,
		})

		// Ramping is a replace, not a merge.
		spec = applyOp(
			spec,
			{
				op: 'flags.setTargeting',
				args: { flagId: 'flg-checkout-v2', targeting: { rolloutPercent: 50 } },
			},
			meta(3),
		)
		expect(findFlag(spec, 'checkout-v2')?.targeting).toEqual({
			rolloutPercent: 50,
		})

		spec = applyOp(
			spec,
			{ op: 'flags.setTargeting', args: { flagId: 'flg-checkout-v2' } },
			meta(4),
		)
		expect(findFlag(spec, 'checkout-v2')?.targeting).toBeUndefined()
	})

	it('refuses an unknown flag', () => {
		expect(
			validateOp(base(), {
				op: 'flags.setTargeting',
				args: { flagId: 'flg-nope', targeting: { roles: ['admin'] } },
			}),
		).toEqual(['flags.setTargeting: unknown flag "flg-nope"'])
	})
})

describe('flags.gate', () => {
	it('gates and ungates a page', () => {
		let spec = withFlagAndPage()
		spec = applyOp(
			spec,
			{
				op: 'flags.gate',
				args: {
					target: { kind: 'page', id: 'pg-checkout' },
					flag: 'checkout-v2',
				},
			},
			meta(3),
		)
		expect(spec.pages.pages[0]?.flag).toBe('checkout-v2')
		expect(flagGates(spec, 'checkout-v2')).toEqual([
			{ kind: 'page', id: 'pg-checkout', label: 'Checkout' },
		])
		expect(collectSpecSystemErrors(spec)).toEqual([])

		spec = applyOp(
			spec,
			{
				op: 'flags.gate',
				args: { target: { kind: 'page', id: 'pg-checkout' }, flag: null },
			},
			meta(4),
		)
		expect(spec.pages.pages[0]?.flag).toBeUndefined()
		expect(flagGates(spec, 'checkout-v2')).toEqual([])
	})

	it('gates a block, which needs its page as parentId', () => {
		const spec = applyOp(
			withFlagAndPage(),
			{
				op: 'flags.gate',
				args: {
					target: {
						kind: 'block',
						id: 'blk-checkout-table',
						parentId: 'pg-checkout',
					},
					flag: 'checkout-v2',
				},
			},
			meta(3),
		)
		expect(spec.pages.pages[0]?.blocks[0]?.flag).toBe('checkout-v2')
		expect(flagGates(spec, 'checkout-v2')[0]?.kind).toBe('block')
	})

	it('refuses a gate on an undeclared flag — the whole point of declaring them', () => {
		expect(
			validateOp(withFlagAndPage(), {
				op: 'flags.gate',
				args: {
					target: { kind: 'page', id: 'pg-checkout' },
					flag: 'not-a-flag',
				},
			}).join('\n'),
		).toMatch(/undeclared flag "not-a-flag"/)
	})

	it('refuses a gate on an unknown surface', () => {
		expect(
			validateOp(withFlagAndPage(), {
				op: 'flags.gate',
				args: { target: { kind: 'page', id: 'pg-ghost' }, flag: 'checkout-v2' },
			}),
		).toEqual(['flags.gate: unknown page "pg-ghost"'])
	})
})

describe('flags.remove', () => {
	it('removes a flag that gates nothing', () => {
		const declared = applyOp(base(), declare(), meta(1))
		const spec = applyOp(
			declared,
			{ op: 'flags.remove', args: { flagId: 'flg-checkout-v2' } },
			meta(2),
		)
		expect(listFlags(spec)).toEqual([])
		expect(collectSpecSystemErrors(spec)).toEqual([])
		// The removal is still auditable — the op log keeps the diff.
		expect(spec.opLog.at(-1)?.diff.change).toBe('remove')
	})

	it('refuses while a surface still gates on it, naming the surface', () => {
		const spec = applyOp(
			withFlagAndPage(),
			{
				op: 'flags.gate',
				args: {
					target: { kind: 'page', id: 'pg-checkout' },
					flag: 'checkout-v2',
				},
			},
			meta(3),
		)
		const errors = validateOp(spec, {
			op: 'flags.remove',
			args: { flagId: 'flg-checkout-v2' },
		})
		expect(errors.join('\n')).toMatch(/still gates 1 surface\(s\).*pg-checkout/)
	})

	it('leaves no dangling gate behind — the system validator agrees', () => {
		// The pairing that matters: ungate, then remove, and the spec stays valid.
		let spec = applyOp(
			withFlagAndPage(),
			{
				op: 'flags.gate',
				args: {
					target: { kind: 'page', id: 'pg-checkout' },
					flag: 'checkout-v2',
				},
			},
			meta(3),
		)
		spec = applyOp(
			spec,
			{
				op: 'flags.gate',
				args: { target: { kind: 'page', id: 'pg-checkout' }, flag: null },
			},
			meta(4),
		)
		expect(
			validateOpDryRun(
				spec,
				{ op: 'flags.remove', args: { flagId: 'flg-checkout-v2' } },
				'human',
			),
		).toEqual([])
	})
})

describe('evaluateFlag', () => {
	const flag = (over: Partial<FlagSpec> = {}): FlagSpec => ({
		id: 'flg-checkout-v2',
		key: 'checkout-v2',
		description: 'x',
		default: false,
		declaredAt: '2026-07-27',
		provenance: manual(),
		...over,
	})

	it('is the default when nothing targets the viewer', () => {
		expect(evaluateFlag(flag(), { subject: 'u1' })).toBe(false)
		expect(evaluateFlag(flag({ default: true }), { subject: 'u1' })).toBe(true)
	})

	it('targets by role and by organization', () => {
		const byRole = flag({ targeting: { roles: ['admin'] } })
		expect(evaluateFlag(byRole, { role: 'admin' })).toBe(true)
		expect(evaluateFlag(byRole, { role: 'member' })).toBe(false)

		const byOrg = flag({ targeting: { organizations: ['org-acme'] } })
		expect(evaluateFlag(byOrg, { organizationId: 'org-acme' })).toBe(true)
		expect(evaluateFlag(byOrg, { organizationId: 'org-other' })).toBe(false)
	})

	it('buckets a subject deterministically, and never buckets an anonymous viewer', () => {
		const half = flag({ targeting: { rolloutPercent: 50 } })
		const subject = 'user-42'
		const bucket = rolloutBucket(subject, 'checkout-v2')
		expect(evaluateFlag(half, { subject })).toBe(bucket < 50)
		// Same answer every time — no clock, no randomness.
		expect(evaluateFlag(half, { subject })).toBe(
			evaluateFlag(half, { subject }),
		)
		expect(evaluateFlag(half, {})).toBe(false)
	})

	it('ramping a rollout never turns anyone back off', () => {
		const subjects = Array.from({ length: 500 }, (_, i) => `user-${i}`)
		const on = (percent: number) =>
			new Set(
				subjects.filter((s) =>
					evaluateFlag(flag({ targeting: { rolloutPercent: percent } }), {
						subject: s,
					}),
				),
			)
		const at10 = on(10)
		const at30 = on(30)
		for (const s of at10) expect(at30.has(s)).toBe(true)
		// And the bucketing is roughly the share it claims (500 subjects, ±8pp).
		expect(at30.size / subjects.length).toBeGreaterThan(0.22)
		expect(at30.size / subjects.length).toBeLessThan(0.38)
	})

	it('evaluates a whole spec for one viewer', () => {
		const spec = applyOp(
			applyOp(base(), declare(), meta(1)),
			declare({ id: 'flg-beta-nav', key: 'beta-nav', default: true }),
			meta(2),
		)
		expect(evaluateFlags(spec, { subject: 'u1' })).toEqual({
			'checkout-v2': false,
			'beta-nav': true,
		})
		expect(evaluateFlags(base())).toEqual({})
	})
})

describe('the flag diff', () => {
	it('summarizes each op for the log', () => {
		expect(diffOp(declare()).summary).toBe(
			'Declare flag "checkout-v2" (default off)',
		)
		expect(
			diffOp({
				op: 'flags.setTargeting',
				args: {
					flagId: 'flg-checkout-v2',
					targeting: { roles: ['admin'], rolloutPercent: 25 },
				},
			}).summary,
		).toBe('Target flag "flg-checkout-v2": roles admin, 25% rollout')
		expect(
			diffOp({
				op: 'flags.gate',
				args: { target: { kind: 'page', id: 'pg-checkout' }, flag: null },
			}).summary,
		).toBe('Ungate page "pg-checkout"')
	})
})
