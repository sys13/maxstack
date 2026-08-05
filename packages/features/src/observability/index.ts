/**
 * Observability & ops (task 61) — the production-readiness layer: error
 * reporting, rate limiting, and structured request logging/tracing. Not the
 * DB-aggregation `metrics` module (admin dashboard counts) — this is
 * request-path infrastructure, deliberately dependency-free (no Sentry/OTel
 * SDK found anywhere in the monorepo) with an env-var-gated remote provider,
 * matching billing's `STRIPE_SECRET_KEY` / storage's `S3_BUCKET` pattern.
 */

export type { CapturedError, ErrorReporter } from './errors.ts'
export {
	createConsoleErrorReporter,
	createDefaultErrorReporter,
	createMemoryErrorReporter,
	createRemoteErrorReporter,
} from './errors.ts'
export type { RequestLogFields } from './logger.ts'
export { logRequest, nextRequestId } from './logger.ts'
export type {
	RateLimiter,
	RateLimiterOptions,
	RateLimitResult,
} from './rate-limit.ts'
export {
	createInMemoryRateLimiter,
	createRateLimiter,
	rateLimiterFromEnv,
} from './rate-limit.ts'
export type { RedactionPolicy } from './redaction.ts'
export {
	isSensitiveName,
	REDACTED,
	redact,
	redactUrl,
} from './redaction.ts'
