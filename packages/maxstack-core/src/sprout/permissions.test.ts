import { describe, expect, it } from 'vitest'
import {
	authorize,
	canPerformAction,
	createAccessContext,
	expandShortcut,
	PermissionError,
	type ResourceAccess,
	resourceCapabilities,
	type SproutUser,
	scopeGrants,
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
