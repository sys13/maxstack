/**
 * `GET /sitemap.xml` — every URL the declared public portals make reachable.
 *
 * **404 when no site is declared**, rather than an empty `<urlset>`. An empty
 * sitemap and a missing sitemap look identical to a person and mean opposite
 * things: the first says "this app has nothing public", the second says "this
 * app has not claimed a public identity". Only the second is true here, and
 * `robots.txt` says so too by omitting its `Sitemap:` line.
 *
 * Past the protocol's 50,000-URL ceiling this becomes a `<sitemapindex>`
 * pointing at `/sitemaps/:page`.
 */

import {
	renderSitemapIndex,
	renderUrlset,
	SITEMAP_PAGE_SIZE,
	sitemapPageCount,
} from '~/sitemap'
import { collectSitemap } from '~/sitemap.server'
import type { Route } from './+types/sitemap.xml'

const XML = {
	'Content-Type': 'application/xml; charset=utf-8',
	'Cache-Control': 'public, max-age=3600',
}

export async function loader({ request }: Route.LoaderArgs) {
	const data = await collectSitemap(request)
	if (!data) throw new Response('Not found', { status: 404 })

	// Nothing is dropped silently. A truncated sitemap that reads as complete is
	// the failure this repo has already shipped once (#367–#371), so every drop
	// is named in the log with its portal and its count.
	for (const drop of data.dropped)
		console.warn(
			`[sitemap] dropped ${drop.count} URL(s) from portal "${drop.portalKey}": ${drop.reason}`,
		)

	const pages = sitemapPageCount(data.entries.length)
	const body =
		data.entries.length > SITEMAP_PAGE_SIZE
			? renderSitemapIndex(data.site, pages)
			: renderUrlset(data.entries)
	return new Response(body, { headers: XML })
}
