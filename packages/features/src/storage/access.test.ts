/**
 * The access-control test issue #183 asks for by name: "signed expiring reads
 * with an access-control test".
 *
 * The property under test is not "a signature verifies" — it is that a URL
 * minted for one person does not work for anyone else, cannot be forged without
 * the secret, and stops working when it expires.
 */

import { describe, expect, it } from 'vitest'
import {
	ANONYMOUS_SUBJECT,
	DEFAULT_READ_TTL_SECONDS,
	fileGatewayUrl,
	mintReadToken,
	verifyReadToken,
} from './access.ts'

const SECRET = 'signing-secret'
const KEY = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d.png'

/** Verify a minted token as the gateway would, for a given session user. */
function check(
	token: { exp: number; sig: string },
	subject: string | null,
	opts: { secret?: string; key?: string; now?: () => number } = {},
) {
	return verifyReadToken({
		secret: opts.secret ?? SECRET,
		key: opts.key ?? KEY,
		subject,
		exp: token.exp,
		sig: token.sig,
		now: opts.now,
	})
}

describe('a read token is bound to one viewer', () => {
	it('verifies for the viewer it was minted for', () => {
		const token = mintReadToken({ secret: SECRET, key: KEY, subject: 'alice' })
		expect(check(token, 'alice')).toEqual({
			ok: true,
			key: KEY,
			subject: 'alice',
		})
	})

	it('refuses the same URL for a different signed-in user', () => {
		// The scenario the issue names: a link copied out of one person's page.
		const token = mintReadToken({ secret: SECRET, key: KEY, subject: 'alice' })
		expect(check(token, 'bob')).toEqual({ ok: false, reason: 'bad-signature' })
	})

	it('refuses a signed-in viewer’s URL for a signed-out visitor', () => {
		const token = mintReadToken({ secret: SECRET, key: KEY, subject: 'alice' })
		expect(check(token, null).ok).toBe(false)
	})

	it('refuses an anonymous URL once a different viewer presents it', () => {
		const token = mintReadToken({ secret: SECRET, key: KEY })
		expect(check(token, null).ok).toBe(true)
		expect(check(token, 'bob')).toEqual({ ok: false, reason: 'wrong-subject' })
	})

	it('treats a missing subject and the anonymous sentinel identically', () => {
		const token = mintReadToken({ secret: SECRET, key: KEY, subject: null })
		expect(check(token, ANONYMOUS_SUBJECT).ok).toBe(true)
	})
})

describe('a read token is not guessable and not portable', () => {
	it('refuses a token signed with a different secret', () => {
		const token = mintReadToken({ secret: 'other', key: KEY, subject: 'alice' })
		expect(check(token, 'alice').ok).toBe(false)
	})

	it('refuses a token replayed against a different key', () => {
		// Guessing another key is the "guessable URL" case: the key is in the MAC,
		// so a valid token for one object says nothing about any other.
		const token = mintReadToken({ secret: SECRET, key: KEY, subject: 'alice' })
		expect(check(token, 'alice', { key: 'someone-elses.png' }).ok).toBe(false)
	})

	it('refuses a tampered expiry — extending the window invalidates the MAC', () => {
		const token = mintReadToken({ secret: SECRET, key: KEY, subject: 'alice' })
		const extended = { exp: token.exp + 86_400_000, sig: token.sig }
		expect(check(extended, 'alice').ok).toBe(false)
	})

	it('refuses garbage, empty and malformed inputs without throwing', () => {
		const base = { secret: SECRET, key: KEY, subject: 'alice' }
		expect(verifyReadToken({ ...base, exp: null, sig: null }).ok).toBe(false)
		expect(verifyReadToken({ ...base, exp: 'later', sig: 'ff' }).ok).toBe(false)
		expect(verifyReadToken({ ...base, exp: 1e18, sig: '' }).ok).toBe(false)
		expect(verifyReadToken({ ...base, exp: 1e18, sig: 'zz' }).ok).toBe(false)
		expect(
			verifyReadToken({ ...base, secret: '', exp: 1e18, sig: 'ff' }).ok,
		).toBe(false)
	})
})

describe('a read token expires', () => {
	it('stops verifying past its expiry', () => {
		const t0 = 1_800_000_000_000
		const token = mintReadToken({
			secret: SECRET,
			key: KEY,
			subject: 'alice',
			expiresInSeconds: 60,
			now: () => t0,
		})
		expect(check(token, 'alice', { now: () => t0 + 59_000 }).ok).toBe(true)
		expect(check(token, 'alice', { now: () => t0 + 61_000 })).toEqual({
			ok: false,
			reason: 'expired',
		})
	})

	it('defaults to a short window', () => {
		const t0 = 1_800_000_000_000
		const token = mintReadToken({ secret: SECRET, key: KEY, now: () => t0 })
		expect(token.exp - t0).toBe(DEFAULT_READ_TTL_SECONDS * 1000)
	})
})

describe('the gateway URL', () => {
	it('carries only the expiry and the signature — never the subject', () => {
		// The subject is re-derived from the session. If it were in the URL, an
		// attacker could simply claim to be the person it was minted for.
		const url = new URL(
			fileGatewayUrl({ secret: SECRET, key: KEY, subject: 'alice' }),
			'http://app.test',
		)
		expect(url.pathname).toBe(`/files/${encodeURIComponent(KEY)}`)
		expect([...url.searchParams.keys()].sort()).toEqual(['exp', 'sig'])
		expect(url.toString()).not.toContain('alice')
	})

	it('honors a custom prefix and encodes the key', () => {
		const url = new URL(
			fileGatewayUrl({
				secret: SECRET,
				key: 'nested/a b.png',
				prefix: '/uploads/',
			}),
			'http://app.test',
		)
		expect(url.pathname).toBe('/uploads/nested%2Fa%20b.png')
	})

	it('verifies end to end against what the gateway would parse', () => {
		const url = new URL(
			fileGatewayUrl({ secret: SECRET, key: KEY, subject: 'alice' }),
			'http://app.test',
		)
		expect(
			verifyReadToken({
				secret: SECRET,
				key: KEY,
				subject: 'alice',
				exp: url.searchParams.get('exp'),
				sig: url.searchParams.get('sig'),
			}).ok,
		).toBe(true)
	})
})
