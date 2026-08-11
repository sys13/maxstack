/**
 * Head tags derived from the declared site identity — one helper, so
 * every public route in the app emits the same set and no route emits a
 * hand-rolled one.
 *
 * ## Why this file is not `seo.server.ts`
 *
 * Issue #430 asked for `seo.server.ts`. It cannot be: React Router calls a
 * route's `meta` export on the **client** during navigation as well as on the
 * server during SSR, and Vite strips a `.server` module out of the client
 * bundle. A `pageMeta` living in `seo.server.ts` would render correctly on a
 * cold load and throw on every client-side navigation into the same route —
 * which is the failure mode that only shows up after the tests pass.
 *
 * Everything here is therefore pure: it takes a {@link SiteSpec} and a
 * description of the page and returns descriptors. Loading the site from the
 * spec *is* server work, and that half lives in `seo.server.ts`.
 *
 * ## Default deny
 *
 * {@link NOINDEX_META} is exported as root's `meta`, so the 60-odd routes that
 * export none inherit it and emit `noindex`. React Router resolves an absent
 * `meta` export by walking up to the nearest ancestor that has one, so this is
 * mechanical rather than a rule somebody has to remember on every new route:
 * a route is indexable only if it says so.
 *
 * That is the same posture `portals.ts` takes toward reachability, and for the
 * same reason. The admin, the workbench, `/settings`, `/billing`, `/jobs` and
 * every API route are not things anybody means to have indexed, and the cost of
 * the two defaults is asymmetric — a public page nobody indexed is a bug
 * somebody notices in a week, while an indexed `/settings` is a leak that
 * outlives the fix by however long the cache does.
 *
 * ## With no site declared
 *
 * No canonical, no OG, no cards, `noindex` everywhere. Absence still means
 * nothing is public, exactly as it does in `site.ts` — and a canonical is a
 * claim about an origin, so a spec that has not named one has nothing true to
 * say here.
 */

import {
	META_DESCRIPTION_MAX,
	META_TITLE_MAX,
	type SiteSpec,
	siteUrl,
} from '@maxstack/spec'

/** What React Router accepts back from a `meta` export. Narrowed to the three
 * shapes this helper actually emits, so a typo is a type error. */
export type MetaDescriptor =
	| { title: string }
	| { name: string; content: string }
	| { property: string; content: string }
	| { tagName: 'link'; rel: string; href: string }

/**
 * The robots directive for everything that is not a declared public surface.
 *
 * `nofollow` rides along with `noindex` deliberately: these are authenticated
 * app surfaces whose links point at more authenticated app surfaces, and a
 * crawler that indexes none of them but follows all of them still spends a
 * budget walking a login wall.
 */
export const NOINDEX = 'noindex, nofollow'

/** Root's `meta`, and therefore the default for every route in the app that
 * does not override it. */
export const NOINDEX_META: MetaDescriptor[] = [
	{ name: 'robots', content: NOINDEX },
]

/** What a public route tells {@link pageMeta} about itself. */
export interface PageMetaInput {
	/**
	 * The page's own title, *without* the site name — the suffix is composed
	 * here so the separator and the length budget are decided in one place.
	 */
	title?: string
	/** The page's own description. Emitted verbatim; never fabricated. */
	description?: string
	/**
	 * The route's own path, rooted (`/p/posts`). The canonical is this resolved
	 * against the declared domain, so it must be the path the page is *served*
	 * at rather than the one it was linked from — a canonical that names a
	 * different URL than the page it is on is a redirect instruction.
	 */
	path: string
	/** Card image: absolute URL or rooted path. Falls back to the site's. */
	image?: string
	/** Force `noindex` on a route that is otherwise public-shaped. */
	noindex?: boolean
}

/**
 * Compose the `<title>`.
 *
 * When the page title plus the site name would exceed {@link META_TITLE_MAX},
 * **the brand suffix is dropped rather than the title truncated.** The specific
 * half is the half that distinguishes this page from every other one in the
 * app, and it sits at the front; truncating the composed string would cut the
 * brand off mid-word and leave the reader with neither. If the page title alone
 * is still over the bound it is emitted as-is, because silently shortening it
 * would hide from the gate the fact that somebody declared a title too long to
 * show.
 */
export function composeTitle(
	title: string | undefined,
	site: SiteSpec | undefined,
): string {
	const own = title?.trim()
	if (!site) return own ?? ''
	if (!own || own === site.name) return site.name
	const composed = `${own} · ${site.name}`
	return composed.length <= META_TITLE_MAX ? composed : own
}

/**
 * Clamp a description to {@link META_DESCRIPTION_MAX}, at a word boundary.
 *
 * Truncating here is the opposite call from {@link composeTitle}, and the
 * asymmetry is deliberate. A title's specific half sits at the *front* and is
 * ruined by a cut; a description is prose whose tail is the least load-bearing
 * part, and every search engine truncates it anyway — so doing it here means the
 * emitted tag says what the renderer intended rather than whatever the crawler's
 * own cut left behind.
 *
 * The lower bound is deliberately *not* enforced by padding. A short description
 * stays short and the gate reports the route by name, because the fix is to
 * write a better sentence and no code can do that.
 */
export function clampDescription(text: string): string {
	if (text.length <= META_DESCRIPTION_MAX) return text
	const cut = text.slice(0, META_DESCRIPTION_MAX - 1)
	const boundary = cut.lastIndexOf(' ')
	return `${(boundary > 40 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}

/**
 * Every head tag for one page.
 *
 * The ordering is fixed (title, description, robots, canonical, OG, Twitter) so
 * that two pages' emitted heads diff as a diff of their *content* rather than
 * of the order this function happened to build them in — the same reason
 * `portalExposureReport` sorts.
 */
export function pageMeta(
	input: PageMetaInput,
	site: SiteSpec | undefined,
): MetaDescriptor[] {
	const title = composeTitle(input.title, site)
	const tags: MetaDescriptor[] = []
	if (title) tags.push({ title })

	// With no declared identity there is no origin to build a canonical against
	// and nothing true to put in a card, so the page says only what it is and
	// that it should not be indexed.
	if (!site) {
		if (input.description)
			tags.push({ name: 'description', content: input.description })
		tags.push({ name: 'robots', content: NOINDEX })
		return tags
	}

	// Never invented. A page with nothing to say about itself emits no
	// description and the gate reports that, rather than a generated sentence
	// passing a length check while meaning nothing.
	const raw = input.description ?? site.description
	const description = raw ? clampDescription(raw) : undefined
	if (description) tags.push({ name: 'description', content: description })

	if (input.noindex) {
		// No canonical and no card on a noindex page. A canonical would be a claim
		// about a page we have just asked not to be indexed, and keeping the two
		// mutually exclusive is what makes "noindex ⇒ absent from the sitemap"
		// checkable by looking at one tag.
		tags.push({ name: 'robots', content: NOINDEX })
		return tags
	}

	const canonical = siteUrl(site, input.path)
	tags.push({ tagName: 'link', rel: 'canonical', href: canonical })

	const image = input.image ?? site.defaultOgImage
	const imageUrl = image ? siteUrl(site, image) : undefined

	tags.push({ property: 'og:type', content: 'website' })
	tags.push({ property: 'og:site_name', content: site.name })
	tags.push({ property: 'og:url', content: canonical })
	if (title) tags.push({ property: 'og:title', content: title })
	if (description)
		tags.push({ property: 'og:description', content: description })
	if (imageUrl) tags.push({ property: 'og:image', content: imageUrl })

	// `summary_large_image` only when there is an image to be large. Declaring it
	// without one renders as a bare link, which is worse than the small card.
	tags.push({
		name: 'twitter:card',
		content: imageUrl ? 'summary_large_image' : 'summary',
	})
	if (site.social?.twitter)
		tags.push({ name: 'twitter:site', content: site.social.twitter })
	if (title) tags.push({ name: 'twitter:title', content: title })
	if (description)
		tags.push({ name: 'twitter:description', content: description })
	if (imageUrl) tags.push({ name: 'twitter:image', content: imageUrl })

	return tags
}

/**
 * A portal key as a page title — `client-invoices` becomes `Client invoices`.
 *
 * The key rather than the portal's `description` is the title, because a
 * description is a sentence explaining what the portal is *for* and a title is
 * a label. The description is a better meta description than it is a title, and
 * it is used as exactly that.
 */
export function humanizeKey(key: string): string {
	const words = key.replace(/[-_]+/g, ' ').trim()
	return words.charAt(0).toUpperCase() + words.slice(1)
}
