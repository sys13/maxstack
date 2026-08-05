/**
 * Issue #188: *"observability must not leak PII into logs or traces by default.
 * Field-level redaction derived from declared sensitivity."*
 *
 * The tests are written against the places PII actually reaches a log — a
 * nested context bag, an error's `cause` chain, a stack trace, a query string —
 * rather than against a flat object, because a flat object is the one case
 * everybody remembers to handle.
 */

import { describe, expect, it, vi } from 'vitest'
import { createMemoryErrorReporter } from './errors.ts'
import { logRequest } from './logger.ts'
import { isSensitiveName, REDACTED, redact, redactUrl } from './redaction.ts'

describe('declared sensitivity is the primary rule', () => {
	it('redacts a declared field the name heuristic would not catch', () => {
		const out = redact(
			{ email: 'a@b.com', homeAddress: '1 Main St', city: 'Springfield' },
			{ declared: ['email', 'homeAddress'] },
		) as Record<string, unknown>
		expect(out.email).toBe(REDACTED)
		expect(out.homeAddress).toBe(REDACTED)
		// Not declared, not secret-shaped: kept, because a log with nothing in it
		// is not observability.
		expect(out.city).toBe('Springfield')
	})

	it('matches a declaration across naming styles', () => {
		const out = redact(
			{ emailAddress: 'x', email_address: 'y', EmailAddress: 'z' },
			{ declared: ['email address'] },
		) as Record<string, unknown>
		expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED])
	})
})

describe('the name backstop', () => {
	it('catches the field somebody forgot to declare', () => {
		const out = redact({
			password: 'hunter2',
			accessToken: 'sk_live_1',
			'x-api-key': 'k',
			authorization: 'Bearer x',
			cookie: 'session=1',
		}) as Record<string, unknown>
		expect(Object.values(out).every((v) => v === REDACTED)).toBe(true)
	})

	it('is deliberately over-eager, and the asymmetry is the reason', () => {
		// A redacted `tokenCount` is a worse log line. A logged `accessToken` is
		// an incident. The rule optimizes for the second.
		expect(isSensitiveName('tokenCount')).toBe(true)
		expect(isSensitiveName('durationMs')).toBe(false)
	})

	it('can be turned off only explicitly', () => {
		const out = redact({ password: 'p' }, { disableNameHeuristic: true }) as {
			password: string
		}
		expect(out.password).toBe('p')
	})
})

describe('the shapes PII actually hides in', () => {
	it('redacts a value nested three levels deep', () => {
		const out = redact({
			request: { headers: { authorization: 'Bearer x' }, path: '/p' },
		}) as { request: { headers: { authorization: string }; path: string } }
		expect(out.request.headers.authorization).toBe(REDACTED)
		expect(out.request.path).toBe('/p')
	})

	it('walks an error’s cause chain', () => {
		const inner = new Error('inner')
		Object.assign(inner, { apiKey: 'sk_live' })
		const outer = new Error('outer', { cause: inner })
		const out = redact({ err: outer }) as {
			err: { cause: { message: string } }
		}
		expect(out.err.cause.message).toBe('inner')
		expect(JSON.stringify(out)).not.toContain('sk_live')
	})

	it('redacts inside arrays', () => {
		const out = redact(
			{ users: [{ email: 'a', name: 'A' }] },
			{
				declared: ['email'],
			},
		) as { users: { email: string; name: string }[] }
		expect(out.users[0]?.email).toBe(REDACTED)
		expect(out.users[0]?.name).toBe('A')
	})

	it('cannot be hung by a circular object', () => {
		// A logger that can be crashed by the thing it is logging turns an error
		// into an outage — and the thing being logged is, by definition, the thing
		// that just went wrong.
		const cycle: Record<string, unknown> = { name: 'x' }
		cycle.self = cycle
		expect(() => redact(cycle)).not.toThrow()
		expect((redact(cycle) as { self: string }).self).toBe('[circular]')
	})

	it('bounds depth rather than recursing forever', () => {
		let deep: Record<string, unknown> = { value: 1 }
		for (let i = 0; i < 30; i++) deep = { nested: deep }
		expect(JSON.stringify(redact(deep))).toContain('[deep]')
	})
})

describe('URLs', () => {
	it('keeps the path and drops every query value', () => {
		// A password-reset link, an unsubscribe token and a signed file URL are
		// all "a path with a query string", and all three are credentials.
		expect(redactUrl('/reset?token=abc&next=/home')).toBe(
			`/reset?next=${REDACTED}&token=${REDACTED}`,
		)
	})

	it('leaves a bare path alone', () => {
		expect(redactUrl('/projects/1')).toBe('/projects/1')
	})
})

describe('redaction is on by default at the call sites', () => {
	it('logRequest redacts the query string without being asked', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
		logRequest({
			requestId: 'req_1',
			method: 'GET',
			path: '/files/x?signature=abc123',
			status: 200,
			durationMs: 4,
		})
		const line = String(spy.mock.calls[0]?.[0])
		expect(line).not.toContain('abc123')
		expect(line).toContain('/files/x')
		spy.mockRestore()
	})

	it('the error reporter redacts the context bag without being asked', () => {
		const reporter = createMemoryErrorReporter()
		reporter.capture(new Error('boom'), {
			userId: 'u1',
			sessionToken: 'st_secret',
		})
		expect(reporter.errors[0]?.context).toMatchObject({
			userId: 'u1',
			sessionToken: REDACTED,
		})
		expect(JSON.stringify(reporter.errors)).not.toContain('st_secret')
	})
})
