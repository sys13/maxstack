/**
 * The guarded fetch, organized by *bypass* rather than by control
 * — the same shape `webhooks/ssrf.test.ts` uses, and for the same reason: the
 * question a reader has is "could somebody get this to request the metadata
 * endpoint", not "is there a function called checkUrl".
 */

import type { SourceSpec } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import {
	buildSourceUrl,
	type FetchLike,
	fetchSource,
	MAX_RESPONSE_BYTES,
	type SourceFetchError,
	sourceBackoffMs,
	substitutePlaceholders,
} from './fetch.ts'

const source = (overrides: Partial<SourceSpec> = {}): SourceSpec =>
	({
		id: 'src-isbn',
		key: 'isbn.lookup',
		description: 'ISBN lookup',
		mode: 'enrich',
		entityId: 'e-book',
		request: { url: 'https://openlibrary.org/isbn/{isbn}.json' },
		auth: { kind: 'none' },
		mapping: [{ from: 'title', to: 'fld-book-title' }],
		limits: {
			requestsPerMinute: 60,
			timeoutMs: 5000,
			maxAttempts: 3,
			backoffMs: 1000,
		},
		triggers: [{ kind: 'create' }],
		inputField: 'fld-book-isbn',
		declaredAt: '2026-07-28',
		provenance: {
			isSuggested: false,
			isAccepted: true,
			isAddedManually: true,
			suggestedDescription: null,
			priority: 'medium',
		},
		...overrides,
	}) as SourceSpec

/** A fetch stub that records what it was asked for. */
function stubFetch(
	response: Partial<{
		status: number
		body: string
		headers: Record<string, string>
	}> = {},
): FetchLike & { calls: { url: string; headers: Record<string, string> }[] } {
	const calls: { url: string; headers: Record<string, string> }[] = []
	const fn = (async (url, init) => {
		calls.push({ url, headers: init.headers })
		return {
			status: response.status ?? 200,
			headers: {
				get: (name: string) => response.headers?.[name.toLowerCase()] ?? null,
			},
			text: async () => response.body ?? '{"title":"Dune"}',
		}
	}) as FetchLike & { calls: typeof calls }
	fn.calls = calls
	return fn
}

describe('placeholders', () => {
	it('percent-encodes every substituted value', () => {
		// A row whose value contains `../` must not be able to walk the path of a
		// URL the spec author wrote.
		expect(
			substitutePlaceholders('https://x.example.com/{isbn}', {
				isbn: '../../admin',
			}),
		).toBe('https://x.example.com/..%2F..%2Fadmin')
	})

	it('refuses to issue a request the declaration did not describe', () => {
		// `/isbn/.json` is a different request from the declared one, and quietly
		// issuing it is worse than not issuing it.
		expect(() =>
			substitutePlaceholders('https://x.example.com/{isbn}.json', { isbn: '' }),
		).toThrow(/has no value on this row/)
	})

	it('attaches the declared query, placeholders resolved', () => {
		const url = buildSourceUrl(
			source({
				request: {
					url: 'https://openlibrary.org/isbn/{isbn}.json',
					query: { lang: '{locale}', fmt: 'json' },
				},
			}),
			{ isbn: '9780441013593', locale: 'en' },
		)
		expect(url).toBe(
			'https://openlibrary.org/isbn/9780441013593.json?lang=en&fmt=json',
		)
	})
})

describe('the credential never leaves this function', () => {
	it('sends a bearer token read from the secret store by name', async () => {
		const fetch = stubFetch()
		await fetchSource(
			source({ auth: { kind: 'bearer', secretName: 'OL_TOKEN' } }),
			{ isbn: '1' },
			{ fetch, secrets: { get: () => 'super-secret-value' } },
		)
		expect(fetch.calls[0]?.headers.authorization).toBe(
			'Bearer super-secret-value',
		)
	})

	it('fails with a named reason when the deployment never set the secret', async () => {
		// The spec names it; the deployment supplies it. A missing one is a
		// deployment problem stated as such, not a 401 from a stranger.
		await expect(
			fetchSource(
				source({ auth: { kind: 'bearer', secretName: 'OL_TOKEN' } }),
				{ isbn: '1' },
				{ fetch: stubFetch(), secrets: { get: () => undefined } },
			),
		).rejects.toMatchObject({ reason: 'missing-secret' })
	})

	it('does not put the secret in the error when the request fails', async () => {
		const secret = 'super-secret-value'
		const failing: FetchLike = async () => {
			throw new Error('boom')
		}
		const err = await fetchSource(
			source({ auth: { kind: 'bearer', secretName: 'OL_TOKEN' } }),
			{ isbn: '1' },
			{ fetch: failing, secrets: { get: () => secret } },
		).catch((e: unknown) => e)
		expect(String((err as Error).message)).not.toContain(secret)
	})

	it('puts a query-parameter credential on the wire but not in buildSourceUrl', async () => {
		const fetch = stubFetch()
		const spec = source({
			auth: { kind: 'query', param: 'key', secretName: 'K' },
		})
		expect(buildSourceUrl(spec, { isbn: '1' })).not.toContain('key=')
		await fetchSource(
			spec,
			{ isbn: '1' },
			{ fetch, secrets: { get: () => 'v' } },
		)
		expect(fetch.calls[0]?.url).toContain('key=v')
	})
})

describe('SSRF', () => {
	it('refuses an endpoint that resolves to an internal address', async () => {
		// The rebinding case: the literal is public, this request's resolution is
		// not. Only a resolution catches it, and it has to be this one.
		await expect(
			fetchSource(
				source(),
				{ isbn: '1' },
				{ fetch: stubFetch(), resolve: async () => ['169.254.169.254'] },
			),
		).rejects.toMatchObject({ reason: 'refused-url' })
	})

	it('never follows a redirect', async () => {
		// A 302 to an internal host walks past the resolution check, the origin
		// pin and the port allowlist in one hop.
		await expect(
			fetchSource(
				source(),
				{ isbn: '1' },
				{ fetch: stubFetch({ status: 302 }) },
			),
		).rejects.toMatchObject({ reason: 'redirect' })
	})

	it('asks the transport for manual redirect handling, not just ignores 3xx', async () => {
		let sawManual = false
		const fetch: FetchLike = async (_url, init) => {
			sawManual = init.redirect === 'manual'
			return {
				status: 200,
				headers: { get: () => null },
				text: async () => '{}',
			}
		}
		await fetchSource(source(), { isbn: '1' }, { fetch })
		expect(sawManual).toBe(true)
	})
})

describe('failure is an outcome with a reason', () => {
	it('separates retryable from permanent HTTP failures', async () => {
		const cases: [number, boolean][] = [
			[404, false],
			[401, false],
			[429, true],
			[503, true],
		]
		for (const [status, retryable] of cases) {
			const err = (await fetchSource(
				source(),
				{ isbn: '1' },
				{ fetch: stubFetch({ status }) },
			).catch((e: unknown) => e)) as SourceFetchError
			expect(err.reason, String(status)).toBe('http-error')
			expect(err.retryable, String(status)).toBe(retryable)
		}
	})

	it('caps the response the sender declares AND the bytes it actually sends', async () => {
		await expect(
			fetchSource(
				source(),
				{ isbn: '1' },
				{
					fetch: stubFetch({
						headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
					}),
				},
			),
		).rejects.toMatchObject({ reason: 'too-large' })
		// The header is a claim the sender makes about itself.
		await expect(
			fetchSource(
				source(),
				{ isbn: '1' },
				{ fetch: stubFetch({ body: 'x'.repeat(MAX_RESPONSE_BYTES + 1) }) },
			),
		).rejects.toMatchObject({ reason: 'too-large' })
	})

	it('reports a non-JSON body without echoing it', async () => {
		const err = (await fetchSource(
			source(),
			{ isbn: '1' },
			{
				fetch: stubFetch({
					body: '<html><body>Service Unavailable</body></html>',
				}),
			},
		).catch((e: unknown) => e)) as SourceFetchError
		expect(err.reason).toBe('not-json')
		expect(err.message).not.toContain('Service Unavailable')
	})

	it('honours the declared per-minute budget', async () => {
		const limiter = {
			check: async () => ({
				allowed: false,
				remaining: 0,
				resetAt: 0,
				limit: 60,
			}),
			describe: () => 'a stub that always refuses',
		}
		await expect(
			fetchSource(source(), { isbn: '1' }, { fetch: stubFetch(), limiter }),
		).rejects.toMatchObject({ reason: 'rate-limited' })
	})

	it('doubles the declared backoff per attempt', () => {
		const spec = source()
		expect(sourceBackoffMs(spec, 1)).toBe(1000)
		expect(sourceBackoffMs(spec, 2)).toBe(2000)
		expect(sourceBackoffMs(spec, 3)).toBe(4000)
	})
})
