/**
 * Rate limiting — the production-readiness layer's "rate-limits abusive
 * traffic" leg (task 61). No existing rate-limit primitive was found
 * anywhere in the monorepo (checked `api-keys`, which only carries
 * scope/quota data, no throttling); this is a fresh primitive matching the
 * house style of `JobQueue`/`WebhookService`: a small interface + a default
 * that is safe with zero config.
 *
 * Token bucket, one bucket per key (typically the caller's user id, api-key
 * id, or IP): capacity `max` tokens, refilling continuously at
 * `max / windowMs` tokens/ms. A request consumes one token; denied requests
 * do not consume one. This smooths bursts better than a fixed window while
 * staying O(1) per check and needing no background timer.
 *
 * ## Where the buckets live (absorbing #227)
 *
 * Nowhere in this file, any more. The arithmetic and the storage both moved to
 * `Coordinator` in `@maxstack/core` — one seam, because live fan-out had the
 * *same* per-process bound and solving it twice would have produced two
 * half-tested notions of "shared". This module is now the adapter that turns a
 * coordinator into the `RateLimiter` shape its callers already hold.
 *
 * The consequence for a deployment: with an in-process coordinator two
 * instances serve a declared budget at twice the declared number, and with a
 * Postgres one they serve it at the declared number. `RateLimiter.describe()`
 * says which, so an operator can read the answer instead of inferring it.
 */

import {
	type Coordinator,
	createInProcessCoordinator,
	type TokenVerdict,
} from '@maxstack/core'

/** What one `check` decided. Structurally `TokenVerdict`; kept as its own name
 * because it is the published shape of this module and the two layers are
 * allowed to be described in their own vocabulary. */
export type RateLimitResult = TokenVerdict

export interface RateLimiter {
	/**
	 * Consume one token from `key`'s bucket.
	 *
	 * `max` overrides the limiter's default capacity for this bucket only — an
	 * api key with its own budget. It is passed per call rather than
	 * configured per bucket because the authority for a key's budget is the key
	 * row, which is re-read on every request anyway; caching it here would be a
	 * second copy that goes stale the moment someone edits the key. Changing the
	 * override for an existing bucket re-scales the tokens already in it rather
	 * than refilling it, so raising a limit cannot be used to reset a bucket the
	 * caller has already drained.
	 *
	 * **Asynchronous since issue #228**, and it had to become so: a bucket every
	 * instance shares is a row in the database, and there is no synchronous way to
	 * read one. Keeping a synchronous signature would have meant either a cached
	 * copy of a shared counter — which is the per-process limiter again, wearing a
	 * shared-store costume — or a second interface, so that the two limiters could
	 * not be swapped at a call site. Both are worse than three `await`s.
	 */
	check(key: string, max?: number): Promise<RateLimitResult>
	/** One line an operator can log at boot: what this limiter's numbers mean
	 * across instances. Not decoration — "the declaration says a number and the
	 * deployment delivers a multiple of it, silently" was half of issue #227, and
	 * the silence was the reportable part. */
	describe(): string
}

export interface RateLimiterOptions {
	/** Requests allowed per window. Default 60. */
	max?: number
	/** Window length in ms. Default 60_000 (60 req/min). */
	windowMs?: number
	/** Where the buckets live. Defaults to a fresh in-process coordinator, which
	 * is the pre-#228 behaviour exactly. */
	coordinator?: Coordinator
	/** Epoch-ms clock. Injectable so a test drives the refill curve instead of
	 * sleeping through it. */
	now?: () => number
}

/**
 * A token-bucket limiter over a {@link Coordinator}.
 *
 * With the default (in-process) coordinator this is the limiter that has always
 * shipped: per-process buckets, reset on restart, enough for the single-container
 * deploy `maxstack deploy` produces. Hand it a Postgres coordinator and the same
 * call sites enforce one budget across every instance.
 */
export function createRateLimiter(opts?: RateLimiterOptions): RateLimiter {
	const defaultMax = opts?.max ?? 60
	const windowMs = opts?.windowMs ?? 60_000
	const coordinator = opts?.coordinator ?? createInProcessCoordinator()
	const clock = opts?.now ?? Date.now

	return {
		check(key, override) {
			const max =
				override !== undefined && Number.isFinite(override) && override > 0
					? override
					: defaultMax
			return coordinator.take({ key, max, windowMs, now: clock() })
		},
		describe() {
			return coordinator.kind === 'in-process'
				? `rate limiting is per-process: ${defaultMax} per ${windowMs}ms per instance, so a deployment running N instances serves N times each declared budget`
				: `rate limiting is shared through Postgres: ${defaultMax} per ${windowMs}ms across every instance`
		},
	}
}

/** @deprecated Renamed to {@link createRateLimiter} in issue #228, because the
 * bucket store is now a constructor argument and "InMemory" stopped being true
 * of the function rather than of its default. Kept as an alias so a project that
 * ejected a call site still compiles; it takes the same options. */
export const createInMemoryRateLimiter = createRateLimiter

/**
 * `max`/`windowMs` from `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` env vars,
 * falling back to the defaults (60 req/min) — a deployment tunes throttling
 * without a code change.
 *
 * `coordinator` is separate from the env because it is not a tuning knob: it is
 * whichever store the host opened, and the host is the only thing that knows.
 */
export function rateLimiterFromEnv(
	env: Record<string, string | undefined> = process.env,
	opts: { coordinator?: Coordinator } = {},
): RateLimiter {
	const max = Number.parseInt(env.RATE_LIMIT_MAX ?? '', 10)
	const windowMs = Number.parseInt(env.RATE_LIMIT_WINDOW_MS ?? '', 10)
	return createRateLimiter({
		max: Number.isFinite(max) && max > 0 ? max : undefined,
		windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined,
		...(opts.coordinator ? { coordinator: opts.coordinator } : {}),
	})
}
