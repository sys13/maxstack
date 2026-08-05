/**
 * Error reporting — the production-readiness layer's "reports errors" leg
 * (task 61). `ErrorReporter` is deliberately tiny (one method) so it slots
 * into request handlers, route error boundaries, and process-level
 * `uncaughtException`/`unhandledRejection` hooks alike.
 *
 * Zero-config default is `createConsoleErrorReporter` (structured JSON to
 * stderr — always safe, no dependency, no network call). Setting
 * `SENTRY_DSN` or `ERROR_TRACKING_DSN` swaps in `createRemoteErrorReporter`,
 * a best-effort JSON POST of the same envelope to that URL. This is *not*
 * the full Sentry ingestion protocol (no `@sentry/node` dependency exists
 * anywhere in this monorepo — checked before adding one); a real Sentry
 * project should read `SENTRY_DSN` as a signal to swap this reporter for
 * `@sentry/node`'s own client. `createMemoryErrorReporter` is for tests.
 */

export interface CapturedError {
	message: string
	stack?: string
	context?: Record<string, unknown>
	capturedAt: string
}

import { type RedactionPolicy, redact } from './redaction.ts'

export interface ErrorReporter {
	capture(error: unknown, context?: Record<string, unknown>): void
}

/**
 * Build the envelope, **redacted**.
 *
 * A captured error is the single most likely place for PII to reach a log: the
 * context bag is whatever the call site had to hand, and a stack trace routinely
 * carries a URL with a token in its query string. Redaction happens here, once,
 * rather than at each reporter — a reporter added later would otherwise have to
 * remember, and the one that forgets is the one wired to a third party.
 */
function toCaptured(
	error: unknown,
	context?: Record<string, unknown>,
	policy?: RedactionPolicy,
): CapturedError {
	const err = error instanceof Error ? error : new Error(String(error))
	const safe = redact(
		{ message: err.message, stack: err.stack, context },
		policy,
	)
	const fields = safe as {
		message: string
		stack?: string
		context?: Record<string, unknown>
	}
	return {
		message: fields.message,
		stack: fields.stack,
		context: fields.context,
		capturedAt: new Date().toISOString(),
	}
}

/** Structured JSON to stderr — the zero-config default, safe in any
 * environment (no network, no dependency). */
export function createConsoleErrorReporter(): ErrorReporter {
	return {
		capture(error, context) {
			const captured = toCaptured(error, context)
			console.error(JSON.stringify({ level: 'error', ...captured }))
		},
	}
}

/** In-memory reporter for tests — every captured error is appended to
 * `.errors`, mirroring `createMemoryJobStore`/`createMemoryAuditSink`'s
 * inspectable-array shape. */
export function createMemoryErrorReporter(): ErrorReporter & {
	errors: CapturedError[]
} {
	const errors: CapturedError[] = []
	return {
		errors,
		capture(error, context) {
			errors.push(toCaptured(error, context))
		},
	}
}

/**
 * Best-effort JSON POST to a DSN/webhook URL — fire-and-forget (a reporting
 * failure must never throw back into the caller's request path). Falls back
 * to the console reporter for every capture in addition to the network send,
 * so an unreachable endpoint doesn't silently swallow the error.
 */
export function createRemoteErrorReporter(dsn: string): ErrorReporter {
	const fallback = createConsoleErrorReporter()
	return {
		capture(error, context) {
			fallback.capture(error, context)
			const captured = toCaptured(error, context)
			void fetch(dsn, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(captured),
			}).catch(() => {
				// Reporting is observational — a network/DSN failure must never
				// surface to the caller.
			})
		},
	}
}

/** Picks the remote reporter when `SENTRY_DSN` or `ERROR_TRACKING_DSN` is
 * set, else the console default — the same env-var-gated provider pattern
 * as billing's `STRIPE_SECRET_KEY` / storage's `S3_BUCKET`. */
export function createDefaultErrorReporter(
	env: Record<string, string | undefined> = process.env,
): ErrorReporter {
	const dsn = env.SENTRY_DSN?.trim() || env.ERROR_TRACKING_DSN?.trim()
	return dsn ? createRemoteErrorReporter(dsn) : createConsoleErrorReporter()
}
