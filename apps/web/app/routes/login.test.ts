/**
 * The sign-in surface. Drives the `/login` route's `action` +
 * `loader` over the demo backend the web app actually boots, proving:
 *   1. a `signIn` intent with the seeded owner's credentials sets a session
 *      cookie and redirects home;
 *   2. bad credentials return a 401 with an error, no cookie;
 *   3. the loader bounces an already-authenticated request off `/login`.
 */

import { describe, expect, it } from 'vitest'
import { getAuth } from '../sprout.server'
import { action, loader } from './login'

/** A POST Request whose body is the given form fields — what `<Form method="post">`
 * submits, so the route's `request.formData()` parses it the same way. */
function formPost(fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields)
	return new Request('http://localhost/login', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body,
	})
}

const args = (request: Request): Parameters<typeof action>[0] =>
	({ request, params: {}, context: {} }) as Parameters<typeof action>[0]

describe('/login', () => {
	it('signs the seeded owner in and sets a session cookie', async () => {
		const res = await action(
			args(
				formPost({
					intent: 'signIn',
					email: 'admin@maxstack.dev',
					password: 'maxstack',
				}),
			),
		)
		expect(res).toBeInstanceOf(Response)
		const response = res as Response
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('/')
		const setCookie = response.headers.get('set-cookie')
		expect(setCookie).toContain('better-auth')
	})

	it('returns a 401 with an error for bad credentials', async () => {
		const res = await action(
			args(
				formPost({
					intent: 'signIn',
					email: 'admin@maxstack.dev',
					password: 'wrong-password',
				}),
			),
		)
		// A `data(...)` result, not a redirect Response — it carries the 401 in
		// `init` and the message in `data`, and never a Set-Cookie.
		expect(res).not.toBeInstanceOf(Response)
		const result = res as {
			init?: { status?: number }
			data: { error: string }
		}
		expect(result.init?.status).toBe(401)
		expect(result.data.error).toBeTruthy()
	})

	it('redirects an already-authenticated request off the sign-in page', async () => {
		const auth = await getAuth()
		const signIn = await auth.api.signInEmail({
			body: { email: 'admin@maxstack.dev', password: 'maxstack' },
			returnHeaders: true,
		})
		const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''

		const thrown = await loader(
			args(new Request('http://localhost/login', { headers: { cookie } })),
		).catch((e: unknown) => e)
		expect(thrown).toBeInstanceOf(Response)
		const response = thrown as Response
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('/')
	})
})
