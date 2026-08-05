/**
 * Auth breadth (task 50) over pglite: magic-link sign-in, email verification,
 * password reset, TOTP two-factor, session/device management, and the social
 * sign-in redirect — every flow the SaaS starter adds beyond email+password.
 * Emails are captured by the memory mailer, so each test drives the full
 * request → template → token → verify loop the real app performs.
 */

import { createHmac } from 'node:crypto'
import { bootPglite } from '@maxstack/core/testing'
import { beforeAll, describe, expect, it } from 'vitest'
import { createMemoryMailer } from '../email/index.ts'
import {
	type Auth,
	createPgliteAuth,
	listUserSessions,
	resolveSproutUser,
	revokeOtherUserSessions,
	revokeUserSession,
} from './index.ts'

/** Extract the first href from a rendered email body (unescaping &amp;). */
function hrefFrom(html: string): URL {
	const m = html.match(/href="([^"]+)"/)
	if (!m?.[1]) throw new Error(`no href in email: ${html}`)
	return new URL(m[1].replace(/&amp;/g, '&'))
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s) — what an authenticator app computes. */
function totp(secretBase32: string, at = Date.now()): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
	let bits = 0
	let value = 0
	const bytes: number[] = []
	for (const c of secretBase32.replace(/=+$/, '').toUpperCase()) {
		const idx = alphabet.indexOf(c)
		if (idx === -1) continue
		value = (value << 5) | idx
		bits += 5
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff)
			bits -= 8
		}
	}
	const counter = Buffer.alloc(8)
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
	const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
	const offset = (digest[digest.length - 1] as number) & 0xf
	const code =
		(((digest[offset] as number) & 0x7f) << 24) |
		((digest[offset + 1] as number) << 16) |
		((digest[offset + 2] as number) << 8) |
		(digest[offset + 3] as number)
	return String(code % 10 ** 6).padStart(6, '0')
}

const cookieOf = (headers: Headers): string =>
	headers.get('set-cookie')?.split(';')[0] ?? ''

const withCookie = (cookie: string): Headers => new Headers({ cookie })

/**
 * Every test owns its user.
 *
 * These flows used to run as one narrative over a single `ada@example.com`:
 * "verifies an email address" created her, "resets a password" changed her
 * password, and "enables TOTP" signed in with the password that reset had
 * produced. Two of them failed under `--sequence.shuffle --sequence.seed=42`
 * — and the coupling ran the other way too, since enabling 2FA on
 * the shared user puts a second factor in front of any later sign-in as her.
 *
 * The pglite instance and the `Auth` (and so the DDL) stay in `beforeAll`;
 * only the *user* is per-test, which is the smallest unit that makes these
 * independent without re-paying for a database each time.
 */
async function freshUser(
	auth: Auth,
	slug: string,
	password = 'correct-horse',
): Promise<{ email: string; password: string }> {
	const email = `${slug}@example.com`
	await auth.api.signUpEmail({ body: { email, password, name: slug } })
	return { email, password }
}

describe('auth breadth (task 50)', () => {
	let auth: Auth
	let mailer: ReturnType<typeof createMemoryMailer>

	beforeAll(async () => {
		mailer = createMemoryMailer()
		auth = await createPgliteAuth(await bootPglite(), {
			secret: 'test-secret-test-secret-test-secret',
			baseURL: 'http://localhost:3000',
			mailer,
			appName: 'Acme',
			socialProviders: {
				github: { clientId: 'gh-client', clientSecret: 'gh-secret' },
			},
		})
	})

	it('signs in via magic link: request → email → verify → session', async () => {
		const res = await auth.api.signInMagicLink({
			body: { email: 'link@example.com', name: 'Link' },
			headers: new Headers(),
		})
		expect(res.status).toBe(true)
		const mail = mailer.sent.at(-1)
		expect(mail?.to).toBe('link@example.com')
		expect(mail?.subject).toBe('Sign in to Acme')
		const url = hrefFrom(mail?.html ?? '')
		const token = url.searchParams.get('token')
		expect(token).toBeTruthy()
		const verified = await auth.api.magicLinkVerify({
			query: { token: token as string },
			headers: new Headers(),
			returnHeaders: true,
		})
		const cookie = cookieOf(verified.headers)
		expect(cookie).toContain('better-auth')
		const user = await resolveSproutUser(
			auth,
			new Request('http://localhost:3000/', { headers: { cookie } }),
		)
		expect(user?.email).toBe('link@example.com')
	})

	it('verifies an email address from the sent verification link', async () => {
		const { email } = await freshUser(auth, 'verify')
		await auth.api.sendVerificationEmail({ body: { email } })
		const mail = mailer.sent.at(-1)
		expect(mail?.subject).toContain('Verify your email')
		const token = hrefFrom(mail?.html ?? '').searchParams.get('token')
		const result = await auth.api.verifyEmail({
			query: { token: token as string },
		})
		expect(result?.status).toBe(true)
	})

	it('resets a password from the reset email and signs in with the new one', async () => {
		const { email } = await freshUser(auth, 'reset')
		await auth.api.requestPasswordReset({
			body: { email, redirectTo: '/reset' },
		})
		const mail = mailer.sent.at(-1)
		expect(mail?.subject).toBe('Reset your Acme password')
		const url = hrefFrom(mail?.html ?? '')
		// better-auth links `/reset-password/:token` (or ?token=) — handle both.
		const token =
			url.searchParams.get('token') ?? url.pathname.split('/').at(-1)
		const reset = await auth.api.resetPassword({
			body: { newPassword: 'battery-staple-9', token: token as string },
		})
		expect(reset.status).toBe(true)
		const signin = await auth.api.signInEmail({
			body: { email, password: 'battery-staple-9' },
			returnHeaders: true,
		})
		expect(cookieOf(signin.headers)).toContain('better-auth')
	})

	it('enables TOTP two-factor and demands the second factor at sign-in', async () => {
		const { email, password } = await freshUser(auth, 'totp')
		const signin = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		})
		const headers = withCookie(cookieOf(signin.headers))
		const enabled = await auth.api.enableTwoFactor({
			body: { password },
			headers,
		})
		expect(enabled.totpURI).toContain('otpauth://totp/Acme')
		expect(enabled.backupCodes.length).toBeGreaterThan(0)
		const secret = new URL(enabled.totpURI).searchParams.get('secret')
		const verify = await auth.api.verifyTOTP({
			body: { code: totp(secret as string) },
			headers,
		})
		expect(verify.token).toBeTruthy()
		// Password alone no longer signs in — better-auth asks for the 2nd factor.
		const gated = (await auth.api.signInEmail({
			body: { email, password },
		})) as { twoFactorRedirect?: boolean }
		expect(gated.twoFactorRedirect).toBe(true)
	})

	it('lists sessions with the current one marked, and revokes another device', async () => {
		const first = await auth.api.signUpEmail({
			body: {
				email: 'sessions@example.com',
				password: 'hopper-nebula',
				name: 'G',
			},
			returnHeaders: true,
		})
		const second = await auth.api.signInEmail({
			body: { email: 'sessions@example.com', password: 'hopper-nebula' },
			returnHeaders: true,
		})
		const request = new Request('http://localhost:3000/', {
			headers: { cookie: cookieOf(second.headers) },
		})
		const sessions = await listUserSessions(auth, request)
		expect(sessions).toHaveLength(2)
		expect(sessions.filter((s) => s.current)).toHaveLength(1)
		const other = sessions.find((s) => !s.current)
		await revokeUserSession(auth, request, (other as { token: string }).token)
		expect(await listUserSessions(auth, request)).toHaveLength(1)
		// The revoked cookie is dead.
		expect(
			await resolveSproutUser(
				auth,
				new Request('http://localhost:3000/', {
					headers: { cookie: cookieOf(first.headers) },
				}),
			),
		).toBeNull()
	})

	it('revokes all other sessions in one call', async () => {
		const { email, password } = await freshUser(auth, 'revoke-all')
		await auth.api.signInEmail({ body: { email, password } })
		const keeper = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		})
		const request = new Request('http://localhost:3000/', {
			headers: { cookie: cookieOf(keeper.headers) },
		})
		expect((await listUserSessions(auth, request)).length).toBeGreaterThan(1)
		await revokeOtherUserSessions(auth, request)
		const remaining = await listUserSessions(auth, request)
		expect(remaining).toHaveLength(1)
		expect(remaining[0]?.current).toBe(true)
	})

	it('builds the social sign-in redirect for a configured provider', async () => {
		const social = await auth.api.signInSocial({
			body: { provider: 'github', callbackURL: '/' },
		})
		const url = new URL(social.url as string)
		expect(url.hostname).toBe('github.com')
		expect(url.searchParams.get('client_id')).toBe('gh-client')
	})
})
