/**
 * The pure half of external data sources: the typed mapping, the
 * path grammar, and the declaration-time SSRF literal check.
 *
 * Organized by *what would go wrong*, not by function. A response path test
 * that only checks `a.b` resolves is a test that passes on the day the parser
 * starts accepting `a.*.b` too.
 */

import { describe, expect, it } from 'vitest'
import {
	coerceToFieldType,
	describeAuth,
	describeSource,
	describeTrigger,
	isPrivateHostLiteral,
	looksLikeSecret,
	originOf,
	parseSourcePath,
	readSourcePath,
	redact,
	requestPlaceholders,
	type SourceSpec,
	sourceUrlErrors,
} from './sources.ts'

describe('response paths', () => {
	it('parses dotted keys and [n] indices', () => {
		expect(parseSourcePath('title')).toEqual(['title'])
		expect(parseSourcePath('cover.large')).toEqual(['cover', 'large'])
		expect(parseSourcePath('authors[0].name')).toEqual(['authors', 0, 'name'])
		expect(parseSourcePath('[0].id')).toEqual([0, 'id'])
	})

	it('is a path grammar and not a query language', () => {
		// Each of these is the first step down the road to needing a parser, a
		// grammar and an injection story. See the module note on ComputedExpr.
		for (const bad of ['$..id', 'a.*.b', 'authors[*]', 'a..b', '', ' ', 'a[b]'])
			expect(parseSourcePath(bad), bad).toBeNull()
	})

	it('bounds depth', () => {
		expect(parseSourcePath('a.b.c.d.e.f.g.h')).not.toBeNull()
		expect(parseSourcePath('a.b.c.d.e.f.g.h.i')).toBeNull()
	})

	it('reads a value, and reports absence as absence rather than as failure', () => {
		const doc = { cover: { large: 'x' }, authors: [{ name: 'Ada' }] }
		const read = (p: string) => readSourcePath(doc, parseSourcePath(p) ?? [])
		expect(read('cover.large')).toBe('x')
		expect(read('authors[0].name')).toBe('Ada')
		// A book with no cover is the normal case, not an error — treating it as
		// one would make every partial response a failed run.
		expect(read('cover.small')).toBeUndefined()
		expect(read('authors[9].name')).toBeUndefined()
		expect(read('cover[0]')).toBeUndefined()
	})

	it('does not walk into a string or a number', () => {
		expect(readSourcePath({ a: 'text' }, ['a', 'length'])).toBeUndefined()
	})
})

describe('typed mapping', () => {
	it('coerces to the target column’s declared type', () => {
		expect(coerceToFieldType(17, 'number')).toEqual({ ok: true, value: 17 })
		expect(coerceToFieldType('17', 'number')).toEqual({ ok: true, value: 17 })
		expect(coerceToFieldType(17, 'string')).toEqual({ ok: true, value: '17' })
		expect(coerceToFieldType('true', 'boolean')).toEqual({
			ok: true,
			value: true,
		})
		expect(coerceToFieldType({ a: 1 }, 'json')).toEqual({
			ok: true,
			value: '{"a":1}',
		})
	})

	it('refuses rather than writing a lie', () => {
		// A third party that starts returning "seventeen" must not write NaN into
		// a number column, and must not take the page down either.
		const refused = coerceToFieldType('seventeen', 'number')
		expect(refused.ok).toBe(false)
		expect(refused.ok === false && refused.reason).toMatch(/expected a number/)
		expect(coerceToFieldType({ a: 1 }, 'string').ok).toBe(false)
		expect(coerceToFieldType('yes', 'boolean').ok).toBe(false)
	})

	it('does not accept the empty string as zero', () => {
		// `Number('')` is 0. That is the coercion that quietly zeroes a column.
		expect(coerceToFieldType('', 'number').ok).toBe(false)
		expect(coerceToFieldType('  ', 'number').ok).toBe(false)
	})

	it('normalizes a date to an ISO instant and refuses a non-date', () => {
		expect(coerceToFieldType('2026-07-28', 'date')).toEqual({
			ok: true,
			value: '2026-07-28T00:00:00.000Z',
		})
		expect(coerceToFieldType('last tuesday', 'date').ok).toBe(false)
	})

	it('refuses to write a remote URL into a file column', () => {
		// A file column holds a storage key only the upload path can mint. Writing
		// a URL there produces a key that resolves to nothing — an integration
		// that looks like it worked.
		const refused = coerceToFieldType('https://example.com/a.png', 'file')
		expect(refused.ok).toBe(false)
		expect(refused.ok === false && refused.reason).toMatch(/storage key/)
	})

	it('maps a missing value to null rather than dropping the key', () => {
		expect(coerceToFieldType(undefined, 'string')).toEqual({
			ok: true,
			value: null,
		})
	})
})

describe('the endpoint constraint', () => {
	it.each([
		['127.0.0.1', true],
		['localhost', true],
		['LOCALHOST.', true],
		['169.254.169.254', true],
		['2130706433', true], // decimal spelling of 127.0.0.1
		['0x7f.0.0.1', true], // hex octet
		['0177.0.0.1', true], // octal octet
		['10.0.0.5', true],
		['172.16.0.1', true],
		['192.168.1.1', true],
		['100.64.0.1', true], // CGNAT
		['::1', true],
		['[::ffff:127.0.0.1]', true],
		['fd00::1', true],
		['api.internal', true],
		['printer.local', true],
		['openlibrary.org', false],
		['8.8.8.8', false],
		['172.32.0.1', false], // just outside RFC1918
	])('classifies %s', (host, expected) => {
		expect(isPrivateHostLiteral(host)).toBe(expected)
	})

	it('accepts a real third-party endpoint, placeholders and all', () => {
		expect(
			sourceUrlErrors('src', 'https://openlibrary.org/isbn/{isbn}.json'),
		).toEqual([])
	})

	it('refuses plaintext, odd ports, fragments and userinfo', () => {
		expect(sourceUrlErrors('src', 'http://a.example.com').join()).toMatch(
			/must be https/,
		)
		expect(sourceUrlErrors('src', 'https://a.example.com:5432').join()).toMatch(
			/is not an API endpoint/,
		)
		expect(sourceUrlErrors('src', 'https://a.example.com/#x').join()).toMatch(
			/fragment/,
		)
		expect(sourceUrlErrors('src', 'https://u:p@a.example.com').join()).toMatch(
			/credentials/,
		)
	})

	it('refuses something that is not an absolute URL at all', () => {
		expect(sourceUrlErrors('src', '/books/{isbn}').join()).toMatch(
			/not an absolute URL/,
		)
		expect(sourceUrlErrors('src', undefined).join()).toMatch(/url is required/)
	})

	it('reports the origin a source is allowed to reach', () => {
		expect(originOf('https://openlibrary.org/isbn/{isbn}.json')).toBe(
			'https://openlibrary.org',
		)
		expect(originOf('nonsense')).toBeNull()
	})
})

describe('the secret scan', () => {
	it('catches credential formats by shape', () => {
		expect(looksLikeSecret('Bearer abc123')).toMatch(/Bearer/)
		expect(looksLikeSecret('sk-abcdefghijklmnopqrstuvwx')).toMatch(/OpenAI/)
		expect(looksLikeSecret('AKIAIOSFODNN7EXAMPLE')).toMatch(/AWS/)
		expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----')).toMatch(
			/private key/,
		)
	})

	it('catches an unenumerated format by entropy', () => {
		expect(looksLikeSecret('aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z')).toMatch(
			/high-entropy/,
		)
	})

	it('leaves ordinary strings alone — a check people route around is worse than none', () => {
		for (const ok of [
			'application/json',
			'this-is-a-long-but-perfectly-ordinary-slug-name-for-a-thing',
			'2026-07-28T00:00:00.000Z',
			'{isbn}',
		])
			expect(looksLikeSecret(ok), ok).toBeNull()
	})

	it('ignores placeholders, which are field names and not values', () => {
		expect(looksLikeSecret('https://x.example.com/{isbn}/{title}')).toBeNull()
	})

	it('redacts enough to identify and not enough to use', () => {
		const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123'
		const shown = redact(secret)
		expect(shown).not.toContain(secret)
		expect(shown).toContain('34 chars')
		expect(redact('short')).toBe('***')
	})
})

describe('prose', () => {
	const source = {
		id: 'src-isbn',
		key: 'isbn.lookup',
		description: 'ISBN lookup',
		mode: 'enrich',
		entityId: 'e-book',
		request: { url: 'https://openlibrary.org/isbn/{isbn}.json' },
		auth: { kind: 'none' },
		mapping: [],
		limits: {
			requestsPerMinute: 60,
			timeoutMs: 5000,
			maxAttempts: 3,
			backoffMs: 1000,
		},
		triggers: [{ kind: 'create' }, { kind: 'manual' }],
		declaredAt: '2026-07-28',
	} as unknown as SourceSpec

	it('renders a source as one reviewable line', () => {
		expect(describeSource(source)).toBe(
			'enrich from https://openlibrary.org (on create, on demand)',
		)
	})

	it('never renders a credential, because there is not one to render', () => {
		expect(
			describeAuth({ kind: 'bearer', secretName: 'OPENLIBRARY_TOKEN' }),
		).toBe('bearer token from secret OPENLIBRARY_TOKEN')
		expect(describeTrigger({ kind: 'schedule', scheduleKey: 'nightly' })).toBe(
			'on schedule "nightly"',
		)
	})

	it('collects the placeholders a request resolves from the row', () => {
		expect(
			requestPlaceholders({
				url: 'https://x.example.com/{isbn}',
				query: { lang: '{locale}', fixed: 'en' },
			}),
		).toEqual(['isbn', 'locale'])
	})
})
