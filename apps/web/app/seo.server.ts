/**
 * The server half of the site identity: reading the declared
 * {@link SiteSpec} out of the spec so a loader can hand it to the pure
 * `pageMeta` in `seo.ts`.
 *
 * Split from `seo.ts` because a route's `meta` export runs on the client too —
 * see that file's header. Nothing here may be imported from a `meta` export.
 */

import type { SiteSpec } from '@maxstack/spec'
import { isProjectMode } from './project.server'
import { getPlatform } from './sprout.server'

/**
 * The declared site, or `undefined` when this spec has never declared one.
 *
 * Never throws. A spec that cannot be loaded is treated exactly as a spec with
 * no site: the app renders with no canonical and `noindex`, which is the same
 * answer absence gives and is a strictly safe direction to fail in. The
 * alternative — letting this reject — would take down the page over a tag.
 */
export async function loadSite(): Promise<SiteSpec | undefined> {
	// In demo mode there is no project spec to read an identity out of, and the
	// generic admin it serves instead is not a public surface by any reading.
	if (!isProjectMode()) return undefined
	try {
		const spec = await getPlatform().spec.load()
		return spec.site
	} catch {
		return undefined
	}
}
