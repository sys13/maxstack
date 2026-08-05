import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryRateLimiter, rateLimiterFromEnv } from './rate-limit.ts'

describe('createInMemoryRateLimiter', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('allows up to `max` requests in a window, then denies', async () => {
		const limiter = createInMemoryRateLimiter({ max: 3, windowMs: 1000 })
		expect((await limiter.check('a')).allowed).toBe(true)
		expect((await limiter.check('a')).allowed).toBe(true)
		expect((await limiter.check('a')).allowed).toBe(true)
		const denied = await limiter.check('a')
		expect(denied.allowed).toBe(false)
		expect(denied.remaining).toBe(0)
	})

	it('tracks separate keys independently', async () => {
		const limiter = createInMemoryRateLimiter({ max: 1, windowMs: 1000 })
		expect((await limiter.check('a')).allowed).toBe(true)
		expect((await limiter.check('a')).allowed).toBe(false)
		expect((await limiter.check('b')).allowed).toBe(true)
	})

	it('refills tokens over time', async () => {
		const limiter = createInMemoryRateLimiter({ max: 2, windowMs: 1000 })
		expect((await limiter.check('a')).allowed).toBe(true)
		expect((await limiter.check('a')).allowed).toBe(true)
		expect((await limiter.check('a')).allowed).toBe(false)

		// Half the window elapses — one token's worth refills.
		vi.setSystemTime(500)
		const result = await limiter.check('a')
		expect(result.allowed).toBe(true)

		// Immediately after, the bucket is empty again.
		expect((await limiter.check('a')).allowed).toBe(false)
	})

	it('a denied check does not consume a token', async () => {
		const limiter = createInMemoryRateLimiter({ max: 1, windowMs: 1000 })
		expect((await limiter.check('a')).allowed).toBe(true)
		expect((await limiter.check('a')).allowed).toBe(false)
		expect((await limiter.check('a')).allowed).toBe(false)
		vi.setSystemTime(1000)
		expect((await limiter.check('a')).allowed).toBe(true)
	})
})

describe('rateLimiterFromEnv', () => {
	it('falls back to defaults when env vars are unset/invalid', async () => {
		const limiter = rateLimiterFromEnv({})
		const result = await limiter.check('a')
		expect(result.limit).toBe(60)
	})

	it('reads RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS', async () => {
		const limiter = rateLimiterFromEnv({
			RATE_LIMIT_MAX: '2',
			RATE_LIMIT_WINDOW_MS: '1000',
		})
		expect((await limiter.check('a')).allowed).toBe(true)
		expect((await limiter.check('a')).allowed).toBe(true)
		expect((await limiter.check('a')).allowed).toBe(false)
	})

	it('ignores a non-numeric env var and falls back to the default', async () => {
		const limiter = rateLimiterFromEnv({ RATE_LIMIT_MAX: 'not-a-number' })
		expect((await limiter.check('a')).limit).toBe(60)
	})
})

/** Issue #186 — a per-key budget, so one credential's traffic is one
 * credential's problem. */
describe('per-bucket budget override', () => {
	it('a bucket with its own max is limited by that max, not the default', async () => {
		const limiter = createInMemoryRateLimiter({ max: 60, windowMs: 60_000 })
		expect((await limiter.check('apikey:cheap', 2)).allowed).toBe(true)
		expect((await limiter.check('apikey:cheap', 2)).allowed).toBe(true)
		const denied = await limiter.check('apikey:cheap', 2)
		expect(denied.allowed).toBe(false)
		expect(denied.limit).toBe(2)
		// The default bucket next door is untouched — budgets do not leak.
		expect((await limiter.check('user:someone')).allowed).toBe(true)
	})

	it('an absent or nonsensical override falls back to the default', async () => {
		const limiter = createInMemoryRateLimiter({ max: 3, windowMs: 60_000 })
		expect((await limiter.check('a', undefined)).limit).toBe(3)
		expect((await limiter.check('b', 0)).limit).toBe(3)
		expect((await limiter.check('c', Number.NaN)).limit).toBe(3)
	})

	it('raising a drained bucket’s budget grants headroom, not amnesty', async () => {
		const limiter = createInMemoryRateLimiter({ max: 60, windowMs: 60_000 })
		await limiter.check('k', 2)
		await limiter.check('k', 2)
		expect((await limiter.check('k', 2)).allowed).toBe(false)
		// Editing the key to a 10/min budget: the bucket was empty, and stays
		// proportionally empty. Otherwise "raise the limit" would be a way to
		// refill instantly, which makes the limit unenforceable against anyone
		// who can edit their own key.
		const after = await limiter.check('k', 10)
		expect(after.allowed).toBe(false)
		expect(after.limit).toBe(10)
	})
})
