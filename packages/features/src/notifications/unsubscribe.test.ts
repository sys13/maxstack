import { describe, expect, it } from 'vitest'
import {
	mintUnsubscribeToken,
	unsubscribeUrl,
	verifyUnsubscribeToken,
} from './unsubscribe.ts'

const SECRET = 'test-unsubscribe-secret'

describe('unsubscribe tokens', () => {
	it('round-trips a type-scoped payload', () => {
		const token = mintUnsubscribeToken(SECRET, {
			userId: 'u1',
			scope: { kind: 'type', type: 'invitation-accepted' },
		})
		expect(verifyUnsubscribeToken(SECRET, token)).toEqual({
			userId: 'u1',
			scope: { kind: 'type', type: 'invitation-accepted' },
		})
	})

	it('round-trips an all-scoped payload', () => {
		const token = mintUnsubscribeToken(SECRET, {
			userId: 'u1',
			scope: { kind: 'all' },
		})
		expect(verifyUnsubscribeToken(SECRET, token)?.scope).toEqual({
			kind: 'all',
		})
	})

	it('rejects a token signed with another secret', () => {
		const token = mintUnsubscribeToken('other', {
			userId: 'u1',
			scope: { kind: 'all' },
		})
		expect(verifyUnsubscribeToken(SECRET, token)).toBeNull()
	})

	it('rejects an edited payload — the whole point of signing it', () => {
		const token = mintUnsubscribeToken(SECRET, {
			userId: 'u1',
			scope: { kind: 'all' },
		})
		const [, signature] = token.split('.')
		const forged = `${Buffer.from(
			JSON.stringify({ userId: 'someone-else', scope: { kind: 'all' } }),
		)
			.toString('base64')
			.replace(/=+$/, '')}.${signature}`
		expect(verifyUnsubscribeToken(SECRET, forged)).toBeNull()
	})

	it('returns null rather than throwing for junk', () => {
		for (const junk of ['', 'no-dot', 'a.b', '....', 'x'.repeat(500)]) {
			expect(verifyUnsubscribeToken(SECRET, junk)).toBeNull()
		}
	})

	it('builds a URL the click target can read back', () => {
		const url = unsubscribeUrl(
			{ secret: SECRET, baseUrl: 'https://app.example/unsubscribe' },
			{ userId: 'u1', scope: { kind: 'type', type: 'product-update' } },
		)
		const token = new URL(url).searchParams.get('token') ?? ''
		expect(verifyUnsubscribeToken(SECRET, token)).toEqual({
			userId: 'u1',
			scope: { kind: 'type', type: 'product-update' },
		})
	})

	it('appends to a base URL that already carries a query', () => {
		const url = unsubscribeUrl(
			{ secret: SECRET, baseUrl: 'https://app.example/u?src=email' },
			{ userId: 'u1', scope: { kind: 'all' } },
		)
		expect(url).toContain('src=email&token=')
	})
})
