/**
 * The rate-limit bucket key is not caller-controlled.
 *
 * `clientIdOf` read `x-forwarded-for`'s **leftmost** entry unconditionally — the
 * one part of the chain an attacker fully controls, since nothing required a
 * proxy to overwrite it and nothing verified that one had. Rotating the header
 * minted an unbounded number of buckets, so a portal's declared
 * `rateLimitPerHour` was enforced per *fabricated address*: a rate limiter that
 * does not limit.
 *
 * The trust is now declared. These pin both directions of that, because getting
 * either wrong is silent — an over-trusting version passes every functional test
 * of the limiter, and an over-strict one only shows up as a support ticket about
 * shared budgets.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { clientIdOf } from './portals.server'

const req = (headers: Record<string, string>) =>
	new Request('https://example.test/p/k', { headers })

const ORIGINAL = process.env.MAXSTACK_TRUSTED_PROXY_HOPS
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.MAXSTACK_TRUSTED_PROXY_HOPS
	else process.env.MAXSTACK_TRUSTED_PROXY_HOPS = ORIGINAL
})

describe('with no declared proxy', () => {
	it('ignores the header entirely', () => {
		delete process.env.MAXSTACK_TRUSTED_PROXY_HOPS
		// The attack: one caller, many claimed addresses, previously one bucket each.
		const buckets = new Set(
			['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((ip) =>
				clientIdOf(req({ 'x-forwarded-for': ip })),
			),
		)
		expect(buckets).toEqual(new Set(['anonymous']))
	})

	it('ignores x-real-ip too — same header, same problem', () => {
		delete process.env.MAXSTACK_TRUSTED_PROXY_HOPS
		expect(clientIdOf(req({ 'x-real-ip': '9.9.9.9' }))).toBe('anonymous')
	})
})

describe('with one declared proxy hop', () => {
	it('reads what the trusted hop saw, not what the caller claimed', () => {
		process.env.MAXSTACK_TRUSTED_PROXY_HOPS = '1'
		// The caller forged the first two entries; the proxy appended the third.
		const id = clientIdOf(
			req({ 'x-forwarded-for': 'fake-1, fake-2, 203.0.113.7' }),
		)
		expect(id).toBe('203.0.113.7')
		// Which is the whole point: forging the left side changes nothing.
		expect(clientIdOf(req({ 'x-forwarded-for': 'other, 203.0.113.7' }))).toBe(
			'203.0.113.7',
		)
	})

	it('refuses a chain shorter than the declared hops', () => {
		process.env.MAXSTACK_TRUSTED_PROXY_HOPS = '2'
		// Two hops declared, one entry present: this did not come through the
		// proxies we were told about, so there is nothing here worth trusting.
		expect(clientIdOf(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe(
			'anonymous',
		)
	})

	it('falls back to anonymous with no header at all', () => {
		process.env.MAXSTACK_TRUSTED_PROXY_HOPS = '1'
		expect(clientIdOf(req({}))).toBe('anonymous')
	})
})
