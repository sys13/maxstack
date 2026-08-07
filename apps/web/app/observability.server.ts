/**
 * Owned-code wiring for observability & ops (task 61) — the production-
 * readiness layer: error reporting, rate limiting, and structured request
 * logging/tracing. Same posture as `billing.server.ts`/`storage.server.ts`:
 * the feature (`@maxstack/features/observability`) owns the primitives, this
 * module picks/configures them for the running app.
 *
 * - `getErrorReporter()` — `SENTRY_DSN`/`ERROR_TRACKING_DSN` selects the
 *   remote (best-effort JSON POST) reporter; otherwise structured JSON to
 *   stderr, zero config.
 * - `getRateLimiter()` — a token bucket, tuned by
 *   `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` (defaults: 60 req/min), over the
 *   process's coordinator: shared across instances on a Postgres backend, held
 * in this process on pglite, where a second instance cannot exist.
 * - `withRequestObservability()` — wraps a loader/action body: assigns a
 *   request id, rate-limits the caller, logs one structured JSON line per
 *   request (method/path/status/durationMs/requestId), and reports thrown
 *   errors through the error reporter before rethrowing (so React Router's
 *   own error boundary/response handling is unaffected).
 * - `registerProcessErrorHooks()` — `unhandledRejection`/`uncaughtException`
 *   also flow through the error reporter, once per process.
 *
 * Applied to the REST API surface (`/api/:resource`, `/api/:resource/:id`,
 * `/api/upload`) — the widest, most script-reachable attack surface for a
 * deployed app, and exactly where "rate-limits abusive traffic" and
 * "reports errors" (the issue's exit criteria) matter most.
 */

import type { ErrorContext, SproutUser } from '@maxstack/core'
import { nextErrorId, reportInternalError } from '@maxstack/core'
import {
	createDefaultErrorReporter,
	type ErrorReporter,
	logRequest,
	nextRequestId,
	type RateLimiter,
	type RateLimitResult,
	rateLimiterFromEnv,
} from '@maxstack/features/observability'
import { data } from 'react-router'
import { getCoordinator } from './coordination.server'

const scope = globalThis as typeof globalThis & {
	__maxstackErrorReporter?: ErrorReporter
	__maxstackRateLimiter?: Promise<RateLimiter>
	__maxstackProcessHooksRegistered?: boolean
}

export function getErrorReporter(): ErrorReporter {
	scope.__maxstackErrorReporter ??= createDefaultErrorReporter()
	return scope.__maxstackErrorReporter
}

/**
 * The process's limiter, built once against the shared coordinator.
 *
 * A promise rather than a value, because the coordinator has to open the store
 * backend first. Callers await it, which is why `checkRateLimit` is async — see
 * `RateLimiter.check` for why a synchronous shared budget is not a thing that
 * exists.
 */
export function getRateLimiter(): Promise<RateLimiter> {
	scope.__maxstackRateLimiter ??= (async () => {
		const limiter = rateLimiterFromEnv(process.env, {
			coordinator: await getCoordinator(),
		})
		console.info('[observability]', limiter.describe())
		return limiter
	})()
	return scope.__maxstackRateLimiter
}

/**
 * A best-effort caller key for rate limiting, most specific first:
 *
 * - **the api key's own id** when the caller presented one, so
 *     two keys held by the same person have independent budgets and neither
 *     can exhaust the budget of that person's browser session. Rate limiting
 *     per *user* would let a runaway script take its owner's UI down with it;
 *     per key, revoking the key is also the fix for the noise.
 *   - the resolved user id (fair per-account limits, stable across a NAT),
 *   - the `x-forwarded-for`/`x-real-ip` client address,
 *   - one shared bucket for fully anonymous/unproxied traffic.
 */
export function rateLimitKey(
	request: Request,
	user?: SproutUser | null,
): string {
	if (user?.apiKeyId) return `apikey:${user.apiKeyId}`
	if (user?.id) return `user:${user.id}`
	const forwarded = request.headers.get('x-forwarded-for')
	const ip =
		forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip')
	return ip ? `ip:${ip}` : 'anonymous'
}

/** The per-key budget override, when the caller is an api key that declares
 * one. `undefined` means "the deployment default". */
function budgetOf(user?: SproutUser | null): number | undefined {
	const declared = user?.apiKeyRateLimit
	return typeof declared === 'number' && declared > 0 ? declared : undefined
}

/**
 * The budget headers a caller needs to pace itself, on **every** response and
 * not only on the `429`. A client that can only discover its
 * budget by being refused has to hit the wall to find it; these let it slow
 * down before that. Names follow the widely-implemented `X-RateLimit-*`
 * convention (GitHub, Stripe) rather than the still-draft `RateLimit` header.
 */
function budgetHeaders(result: RateLimitResult): Record<string, string> {
	return {
		'x-ratelimit-limit': String(result.limit),
		'x-ratelimit-remaining': String(result.remaining),
		// Unix seconds, as GitHub sends it.
		'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000)),
	}
}

/**
 * Consume one token for this caller. Returns the `429` to short-circuit with
 * (already carrying the budget headers) plus the headers the *successful*
 * response should also carry. Call before doing any work — a denied request
 * should cost as little as possible.
 */
export async function checkRateLimit(
	request: Request,
	user?: SproutUser | null,
): Promise<{ denied: Response | null; headers: Record<string, string> }> {
	const result = await (await getRateLimiter()).check(
		rateLimitKey(request, user),
		budgetOf(user),
	)
	const headers = budgetHeaders(result)
	if (result.allowed) return { denied: null, headers }
	const retryAfterSec = Math.max(
		1,
		Math.ceil((result.resetAt - Date.now()) / 1000),
	)
	return {
		denied: Response.json(
			{ error: 'Too many requests' },
			{
				status: 429,
				headers: { ...headers, 'retry-after': String(retryAfterSec) },
			},
		),
		headers,
	}
}

/**
 * Wraps a loader/action `fn`: rate-limits (short-circuiting with a `429`
 * when over budget), times the call, logs one structured request line, and
 * reports thrown errors before rethrowing — mirrors `checkApiKeyScope`'s
 * "call at the top of the loader, short-circuit on a returned `Response`"
 * shape, plus a wrapper for the rest.
 */
export async function withRequestObservability(
	request: Request,
	user: SproutUser | null | undefined,
	fn: () => Promise<Response>,
): Promise<Response> {
	const { denied, headers } = await checkRateLimit(request, user)
	if (denied) return denied

	const userId = user?.id
	const requestId = nextRequestId()
	const start = Date.now()
	const url = new URL(request.url)
	try {
		const response = await fn()
		for (const [name, value] of Object.entries(headers)) {
			response.headers.set(name, value)
		}
		logRequest({
			requestId,
			method: request.method,
			path: url.pathname,
			status: response.status,
			durationMs: Date.now() - start,
			userId: userId ?? null,
			// Distinguishes a scripted caller from a browser in the request log, the
			// same distinction the audit log records.
			apiKeyId: user?.apiKeyId ?? null,
		})
		return response
	} catch (err) {
		getErrorReporter().capture(err, {
			requestId,
			method: request.method,
			path: url.pathname,
		})
		logRequest({
			requestId,
			method: request.method,
			path: url.pathname,
			status: 500,
			durationMs: Date.now() - start,
			userId: userId ?? null,
			apiKeyId: user?.apiKeyId ?? null,
		})
		throw err
	}
}

/**
 * Is this thrown value React Router's own control flow rather than a failure?
 *
 * Two shapes qualify. `redirect()` throws a real `Response`. `data()` throws a
 * `DataWithResponseInit`, which is neither a `Response` nor an `Error` — the
 * class is exported as a *type* only, so there is no `instanceof` to reach for
 * and the tag it carries is the available signal. Every deliberate 4xx in this
 * app is a `throw data(...)`, so getting this wrong would turn every 404 into a
 * 500; `observability.server.test.ts` pins it by throwing a real `data()` rather
 * than a hand-built lookalike, which is what would catch a rename upstream.
 */
function isRouterThrow(e: unknown): boolean {
	return (
		e instanceof Response ||
		(typeof e === 'object' &&
			e !== null &&
			'type' in e &&
			(e as { type?: unknown }).type === 'DataWithResponseInit')
	)
}

/**
 * Wraps a page loader/action so an unrecognized failure reaches the browser as
 * `500 { error: 'Internal error', errorId }` instead of as its own message.
 *
 * This is #336's boundary one layer out. The REST handlers already draw it, but
 * a *page* loader had no such line: a driver error thrown inside it propagated
 * to React Router, which put `error.message` — the failed statement, its
 * columns and its bound parameters — straight into the root error boundary, and
 * from there into the HTML. The user, meanwhile, got a sentence they could not
 * act on and no id to quote.
 *
 * A thrown `Response` passes through untouched, and that is the whole
 * distinction: every 4xx in this app is constructed by us and addressed to the
 * caller (`Unknown page "…"`, `Method not allowed`), so it is already safe to
 * show. Anything that is *not* a `Response` arrived from somewhere that never
 * meant to be read by a user.
 *
 * The id is minted and logged by `@maxstack/core`'s shared helper, so a page
 * failure and an API failure produce the same `err_…` shape on the same
 * structured stderr line — one thing for an operator to grep, one thing for
 * `maxstack doctor` to point at.
 */
export async function withErrorId<T>(
	context: ErrorContext,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn()
	} catch (e) {
		if (isRouterThrow(e)) throw e
		const errorId = nextErrorId()
		reportInternalError(e, errorId, context)
		throw data({ error: 'Internal error', errorId }, { status: 500 })
	}
}

/** `unhandledRejection`/`uncaughtException` → the error reporter, once per
 * process (HMR-safe via the same `globalThis` guard every other singleton
 * in this app uses). A crash still crashes — this only ensures it's
 * reported first. */
export function registerProcessErrorHooks(): void {
	if (scope.__maxstackProcessHooksRegistered) return
	scope.__maxstackProcessHooksRegistered = true
	const reporter = getErrorReporter()
	process.on('unhandledRejection', (reason) => {
		reporter.capture(reason, { source: 'unhandledRejection' })
	})
	process.on('uncaughtException', (error) => {
		reporter.capture(error, { source: 'uncaughtException' })
	})
}

registerProcessErrorHooks()
