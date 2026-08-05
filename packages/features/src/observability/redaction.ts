/**
 * **Field-level redaction for logs and traces**.
 *
 * The gating clause: *"observability must not leak PII into logs or traces by
 * default. Field-level redaction derived from declared sensitivity."*
 *
 * Two words in that sentence do the work.
 *
 * **"by default"** — redaction is not something a call site opts into. Every
 * structured log line and every captured error goes through {@link redact}
 * before it is written, so the failure mode is a redacted field somebody wanted
 * (annoying, fixable) rather than a leaked one nobody noticed (permanent, and
 * discovered by someone else).
 *
 * **"declared"** — the primary rule is the schema's own declaration: a column
 * marked sensitive is redacted wherever it appears, in any shape, without the
 * logging call site knowing anything about it. The name heuristic underneath is
 * a *backstop*, not the mechanism: it catches the field somebody forgot to
 * declare, and it is deliberately over-eager, because a redacted `tokenCount` is
 * a worse log line and a logged `accessToken` is an incident.
 *
 * ## Why a whole module rather than a `JSON.stringify` replacer
 *
 * Because the interesting cases are nested and typed. An error's `cause` chain,
 * a request body captured on a 500, a span attribute bag — all of them are
 * arbitrarily deep objects where the sensitive value is three levels down under
 * a key nobody thought about. {@link redact} walks the whole structure, handles
 * cycles, and bounds depth so a self-referential object cannot hang a logger.
 */

/** What a redacted value is replaced with. Recognizable in a log, and short. */
export const REDACTED = '[redacted]'

/**
 * The name backstop. Deliberately over-eager: this is the net under the
 * declaration, and the cost asymmetry is not close.
 */
const SENSITIVE_NAME_PARTS = [
	'password',
	'passwd',
	'secret',
	'token',
	'apikey',
	'authorization',
	'cookie',
	'sessionid',
	'ssn',
	'socialsecurity',
	'taxid',
	'creditcard',
	'cardnumber',
	'cvv',
	'iban',
	'privatekey',
	'accesskey',
	'refreshtoken',
	'otp',
	'mfa',
	'dateofbirth',
	'dob',
]

const normalize = (key: string): string =>
	key.toLowerCase().replace(/[_\-\s]/g, '')

/** Whether a field name alone is enough to redact it. */
export function isSensitiveName(key: string): boolean {
	const normalized = normalize(key)
	return SENSITIVE_NAME_PARTS.some((part) => normalized.includes(part))
}

export interface RedactionPolicy {
	/**
	 * Field names declared sensitive by the schema — the primary rule. Matched
	 * case-insensitively and ignoring separators, so one declaration covers
	 * `emailAddress`, `email_address` and `EmailAddress`.
	 */
	declared?: readonly string[]
	/**
	 * Turn the name backstop off. There is one legitimate reason — a test
	 * asserting exactly what the declaration covers — and it is off-by-default
	 * for everything else.
	 */
	disableNameHeuristic?: boolean
	/** Maximum depth to walk. Past it, a value is replaced with `'[deep]'`. */
	maxDepth?: number
}

/**
 * Redact a value for logging.
 *
 * Total: never throws, whatever it is handed. A logger that can be crashed by
 * the thing it is logging turns an error into an outage, and the thing being
 * logged is by definition the thing that just went wrong.
 */
export function redact(value: unknown, policy: RedactionPolicy = {}): unknown {
	const declared = new Set((policy.declared ?? []).map(normalize))
	const maxDepth = policy.maxDepth ?? 8
	const seen = new WeakSet<object>()

	const sensitive = (key: string): boolean =>
		declared.has(normalize(key)) ||
		(!policy.disableNameHeuristic && isSensitiveName(key))

	const walk = (input: unknown, depth: number): unknown => {
		if (depth > maxDepth) return '[deep]'
		if (input === null || typeof input !== 'object') return input
		if (seen.has(input)) return '[circular]'
		seen.add(input)
		if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1))
		if (input instanceof Date) return input.toISOString()
		if (input instanceof Error) {
			return {
				name: input.name,
				message: input.message,
				// The stack can carry a query string with a token in it, so it is a
				// value like any other rather than a trusted string.
				stack: typeof input.stack === 'string' ? input.stack : undefined,
				cause:
					input.cause === undefined ? undefined : walk(input.cause, depth + 1),
			}
		}
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(input as Record<string, unknown>))
			out[key] = sensitive(key) ? REDACTED : walk(item, depth + 1)
		return out
	}

	return walk(value, 0)
}

/**
 * Redact a URL for a log line: the path survives, the query string does not.
 *
 * A password-reset link, an unsubscribe token and a signed file URL are all
 * "just a path with a query string", and all three are credentials. Keeping the
 * path keeps the log useful for spotting a slow or failing route, which is what
 * the path was there for.
 */
export function redactUrl(raw: string): string {
	try {
		const url = new URL(raw, 'https://placeholder.invalid')
		if (!url.search) return raw
		// Every value goes, not only the sensitive-looking ones: the parameter
		// *names* are what a maintainer needs in a log line, and guessing which
		// values are safe is how the one that mattered gets through.
		const params = [...new Set(url.searchParams.keys())]
			.sort()
			.map((key) => `${key}=${REDACTED}`)
			.join('&')
		return `${url.pathname}?${params}`
	} catch {
		return raw
	}
}
