/**
 * End-to-end auth over pglite: materialize the schema, create the instance,
 * sign a user up, and resolve their session back to a `SproutUser`. This is the
 * same wiring the web app uses, so a green run here proves the better-auth +
 * drizzle-adapter + pglite stack works before it reaches a route.
 */

import { bootPglite } from '@maxstack/core/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTH_DDL, type Auth, createAuth, resolveSproutUser } from './index.ts'

async function freshAuth(): Promise<Auth> {
	const client = await bootPglite()
	await client.exec(AUTH_DDL)
	const db = drizzle({ client })
	return createAuth({
		db,
		secret: 'test-secret',
		baseURL: 'http://localhost:3000',
	})
}

/**
 * Sign `email` up and return the session cookie, so a test that needs a signed-in
 * user can make one rather than inherit one.
 *
 * The suite used to hand the cookie from the first test to the second through a
 * `let`, and "resolves the session cookie back to a SproutUser" duly failed
 * under `--sequence.shuffle --sequence.seed=42` against an empty `cookie`
 *. The database and the `Auth` instance still cost one `beforeAll`
 * between them — what each test owns is its *user*, which is why the emails
 * differ: a shared instance means a shared `user` table, and password hashing
 * is the expensive part of a sign-up, so re-truncating and re-creating per test
 * would buy independence at a price this doesn't have to pay.
 */
async function signUp(auth: Auth, email: string, name: string) {
	const res = await auth.api.signUpEmail({
		body: { email, password: 'correct-horse', name },
		returnHeaders: true,
	})
	return {
		user: res.response.user,
		setCookie: res.headers.get('set-cookie'),
		cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
	}
}

describe('auth feature', () => {
	let auth: Auth

	beforeAll(async () => {
		auth = await freshAuth()
	})

	it('signs a user up and issues a session cookie', async () => {
		const res = await signUp(auth, 'ada@example.com', 'Ada')
		expect(res.user.email).toBe('ada@example.com')
		expect(res.setCookie).toBeTruthy()
		expect(res.cookie).toContain('better-auth')
	})

	it('resolves the session cookie back to a SproutUser with a default role', async () => {
		const { cookie } = await signUp(auth, 'grace@example.com', 'Grace')
		const request = new Request('http://localhost:3000/', {
			headers: { cookie },
		})
		const user = await resolveSproutUser(auth, request)
		expect(user).not.toBeNull()
		expect(user?.email).toBe('grace@example.com')
		// The `role` additional field defaults to 'member' — RBAC's baseline.
		expect(user?.role).toBe('member')
	})

	it('returns null for an anonymous request', async () => {
		const request = new Request('http://localhost:3000/')
		expect(await resolveSproutUser(auth, request)).toBeNull()
	})
})

// The same sign-up → session → SproutUser flow over a real Postgres server —
// proving "the dogfood app runs auth'd on Postgres" (task 22). Runs only when
// MAXSTACK_TEST_POSTGRES_URL is set (CI / nightly); skips cleanly otherwise.
const pgUrl = process.env.MAXSTACK_TEST_POSTGRES_URL?.trim()
describe.skipIf(!pgUrl)('auth feature on Postgres', () => {
	let sql: ReturnType<typeof postgres>
	let auth: Auth

	beforeAll(async () => {
		sql = postgres(pgUrl as string, { max: 2 })
		for (const stmt of AUTH_DDL.split(';')
			.map((s) => s.trim())
			.filter(Boolean)) {
			await sql.unsafe(stmt)
		}
		auth = createAuth({
			db: drizzlePostgres({ client: sql }),
			secret: 'test-secret',
			baseURL: 'http://localhost:3000',
		})
	})

	afterAll(async () => {
		await sql?.end({ timeout: 5 })
	})

	it('signs up and resolves a session over Postgres', async () => {
		const email = 'pg-user@example.com'
		await sql`DELETE FROM "user" WHERE email = ${email}`
		const res = await auth.api.signUpEmail({
			body: { email, password: 'correct-horse', name: 'PG User' },
			returnHeaders: true,
		})
		expect(res.response.user.email).toBe(email)
		const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
		const request = new Request('http://localhost:3000/', {
			headers: { cookie },
		})
		const user = await resolveSproutUser(auth, request)
		expect(user?.email).toBe(email)
		expect(user?.role).toBe('member')
	})
})
