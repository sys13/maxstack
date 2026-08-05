import type { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePglite } from '../testing/pglite-fixture.ts'
import { API_KEYS_DDL } from './schema.ts'
import { ApiKeyService } from './service.ts'

type Db = ReturnType<typeof drizzle>

const pg = usePglite(API_KEYS_DDL)

let db: Db
let service: ApiKeyService

beforeEach(() => {
	db = pg.db
	service = new ApiKeyService({ db })
})

describe('issueKey / verifyKey', () => {
	it('round-trips: a freshly issued key verifies to its owner and scope', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'CI key',
			scope: { post: ['read'] },
		})
		expect(issued.key).toMatch(/^mx_/)
		expect(issued.prefix).toBe(issued.key.slice(0, 11))

		const result = await service.verifyKey(issued.key)
		expect(result).toEqual({
			keyId: issued.id,
			userId: 'u1',
			scope: { post: ['read'] },
			organizationId: null,
			rateLimitPerMinute: null,
		})
	})

	it('rejects a token that was never issued', async () => {
		expect(await service.verifyKey('mx_not-a-real-key')).toBeNull()
	})

	it('rejects a revoked key', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
		})
		await service.revokeKey(issued.id, 'u1')
		expect(await service.verifyKey(issued.key)).toBeNull()
	})

	it('stamps lastUsedAt on a successful verify', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
		})
		expect((await service.listKeys('u1'))[0]?.lastUsedAt).toBeNull()
		await service.verifyKey(issued.key)
		expect((await service.listKeys('u1'))[0]?.lastUsedAt).not.toBeNull()
	})

	it('two issued keys never collide and each verifies independently', async () => {
		const a = await service.issueKey({
			userId: 'u1',
			name: 'a',
			scope: { post: ['read'] },
		})
		const b = await service.issueKey({
			userId: 'u1',
			name: 'b',
			scope: { post: ['read'] },
		})
		expect(a.key).not.toBe(b.key)
		expect((await service.verifyKey(a.key))?.userId).toBe('u1')
		expect((await service.verifyKey(b.key))?.userId).toBe('u1')
	})
})

describe('listKeys', () => {
	it('never exposes the hash or plaintext, only id/name/prefix/scope/timestamps', async () => {
		await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
		})
		const [view] = await service.listKeys('u1')
		expect(view).toMatchObject({ name: 'k', scope: { post: ['read'] } })
		expect(view).not.toHaveProperty('tokenHash')
		expect(view).not.toHaveProperty('key')
	})

	it('scopes to the given user', async () => {
		await service.issueKey({
			userId: 'u1',
			name: 'a',
			scope: { post: ['read'] },
		})
		await service.issueKey({
			userId: 'u2',
			name: 'b',
			scope: { post: ['read'] },
		})
		expect(await service.listKeys('u1')).toHaveLength(1)
		expect(await service.listKeys('u2')).toHaveLength(1)
	})
})

describe('revokeKey', () => {
	it('is scoped to the owning user — another user’s id is a no-op', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
		})
		await service.revokeKey(issued.id, 'someone-else')
		expect(await service.verifyKey(issued.key)).not.toBeNull()
	})
})

describe('rotateKey', () => {
	it('invalidates the old token and the new one verifies with the same scope', async () => {
		const original = await service.issueKey({
			userId: 'u1',
			name: 'rotating',
			scope: { post: ['read', 'create'] },
		})
		const rotated = await service.rotateKey(original.id, 'u1')

		expect(rotated.key).not.toBe(original.key)
		expect(await service.verifyKey(original.key)).toBeNull()
		expect(await service.verifyKey(rotated.key)).toEqual({
			keyId: rotated.id,
			userId: 'u1',
			scope: { post: ['read', 'create'] },
			organizationId: null,
			rateLimitPerMinute: null,
		})
	})

	it('throws for a key that does not belong to the caller', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
		})
		await expect(service.rotateKey(issued.id, 'someone-else')).rejects.toThrow()
	})
})

/**
 * Issue #186. The service half of the exit criteria — the permission half
 * (a key can never exceed its holder) lives in core's `permissions.test.ts`,
 * because that is where the intersection is enforced.
 */
describe('scope validation', () => {
	it('refuses an action the evaluator would not recognize', async () => {
		await expect(
			service.issueKey({
				userId: 'u1',
				name: 'k',
				// `write` is what someone types when they mean create+update. Stored
				// verbatim it would mint a key that silently fails every call.
				scope: { post: ['write'] as never },
			}),
		).rejects.toThrow(/unknown action "write"/)
	})

	it('refuses a key that grants nothing', async () => {
		await expect(
			service.issueKey({ userId: 'u1', name: 'k', scope: {} }),
		).rejects.toThrow(/at least one resource/)
		await expect(
			service.issueKey({ userId: 'u1', name: 'k', scope: { post: [] } }),
		).rejects.toThrow(/at least one resource/)
	})

	it('normalizes duplicates rather than storing them', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read', 'read', 'create'] },
		})
		expect((await service.verifyKey(issued.key))?.scope).toEqual({
			post: ['read', 'create'],
		})
	})
})

describe('revocation is immediate', () => {
	it('a key revoked between two calls fails the second one', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
		})
		// The property is not "revoked keys are rejected" — it is that no request
		// in flight after the revoke can still be honored. Verify reads the row
		// every time precisely so there is no window here to measure.
		expect(await service.verifyKey(issued.key)).not.toBeNull()
		await service.revokeKey(issued.id, 'u1')
		expect(await service.verifyKey(issued.key)).toBeNull()
	})

	it('an expired key stops verifying without anyone revoking it', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
			expiresAt: new Date(Date.now() - 1000),
		})
		expect(await service.verifyKey(issued.key)).toBeNull()
	})

	it('rotation carries the org pin and the budget onto the new key', async () => {
		const original = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
			organizationId: 'org-1',
			rateLimitPerMinute: 5,
		})
		const rotated = await service.rotateKey(original.id, 'u1')
		expect(await service.verifyKey(rotated.key)).toMatchObject({
			organizationId: 'org-1',
			rateLimitPerMinute: 5,
		})
	})
})

describe('the plaintext is never recoverable', () => {
	it('is absent from the list view and from the stored row', async () => {
		const issued = await service.issueKey({
			userId: 'u1',
			name: 'k',
			scope: { post: ['read'] },
		})
		const [view] = await service.listKeys('u1')
		expect(JSON.stringify(view)).not.toContain(issued.key)
		// And not in the table either — only the hash, which the token cannot be
		// recovered from.
		const rows = await db.execute('SELECT * FROM api_key')
		expect(JSON.stringify(rows)).not.toContain(issued.key)
	})
})
