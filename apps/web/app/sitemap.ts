/**
 * `robots.txt` and `sitemap.xml`, derived from the portal declarations —
 * the selection rule and the two documents, with no IO.
 *
 * This is the highest-leverage piece of the SEO epic and it is almost entirely
 * a read of something already written. `PortalsSpec` declares exactly which rows
 * are reachable without a session and under what bound. That *is* the sitemap,
 * in a form that cannot drift from the access rule — **because it is the access
 * rule**. The rows come from `opList` under the portal's own identity, the same
 * call `/p/:key` makes, so the sitemap cannot list a row the portal would 404
 * on. Deriving them from the declarations instead would be a second
 * implementation of the bound, and two implementations of an exposure boundary
 * is one more than is safe (`portalExposureReport` makes the same argument).
 *
 * The row read is injected ({@link SitemapSource}) rather than reached for, so
 * the selection rule can be driven against a real registry and a real store in
 * a test without booting the platform. `sitemap.server.ts` is the wiring.
 *
 * ## What never appears
 *
 * - **`token` portals.** A token portal URL in a sitemap is a credential leak:
 *   `portals.ts` establishes that a token is a credential minted for one
 *   recipient, and publishing one hands it to everybody.
 * - **`role` portals.** An ordinary signed-in session behind a role gate. A
 *   crawler has no session, so every entry would be a 404 that advertises the
 *   shape of an internal surface.
 * - **Paused portals.** `paused` is the flag somebody flips at 3am. It has to
 *   stop answering *and* stop being advertised.
 * - **`row`-scoped portals.** Reachable only with a token by construction, so
 *   there is nothing to list.
 *
 * Every one of those is a `public`-check plus a `paused`-check rather than a
 * denylist, so a portal audience added later is excluded until somebody decides
 * otherwise — default deny, on `seo.ts`'s terms.
 *
 * ## `lastmod` only when the portal exposes it
 *
 * Issue #431 asks for `lastmod` from `updatedAt`. A portal projection is an
 * allowlist: the runtime rebuilds each row from `readFields` plus the primary
 * key and drops every other column, so `updatedAt` is present **only if the
 * portal declared it**. It is left off otherwise rather than reached for behind
 * the projection's back — `lastmod` is a hint, the projection is a boundary, and
 * a hint is not worth crossing one for.
 */

import type { PortalPlan } from '@maxstack/core'
import { type SiteSpec, siteUrl } from '@maxstack/spec'

/**
 * The sitemap protocol's hard ceiling: 50,000 URLs per file. Past it a sitemap
 * is not "mostly read", it is rejected.
 */
export const SITEMAP_URL_LIMIT = 50_000

/** How many URLs go in one paginated child sitemap. */
export const SITEMAP_PAGE_SIZE = 10_000

/** One URL in the sitemap. */
export interface SitemapEntry {
	loc: string
	/** W3C date, omitted when the portal does not expose `updatedAt`. */
	lastmod?: string
}

/** Something that did not make it in. Never silent — see {@link buildSitemap}. */
export interface SitemapDrop {
	portalKey: string
	reason: string
	count: number
}

export interface SitemapResult {
	entries: SitemapEntry[]
	dropped: SitemapDrop[]
}

/** Where the rows come from. Injected so the rule is testable against a real
 * store without a platform boot. */
export interface SitemapSource {
	/** Every declared plan, in any order. Filtering is this module's job. */
	plans: readonly PortalPlan[]
	/** The portal's own `opList`, under the portal's own identity. */
	listRows: (
		plan: PortalPlan,
		limit: number,
	) => Promise<Record<string, unknown>[]>
}

/**
 * The portals whose *collections* are listed, in a deterministic order so two
 * runs diff as a diff of the data rather than of the iteration.
 */
export function indexablePortals(plans: readonly PortalPlan[]): PortalPlan[] {
	return plans
		.filter(
			(p) => p.audience === 'public' && !p.paused && p.scope === 'collection',
		)
		.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * The portal keys `robots.txt` allows. Wider than {@link indexablePortals} by
 * one case on purpose: a `row`-scoped public portal has no collection to list
 * but its row URLs are still legitimately crawlable if somebody links one.
 */
export function crawlablePortalKeys(plans: readonly PortalPlan[]): string[] {
	return plans
		.filter((p) => p.audience === 'public' && !p.paused)
		.map((p) => p.key)
		.sort()
}

/** `updatedAt` as a W3C date, or `undefined` if the portal did not expose it. */
export function lastmodOf(row: Record<string, unknown>): string | undefined {
	const value = row.updatedAt ?? row.updated_at
	if (value instanceof Date) return value.toISOString()
	if (typeof value === 'string') {
		const parsed = new Date(value)
		return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
	}
	return undefined
}

/**
 * Every URL the declared public portals make reachable, plus an explicit
 * account of anything left out.
 *
 * **Nothing is dropped silently.** Every cap, every failed portal read and every
 * truncation lands in {@link SitemapResult.dropped} and is logged by the route.
 * Silent truncation reads as "we indexed everything" when it did not, which is
 * the exact failure the docs-site link checker shipped (#367–#371).
 */
export async function buildSitemap(
	site: SiteSpec,
	source: SitemapSource,
): Promise<SitemapResult> {
	const entries: SitemapEntry[] = []
	const dropped: SitemapDrop[] = []

	// The home page, which is a public surface exactly when the app has an
	// identity to be public under.
	entries.push({ loc: siteUrl(site, '/') })

	for (const plan of indexablePortals(source.plans)) {
		entries.push({ loc: siteUrl(site, `/p/${plan.key}`) })

		// One over the budget, so hitting the cap is distinguishable from exactly
		// filling it.
		const budget = SITEMAP_URL_LIMIT - entries.length
		let rows: Record<string, unknown>[]
		try {
			rows = await source.listRows(plan, budget + 1)
		} catch (error) {
			// A portal that throws is a portal whose rows are unknown, not a portal
			// with none. Recorded rather than swallowed.
			dropped.push({
				portalKey: plan.key,
				reason: `listing failed: ${error instanceof Error ? error.message : String(error)}`,
				count: 1,
			})
			continue
		}

		if (rows.length > budget) {
			dropped.push({
				portalKey: plan.key,
				reason: `sitemap is at the ${SITEMAP_URL_LIMIT}-URL protocol limit`,
				count: rows.length - budget,
			})
			rows = rows.slice(0, budget)
		}

		for (const row of rows) {
			const id = row.id
			if (id === undefined || id === null) continue
			const lastmod = lastmodOf(row)
			entries.push({
				loc: siteUrl(site, `/p/${plan.key}/${String(id)}`),
				...(lastmod ? { lastmod } : {}),
			})
		}
	}

	return { entries, dropped }
}

/** XML text escaping. A `&` in a row id is not a parse error anybody should
 * have to debug out of a search console. */
export function xmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

/** A `<urlset>` document for one page of entries. */
export function renderUrlset(entries: readonly SitemapEntry[]): string {
	const urls = entries
		.map((entry) => {
			const lastmod = entry.lastmod
				? `\n\t\t<lastmod>${xmlEscape(entry.lastmod)}</lastmod>`
				: ''
			return `\t<url>\n\t\t<loc>${xmlEscape(entry.loc)}</loc>${lastmod}\n\t</url>`
		})
		.join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/** A `<sitemapindex>` document pointing at the paginated children. */
export function renderSitemapIndex(site: SiteSpec, pages: number): string {
	const items = Array.from(
		{ length: pages },
		(_, i) =>
			`\t<sitemap>\n\t\t<loc>${xmlEscape(siteUrl(site, `/sitemaps/${i + 1}`))}</loc>\n\t</sitemap>`,
	).join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`
}

/** How many paginated children a set of entries needs. */
export function sitemapPageCount(total: number): number {
	return Math.max(1, Math.ceil(total / SITEMAP_PAGE_SIZE))
}

/**
 * `robots.txt`.
 *
 * **`Allow` is per portal key, never `Allow: /p/`.** Token and role portals live
 * under the same `/p/` prefix as public ones, so a prefix allow would invite a
 * crawler into exactly the two audiences that must never be indexed. The
 * declaration is per-portal, so the rule is too.
 *
 * With no site declared the whole app is disallowed and there is no `Sitemap:`
 * line, because there is no origin to name one at. Absence still means nothing
 * is public.
 */
export function renderRobots(
	site: SiteSpec | undefined,
	plans: readonly PortalPlan[],
): string {
	const lines = ['User-agent: *']
	if (!site) {
		lines.push('Disallow: /')
		return `${lines.join('\n')}\n`
	}
	// `Disallow: /` first, then the narrower `Allow`s. Crawlers resolve a
	// conflict by the longest matching path rather than by order, so the
	// arrangement is for the human reading it.
	lines.push('Disallow: /')
	lines.push('Allow: /$')
	for (const key of crawlablePortalKeys(plans)) lines.push(`Allow: /p/${key}`)
	lines.push('')
	lines.push(`Sitemap: ${siteUrl(site, '/sitemap.xml')}`)
	return `${lines.join('\n')}\n`
}
