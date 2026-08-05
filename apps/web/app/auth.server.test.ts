/**
 * Auth wiring at the app seam (task 22). Drives `resolveUser` / `getAuth` over
 * the demo backend the web app actually boots, proving three things end-to-end:
 *   1. the dev fallback still resolves a usable admin (local DX unchanged);
 *   2. an `x-maxstack-role` header still selects a role (unit-test/demo path);
 *   3. a *real* better-auth session wins over the fallback and carries the
 *      seeded owner's id + admin role — i.e. the header is genuinely replaced.
 */

import { describe, expect, it } from 'vitest'
import { getApiKeyService } from './api-keys.server'
import { getAuth, isAnonymousWrite, resolveUser } from './sprout.server'

describe('app auth', () => {
	it('falls back to a dev admin for an anonymous request', async () => {
		const user = await resolveUser(new Request('http://localhost/'))
		// Tagged `devFallback` so the REST write gate can tell it from a real login.
		expect(user).toEqual({ id: 'dev-admin', role: 'admin', devFallback: true })
	})

	it('honors an x-maxstack-role header when there is no session', async () => {
		const user = await resolveUser(
			new Request('http://localhost/', {
				headers: { 'x-maxstack-role': 'member' },
			}),
		)
		expect(user).toEqual({ id: 'member', role: 'member', devFallback: true })
	})

	it('resolves a real session to the seeded admin, outranking the fallback', async () => {
		const auth = await getAuth()
		const signIn = await auth.api.signInEmail({
			body: { email: 'admin@maxstack.dev', password: 'maxstack' },
			returnHeaders: true,
		})
		const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''
		expect(cookie).toContain('better-auth')

		const user = await resolveUser(
			new Request('http://localhost/', { headers: { cookie } }),
		)
		expect(user?.role).toBe('admin')
		// A real user id (better-auth generated), not the 'dev-admin' stand-in.
		expect(user?.id).not.toBe('dev-admin')
		expect(user?.email).toBe('admin@maxstack.dev')
	})

	/**
	 * Issue #186. A bearer token that does not verify is a *failed claim*, not
	 * the absence of one. Resolving it to `null` looks safe but lands the caller
	 * on the anonymous identity, which an open-by-default resource happily
	 * serves — so a revoked key kept getting `200` on public reads and neither
	 * the caller nor the operator could see that it had stopped working.
	 */
	it('throws 401 for a bearer token that does not verify, rather than degrading to anonymous', async () => {
		const rejected = await resolveUser(
			new Request('http://localhost/', {
				headers: { authorization: 'Bearer mx_not-a-real-key' },
			}),
		).then(
			(user) => ({ kind: 'resolved' as const, user }),
			(thrown: unknown) => ({ kind: 'threw' as const, thrown }),
		)
		expect(rejected.kind).toBe('threw')
		const response = rejected.kind === 'threw' ? rejected.thrown : null
		expect(response).toBeInstanceOf(Response)
		expect((response as Response).status).toBe(401)
	})

	/**
	 * Issue #186. The key resolves to the *holder's* role, read live at verify
	 * time. Before this, the bearer path hard-coded `role: 'api-key'` — a string
	 * no access rule anyone writes ever matches, so an admin's key could not
	 * reach an admin-gated resource and a member's key was indistinguishable
	 * from it. The narrowing belongs in the scope, where `scopeGrants` can
	 * enforce it; the role has to be true.
	 */
	it('resolves an api key to its holder’s real role, plus the key’s scope', async () => {
		const auth = await getAuth()
		const signIn = await auth.api.signInEmail({
			body: { email: 'admin@maxstack.dev', password: 'maxstack' },
			returnHeaders: true,
		})
		const holderId = signIn.response.user.id

		const service = await getApiKeyService()
		const issued = await service.issueKey({
			userId: holderId,
			name: 'role carriage',
			scope: { project: ['read'] },
		})

		const user = await resolveUser(
			new Request('http://localhost/', {
				headers: { authorization: `Bearer ${issued.key}` },
			}),
		)
		expect(user?.id).toBe(holderId)
		expect(user?.role).toBe('admin')
		expect(user?.origin).toBe('api-key')
		expect(user?.apiKeyId).toBe(issued.id)
		expect(user?.apiKeyScope).toEqual({ project: ['read'] })

		await service.revokeKey(issued.id, holderId)
	})

	// The REST write gate: with the auth bundle installed,
	// an anonymous/dev-fallback write must be rejected, so installing auth
	// actually protects the API — but reads and real principals pass.
	describe('isAnonymousWrite (REST write gate)', () => {
		const devUser = { id: 'dev-admin', role: 'admin', devFallback: true }
		const realUser = { id: 'usr-1', role: 'admin' }
		const apiKeyUser = { id: 'usr-1', role: 'api-key', apiKeyScope: {} }

		it('rejects an anonymous/dev write once auth is installed', () => {
			expect(isAnonymousWrite('POST', true, null)).toBe(true)
			expect(isAnonymousWrite('POST', true, devUser)).toBe(true)
			expect(isAnonymousWrite('DELETE', true, devUser)).toBe(true)
			expect(isAnonymousWrite('PUT', true, devUser)).toBe(true)
		})

		it('allows reads regardless of auth or principal', () => {
			expect(isAnonymousWrite('GET', true, null)).toBe(false)
			expect(isAnonymousWrite('GET', true, devUser)).toBe(false)
		})

		it('allows writes when the auth bundle is not installed (open API)', () => {
			expect(isAnonymousWrite('POST', false, null)).toBe(false)
			expect(isAnonymousWrite('DELETE', false, devUser)).toBe(false)
		})

		it('lets a real session or api-key write through', () => {
			expect(isAnonymousWrite('POST', true, realUser)).toBe(false)
			expect(isAnonymousWrite('DELETE', true, apiKeyUser)).toBe(false)
		})
	})

	it('denies anonymous requests under MAXSTACK_AUTH_STRICT', async () => {
		const prev = process.env.MAXSTACK_AUTH_STRICT
		process.env.MAXSTACK_AUTH_STRICT = '1'
		try {
			const user = await resolveUser(new Request('http://localhost/'))
			expect(user).toBeNull()
		} finally {
			if (prev === undefined) delete process.env.MAXSTACK_AUTH_STRICT
			else process.env.MAXSTACK_AUTH_STRICT = prev
		}
	})
})
