/**
 * `GET /robots.txt` — the crawl rule, derived from the portal declarations.
 *
 * A resource route with no component: the response is the file. Registered as a
 * static segment above the project catch-all in `app/routes.ts`, for the reason
 * `documents`, `imports` and `p` are static — a project page named `robots.txt`
 * would otherwise shadow it.
 *
 * Everything about *what* it says lives in `sitemap.server.ts`, including why
 * `Allow` is per portal key rather than a `/p/` prefix.
 */

import { robotsTxt } from '~/sitemap.server'

export async function loader() {
	return new Response(await robotsTxt(), {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			// Crawlers re-fetch this often and it changes only when a portal
			// declaration does. An hour is short enough that pausing a portal takes
			// effect on a human timescale.
			'Cache-Control': 'public, max-age=3600',
		},
	})
}
