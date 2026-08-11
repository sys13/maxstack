/**
 * The sitemap is the access rule, read back (#431).
 *
 * The claim this file has to pin is that **the sitemap cannot list a row the
 * portal would 404 on**. So the rows here do not come from a stub: the test
 * grounds a real spec, registers it, materializes a real pglite database, builds
 * the portal's own identity with `portalIdentity`, and reads through the
 * ordinary `opList` — the same call `/p/:key` makes. If the declared bound ever
 * stops being forced, the sitemap grows URLs and this goes red.
 *
 * The audience exclusions are asserted the same way round. A `token` portal URL
 * in a sitemap is a credential leak, so "it does not appear" is worth a test
 * that would notice a refactor putting it back.
 */

import {
	createSpecDb,
	opCreate,
	opList,
	type PortalPlan,
	portalIdentity,
	ResourceRegistry,
	registerSpecEntities,
} from '@maxstack/core'
import {
	applyOp,
	newSpecSystem,
	type PortalSpec,
	type SiteSpec,
	type SpecOp,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import {
	buildSitemap,
	crawlablePortalKeys,
	indexablePortals,
	renderRobots,
	renderSitemapIndex,
	renderUrlset,
	SITEMAP_PAGE_SIZE,
	sitemapPageCount,
	xmlEscape,
} from './sitemap'
import { groundedEntityShapes } from './spec-sprout'

const meta = (n: number) => ({
	id: `op-${n}` as const,
	origin: 'human' as const,
	appliedAt: '2026-08-10' as const,
	actor: { surface: 'harness' as const },
})

const site: SiteSpec = { domain: 'https://example.com', name: 'Taskly' }

const provenance = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}

function baseSpec(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-post',
					name: 'Post',
					description: 'A piece of writing.',
					fields: [
						{ id: 'fld-title', name: 'title', type: 'string', required: true },
						{
							id: 'fld-published',
							name: 'published',
							type: 'boolean',
							required: false,
						},
						{
							id: 'fld-notes',
							name: 'internalNotes',
							type: 'string',
							required: false,
						},
					],
				},
			},
		} as SpecOp,
		meta(1),
	)
}

const ARCHIVE: PortalSpec = {
	id: 'ptl-archive',
	key: 'archive',
	description: 'The public archive of published posts.',
	entityId: 'e-post',
	audience: 'public',
	scope: 'collection',
	readFields: ['fld-title'],
	filter: { fieldId: 'fld-published', equals: true },
	writes: [],
	layout: 'feed',
	paused: false,
	declaredAt: '2026-08-10',
	provenance,
}

function specWith(...portals: PortalSpec[]): SpecSystem {
	let spec = baseSpec()
	portals.forEach((portal, i) => {
		spec = applyOp(
			spec,
			{ op: 'portals.declare', args: { portal } } as SpecOp,
			meta(i + 2),
		)
	})
	return spec
}

/** Ground, register, materialize — and seed five posts, two of them published. */
async function runtimeFor(spec: SpecSystem) {
	const shapes = groundedEntityShapes(spec)
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, shapes)
	const { store } = await createSpecDb(registry, shapes)
	const root = { registry, store, user: null }
	const seeded: { title: string; published: boolean }[] = [
		{ title: 'Cooking rice', published: true },
		{ title: 'Draft one', published: false },
		{ title: 'Shipping it', published: true },
		{ title: 'Draft two', published: false },
		{ title: 'Draft three', published: false },
	]
	for (const row of seeded)
		await opCreate(root, 'post', { ...row, internalNotes: 'never public' })
	// Non-vacuity: an ordinary caller genuinely sees all five.
	expect(await opList(root, 'post')).toHaveLength(5)
	return { registry, store, shapes }
}

/** Build the sitemap through the portal's OWN identity and the ordinary ops. */
async function sitemapFor(spec: SpecSystem) {
	const { registry, store } = await runtimeFor(spec)
	const plans = registry.all().flatMap((e) => e.config.portals ?? [])
	return buildSitemap(site, {
		plans,
		listRows: async (plan: PortalPlan, limit: number) => {
			const user = portalIdentity(plan, { clientId: 'crawler' })
			if (!user) throw new Error('no identity')
			return (await opList({ registry, store, user }, plan.resource, {
				limit,
			})) as Record<string, unknown>[]
		},
	})
}

describe('the sitemap lists exactly what the portal admits', () => {
	it('contains only the rows the declared filter lets through — 2 of 5', async () => {
		// THE assertion of #431. Five rows exist; the bound admits two; the sitemap
		// has two row URLs and no others.
		const { entries, dropped } = await sitemapFor(specWith(ARCHIVE))
		const rowUrls = entries
			.map((e) => e.loc)
			.filter((loc) => /\/p\/archive\/.+/.test(loc))
		expect(rowUrls).toHaveLength(2)
		expect(dropped).toEqual([])
	})

	it('lists the collection URL and the home page, both absolute', async () => {
		const { entries } = await sitemapFor(specWith(ARCHIVE))
		const locs = entries.map((e) => e.loc)
		expect(locs).toContain('https://example.com/')
		expect(locs).toContain('https://example.com/p/archive')
		for (const loc of locs)
			expect(loc.startsWith('https://example.com/')).toBe(true)
	})

	it('emits no lastmod when the portal does not expose updatedAt', async () => {
		// The projection is an allowlist; `lastmod` is a hint. A hint is not worth
		// reaching behind a boundary for.
		const { entries } = await sitemapFor(specWith(ARCHIVE))
		expect(entries.every((e) => e.lastmod === undefined)).toBe(true)
	})
})

describe('the audiences that never appear', () => {
	it('a token portal contributes nothing — its URL is a credential', async () => {
		const token: PortalSpec = {
			...ARCHIVE,
			id: 'ptl-client',
			key: 'client',
			audience: 'token',
			scope: 'row',
			token: { ttlHours: 24, maxUses: null },
			filter: undefined,
			// A row-scoped portal renders one row, so the spec requires `detail`.
			layout: 'detail',
		}
		const { entries } = await sitemapFor(specWith(ARCHIVE, token))
		expect(entries.some((e) => e.loc.includes('/p/client'))).toBe(false)
	})

	it('a role portal contributes nothing — a crawler has no session', async () => {
		const role: PortalSpec = {
			...ARCHIVE,
			id: 'ptl-support',
			key: 'support',
			audience: 'role',
			role: 'support',
		}
		const { entries } = await sitemapFor(specWith(ARCHIVE, role))
		expect(entries.some((e) => e.loc.includes('/p/support'))).toBe(false)
	})

	it('a paused portal contributes nothing — pausing must un-advertise it', async () => {
		const paused: PortalSpec = {
			...ARCHIVE,
			id: 'ptl-old',
			key: 'old',
			paused: true,
		}
		const { entries } = await sitemapFor(specWith(ARCHIVE, paused))
		expect(entries.some((e) => e.loc.includes('/p/old'))).toBe(false)
	})

	it('selects by naming `public`, so a new audience is excluded by default', () => {
		const plans = [
			{ key: 'a', audience: 'public', paused: false, scope: 'collection' },
			{ key: 'b', audience: 'future', paused: false, scope: 'collection' },
		] as unknown as PortalPlan[]
		expect(indexablePortals(plans).map((p) => p.key)).toEqual(['a'])
	})
})

describe('robots.txt', () => {
	const plans = [
		{ key: 'archive', audience: 'public', paused: false, scope: 'collection' },
		{ key: 'client', audience: 'token', paused: false, scope: 'row' },
		{ key: 'old', audience: 'public', paused: true, scope: 'collection' },
	] as unknown as PortalPlan[]

	it('allows each public portal by key and never the /p/ prefix', () => {
		// A prefix allow would invite a crawler into the token portals that share
		// it — the one mistake in this file that leaks a credential.
		const txt = renderRobots(site, plans)
		expect(txt).toContain('Allow: /p/archive')
		expect(txt).not.toContain('Allow: /p/\n')
		expect(txt).not.toContain('Allow: /p/client')
		expect(txt).not.toContain('Allow: /p/old')
	})

	it('disallows everything else and names the sitemap', () => {
		const txt = renderRobots(site, plans)
		expect(txt).toContain('Disallow: /')
		expect(txt).toContain('Sitemap: https://example.com/sitemap.xml')
	})

	it('with no site: Disallow / and no Sitemap line at all', () => {
		const txt = renderRobots(undefined, plans)
		expect(txt).toBe('User-agent: *\nDisallow: /\n')
		expect(txt).not.toContain('Sitemap:')
		expect(txt).not.toContain('Allow:')
	})

	it('lists a public row portal, which has no collection but is crawlable', () => {
		expect(crawlablePortalKeys(plans)).toEqual(['archive'])
	})
})

describe('the documents', () => {
	it('escapes XML text, so an ampersand is not a parse error', () => {
		expect(xmlEscape('a&b<c>')).toBe('a&amp;b&lt;c&gt;')
		const xml = renderUrlset([{ loc: 'https://example.com/p/a?x=1&y=2' }])
		expect(xml).toContain('<loc>https://example.com/p/a?x=1&amp;y=2</loc>')
	})

	it('emits lastmod only when it is there', () => {
		const xml = renderUrlset([
			{ loc: 'https://example.com/a', lastmod: '2026-08-10T00:00:00.000Z' },
			{ loc: 'https://example.com/b' },
		])
		expect(xml.match(/<lastmod>/g)).toHaveLength(1)
	})

	it('paginates into an index past the per-file ceiling', () => {
		expect(sitemapPageCount(0)).toBe(1)
		expect(sitemapPageCount(SITEMAP_PAGE_SIZE)).toBe(1)
		expect(sitemapPageCount(SITEMAP_PAGE_SIZE + 1)).toBe(2)
		const index = renderSitemapIndex(site, 2)
		expect(index).toContain('<loc>https://example.com/sitemaps/1</loc>')
		expect(index).toContain('<loc>https://example.com/sitemaps/2</loc>')
	})
})

describe('nothing is dropped silently', () => {
	it('records a portal whose listing throws, rather than swallowing it', async () => {
		const plans = [
			{
				key: 'archive',
				audience: 'public',
				paused: false,
				scope: 'collection',
				resource: 'post',
			},
		] as unknown as PortalPlan[]
		const { entries, dropped } = await buildSitemap(site, {
			plans,
			listRows: async () => {
				throw new Error('store is down')
			},
		})
		// The collection URL still stands; the rows are accounted for in writing.
		expect(entries.map((e) => e.loc)).toContain('https://example.com/p/archive')
		expect(dropped).toEqual([
			{
				portalKey: 'archive',
				reason: 'listing failed: store is down',
				count: 1,
			},
		])
	})
})
