/**
 * `GET /sitemaps/:page` — one page of a paginated sitemap.
 *
 * Only reachable once the URL count passes {@link SITEMAP_PAGE_SIZE}; below that
 * `/sitemap.xml` is a single `<urlset>` and nothing links here. A page number
 * outside the range is a 404 rather than an empty document, for
 * `sitemap.xml`'s reason: an empty `<urlset>` claims "nothing here", which is a
 * different statement from "there is no such page".
 */

import { renderUrlset, SITEMAP_PAGE_SIZE, sitemapPageCount } from '~/sitemap'
import { collectSitemap } from '~/sitemap.server'
import type { Route } from './+types/sitemaps.$page'

export async function loader({ request, params }: Route.LoaderArgs) {
	const data = await collectSitemap(request)
	if (!data) throw new Response('Not found', { status: 404 })

	const page = Number(params.page)
	if (!Number.isInteger(page) || page < 1)
		throw new Response('Not found', { status: 404 })
	if (page > sitemapPageCount(data.entries.length))
		throw new Response('Not found', { status: 404 })

	const slice = data.entries.slice(
		(page - 1) * SITEMAP_PAGE_SIZE,
		page * SITEMAP_PAGE_SIZE,
	)
	return new Response(renderUrlset(slice), {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': 'public, max-age=3600',
		},
	})
}
