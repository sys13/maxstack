/**
 * The guarded fetch behind a declared source.
 *
 * Everything here exists because "let the app issue a request to a URL somebody
 * wrote down" is a security surface before it is a feature. The declaration
 * already survived the spec-layer refusals (`sourceUrlErrors` — https, no
 * credentials, narrow ports, no internal address literal); this is the half
 * those cannot do, because it needs a clock, a resolver and a socket:
 *
 * | Control | Why it is here and not in the spec |
 * |---|---|
 * | `assertPublicUrl` before every request | A name that was public at declaration time can resolve to `169.254.169.254` an hour later. Only a resolution catches that, and it has to be *this* request's resolution. |
 * | The declared origin is pinned | A redirect to an internal host is the cheapest way around every other check, so redirects are **never followed** — a 3xx is a failed request with a reason, not a hop. |
 * | The secret is read at request time | The spec holds a name; the value never exists outside this function's stack, and is never returned, logged or attached to an error. |
 * | Timeout, size cap, rate limit | A third party that hangs, floods or is being hammered is the normal failure of every integration that has ever existed. |
 *
 * The `fetch` implementation is **injected**, defaulting to the global one.
 * That is not only for tests: it is what lets `source-determinism.test.ts`
 * assert the generation path never reaches this module by stubbing the global
 * to throw and generating anyway.
 */

import {
	originOf,
	redact,
	SOURCE_PLACEHOLDER_RE,
	type SourceAuth,
	type SourceSpec,
} from '@maxstack/spec'
import type { RateLimiter } from '../observability/rate-limit.ts'
import type { AddressResolver } from '../webhooks/ssrf.ts'
import { assertPublicUrl, SsrfRefusedError } from '../webhooks/ssrf.ts'

/** The subset of `fetch` a source needs. Injected so nothing here is ambient. */
export type FetchLike = (
	url: string,
	init: {
		method: string
		headers: Record<string, string>
		redirect: 'manual'
		signal?: AbortSignal
	},
) => Promise<{
	status: number
	headers: { get(name: string): string | null }
	text(): Promise<string>
}>

/**
 * Where a credential's *value* comes from. A name in, a value out — and the
 * value never travels any further than {@link fetchSource}'s own stack.
 * Defaults to the process environment, which is what every deployment target
 * this runs on already has.
 */
export interface SecretStore {
	get(name: string): string | undefined
}

/** The default store: the process environment. */
export function envSecretStore(
	env: Record<string, string | undefined> = process.env,
): SecretStore {
	return { get: (name) => env[name] }
}

/** Why a source's request failed. Machine-readable so a status can render it. */
export type SourceFailure =
	| 'refused-url'
	| 'missing-secret'
	| 'rate-limited'
	| 'timeout'
	| 'redirect'
	| 'http-error'
	| 'too-large'
	| 'not-json'
	| 'network'

export class SourceFetchError extends Error {
	readonly reason: SourceFailure
	/** Whether trying again could plausibly work. A 404 is not worth a retry. */
	readonly retryable: boolean

	constructor(reason: SourceFailure, message: string, retryable: boolean) {
		super(message)
		this.name = 'SourceFetchError'
		this.reason = reason
		this.retryable = retryable
	}
}

/**
 * The biggest response body a source will read: 2 MiB.
 *
 * A cap has to exist, because "map three fields out of a JSON document" has no
 * upper bound on the document. Without it a partner that starts returning their
 * whole catalogue takes the worker's memory with them. Applied to the declared
 * `content-length` *and* to the bytes actually read, because the header is a
 * claim the sender makes about itself.
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export interface FetchSourceDeps {
	fetch?: FetchLike
	secrets?: SecretStore
	/** Shared across sources; each call passes its own declared per-minute cap. */
	limiter?: RateLimiter
	/** Host resolution for the DNS-rebinding check. Omit to skip it. */
	resolve?: AddressResolver
}

/** One row's worth of values a placeholder may resolve from. */
export type PlaceholderValues = Record<string, unknown>

/**
 * Substitute `{field}` placeholders, percent-encoding every value.
 *
 * The encoding is the point: a row whose `isbn` is `../../admin` must not be
 * able to walk the path of a URL the spec author wrote. A placeholder with no
 * value is an error rather than an empty string — `/isbn/.json` is a different
 * request from the one that was declared, and quietly issuing it is worse than
 * not issuing it.
 */
export function substitutePlaceholders(
	template: string,
	values: PlaceholderValues,
): string {
	return template.replace(SOURCE_PLACEHOLDER_RE, (_match, name: string) => {
		const value = values[name]
		if (value === null || value === undefined || value === '')
			throw new SourceFetchError(
				'refused-url',
				`placeholder "{${name}}" has no value on this row — refusing to issue a request the declaration did not describe`,
				false,
			)
		return encodeURIComponent(String(value))
	})
}

/** The headers a request carries, with the credential resolved by name. */
function authHeaders(
	auth: SourceAuth,
	secrets: SecretStore,
): {
	headers: Record<string, string>
	queryParam: { name: string; value: string } | null
} {
	if (auth.kind === 'none') return { headers: {}, queryParam: null }
	const value = secrets.get(auth.secretName)
	if (!value)
		throw new SourceFetchError(
			'missing-secret',
			`secret "${auth.secretName}" is not set in this deployment — the spec names it, the deployment supplies it`,
			false,
		)
	if (auth.kind === 'bearer')
		return { headers: { authorization: `Bearer ${value}` }, queryParam: null }
	if (auth.kind === 'header')
		return { headers: { [auth.header]: value }, queryParam: null }
	return { headers: {}, queryParam: { name: auth.param, value } }
}

/**
 * Build the URL a source requests, placeholders resolved and the declared
 * query attached. Exported because the URL a run *would* issue is worth showing
 * in admin — with the credential parameter absent, since it is not in here.
 */
export function buildSourceUrl(
	source: SourceSpec,
	values: PlaceholderValues = {},
): string {
	const url = new URL(substitutePlaceholders(source.request.url, values))
	for (const [name, raw] of Object.entries(source.request.query ?? {}))
		url.searchParams.set(name, substitutePlaceholders(raw, values))
	return url.toString()
}

/** What one request returned. */
export interface SourceResponse {
	/** The decoded JSON document. */
	document: unknown
	status: number
}

/**
 * Issue one request for `source`, with every control above applied.
 *
 * Throws {@link SourceFetchError} on any refusal or failure, carrying a
 * machine-readable reason and whether a retry could plausibly help. It never
 * throws something carrying the credential: the one place the value exists, it
 * is read into a header and dropped.
 */
export async function fetchSource(
	source: SourceSpec,
	values: PlaceholderValues = {},
	deps: FetchSourceDeps = {},
): Promise<SourceResponse> {
	const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike)
	const secrets = deps.secrets ?? envSecretStore()

	if (deps.limiter) {
		const verdict = await deps.limiter.check(
			`source:${source.key}`,
			source.limits.requestsPerMinute,
		)
		if (!verdict.allowed)
			throw new SourceFetchError(
				'rate-limited',
				`source "${source.key}" is over its declared ${source.limits.requestsPerMinute}/min budget`,
				true,
			)
	}

	const target = buildSourceUrl(source, values)

	// The declaration is the allowlist. Checked before the SSRF pass as well as
	// after a redirect, so a placeholder that somehow produced another origin is
	// caught by the same rule a 302 would be.
	const declaredOrigin = originOf(source.request.url)
	if (!declaredOrigin || new URL(target).origin !== declaredOrigin)
		throw new SourceFetchError(
			'refused-url',
			`request origin does not match the declared endpoint (${declaredOrigin ?? 'none'})`,
			false,
		)

	// The rebinding check: this request's resolution, immediately before it.
	try {
		await assertPublicUrl(target, { resolve: deps.resolve })
	} catch (err) {
		if (err instanceof SsrfRefusedError)
			throw new SourceFetchError('refused-url', err.message, false)
		throw err
	}

	const { headers: authHeader, queryParam } = authHeaders(source.auth, secrets)
	let url = target
	if (queryParam) {
		const withKey = new URL(target)
		withKey.searchParams.set(queryParam.name, queryParam.value)
		url = withKey.toString()
	}

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), source.limits.timeoutMs)
	let response: Awaited<ReturnType<FetchLike>>
	try {
		response = await doFetch(url, {
			method: source.request.method ?? 'GET',
			headers: {
				accept: 'application/json',
				...Object.fromEntries(
					Object.entries(source.request.headers ?? {}).map(([k, v]) => [
						k.toLowerCase(),
						v,
					]),
				),
				...authHeader,
			},
			// Never `follow`. A 302 to an internal address walks past assertPublicUrl,
			// the origin pin and the port allowlist in one hop.
			redirect: 'manual',
			signal: controller.signal,
		})
	} catch (err) {
		const aborted = controller.signal.aborted
		throw new SourceFetchError(
			aborted ? 'timeout' : 'network',
			aborted
				? `no response within the declared ${source.limits.timeoutMs}ms`
				: `request failed: ${err instanceof Error ? err.message : String(err)}`,
			true,
		)
	} finally {
		clearTimeout(timer)
	}

	if (response.status >= 300 && response.status < 400)
		throw new SourceFetchError(
			'redirect',
			`endpoint redirected (${response.status}) — a source never follows one, because a redirect to an internal address is the cheapest way around every other check. Declare the final URL instead`,
			false,
		)

	if (response.status >= 400)
		throw new SourceFetchError(
			'http-error',
			`endpoint returned ${response.status}`,
			// 408/429 and every 5xx are worth another attempt; the rest are the
			// endpoint telling us the request itself is wrong, and repeating it is
			// just being rude to somebody's server.
			response.status === 408 ||
				response.status === 429 ||
				response.status >= 500,
		)

	const declaredLength = Number(response.headers.get('content-length') ?? '0')
	if (declaredLength > MAX_RESPONSE_BYTES)
		throw new SourceFetchError(
			'too-large',
			`response declares ${declaredLength} bytes, over the ${MAX_RESPONSE_BYTES} cap`,
			false,
		)

	const body = await response.text()
	// The header is a claim the sender makes about itself, so the bytes are
	// checked too.
	if (body.length > MAX_RESPONSE_BYTES)
		throw new SourceFetchError(
			'too-large',
			`response body is ${body.length} bytes, over the ${MAX_RESPONSE_BYTES} cap`,
			false,
		)

	try {
		return { document: JSON.parse(body) as unknown, status: response.status }
	} catch {
		throw new SourceFetchError(
			'not-json',
			`endpoint returned ${redact(body.slice(0, 40))} rather than JSON`,
			false,
		)
	}
}

/** The delay before attempt `n` (1-based), doubling from the declared base. */
export function sourceBackoffMs(source: SourceSpec, attempt: number): number {
	return source.limits.backoffMs * 2 ** Math.max(0, attempt - 1)
}
