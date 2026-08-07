/**
 * What the root error boundary is allowed to say (#339).
 *
 * The two assertions that carry the fix are the negative ones: a 500's message
 * never reaches the presentation outside dev, and a 404 is not classified as a
 * failure. Everything else is copy.
 */

import { UNSAFE_ErrorResponseImpl } from 'react-router'
import { describe, expect, it } from 'vitest'
import { presentError } from './error-page'

/** A thrown `data()` as React Router hands it to a boundary: an `ErrorResponse`. */
function thrown(status: number, statusText: string, body: unknown) {
	return new UNSAFE_ErrorResponseImpl(status, statusText, body)
}

describe('presentError', () => {
	it('reads a 404 as a wrong address, naming the path', () => {
		const presented = presentError(
			thrown(404, 'Not Found', { error: 'Unknown page "nonsense"' }),
			{ dev: false, path: '/nonsense' },
		)
		expect(presented.kind).toBe('not-found')
		expect(presented.status).toBe(404)
		expect(presented.heading).toBe('Page not found')
		expect(presented.body).toContain('/nonsense')
		expect(presented.errorId).toBeNull()
	})

	it('surfaces a 500 as a correlation id, never as its message', () => {
		const presented = presentError(
			thrown(500, 'Internal Server Error', {
				error: 'Internal error',
				errorId: 'err_abc123',
			}),
			{ dev: false, path: '/books' },
		)
		expect(presented.kind).toBe('route')
		expect(presented.errorId).toBe('err_abc123')
		expect(presented.heading).toBe('Something went wrong')
		expect(presented.detail).toBeNull()
	})

	it('never lets a 5xx body reach the page, however detailed it is', () => {
		const sql =
			'select "book"."secret_token" from "book" where "book"."id" = $1'
		const presented = presentError(thrown(500, 'Internal Server Error', sql), {
			dev: false,
		})
		expect(presented.body).not.toContain('secret_token')
		expect(presented.detail).toBeNull()
	})

	it('never renders a crashed error message or stack in production', () => {
		const error = new Error('connect ECONNREFUSED 127.0.0.1:5432')
		const presented = presentError(error, { dev: false })
		expect(presented.kind).toBe('crash')
		expect(presented.detail).toBeNull()
		expect(presented.body).not.toContain('ECONNREFUSED')
		expect(presented.heading).not.toContain('ECONNREFUSED')
	})

	it('does render the stack in development, where it is the useful thing', () => {
		const error = new Error('connect ECONNREFUSED 127.0.0.1:5432')
		const presented = presentError(error, { dev: true })
		expect(presented.detail).toContain('ECONNREFUSED')
	})

	it('passes a 4xx we constructed through verbatim — it was written for the reader', () => {
		const presented = presentError(
			thrown(405, 'Method Not Allowed', { error: 'Method not allowed' }),
			{ dev: false },
		)
		expect(presented.status).toBe(405)
		expect(presented.body).toBe('Method not allowed')
	})

	it('falls back to a sentence when a 4xx body carries no message', () => {
		const presented = presentError(thrown(403, '', undefined), { dev: false })
		expect(presented.heading).toBe('That request was refused')
		expect(presented.body).toBe('That request could not be served.')
	})

	it('survives a body it cannot serialize, rather than throwing inside the boundary', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(() => presentError(cyclic, { dev: true })).not.toThrow()
	})
})
