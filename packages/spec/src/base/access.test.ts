/**
 * The `access` namespace — the six ops, the declared vocabulary, and the one
 * property the whole thing exists to make expressible: what happens to an
 * action no rule governs.
 *
 * The tests that matter most here are the *compatibility* ones. This namespace
 * can refuse traffic a running deployment currently serves, so "a spec that has
 * never declared access behaves exactly as it did before" is not a nicety, it is
 * the thing that decides whether the feature can ship at all.
 *
 * Enforcement is tested where it is enforced —
 * `packages/maxstack-core/src/sprout/permissions.test.ts` — because a policy
 * that flattens correctly and is never consulted is a passing test over a hole.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import {
	accessDefault,
	describeRole,
	expandRoles,
	findGroup,
	findRole,
	grantHolders,
	listBindings,
	listRoles,
	resolveAccess,
	roleGrants,
	rolesForGroups,
} from './access.ts'
import type { AccessBindingId, GroupId, RoleId } from './ids.ts'
import { decodeSpecSystem, encodeSpecSystem } from './spec-codec.ts'
import {
	type ApplyMeta,
	applyOp,
	diffOp,
	SPEC_OP_NAMES,
	type SpecOp,
	validateOp,
} from './spec-ops.ts'
import { collectSpecSystemErrors } from './spec-system.schema.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: 'human',
	appliedAt: '2026-08-22',
})

/** A spec with one entity, so a grant has something real to name. */
function base(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-invoice',
					name: 'Invoice',
					description: 'A bill sent to a customer.',
					fields: [
						{
							id: 'fld-amount',
							name: 'amount',
							type: 'number',
							required: true,
						},
					],
				},
			},
		},
		meta(0),
	)
}

const defineRole = (over: { id?: string; key?: string } = {}): SpecOp => ({
	op: 'access.defineRole',
	args: {
		role: {
			id: (over.id ?? 'rol-support') as RoleId,
			key: over.key ?? 'support',
			description: 'Reads invoices to answer customer questions.',
			grants: [],
		},
	},
})

const defineGroup = (over: { id?: string; key?: string } = {}): SpecOp => ({
	op: 'access.defineGroup',
	args: {
		group: {
			id: (over.id ?? 'grp-on-call') as GroupId,
			key: over.key ?? 'on-call',
			description: 'Whoever is carrying the pager this week.',
		},
	},
})

/** One role granting read on Invoice, bound to the on-call group. */
function governed(): SpecSystem {
	let spec = applyOp(base(), defineRole(), meta(1))
	spec = applyOp(spec, defineGroup(), meta(2))
	spec = applyOp(
		spec,
		{
			op: 'access.grant',
			args: {
				roleId: 'rol-support' as RoleId,
				resource: 'Invoice',
				actions: ['read'],
			},
		},
		meta(3),
	)
	return applyOp(
		spec,
		{
			op: 'access.bindRole',
			args: {
				binding: {
					id: 'bnd-1' as AccessBindingId,
					role: 'support',
					principal: { kind: 'group', key: 'on-call' },
				},
			},
		},
		meta(4),
	)
}

describe('the absence of a declaration', () => {
	it('reads as the historical open default, not the safe one', () => {
		// The single most load-bearing assertion in this file. Every app generated
		// before this namespace existed relies on it.
		expect(base().access).toBeUndefined()
		expect(accessDefault(base())).toBe('open')
	})

	it('resolves to an empty namespace rather than leaking undefined', () => {
		expect(resolveAccess(base())).toEqual({
			default: 'open',
			roles: [],
			groups: [],
			bindings: [],
		})
	})

	it('hands out a fresh namespace each time, so one spec cannot alias another', () => {
		const a = resolveAccess(base())
		const b = resolveAccess(base())
		expect(a.roles).not.toBe(b.roles)
	})

	it('grows no access.json, so a pre-#447 spec dir round-trips byte-identical', () => {
		const dir = encodeSpecSystem(base())
		expect(dir['access.json']).toBeUndefined()
		expect(encodeSpecSystem(decodeSpecSystem(dir))).toEqual(dir)
	})

	it('declaring a role still changes nothing about the default', () => {
		const spec = applyOp(base(), defineRole(), meta(1))
		expect(accessDefault(spec)).toBe('open')
	})
})

describe('the six ops', () => {
	it('are all in the op vocabulary', () => {
		expect(SPEC_OP_NAMES.filter((n) => n.startsWith('access.'))).toEqual([
			'access.defineRole',
			'access.defineGroup',
			'access.grant',
			'access.revoke',
			'access.bindRole',
			'access.setDefault',
		])
	})

	it('declares a role, a group and a binding', () => {
		const spec = governed()
		expect(findRole(spec, 'support')?.id).toBe('rol-support')
		expect(findGroup(spec, 'on-call')?.id).toBe('grp-on-call')
		expect(listBindings(spec)).toHaveLength(1)
	})

	it('stamps declaredAt from the op rather than trusting the author', () => {
		expect(findRole(governed(), 'support')?.declaredAt).toBe('2026-08-22')
	})

	it('merges a repeated grant instead of duplicating the line', () => {
		let spec = governed()
		spec = applyOp(
			spec,
			{
				op: 'access.grant',
				args: {
					roleId: 'rol-support' as RoleId,
					resource: 'Invoice',
					actions: ['read', 'update'],
				},
			},
			meta(5),
		)
		expect(roleGrants(spec, 'support')).toEqual({ Invoice: ['read', 'update'] })
		expect(findRole(spec, 'support')?.grants).toHaveLength(1)
	})

	it('revokes one action and leaves the rest', () => {
		let spec = applyOp(
			governed(),
			{
				op: 'access.grant',
				args: {
					roleId: 'rol-support' as RoleId,
					resource: 'Invoice',
					actions: ['update'],
				},
			},
			meta(5),
		)
		spec = applyOp(
			spec,
			{
				op: 'access.revoke',
				args: {
					roleId: 'rol-support' as RoleId,
					resource: 'Invoice',
					actions: ['update'],
				},
			},
			meta(6),
		)
		expect(roleGrants(spec, 'support')).toEqual({ Invoice: ['read'] })
	})

	it('drops the whole line when the last action is revoked, rather than leaving a spec its own validator rejects', () => {
		const spec = applyOp(
			governed(),
			{
				op: 'access.revoke',
				args: {
					roleId: 'rol-support' as RoleId,
					resource: 'Invoice',
					actions: ['read'],
				},
			},
			meta(5),
		)
		expect(findRole(spec, 'support')?.grants).toEqual([])
		expect(collectSpecSystemErrors(spec)).toEqual([])
	})

	it('drops the whole line when actions are omitted', () => {
		const spec = applyOp(
			governed(),
			{
				op: 'access.revoke',
				args: { roleId: 'rol-support' as RoleId, resource: 'Invoice' },
			},
			meta(5),
		)
		expect(roleGrants(spec, 'support')).toEqual({})
	})

	it('reads a revocation as a removal in the diff, not a set', () => {
		const diff = diffOp({
			op: 'access.revoke',
			args: { roleId: 'rol-support' as RoleId, resource: 'Invoice' },
		})
		expect(diff.change).toBe('remove')
		expect(diff.layer).toBe('access')
	})

	it('summarises setDefault by its consequence, not its value', () => {
		expect(
			diffOp({ op: 'access.setDefault', args: { default: 'deny' } }).summary,
		).toContain('refused')
	})
})

describe('what the ops refuse', () => {
	it('refuses a grant on an entity that does not exist', () => {
		expect(
			validateOp(governed(), {
				op: 'access.grant',
				args: {
					roleId: 'rol-support' as RoleId,
					resource: 'Nonexistent',
					actions: ['read'],
				},
			}),
		).toEqual([
			'access.grant: unknown resource "Nonexistent" — no entity by that name',
		])
	})

	it('refuses a duplicate role key', () => {
		expect(validateOp(governed(), defineRole({ id: 'rol-other' }))).toContain(
			'access.defineRole: role key "support" already exists',
		)
	})

	it('refuses a binding to an undeclared role', () => {
		expect(
			validateOp(governed(), {
				op: 'access.bindRole',
				args: {
					binding: {
						id: 'bnd-2' as AccessBindingId,
						role: 'nobody',
						principal: { kind: 'group', key: 'on-call' },
					},
				},
			}),
		).toContain(
			'access.bindRole: undeclared role "nobody" — declare it with access.defineRole first',
		)
	})

	it('refuses revoking something the role never held', () => {
		expect(
			validateOp(governed(), {
				op: 'access.revoke',
				args: {
					roleId: 'rol-support' as RoleId,
					resource: 'Invoice',
					actions: ['delete'],
				},
			}),
		).toHaveLength(1)
	})

	it('refuses a role-binding cycle', () => {
		let spec = applyOp(
			governed(),
			defineRole({ id: 'rol-lead', key: 'lead' }),
			meta(5),
		)
		spec = applyOp(
			spec,
			{
				op: 'access.bindRole',
				args: {
					binding: {
						id: 'bnd-2' as AccessBindingId,
						role: 'support',
						principal: { kind: 'role', key: 'lead' },
					},
				},
			},
			meta(6),
		)
		const errors = validateOp(spec, {
			op: 'access.bindRole',
			args: {
				binding: {
					id: 'bnd-3' as AccessBindingId,
					role: 'lead',
					principal: { kind: 'role', key: 'support' },
				},
			},
		})
		expect(errors.join(' ')).toContain('cycle')
	})

	it('refuses deny when nothing is declared, rather than shipping an outage as a setting', () => {
		expect(
			validateOp(base(), {
				op: 'access.setDefault',
				args: { default: 'deny' },
			}),
		).toEqual([
			'access.setDefault: no declared role grants anything, so "deny" would refuse every action on every resource that has no explicit access rule — declare and grant a role first',
		])
	})

	it('refuses deny when roles grant but nothing is bound to them', () => {
		let spec = applyOp(base(), defineRole(), meta(1))
		spec = applyOp(
			spec,
			{
				op: 'access.grant',
				args: {
					roleId: 'rol-support' as RoleId,
					resource: 'Invoice',
					actions: ['read'],
				},
			},
			meta(2),
		)
		expect(
			validateOp(spec, { op: 'access.setDefault', args: { default: 'deny' } }),
		).toHaveLength(1)
	})

	it('allows deny once a granting role is bound', () => {
		expect(
			validateOp(governed(), {
				op: 'access.setDefault',
				args: { default: 'deny' },
			}),
		).toEqual([])
	})
})

describe('reading the declaration', () => {
	it('answers who can do a thing, which is the question a reviewer asks', () => {
		expect(
			grantHolders(governed(), 'Invoice', 'read').map((r) => r.key),
		).toEqual(['support'])
		expect(grantHolders(governed(), 'Invoice', 'delete')).toEqual([])
	})

	it('expands role-to-role bindings transitively', () => {
		let spec = applyOp(
			governed(),
			defineRole({ id: 'rol-lead', key: 'lead' }),
			meta(5),
		)
		spec = applyOp(
			spec,
			{
				op: 'access.bindRole',
				args: {
					binding: {
						id: 'bnd-2' as AccessBindingId,
						role: 'support',
						principal: { kind: 'role', key: 'lead' },
					},
				},
			},
			meta(6),
		)
		expect(expandRoles(spec, ['lead']).sort()).toEqual(['lead', 'support'])
	})

	it('turns runtime group membership into held role keys', () => {
		expect(rolesForGroups(governed(), ['on-call'])).toEqual(['support'])
		expect(rolesForGroups(governed(), ['nobody-else'])).toEqual([])
	})

	it('describes a role by its blast radius rather than its prose', () => {
		expect(describeRole({ key: 'support', grants: [] })).toBe(
			'support (grants nothing)',
		)
		expect(
			describeRole({
				key: 'support',
				grants: [{ resource: 'Invoice', actions: ['read'] }],
			}),
		).toContain('Invoice')
	})
})

describe('the spec survives the round trip', () => {
	it('encodes and decodes a declared namespace unchanged', () => {
		const spec = applyOp(
			governed(),
			{ op: 'access.setDefault', args: { default: 'deny' } },
			meta(5),
		)
		const dir = encodeSpecSystem(spec)
		expect(dir['access.json']).toBeDefined()
		const decoded = decodeSpecSystem(dir)
		expect(decoded.access).toEqual(spec.access)
		expect(listRoles(decoded)).toHaveLength(1)
	})

	it('validates clean at the schema layer', () => {
		expect(collectSpecSystemErrors(governed())).toEqual([])
	})

	it('catches a hand-edited file naming a role that does not exist', () => {
		const spec = governed()
		const broken: SpecSystem = {
			...spec,
			access: {
				...resolveAccess(spec),
				roles: [],
			},
		}
		expect(collectSpecSystemErrors(broken).join(' ')).toContain(
			'undeclared role "support"',
		)
	})
})
