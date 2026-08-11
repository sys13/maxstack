/**
 * The server wiring for `robots.txt` and `sitemap.xml`: the real registry,
 * the real portal identity, the real `opList`.
 *
 * The selection rule and both documents live in `sitemap.ts` with no IO, so
 * they can be driven against a real store in a test without a platform boot.
 * Nothing here decides what is listed.
 */

import { opList, type PortalPlan } from '@maxstack/core'
import type { SiteSpec } from '@maxstack/spec'
import { portalRequest } from './portals.server'
import { loadSite } from './seo.server'
import { buildSitemap, renderRobots, type SitemapResult } from './sitemap'
import { getSprout } from './sprout.server'

/** Every declared portal plan, across every resource. */
async function allPlans(): Promise<PortalPlan[]> {
	const { registry } = await getSprout()
	return registry.all().flatMap((entry) => entry.config.portals ?? [])
}

export interface SitemapData extends SitemapResult {
	site: SiteSpec
}

/**
 * The sitemap for this request, or `null` when no site is declared — there is
 * no origin to build an absolute `<loc>` against, and a sitemap of relative
 * URLs is not a sitemap.
 */
export async function collectSitemap(
	request: Request,
): Promise<SitemapData | null> {
	const site = await loadSite()
	if (!site) return null
	const plans = await allPlans()
	const result = await buildSitemap(site, {
		plans,
		// The portal's own identity, from the same call `/p/:key` makes — so the
		// forced bound, the tenant scope and the soft-delete scope all apply here
		// exactly as they do to a visitor. This is what makes it impossible for
		// the sitemap to list a row the portal would 404 on.
		listRows: async (plan, limit) => {
			const portal = await portalRequest(request, plan.key)
			if (!portal) throw new Error('the portal did not resolve to an identity')
			return (await opList(portal.ctx, plan.resource, { limit })) as Record<
				string,
				unknown
			>[]
		},
	})
	return { site, ...result }
}

/** `robots.txt` for this deployment. */
export async function robotsTxt(): Promise<string> {
	const site = await loadSite()
	// The plans are still needed with no site — `renderRobots` ignores them and
	// disallows everything, and reading them anyway keeps the two branches from
	// depending on load order.
	return renderRobots(site, site ? await allPlans() : [])
}
