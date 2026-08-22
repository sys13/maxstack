import { afterEach, describe, expect, it } from 'vitest'
import { accessPolicyFromSpec } from './from-spec.ts'
import {
	type AccessPolicy,
	authorize,
	canPerformAction,
	createAccessContext,
	expandShortcut,
	getAccessPolicy,
	heldRoles,
	OPEN_ACCESS_POLICY,
	PermissionError,
	policyGrants,
	type ResourceAccess,
	resetAccessPolicy,
	resourceCapabilities,
	type SproutUser,
	scopeGrants,
	setAccessPolicy,
} from './permissions.ts'

const admin: SproutUser = { id: 'u-admin', role: 'admin' }
const member: SproutUser = { id: 'u-1', role: 'member' }

describe('expandShortcut', () => {
	it('public allows everyone', () => {
		expect(expandShortcut('public')(createAccessContext(null))).toBe(true)
	})
	it('authenticated requires a user', () => {
		expect(expandShortcut('authenticated')(createAccessContext(null))).toBe(
			false,
		)
		expect(expandShortcut('authenticated')(createAccessContext(member))).toBe(
			true,
		)
	})
	it('admin checks the role', () => {
		expect(expandShortcut('admin')(createAccessContext(member))).toBe(false)
		expect(expandShortcut('admin')(createAccessContext(admin))).toBe(true)
	})

	it('owner matches conventional owner columns and needs a row', () => {
		const rule = expandShortcut('owner')
		expect(rule(createAccessContext(member))).toBe(false)
		expect(rule({ user: member, row: { authorId: 'u-1' } })).toBe(true)
		expect(rule({ user: member, row: { ownerId: 'someone-else' } })).toBe(false)
		expect(rule({ user: member, row: { title: 'no owner field' } })).toBe(false)
	})
})

describe('authorize', () => {
	const access: ResourceAccess = { read: 'public', delete: 'admin' }

	it('is open by default when no rule exists for the action', async () => {
		await expect(
			authorize('task', access, 'create', createAccessContext(null)),
		).resolves.toBeUndefined()
	})

	it('throws PermissionError when a rule denies', async () => {
		await expect(
			authorize('task', access, 'delete', createAccessContext(member)),
		).rejects.toBeInstanceOf(PermissionError)
	})

	it('passes when the rule allows', async () => {
		await expect(
			authorize('task', access, 'delete', createAccessContext(admin)),
		).resolves.toBeUndefined()
	})
})

describe('canPerformAction', () => {
	it('swallows a throwing rule into false (for UI gating)', async () => {
		const access: ResourceAccess = {
			read: () => {
				throw new Error('boom')
			},
		}
		expect(
			await canPerformAction(
				'post',
				access,
				'read',
				createAccessContext(member),
			),
		).toBe(false)
	})
})

describe('resourceCapabilities', () => {
	const access: ResourceAccess = {
		read: 'public',
		create: 'authenticated',
		update: 'authenticated',
		delete: 'admin',
	}

	it('resolves every action flag in one call', async () => {
		expect(
			await resourceCapabilities('post', access, createAccessContext(admin)),
		).toEqual({ read: true, create: true, update: true, delete: true })
	})

	it('strips what the role is denied (member cannot delete an admin-gated resource)', async () => {
		expect(
			await resourceCapabilities('post', access, createAccessContext(member)),
		).toEqual({ read: true, create: true, update: true, delete: false })
	})

	it('an anonymous session gets only the public action', async () => {
		expect(
			await resourceCapabilities('post', access, createAccessContext(null)),
		).toEqual({ read: true, create: false, update: false, delete: false })
	})

	it('open-by-default: no rules → everything allowed', async () => {
		expect(
			await resourceCapabilities('post', undefined, createAccessContext(null)),
		).toEqual({ read: true, create: true, update: true, delete: true })
	})
})

/**
 * Issue #186 — the escalation gate. The claim a scoped credential has to earn
 * is not "the scope is checked somewhere" but "a key can never do anything the
 * person holding it could not do, and never anything the scope did not name."
 * Both halves are tested here because they fail in opposite directions: the
 * first fails open when the scope is treated as a grant, the second fails open
 * when a resource simply has no rule yet.
 */
describe('api-key scope', () => {
	/** A key issued by the member above, scoped to reading posts only. */
	const key: SproutUser = {
		...member,
		apiKeyId: 'key-1',
		origin: 'api-key',
		apiKeyScope: { post: ['read'] },
	}

	it('a session identity is unaffected', () => {
		expect(scopeGrants(member, 'post', 'delete')).toBe(true)
		expect(scopeGrants(null, 'post', 'delete')).toBe(true)
	})

	it('grants only the named resource + action', () => {
		expect(scopeGrants(key, 'post', 'read')).toBe(true)
		expect(scopeGrants(key, 'post', 'delete')).toBe(false)
		expect(scopeGrants(key, 'invoice', 'read')).toBe(false)
	})

	it('is closed by default where everything else is open by default', async () => {
		// No access rule at all: a session may do anything, a key may not. This is
		// the case that made the pre-#186 route-level gate unsound — the MCP
		// endpoint reached operations.ts without passing it.
		expect(
			await canPerformAction('secrets', undefined, 'read', {
				user: member,
			}),
		).toBe(true)
		expect(
			await canPerformAction('secrets', undefined, 'read', { user: key }),
		).toBe(false)
		await expect(
			authorize('secrets', undefined, 'read', { user: key }),
		).rejects.toBeInstanceOf(PermissionError)
	})

	it('cannot escalate past its holder: scope narrows, it never grants', async () => {
		const adminOnly: ResourceAccess = { delete: 'admin' }
		// The member's own key, scoped to delete. The scope names the action, so
		// the scope gate passes — and the resource's own rule still refuses,
		// because the holder is not an admin.
		const overreaching: SproutUser = {
			...member,
			apiKeyId: 'key-2',
			origin: 'api-key',
			apiKeyScope: { post: ['delete'] },
		}
		await expect(
			authorize('post', adminOnly, 'delete', { user: overreaching }),
		).rejects.toBeInstanceOf(PermissionError)
		// The same scope in an admin's hands is allowed — proving the denial above
		// came from the holder's role and not from the scope being ignored.
		await expect(
			authorize('post', adminOnly, 'delete', {
				user: {
					...admin,
					apiKeyId: 'key-3',
					apiKeyScope: { post: ['delete'] },
				},
			}),
		).resolves.toBeUndefined()
	})

	it('narrows an admin holder too — capabilities are the intersection', async () => {
		const access: ResourceAccess = {
			read: 'public',
			create: 'authenticated',
			update: 'authenticated',
			delete: 'admin',
		}
		const adminKey: SproutUser = {
			...admin,
			apiKeyId: 'key-4',
			origin: 'api-key',
			apiKeyScope: { post: ['read', 'create'] },
		}
		expect(
			await resourceCapabilities('post', access, createAccessContext(adminKey)),
		).toEqual({ read: true, create: true, update: false, delete: false })
	})
})

/**
 * The declared access policy — the subject axis.
 *
 * Every test here is about one of two things: that an app which has declared
 * nothing behaves exactly as it always has, and that an app which declared
 * `deny` cannot be reached through a path that forgot about it.
 */
describe('the declared access policy', () => {
	const support: SproutUser = { id: 'u-2', role: 'support' }
	const denyPolicy: AccessPolicy = {
		default: 'deny',
		grants: { support: { invoice: ['read'] } },
	}

	afterEach(() => {
		resetAccessPolicy()
	})

	it('is open until an app registers one', () => {
		expect(getAccessPolicy()).toBe(OPEN_ACCESS_POLICY)
	})

	it('leaves an ungoverned action allowed under the historical default', async () => {
		expect(
			await canPerformAction('invoice', undefined, 'delete', {
				user: member,
			}),
		).toBe(true)
	})

	it('refuses an ungoverned action under deny', async () => {
		setAccessPolicy(denyPolicy)
		expect(
			await canPerformAction('invoice', undefined, 'read', { user: member }),
		).toBe(false)
		await expect(
			authorize('invoice', undefined, 'read', { user: member }),
		).rejects.toThrow(PermissionError)
	})

	it('allows it for a role that grants it', async () => {
		setAccessPolicy(denyPolicy)
		expect(
			await canPerformAction('invoice', undefined, 'read', { user: support }),
		).toBe(true)
		await expect(
			authorize('invoice', undefined, 'read', { user: support }),
		).resolves.toBeUndefined()
	})

	it('grants only the action and resource named, not the neighbours', async () => {
		setAccessPolicy(denyPolicy)
		expect(
			await canPerformAction('invoice', undefined, 'delete', { user: support }),
		).toBe(false)
		expect(
			await canPerformAction('payment', undefined, 'read', { user: support }),
		).toBe(false)
	})

	it('reads the conventional role string, so the auth bundle composes unchanged', async () => {
		setAccessPolicy(denyPolicy)
		// `support` holds the role by its plain `role` string alone — nothing about
		// how an app builds a session had to change.
		expect(heldRoles(support)).toEqual(['support'])
		expect(heldRoles({ id: 'u-3', roles: ['support'] })).toEqual(['support'])
		expect(
			heldRoles({ id: 'u-4', role: 'support', roles: ['support', 'lead'] }),
		).toEqual(['support', 'lead'])
	})

	it('never overrides a rule that said no', async () => {
		setAccessPolicy(denyPolicy)
		const access: ResourceAccess = { read: () => false }
		// The grant covers invoice:read, but a rule exists and it refused. A
		// mechanism that could move the decision in both directions would make the
		// answer depend on evaluation order.
		expect(
			await canPerformAction('invoice', access, 'read', { user: support }),
		).toBe(false)
	})

	it('never loosens an api-key scope, which stays closed by default', async () => {
		setAccessPolicy(denyPolicy)
		const keyed: SproutUser = {
			id: 'u-2',
			role: 'support',
			apiKeyScope: { payment: ['read'] },
		}
		expect(
			await canPerformAction('invoice', undefined, 'read', { user: keyed }),
		).toBe(false)
	})

	it('confers nothing on a portal identity, whose role string is not authority', async () => {
		setAccessPolicy(denyPolicy)
		const visitor: SproutUser = {
			id: 'ptl-public:tok',
			role: 'support',
			portal: {
				portalKey: 'public',
				resource: 'invoice',
				audience: 'public',
				readFields: ['id'],
				writes: [],
				scope: 'collection',
			},
		}
		expect(policyGrants(visitor, 'invoice', 'read')).toBe(false)
	})

	it('refuses an anonymous caller under deny', async () => {
		setAccessPolicy(denyPolicy)
		expect(
			await canPerformAction('invoice', undefined, 'read', { user: null }),
		).toBe(false)
	})

	it('keeps the UI capability read in step with what the server enforces', async () => {
		setAccessPolicy(denyPolicy)
		expect(
			await resourceCapabilities('invoice', undefined, { user: support }),
		).toEqual({ read: true, create: false, update: false, delete: false })
	})
})

describe('accessPolicyFromSpec', () => {
	afterEach(() => {
		resetAccessPolicy()
	})

	it('is the open policy for a spec that declared nothing', () => {
		expect(accessPolicyFromSpec(undefined)).toBe(OPEN_ACCESS_POLICY)
	})

	it('flattens a role’s grants', () => {
		expect(
			accessPolicyFromSpec({
				default: 'deny',
				roles: [
					{
						key: 'support',
						grants: [{ resource: 'invoice', actions: ['read'] }],
					},
				],
				bindings: [],
			}),
		).toEqual({ default: 'deny', grants: { support: { invoice: ['read'] } } })
	})

	it('expands role-to-role bindings transitively', () => {
		const policy = accessPolicyFromSpec({
			default: 'deny',
			roles: [
				{
					key: 'support',
					grants: [{ resource: 'invoice', actions: ['read'] }],
				},
				{ key: 'lead', grants: [{ resource: 'invoice', actions: ['update'] }] },
				{ key: 'director', grants: [] },
			],
			bindings: [
				{ role: 'support', principal: { kind: 'role', key: 'lead' } },
				{ role: 'lead', principal: { kind: 'role', key: 'director' } },
			],
		})
		expect(policy.grants.lead?.invoice?.sort()).toEqual(['read', 'update'])
		expect(policy.grants.director?.invoice?.sort()).toEqual(['read', 'update'])
		expect(policy.grants.support?.invoice).toEqual(['read'])
	})

	it('terminates on a cycle a hand-edited spec could hold', () => {
		const policy = accessPolicyFromSpec({
			default: 'deny',
			roles: [
				{ key: 'a', grants: [{ resource: 'invoice', actions: ['read'] }] },
				{ key: 'b', grants: [{ resource: 'invoice', actions: ['update'] }] },
			],
			bindings: [
				{ role: 'a', principal: { kind: 'role', key: 'b' } },
				{ role: 'b', principal: { kind: 'role', key: 'a' } },
			],
		})
		expect(policy.grants.a?.invoice?.sort()).toEqual(['read', 'update'])
	})

	it('does not flatten a group binding, because it cannot know who is in one', () => {
		const policy = accessPolicyFromSpec({
			default: 'deny',
			roles: [
				{
					key: 'support',
					grants: [{ resource: 'invoice', actions: ['read'] }],
				},
			],
			bindings: [
				{ role: 'support', principal: { kind: 'group', key: 'on-call' } },
			],
		})
		expect(Object.keys(policy.grants)).toEqual(['support'])
	})
})
