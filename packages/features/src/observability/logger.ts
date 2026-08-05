/**
 * Structured request logging + a request-id-per-request pattern — task 61's
 * "basic request tracing" leg. No tracing dependency (OpenTelemetry or
 * otherwise) exists anywhere in the monorepo (checked), so this stays a
 * lightweight, dependency-free primitive: one JSON line per request with
 * enough fields to correlate a request across logs (`requestId`) and spot
 * slow/failing routes (`durationMs`, `status`).
 */

import { type RedactionPolicy, redact, redactUrl } from './redaction.ts'

export interface RequestLogFields {
	requestId: string
	method: string
	path: string
	status: number
	durationMs: number
	userId?: string | null
	/** The api key that made the call, when one did. Present so a
	 * spike in the request log can be traced to one credential and revoked,
	 * rather than only to the account that happens to hold it. */
	apiKeyId?: string | null
}

/** A short, sortable-enough id — good for correlating one request's log
 * lines without pulling in a UUID dependency (crypto.randomUUID is already
 * used elsewhere in this app, e.g. `sprout.server.ts`'s `nextOpId`, but a
 * shorter id keeps log lines readable). */
export function nextRequestId(): string {
	return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * One structured JSON line to stdout per request — grep/jq-able, and the
 * natural input to any log pipeline (Datadog, CloudWatch, …) without this app
 * needing to know which one.
 *
 * **Redacted by default**. Every field goes through `redact` and
 * the path goes through `redactUrl`, so a query string carrying a password-reset
 * token or a signed file URL never reaches the log. Redaction is not something a
 * call site opts into: the failure mode has to be a redacted field somebody
 * wanted, not a leaked one nobody noticed.
 */
export function logRequest(
	fields: RequestLogFields,
	policy: RedactionPolicy = {},
): void {
	const safe = redact(
		{ ...fields, path: redactUrl(fields.path) },
		policy,
	) as Record<string, unknown>
	console.log(JSON.stringify({ level: 'info', type: 'request', ...safe }))
}
