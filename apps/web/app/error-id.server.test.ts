/**
 * `withErrorId` — #336's boundary, applied to a page loader (#339).
 *
 * The first case is the fix: a driver error thrown inside a page loader used to
 * propagate as itself, and the root error boundary printed `error.message` — the
 * failed statement, its columns and its bound parameters — into the HTML.
 *
 * The second is the trap that would make the fix worse than the bug: every
 * deliberate refusal in this app is a `throw data(...)`, and a `data()` throw is
 * neither a `Response` nor an `Error`. Swallowing it would turn every 404 into a
 * 500. The case throws a *real* `data()` rather than a hand-built lookalike, so
 * a rename inside React Router fails here instead of in production.
 */

import { data } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { withErrorId } from './observability.server'

/** The thrown value, whatever it is. */
async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn()
	} catch (e) {
		return e
	}
	throw new Error('expected a throw')
}

const context = { resource: 'books', operation: 'list-loader' }

describe('withErrorId', () => {
	it('turns a store failure into a fixed sentence plus a quotable id', async () => {
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
		const secret =
			'select "book"."secret_token" from "book" where "book"."id" = $1'
		const thrown = await thrownBy(() =>
			withErrorId(context, () => Promise.reject(new Error(secret))),
		)
		const body = (thrown as { data: { error: string; errorId: string } }).data
		expect(body.error).toBe('Internal error')
		expect(body.errorId).toMatch(/^err_/)
		expect(JSON.stringify(body)).not.toContain('secret_token')

		// The detail is not lost — it is on stderr, under the same id, in the same
		// structured shape `fail()` prints. That pairing is the whole feature.
		const line = JSON.parse(String(stderr.mock.calls[0]?.[0]))
		expect(line).toMatchObject({
			level: 'error',
			type: 'api-internal-error',
			errorId: body.errorId,
			resource: 'books',
			operation: 'list-loader',
			message: secret,
		})
		stderr.mockRestore()
	})

	it('lets a deliberate refusal through untouched, so a 404 stays a 404', async () => {
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
		const refusal = data({ error: 'Unknown page "nonsense"' }, { status: 404 })
		const thrown = await thrownBy(() =>
			withErrorId(context, () => Promise.reject(refusal)),
		)
		expect(thrown).toBe(refusal)
		expect(stderr).not.toHaveBeenCalled()
		stderr.mockRestore()
	})

	it('lets a redirect through — it is control flow, not a failure', async () => {
		const redirect = new Response(null, {
			status: 302,
			headers: { location: '/login' },
		})
		const thrown = await thrownBy(() =>
			withErrorId(context, () => Promise.reject(redirect)),
		)
		expect(thrown).toBe(redirect)
	})

	it('returns the value untouched when nothing failed', async () => {
		await expect(withErrorId(context, async () => 'ok')).resolves.toBe('ok')
	})
})
