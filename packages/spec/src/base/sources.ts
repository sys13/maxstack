/**
 * Declared external data sources — "fetch this, map it onto these
 * columns" as spec-as-data.
 *
 * Two corpus asks fix the shape, and they are the two shapes this capability
 * ever takes: bookclub's *"fetch cover art and metadata from an ISBN lookup
 * service"* (**enrichment** — call an API about one row, map the answer back
 * onto it) and crmlite's *"sync an email inbox and thread messages per
 * contact"* (**sync** — pull a remote collection into local rows, repeatedly,
 * keyed by a stable remote id). Everything below is the smallest declaration
 * that covers both without becoming an HTTP client with a config file.
 *
 * ## The four properties, in the order they constrain the design
 *
 * 1. **The spec must never contain a secret.** This is the highest-risk surface
 *    in the L2 vocabulary. A spec is committed, diffed, rendered in the
 *    workbench and handed to agents, so a credential that leaks into it leaks
 *    everywhere at once and cannot be un-leaked. {@link SourceAuth} therefore
 *    holds a *name* (`OPENLIBRARY_TOKEN`) and never a value, and
 *    {@link secretLeakErrors} is a **validate-time refusal**, not a convention:
 *    a credential-shaped string anywhere in a declaration stops the op. The
 *    check is deliberately paranoid in both directions — it refuses the header
 *    and query-parameter *names* credentials normally travel under, so a
 *    declaration cannot smuggle one past the value scan by spelling it
 *    differently.
 * 2. **A declared endpoint is an SSRF surface.** The whole feature is "make
 *    this server issue a request somewhere", which is the definition. The spec
 *    constrains it twice: the URL is checked at declaration time
 *    ({@link sourceUrlErrors} — https, no credentials, narrow ports, no
 *    internal address literal), and the *declaration itself is the allowlist* —
 *    the runtime refuses any request whose origin is not the declared one, and
 *    never follows a redirect. Runtime adds the DNS-resolution check
 *    (`assertPublicUrl`, issue #185's, which this deliberately reuses rather
 *    than re-implements).
 * 3. **Generation never makes a network call.** The spec declares the source;
 *    only the running app fetches. Nothing in this module does IO, and nothing
 *    the ownership generators read can reach a response — so the determinism
 *    invariant (§L4A) holds by construction rather than by discipline. Pinned
 *    by `apps/maxstack/src/lib/source-determinism.test.ts`, which stubs `fetch`
 *    to throw and generates anyway.
 * 4. **Failure is normal, not exceptional.** A third party is down at some
 *    point on every schedule that exists. So enrichment is *queued*, never
 *    inline in a write: a create that blocked on someone else's API would fail
 *    when they did. The mapped values land as one validated update or not at
 *    all — {@link SourceMapping} produces a value set, and a partial response
 *    produces a partial *set*, never a partially-written row. And the retry
 *    budget is declared ({@link SourceLimits}) rather than inherited, because
 *    "how hard do we hammer someone else's server" is a product decision.
 *
 * ## What is deliberately not here
 *
 * No expression language, for the reason `ComputedExpr` gives: {@link
 * SourceMapping} is a path and a target field, and the *field's declared type*
 * is what the response value is coerced to. So the mapping is typed without
 * carrying a second type declaration that could drift from the column's.
 * Anything a path cannot say — reconciling two providers, resolving a remote
 * record to a local foreign key, a merge policy — is the user-owned refiner
 * slot ({@link SourceSpec.refine}), which is the same bargain the schedule
 * handler slot strikes: the platform says where the code goes and never
 * overwrites it, and the vocabulary does not grow a merge operator.
 */

import type { EntityId, FieldId, ISODate, SourceId } from './ids.ts'
import { getAcceptedOrAll, type Provenanced } from './provenance.ts'
import type { FieldType, SpecSystem } from './spec-system.ts'

// ===========================================================================
// The declaration
// ===========================================================================

/**
 * What a source does with what it fetches.
 *
 * - `enrich` — one request *about one row*, mapped back onto that row. The
 *   request's placeholders resolve from the row's own values.
 * - `sync` — one request for a *collection*, upserted into the entity by a
 *   stable remote id. Repeated on a schedule or when a webhook says to.
 *
 * They are one primitive rather than two because they differ in exactly three
 * places (what triggers them, whether a collection is read, and whether the
 * write is an update or an upsert) and agree everywhere else — the endpoint,
 * the credential rule, the SSRF constraint, the typed mapping and the failure
 * behavior are identical, and splitting them would duplicate all five.
 */
export type SourceMode = 'enrich' | 'sync'

/** Runtime guard for {@link SourceMode} — ops arrive as JSON. */
export const SOURCE_MODES: readonly SourceMode[] = ['enrich', 'sync']

/**
 * How a request is authenticated. **Every variant carries a `secretName`, never
 * a secret** — the name of an entry in the deployment's secret store (an
 * environment variable in the default runtime), resolved at request time by the
 * running app.
 *
 * `none` is a variant rather than an absence so that "this endpoint is public"
 * is a stated decision that shows up in a diff, instead of a missing key that
 * looks like an oversight.
 */
export type SourceAuth =
	| { kind: 'none' }
	/** `Authorization: Bearer <secret>`. */
	| { kind: 'bearer'; secretName: string }
	/** A named header carrying the secret verbatim (`X-Api-Key: <secret>`). */
	| { kind: 'header'; header: string; secretName: string }
	/**
	 * A query parameter carrying the secret. Supported because a large number of
	 * real APIs only offer this, and refusing it would push people to inline the
	 * key in `request.query` — which is the exact leak this module exists to
	 * prevent. The runtime redacts the parameter from every log line.
	 */
	| { kind: 'query'; param: string; secretName: string }

/** Runtime guard for {@link SourceAuth}'s discriminator. */
export const SOURCE_AUTH_KINDS = [
	'none',
	'bearer',
	'header',
	'query',
] as const satisfies readonly SourceAuth['kind'][]

/** HTTP methods a source may use. Read-only: a source *reads* a third party. */
export type SourceMethod = 'GET' | 'POST'

/** Runtime guard for {@link SourceMethod}. */
export const SOURCE_METHODS: readonly SourceMethod[] = ['GET', 'POST']

/**
 * The request a source issues.
 *
 * `url` is the whole allowlist: the runtime refuses anything whose origin is
 * not this one, and never follows a redirect (a 302 to `169.254.169.254` is the
 * cheapest way around every other check here).
 *
 * `{placeholder}` segments in `url` and `query` values resolve from the
 * triggering row and are only legal in `enrich` mode — a sync has no row to
 * resolve them from. Each names a field on the source's entity, checked at
 * declaration time, and every substituted value is percent-encoded by the
 * runtime, so a row whose value contains `/../` cannot walk the path.
 */
export interface SourceRequest {
	/** Absolute `https:` URL. May contain `{fieldName}` placeholders (enrich). */
	url: string
	/** Defaults to `GET`. */
	method?: SourceMethod
	/** Query parameters; values may contain `{fieldName}` placeholders. */
	query?: Record<string, string>
	/**
	 * Static request headers. Credential-bearing header *names* are refused
	 * outright — those go through {@link SourceAuth}, which is the only place a
	 * secret is ever named.
	 */
	headers?: Record<string, string>
}

/**
 * One response value landing on one entity field.
 *
 * `from` is a path into the JSON response — dotted keys and `[n]` indices, no
 * wildcards, no filters, no expressions (see the module note). `to` is a field
 * on the source's entity, and **its declared type is the mapping's type**: the
 * runtime coerces through {@link coerceToFieldType} and a value that cannot be
 * coerced is dropped with a reason rather than written as a lie.
 */
export interface SourceMapping {
	/** Path into the response document, e.g. `cover.large` or `authors[0].name`. */
	from: string
	/** The entity field the value lands on. */
	to: FieldId
}

/**
 * What a `sync` source reads out of a response, and how it upserts.
 *
 * Required in `sync` mode and refused in `enrich` mode. The remote id is the
 * whole reason sync is safe to repeat: without a stable key, every run appends
 * the same rows again, which is the failure mode people discover a week later
 * with 40,000 duplicate contacts.
 */
export interface SourceCollection {
	/** Path to the array of records; absent = the response document *is* the array. */
	path?: string
	/** Path, within one record, to its stable remote id. */
	idPath: string
	/**
	 * The entity field the remote id is stored in — the upsert key. A stored
	 * column rather than a hidden one, because "which remote record is this row"
	 * is a question support will ask, and an invisible answer is not one.
	 */
	idField: FieldId
	/**
	 * The most records one run may take in. **Required**, and bounded by
	 * {@link MAX_SYNC_RECORDS}: an unbounded pull is how a sync that worked in
	 * staging fills a production disk. A run that hits the bound reports it, so
	 * the truncation is visible rather than silent.
	 */
	maxRecords: number
}

/**
 * What causes a source to run.
 *
 * `create`/`update` are enrichment triggers and enqueue work — they never run
 * inline in the write, so a source that is down cannot fail a create. `manual`
 * is the on-demand button, legal in both modes. `schedule` names a declared
 * schedule and is validated against it, so a sync cannot point at
 * a recurrence nobody declared. `webhook` means an inbound receiver kicks the
 * pull; the receiver itself is code (`webhooks/inbound.ts`), because a
 * provider's callback shape is theirs and not ours to model.
 */
export type SourceTrigger =
	| { kind: 'create' }
	| { kind: 'update' }
	| { kind: 'manual' }
	| { kind: 'webhook' }
	| { kind: 'schedule'; scheduleKey: string }

/** Runtime guard for {@link SourceTrigger}'s discriminator. */
export const SOURCE_TRIGGER_KINDS = [
	'create',
	'update',
	'manual',
	'webhook',
	'schedule',
] as const satisfies readonly SourceTrigger['kind'][]

/** Triggers legal in `enrich` mode. */
export const ENRICH_TRIGGER_KINDS: readonly SourceTrigger['kind'][] = [
	'create',
	'update',
	'manual',
]

/** Triggers legal in `sync` mode. */
export const SYNC_TRIGGER_KINDS: readonly SourceTrigger['kind'][] = [
	'schedule',
	'webhook',
	'manual',
]

/**
 * How hard this app is allowed to lean on somebody else's server, and how
 * patiently it waits.
 *
 * **Every field is required**, on the same argument {@link
 * import('./spec-system.ts').FileFieldSpec} makes about its two limits: a
 * source that forgot to state its budget is a source that inherits one, and an
 * inherited retry policy against a third party is how a transient 503 becomes a
 * self-inflicted denial of service against a partner — usually discovered by
 * them, not by us. Stating it makes the rate a reviewable number in a diff.
 */
export interface SourceLimits {
	/** Requests this source may issue per minute, across the whole deployment. */
	requestsPerMinute: number
	/** Per-request timeout in milliseconds — a hung socket is not a retry. */
	timeoutMs: number
	/** Total attempts per unit of work, including the first. `1` = no retry. */
	maxAttempts: number
	/** First backoff in milliseconds; doubles per attempt (see `backoffMs`). */
	backoffMs: number
}

/** A declared external data source. */
export interface SourceSpec extends Provenanced {
	id: SourceId
	/**
	 * The stable key every job row, log line and refiner module carries. Separate
	 * from {@link id} for the reason a schedule's key is: it is the string that
	 * appears in code, in the run history, and in every human conversation about
	 * the integration.
	 */
	key: string
	/** What the source is for, in one line. Rendered in admin and the workbench. */
	description: string
	mode: SourceMode
	/** The entity the mapped values are written to. */
	entityId: EntityId
	request: SourceRequest
	/** Required, and `{kind: 'none'}` is the explicit way to say "public". */
	auth: SourceAuth
	/** Response paths → entity fields. At least one; see {@link MAX_SOURCE_MAPPINGS}. */
	mapping: SourceMapping[]
	limits: SourceLimits
	/** At least one; every kind checked against {@link SourceSpec.mode}. */
	triggers: SourceTrigger[]
	/**
	 * `enrich` only, and **required** there: the field whose value drives the
	 * lookup. Enrichment is skipped when it is empty, which is what stops a
	 * source from firing a request per row for rows it has nothing to ask about.
	 */
	inputField?: FieldId
	/** `sync` only, and required there. See {@link SourceCollection}. */
	collection?: SourceCollection
	/**
	 * Emit the user-owned refiner slot (`sources/<key>.refine.ts`) and call it
	 * with the raw remote record plus the declared mapping's output, taking its
	 * return value as the final one.
	 *
	 * This is the escape hatch that keeps the *vocabulary* from growing: crmlite
	 * needs each synced message attached to the contact whose email it came from,
	 * which is a lookup against local rows and not a path into a response. Rather
	 * than teach the mapping language about foreign-key resolution — and then
	 * about the next product's variation on it — the platform says where that
	 * code goes and promises never to rewrite it. Off by default: a project that
	 * does not need one grows no file.
	 */
	refine?: boolean
	/**
	 * A paused source keeps its declaration and its run history and stops
	 * fetching. Same argument as a paused schedule: the usual reason to stop an
	 * integration is that the other end is misbehaving, and deleting the
	 * declaration to stop it also deletes what you need to turn it back on.
	 */
	paused?: boolean
	/** The day the source was declared, stamped by `applyOp` from `appliedAt`. */
	declaredAt: ISODate
}

export interface SourcesSpec {
	sources: SourceSpec[]
}

// ===========================================================================
// Shapes and bounds
// ===========================================================================

/** A source key: the same shape as a schedule key, for the same reasons. */
export const SOURCE_KEY_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/

/**
 * A secret's *name*. Env-var shaped on purpose: it is what the name looks like
 * in every deployment target this runs on, and a name that cannot be typed into
 * a secret manager is a name that will be retyped wrongly. Length-bounded from
 * below so a one-character name cannot be a value in disguise.
 */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/

/**
 * A path into a JSON response: dotted keys with optional `[n]` indices, and no
 * wildcards. `a.b[0].c` and `[0].id` are paths; `a.*.b` and `$..id` are a query
 * language, which this is deliberately not.
 */
export const SOURCE_PATH_RE =
	/^(?:\[\d+\]|[A-Za-z_][\w-]*)(?:\[\d+\]|\.[A-Za-z_][\w-]*)*$/

/** A `{fieldName}` placeholder in a URL or query value. */
export const SOURCE_PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Ports a source may target — the same narrow set outbound webhooks allow. */
export const SOURCE_ALLOWED_PORTS: readonly string[] = ['', '443', '8443']

/** How many mappings one source may declare. Past this it is an ETL job. */
export const MAX_SOURCE_MAPPINGS = 32

/** How deep a response path may go. Bounded so a generated path can't be a walk. */
export const MAX_SOURCE_PATH_DEPTH = 8

/** The most records one sync run may take in. See {@link SourceCollection}. */
export const MAX_SYNC_RECORDS = 1000

/** Bounds on {@link SourceLimits}. Every one is a cost somebody else pays. */
export const SOURCE_LIMIT_BOUNDS = {
	/** Below 1 the source never runs; above this it is a load generator. */
	minRequestsPerMinute: 1,
	maxRequestsPerMinute: 600,
	/** Under 100ms nothing on the public internet answers; over 30s nothing should. */
	minTimeoutMs: 100,
	maxTimeoutMs: 30_000,
	minAttempts: 1,
	/** Past this the retries outlive the incident they are retrying through. */
	maxAttempts: 10,
	minBackoffMs: 100,
	maxBackoffMs: 300_000,
} as const

// ===========================================================================
// The secret check (gate: "the spec must never contain a secret")
// ===========================================================================

/**
 * Header names a declaration may not set at all. Not "may not set to a secret"
 * — **may not set**: every one of these exists to carry a credential, so the
 * only honest reason to write one into a spec is to inline one, and a value
 * scan that has to be clever enough to recognize every credential format is a
 * scan that will one day meet a format it does not know.
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
	'authorization',
	'proxy-authorization',
	'authentication',
	'cookie',
	'set-cookie',
	'x-api-key',
	'api-key',
	'apikey',
	'x-auth-token',
	'x-access-token',
	'x-secret',
	'x-signature',
	'x-amz-security-token',
]

/**
 * Query parameter names a declaration may not set statically. Same argument as
 * {@link CREDENTIAL_HEADERS}: an API that authenticates by query parameter is
 * served by `auth: {kind: 'query'}`, which names a secret rather than holding
 * one.
 */
export const CREDENTIAL_QUERY_PARAMS: readonly string[] = [
	'key',
	'api_key',
	'apikey',
	'api-key',
	'token',
	'access_token',
	'auth_token',
	'auth',
	'secret',
	'client_secret',
	'password',
	'passwd',
	'pwd',
	'signature',
	'sig',
	'sessionid',
	'session_id',
]

/** Credential formats recognized by shape, so a *value* can be caught too. */
const CREDENTIAL_PATTERNS: readonly { re: RegExp; what: string }[] = [
	{ re: /^\s*bearer\s+\S/i, what: 'a Bearer token' },
	{ re: /^\s*basic\s+[A-Za-z0-9+/=]{8,}/i, what: 'a Basic credential' },
	{ re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
	{ re: /\bsk-[A-Za-z0-9_-]{16,}/, what: 'an OpenAI-style secret key' },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, what: 'a GitHub token' },
	{ re: /\bxox[abpsr]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
	{ re: /\bAKIA[0-9A-Z]{12,}/, what: 'an AWS access key id' },
	{ re: /\bAIza[0-9A-Za-z_-]{30,}/, what: 'a Google API key' },
	{ re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, what: 'a JWT' },
	{ re: /\bglpat-[A-Za-z0-9_-]{16,}/, what: 'a GitLab token' },
]

/**
 * A run of ≥32 credential-alphabet characters mixing case and digits — the
 * catch-all for a format nobody has enumerated. Mixed classes are required
 * because a 32-character lowercase run is a word, a slug or a path segment, and
 * refusing those would make the check something people learn to work around.
 */
const OPAQUE_RUN_RE = /[A-Za-z0-9+/=_-]{32,}/g

/**
 * What `value` looks like, if it looks like a credential — else `null`.
 *
 * Placeholders are stripped first: `{isbn}` is a row's value at runtime, and it
 * is a field name here.
 */
export function looksLikeSecret(value: string): string | null {
	const bare = value.replace(SOURCE_PLACEHOLDER_RE, '')
	for (const { re, what } of CREDENTIAL_PATTERNS) if (re.test(bare)) return what
	for (const run of bare.match(OPAQUE_RUN_RE) ?? []) {
		const classes =
			(/[a-z]/.test(run) ? 1 : 0) +
			(/[A-Z]/.test(run) ? 1 : 0) +
			(/[0-9]/.test(run) ? 1 : 0)
		if (classes >= 3)
			return `an opaque ${run.length}-character high-entropy string`
	}
	return null
}

/** The remedy sentence every secret refusal ends with — one place, one wording. */
const USE_AUTH =
	'name the credential with `auth` (which stores a NAME, resolved from the ' +
	'deployment secret store at request time) — a spec is committed, diffed, ' +
	'rendered in the workbench and handed to agents, so a secret in one leaks ' +
	'everywhere at once'

/**
 * Every way this declaration would put a credential into the spec.
 *
 * Pure and total, so it is the same check at op time, at decode time, and in a
 * test. It scans the request's URL, its query values, its header names and
 * values, and the secret *names* themselves — a `secretName` that fails
 * {@link SECRET_NAME_RE} is very often a value someone pasted into the
 * name field.
 */
export function secretLeakErrors(
	ctx: string,
	source: Pick<SourceSpec, 'request' | 'auth'>,
): string[] {
	const errors: string[] = []
	const { request, auth } = source

	if (typeof request?.url === 'string') {
		if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(request.url))
			errors.push(
				`${ctx}: the URL embeds credentials (\`user:pass@host\`) — ${USE_AUTH}`,
			)
		const leak = looksLikeSecret(request.url)
		if (leak) errors.push(`${ctx}: the URL contains ${leak} — ${USE_AUTH}`)
	}

	for (const [name, value] of Object.entries(request?.query ?? {})) {
		if (CREDENTIAL_QUERY_PARAMS.includes(name.toLowerCase()))
			errors.push(
				`${ctx}: query parameter "${name}" is a credential parameter and may not be set in the spec — ${USE_AUTH}`,
			)
		const leak = typeof value === 'string' ? looksLikeSecret(value) : null
		if (leak)
			errors.push(
				`${ctx}: query parameter "${name}" contains ${leak} — ${USE_AUTH}`,
			)
	}

	for (const [name, value] of Object.entries(request?.headers ?? {})) {
		if (CREDENTIAL_HEADERS.includes(name.toLowerCase()))
			errors.push(
				`${ctx}: header "${name}" is a credential header and may not be set in the spec — ${USE_AUTH}`,
			)
		const leak = typeof value === 'string' ? looksLikeSecret(value) : null
		if (leak)
			errors.push(`${ctx}: header "${name}" contains ${leak} — ${USE_AUTH}`)
	}

	const secretName = authSecretName(auth)
	if (secretName !== null && !SECRET_NAME_RE.test(secretName))
		errors.push(
			`${ctx}: auth.secretName "${redact(secretName)}" must match ${SECRET_NAME_RE.source} — ` +
				'it is the NAME of a secret (e.g. "OPENLIBRARY_TOKEN"), never the secret itself',
		)

	return errors
}

/** The secret name an auth variant references, or `null` for `none`. */
export function authSecretName(auth: SourceAuth | undefined): string | null {
	if (!auth || auth.kind === 'none') return null
	return typeof auth.secretName === 'string' ? auth.secretName : ''
}

/**
 * Show enough of a rejected string to identify it and not enough to use it.
 * A validation error is written to a log, and a log is not a secret store — so
 * the one place this module handles a possible credential, it does not echo it.
 */
export function redact(value: string): string {
	if (value.length <= 6) return '***'
	return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`
}

// ===========================================================================
// The endpoint constraint (gate: "outbound network is an SSRF surface")
// ===========================================================================

/** Parse an IPv4 literal in any of the spellings a resolver accepts. */
function parseIpv4(host: string): number[] | null {
	const parts = host.split('.')
	if (parts.length === 4) {
		const octets = parts.map(parseNumeric)
		if (octets.every((o) => o !== null && o >= 0 && o <= 255))
			return octets as number[]
		return null
	}
	// `2130706433` is `127.0.0.1`. Skipping this is the classic bypass.
	if (parts.length === 1) {
		const value = parseNumeric(host)
		if (value === null || value < 0 || value > 0xff_ff_ff_ff) return null
		return [
			(value >>> 24) & 0xff,
			(value >>> 16) & 0xff,
			(value >>> 8) & 0xff,
			value & 0xff,
		]
	}
	return null
}

function parseNumeric(text: string): number | null {
	if (!text) return null
	if (/^0[xX][0-9a-fA-F]+$/.test(text)) return Number.parseInt(text, 16)
	if (/^0[0-7]+$/.test(text)) return Number.parseInt(text, 8)
	if (/^\d+$/.test(text)) return Number.parseInt(text, 10)
	return null
}

/** Whether a dotted quad is in a range no third-party endpoint is in. */
function isPrivateIpv4(octets: readonly number[]): boolean {
	const [a = 0, b = 0] = octets
	if (a === 0) return true
	if (a === 10) return true
	if (a === 127) return true
	if (a === 169 && b === 254) return true // the cloud metadata endpoint
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	if (a === 192 && b === 0) return true
	if (a === 100 && b >= 64 && b <= 127) return true
	if (a === 198 && (b === 18 || b === 19)) return true
	if (a >= 224) return true
	return false
}

/** Whether an IPv6 literal is loopback, link-local, ULA, or a mapped private v4. */
function isPrivateIpv6(host: string): boolean {
	const address = host.replace(/^\[|]$/g, '').toLowerCase()
	if (address === '::1' || address === '::') return true
	if (address.startsWith('fe80:')) return true
	if (/^f[cd][0-9a-f]{2}:/.test(address)) return true
	const mapped = /^::ffff:(.+)$/.exec(address)?.[1]
	if (mapped) {
		const quad = parseIpv4(mapped)
		if (quad) return isPrivateIpv4(quad)
		const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped)
		if (hexPair) {
			const high = Number.parseInt(hexPair[1] ?? '0', 16)
			const low = Number.parseInt(hexPair[2] ?? '0', 16)
			return isPrivateIpv4([
				(high >> 8) & 0xff,
				high & 0xff,
				(low >> 8) & 0xff,
				low & 0xff,
			])
		}
	}
	return false
}

/**
 * Whether a host **literal** names an address a source must never reach.
 *
 * The declaration-time half of the SSRF story: pure, no DNS, and therefore
 * usable inside `validateOp` where a network call would be unthinkable. The
 * resolution half (a public *name* re-pointed at an internal address) is
 * `assertPublicUrl` in `@maxstack/features/webhooks`, which the source runtime
 * calls immediately before every fetch.
 *
 * The two agree by test, not by hope: `sources/ssrf.agreement.test.ts` runs both
 * over one table of hosts. They cannot be one function because `@maxstack/spec`
 * is below `@maxstack/features` in the graph and importing upward would be a
 * cycle — so the duplication is deliberate and pinned.
 */
export function isPrivateHostLiteral(host: string): boolean {
	if (host.includes(':') || host.startsWith('[')) return isPrivateIpv6(host)
	const quad = parseIpv4(host)
	if (quad) return isPrivateIpv4(quad)
	const lower = host.toLowerCase().replace(/\.$/, '')
	return (
		lower === 'localhost' ||
		lower.endsWith('.localhost') ||
		lower.endsWith('.local') ||
		lower.endsWith('.internal')
	)
}

/**
 * Everything wrong with a declared endpoint, checked without touching the
 * network. Placeholders are substituted with a benign token first, so a URL
 * whose *path* is templated still parses.
 */
export function sourceUrlErrors(ctx: string, raw: unknown): string[] {
	if (typeof raw !== 'string' || raw.trim().length === 0)
		return [`${ctx}: url is required and must be a string`]
	const probe = raw.replace(SOURCE_PLACEHOLDER_RE, 'x')
	let url: URL
	try {
		url = new URL(probe)
	} catch {
		return [`${ctx}: "${raw}" is not an absolute URL`]
	}
	const errors: string[] = []
	if (url.protocol !== 'https:')
		errors.push(
			`${ctx}: endpoint must be https (got "${url.protocol}") — a plaintext ` +
				'fetch puts the response, and any credential that fetched it, on the wire',
		)
	if (url.username || url.password)
		errors.push(`${ctx}: endpoint must not embed credentials — ${USE_AUTH}`)
	if (!SOURCE_ALLOWED_PORTS.includes(url.port))
		errors.push(
			`${ctx}: port ${url.port} is not an API endpoint — allowed: ` +
				`${SOURCE_ALLOWED_PORTS.filter(Boolean).join(', ')} (or none). ` +
				'A source pointed at an arbitrary port is a port scan with a retry policy',
		)
	if (isPrivateHostLiteral(url.hostname))
		errors.push(
			`${ctx}: "${url.hostname}" is an internal address — a declared source ` +
				'reaches a third party, and the runtime refuses internal addresses by default',
		)
	if (url.hash)
		errors.push(
			`${ctx}: endpoint must not carry a fragment — it is never sent, so one ` +
				'in the spec is a reader misled about what is requested',
		)
	return errors
}

// ===========================================================================
// The typed mapping
// ===========================================================================

/** One step of a parsed {@link SourceMapping.from}: an object key or an index. */
export type SourcePathSegment = string | number

/**
 * Parse a response path into its segments, or `null` when it is not a path.
 * Bounded by {@link MAX_SOURCE_PATH_DEPTH} — depth is a cost, and an unbounded
 * one is a generated path nobody reviewed.
 */
export function parseSourcePath(path: string): SourcePathSegment[] | null {
	if (typeof path !== 'string' || !SOURCE_PATH_RE.test(path)) return null
	const segments: SourcePathSegment[] = []
	const re = /\[(\d+)\]|([A-Za-z_][\w-]*)/g
	for (const match of path.matchAll(re)) {
		if (match[1] !== undefined) segments.push(Number(match[1]))
		else if (match[2] !== undefined) segments.push(match[2])
	}
	if (segments.length === 0 || segments.length > MAX_SOURCE_PATH_DEPTH)
		return null
	return segments
}

/**
 * Read a parsed path out of a decoded JSON document. `undefined` for anything
 * that is not there — a missing value is the normal case (a book with no cover),
 * not an error, and treating it as one would make every partial response a
 * failure.
 */
export function readSourcePath(
	document: unknown,
	segments: readonly SourcePathSegment[],
): unknown {
	let cursor: unknown = document
	for (const segment of segments) {
		if (cursor === null || cursor === undefined) return undefined
		if (typeof segment === 'number') {
			if (!Array.isArray(cursor)) return undefined
			cursor = cursor[segment]
		} else {
			if (typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
			cursor = (cursor as Record<string, unknown>)[segment]
		}
	}
	return cursor
}

/** What a coercion did: a usable value, or why the response value was refused. */
export type CoercionResult =
	| { ok: true; value: string | number | boolean | null }
	| { ok: false; reason: string }

/**
 * Coerce a response value to a field's declared type.
 *
 * **This is what makes the mapping typed**, and it reads the type off the
 * *column* rather than off a second declaration in the mapping — so the
 * mapping's type cannot drift from the column's, because there is only one.
 *
 * Refusal is a first-class outcome. A third party that starts returning
 * `"seventeen"` where it used to return `17` must not write `NaN` into a number
 * column and must not take the page down; it produces a reason the run reports
 * and the row keeps the value it had.
 */
export function coerceToFieldType(
	value: unknown,
	type: FieldType,
): CoercionResult {
	if (value === null || value === undefined) return { ok: true, value: null }
	switch (type) {
		case 'string':
		case 'enum':
			if (typeof value === 'string') return { ok: true, value }
			if (typeof value === 'number' || typeof value === 'boolean')
				return { ok: true, value: String(value) }
			return {
				ok: false,
				reason: `expected a string, got ${describeJson(value)}`,
			}
		case 'number': {
			if (typeof value === 'number')
				return Number.isFinite(value)
					? { ok: true, value }
					: { ok: false, reason: 'got a non-finite number' }
			// A string is accepted only when it is *entirely* a number: `Number('')`
			// is 0 and `Number('12abc')` is NaN, and the first is the dangerous one.
			if (typeof value === 'string' && value.trim() !== '') {
				const parsed = Number(value)
				if (Number.isFinite(parsed)) return { ok: true, value: parsed }
			}
			return {
				ok: false,
				reason: `expected a number, got ${describeJson(value)}`,
			}
		}
		case 'boolean':
			if (typeof value === 'boolean') return { ok: true, value }
			if (value === 'true' || value === 'false')
				return { ok: true, value: value === 'true' }
			return {
				ok: false,
				reason: `expected a boolean, got ${describeJson(value)}`,
			}
		case 'date': {
			if (typeof value !== 'string' && typeof value !== 'number')
				return {
					ok: false,
					reason: `expected a date, got ${describeJson(value)}`,
				}
			const at = new Date(value)
			if (Number.isNaN(at.getTime()))
				return { ok: false, reason: `"${String(value)}" is not a date` }
			return { ok: true, value: at.toISOString() }
		}
		case 'json':
			return { ok: true, value: JSON.stringify(value) }
		case 'file':
			// A file column holds a storage key the upload path minted. A remote URL
			// is not one, and writing it would produce a key that resolves to
			// nothing — an integration that looks like it worked. Ingesting remote
			// bytes is a real capability; it is not this one.
			return {
				ok: false,
				reason:
					'a file field stores a storage key, which only the upload path can mint — map the remote URL to a string field instead',
			}
	}
}

function describeJson(value: unknown): string {
	if (Array.isArray(value)) return 'an array'
	if (typeof value === 'object') return 'an object'
	return `a ${typeof value}`
}

/** The field names a URL/query template resolves from the triggering row. */
export function sourcePlaceholders(text: string): string[] {
	if (typeof text !== 'string') return []
	return [...text.matchAll(SOURCE_PLACEHOLDER_RE)].map((m) => m[1] ?? '')
}

/** Every placeholder in a request, across the URL and every query value. */
export function requestPlaceholders(request: SourceRequest): string[] {
	const names = sourcePlaceholders(request?.url ?? '')
	for (const value of Object.values(request?.query ?? {}))
		names.push(...sourcePlaceholders(value))
	return [...new Set(names)]
}

// ===========================================================================
// Reading the layer
// ===========================================================================

/** Every declared source, or `[]` for a spec that has never declared one. */
export function listSources(spec: Pick<SpecSystem, 'sources'>): SourceSpec[] {
	return spec.sources?.sources ?? []
}

/** The declared source with this key, if any. */
export function findSource(
	spec: Pick<SpecSystem, 'sources'>,
	key: string,
): SourceSpec | undefined {
	return listSources(spec).find((s) => s.key === key)
}

/**
 * The sources a runtime actually fetches: grounded by the same
 * accepted-else-all rule the data and page layers use, minus the paused ones.
 * A source an agent proposed and nobody accepted does not start calling a third
 * party — which is the entire point of having a review queue in front of a
 * vocabulary that can now reach the internet.
 */
export function activeSources(spec: Pick<SpecSystem, 'sources'>): SourceSpec[] {
	return getAcceptedOrAll(listSources(spec)).filter((s) => !s.paused)
}

/** The declared sources that enrich rows of `entityId` on a write trigger. */
export function enrichSourcesFor(
	spec: Pick<SpecSystem, 'sources'>,
	entityId: EntityId,
	on: 'create' | 'update',
): SourceSpec[] {
	return activeSources(spec).filter(
		(s) =>
			s.mode === 'enrich' &&
			s.entityId === entityId &&
			s.triggers.some((t) => t.kind === on),
	)
}

/** The declared sources a schedule key drives. */
export function syncSourcesForSchedule(
	spec: Pick<SpecSystem, 'sources'>,
	scheduleKey: string,
): SourceSpec[] {
	return activeSources(spec).filter(
		(s) =>
			s.mode === 'sync' &&
			s.triggers.some(
				(t) => t.kind === 'schedule' && t.scheduleKey === scheduleKey,
			),
	)
}

/** One line of prose for a trigger — rendered in admin, docs, and diffs. */
export function describeTrigger(trigger: SourceTrigger): string {
	switch (trigger.kind) {
		case 'create':
			return 'on create'
		case 'update':
			return 'on update'
		case 'manual':
			return 'on demand'
		case 'webhook':
			return 'when a webhook receiver signals'
		case 'schedule':
			return `on schedule "${trigger.scheduleKey}"`
	}
}

/** One line of prose for an auth mode. Never renders a value; there isn't one. */
export function describeAuth(auth: SourceAuth): string {
	switch (auth.kind) {
		case 'none':
			return 'unauthenticated'
		case 'bearer':
			return `bearer token from secret ${auth.secretName}`
		case 'header':
			return `header ${auth.header} from secret ${auth.secretName}`
		case 'query':
			return `query parameter ${auth.param} from secret ${auth.secretName}`
	}
}

/** One line of prose for a source — the diff summary and the stub header. */
export function describeSource(source: SourceSpec): string {
	const origin = originOf(source.request?.url ?? '') ?? source.request?.url
	const triggers = (source.triggers ?? []).map(describeTrigger).join(', ')
	return `${source.mode} from ${origin} ${triggers ? `(${triggers})` : ''}`.trim()
}

/**
 * The origin a source is allowed to reach — `https://host[:port]`. This is the
 * per-source allowlist the runtime enforces: a response that redirects
 * elsewhere is refused rather than followed.
 */
export function originOf(url: string): string | null {
	try {
		return new URL(url.replace(SOURCE_PLACEHOLDER_RE, 'x')).origin
	} catch {
		return null
	}
}
