import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import {
	describeSite,
	hasSiteIdentity,
	isLocalHostname,
	MAX_SITE_NAME_LENGTH,
	META_DESCRIPTION_MAX,
	META_DESCRIPTION_MIN,
	type SiteSpec,
	siteDomainErrors,
	siteErrors,
	siteImageErrors,
	siteUrl,
} from './site.ts'
import { type ApplyMeta, applyOp, type SpecOp, validateOp } from './spec-ops.ts'
import { collectSpecSystemErrors } from './spec-system.schema.ts'
import { newSpecSystem } from './spec-system.ts'

const meta: ApplyMeta = {
	actor: { surface: 'harness' },
	id: 'op-site',
	origin: 'human',
	appliedAt: '2026-08-10',
}

const valid: SiteSpec = {
	domain: 'https://example.com',
	name: 'Example',
}

const setOp = (site: unknown): SpecOp =>
	({ op: 'site.set', args: { site } }) as SpecOp

describe('site domain — the origin rule', () => {
	it('accepts a bare origin, with and without a port', () => {
		expect(siteDomainErrors('site', 'https://example.com')).toEqual([])
		expect(siteDomainErrors('site', 'https://app.example.co.uk')).toEqual([])
		expect(siteDomainErrors('site', 'https://example.com:8443')).toEqual([])
		// http is permitted: an intranet deployment is real, and a canonical is a
		// claim about where a page lives rather than a security boundary.
		expect(siteDomainErrors('site', 'http://intranet.corp')).toEqual([])
	})

	it('refuses a trailing slash, and says which string to write instead', () => {
		const [err] = siteDomainErrors('site', 'https://example.com/')
		expect(err).toContain('trailing slash')
		// The message has to carry the fix: every derived URL appends a rooted
		// path, so this exact mistake produces "//" on every page of the app.
		expect(err).toContain('https://example.com')
	})

	it('refuses a path, a query and a fragment', () => {
		expect(
			siteDomainErrors('site', 'https://example.com/app').join(),
		).toContain('has a path')
		expect(
			siteDomainErrors('site', 'https://example.com?a=1').join(),
		).toContain('query string')
		expect(siteDomainErrors('site', 'https://example.com#x').join()).toContain(
			'fragment',
		)
	})

	it('refuses a scheme-less host — the commonest way to get this wrong', () => {
		expect(siteDomainErrors('site', 'example.com').join()).toContain(
			'must include the scheme',
		)
	})

	it('refuses credentials, which must never reach a rendered page', () => {
		expect(
			siteDomainErrors('site', 'https://user:pw@example.com').join(),
		).toContain('credentials')
	})

	it('refuses a non-web scheme', () => {
		expect(siteDomainErrors('site', 'ftp://example.com').join()).toContain(
			'only https: and http:',
		)
	})

	it('refuses every local host, case-insensitively', () => {
		for (const domain of [
			'http://localhost',
			'http://localhost:3000',
			'http://LocalHost:3000',
			'http://127.0.0.1:5173',
			'http://0.0.0.0:8080',
			'http://app.localhost',
			'http://myapp.local',
			'http://myapp.test',
			'http://host.docker.internal:3000',
		])
			expect(siteDomainErrors('site', domain).join()).toContain('local host')
	})

	it('names the real cost of a localhost canonical in the message', () => {
		// Not "invalid domain". The reason is the whole point: this is the one
		// mistake that is worse than leaving the tag off entirely.
		const err = siteDomainErrors('site', 'http://localhost:3000').join()
		expect(err).toContain('cannot reach')
		expect(err).toContain('Declare no site at all for local development')
	})

	it('classifies hostnames directly, for callers that already parsed a URL', () => {
		expect(isLocalHostname('LOCALHOST')).toBe(true)
		expect(isLocalHostname('foo.local')).toBe(true)
		expect(isLocalHostname('example.com')).toBe(false)
		// A host that merely *contains* a refused name is not refused: the rule is
		// exact-match or suffix, so a real product called "localhost-tools.com"
		// is not collateral damage.
		expect(isLocalHostname('localhost-tools.com')).toBe(false)
	})

	it('refuses an absent domain and explains why there is no default', () => {
		expect(siteDomainErrors('site', undefined).join()).toContain(
			'there is no default',
		)
		expect(siteDomainErrors('site', '').join()).toContain('required')
		expect(siteDomainErrors('site', ' https://example.com ').join()).toContain(
			'whitespace',
		)
	})
})

describe('site declaration', () => {
	it('accepts a minimal declaration — domain and name', () => {
		expect(siteErrors('site', valid)).toEqual([])
	})

	it('requires a name and bounds it against the title budget', () => {
		expect(siteErrors('site', { domain: valid.domain }).join()).toContain(
			'name is required',
		)
		const long = 'x'.repeat(MAX_SITE_NAME_LENGTH + 1)
		expect(siteErrors('site', { ...valid, name: long }).join()).toContain(
			`over the ${MAX_SITE_NAME_LENGTH} maximum`,
		)
	})

	it('bounds the description at BOTH ends, because it is emitted verbatim', () => {
		const short = 'Too short.'
		const long = 'x'.repeat(META_DESCRIPTION_MAX + 1)
		expect(
			siteErrors('site', { ...valid, description: short }).join(),
		).toContain(`${META_DESCRIPTION_MIN}–${META_DESCRIPTION_MAX}`)
		expect(
			siteErrors('site', { ...valid, description: long }).join(),
		).toContain(`${META_DESCRIPTION_MIN}–${META_DESCRIPTION_MAX}`)
		const ok =
			'A description that is comfortably inside both of the bounds set.'
		expect(siteErrors('site', { ...valid, description: ok })).toEqual([])
	})

	it('refuses a relative OG image and accepts a rooted path or absolute URL', () => {
		expect(siteImageErrors('og', 'og.png').join()).toContain(
			'resolved against whichever page',
		)
		expect(siteImageErrors('og', '/og.png')).toEqual([])
		expect(siteImageErrors('og', 'https://cdn.example.com/og.png')).toEqual([])
	})

	it('wants a twitter handle, not a profile URL', () => {
		expect(
			siteErrors('site', {
				...valid,
				social: { twitter: 'https://x.com/example' },
			}).join(),
		).toContain('is not a handle')
		expect(
			siteErrors('site', { ...valid, social: { twitter: '@example' } }),
		).toEqual([])
	})

	it('collects every problem in one pass rather than throwing on the first', () => {
		const errors = siteErrors('site', {
			domain: 'http://localhost/',
			name: '',
			description: 'short',
		})
		expect(errors.length).toBeGreaterThan(2)
	})
})

describe('siteUrl', () => {
	it('joins the origin and a path with exactly one separator', () => {
		expect(siteUrl(valid, '/about')).toBe('https://example.com/about')
		expect(siteUrl(valid, 'about')).toBe('https://example.com/about')
		expect(siteUrl(valid, '/')).toBe('https://example.com/')
	})

	it('strips a trailing slash from a derived path, so one page has one URL', () => {
		// Two URLs for one page is precisely what a canonical exists to prevent.
		expect(siteUrl(valid, '/p/posts/')).toBe('https://example.com/p/posts')
	})

	it('leaves an already-absolute URL alone, so a CDN image survives', () => {
		expect(siteUrl(valid, 'https://cdn.example.com/og.png')).toBe(
			'https://cdn.example.com/og.png',
		)
	})
})

describe('site.set — the op', () => {
	it('refuses a bad domain at op time', () => {
		const errors = validateOp(
			newSpecSystem(tasklyPRD),
			setOp({ domain: 'https://example.com/', name: 'Example' }),
		)
		expect(errors.join()).toContain('trailing slash')
	})

	it('refuses localhost at op time — there is no spelling of it', () => {
		const errors = validateOp(
			newSpecSystem(tasklyPRD),
			setOp({ domain: 'http://localhost:3000', name: 'Dev' }),
		)
		expect(errors.join()).toContain('local host')
	})

	it('refuses an unknown key rather than silently dropping it', () => {
		// Last-wins makes a typo doubly costly: `ogImage` is dropped on write AND
		// clears whatever `defaultOgImage` held.
		const errors = validateOp(
			newSpecSystem(tasklyPRD),
			setOp({ ...valid, ogImage: '/og.png' }),
		)
		expect(errors.join()).toContain('unknown site key "ogImage"')
	})

	it('applies onto the spec and leaves an auditable op-log entry', () => {
		const s = applyOp(newSpecSystem(tasklyPRD), setOp(valid), meta)
		expect(s.site).toEqual(valid)
		expect(hasSiteIdentity(s)).toBe(true)
		const logged = s.opLog.at(-1)
		expect(logged?.diff.op).toBe('site.set')
		expect(logged?.diff.summary).toContain('https://example.com')
	})

	it('leaves a fresh spec with no identity at all', () => {
		const s = newSpecSystem(tasklyPRD)
		expect(hasSiteIdentity(s)).toBe(false)
		expect(s.site).toBeUndefined()
	})
})

describe('a hand-edited site.json', () => {
	it('is caught by the aggregate validator, not only by the op', () => {
		// The op path is not the only way a spec arrives. A directory somebody
		// edited by hand is the shape that must never load with a localhost
		// canonical in it.
		const s = newSpecSystem(tasklyPRD)
		s.site = { domain: 'http://localhost:3000', name: 'Dev' }
		expect(collectSpecSystemErrors(s).join()).toContain('local host')
	})

	it('adds no errors when the layer is simply absent', () => {
		expect(collectSpecSystemErrors(newSpecSystem(tasklyPRD))).toEqual([])
	})
})

describe('describeSite', () => {
	it('leads with the domain, the fact every derived URL depends on', () => {
		expect(describeSite(valid)).toBe('"Example" at https://example.com')
		expect(describeSite({ ...valid, defaultOgImage: '/og.png' })).toContain(
			'with OG image',
		)
	})
})
