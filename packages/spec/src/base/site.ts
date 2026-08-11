/**
 * The site identity layer — the app's **public identity**: the origin it is
 * served from, the name it calls itself, and the defaults every derived
 * `<head>` falls back to.
 *
 * This layer exists because every downstream derivation needs an absolute
 * origin and there was nowhere to put one. A canonical URL, an OG image URL and
 * a sitemap entry are all `domain` + path; without a declared `domain` each of
 * those is either absent or a guess, and a guessed canonical is worse than no
 * canonical — it tells a crawler the real page lives somewhere it does not.
 *
 * ## What this layer deliberately is not
 *
 * **Not a page model.** There is no `pages` key here and that is not an
 * oversight. This layer emits metadata for routes that *already exist*; the
 * question of declaring new marketing pages is a separate one and is not
 * answered by anything in this file.
 *
 * **Not deploy configuration.** {@link SiteSpec.domain} is the origin the app
 * claims as its public identity, not the host it is served from and not an
 * instruction to anybody's DNS, TLS or load balancer. The two are usually equal
 * and are allowed to differ: an app behind a proxy under a vanity domain has one
 * public identity and several serving hosts, and only the first belongs in a
 * spec.
 *
 * **Not a serializer or a theme.** Nothing here describes how a value is
 * formatted or what anything looks like; that is the field's declared type and
 * `theme.set`, as everywhere else.
 *
 * **Not an access rule.** Declaring a site does not make one row reachable that
 * was not reachable before. `portals.json` is the only thing in this system that
 * says what the outside can see, and this layer cannot widen it — the sitemap
 * derived downstream is a *view* of the portal declarations, so it can only ever
 * list what the access rule already admits.
 *
 * ## The refusals
 *
 * 1. **There is no default domain.** Absence means the app has no public
 *    identity, which is the correct default rather than a convenient one. A
 *    default here would put a canonical tag naming somebody else's origin on
 *    every page of every project that never asked for one.
 * 2. **`localhost` is refused.** A canonical pointing at localhost is worse than
 *    no canonical: it tells a crawler the real page lives on a host it cannot
 *    reach, and unlike a missing tag it will not be re-derived when the app
 *    ships. See {@link LOCAL_HOST_REFUSAL} for why this is unconditional here
 *    rather than gated on a dev flag.
 * 3. **The domain is an origin, not a URL.** Scheme and host only — no path, no
 *    trailing slash, no query, no fragment, no credentials. A bad domain here
 *    produces a bad canonical on *every page in the app*, so this is the
 *    cheapest possible place to refuse it, and the only place where refusing it
 *    costs one error message instead of a re-crawl.
 *
 * ## Where the bounds live
 *
 * {@link META_TITLE_MAX}, {@link META_DESCRIPTION_MIN} and
 * {@link META_DESCRIPTION_MAX} are declared here rather than beside the code
 * that derives head tags or the gate that checks them. Three copies of "160" in
 * three packages is three chances for the deriver and its gate to disagree, and
 * a gate that disagrees with its deriver is either a false green or a permanent
 * red. One constant, imported by both, cannot drift.
 */

import type { SpecSystem } from './spec-system.ts'

// ===========================================================================
// The declaration
// ===========================================================================

/**
 * Social handles, used only to fill the card attributions a crawler reads
 * (`twitter:site` and friends). Every one is optional and an absent handle
 * simply omits its tag — there is no placeholder, because a card attributing a
 * page to an account that does not exist is worse than an unattributed card.
 *
 * These are **handles, not URLs**. A handle is the thing a person types and the
 * thing the meta tag wants; deriving the profile URL from it is the renderer's
 * job and is one concatenation, whereas recovering the handle from an arbitrary
 * profile URL is parsing somebody else's routing scheme.
 */
export interface SiteSocial {
	/** `@handle` — emitted as `twitter:site`. */
	twitter?: string
	/** `owner` or `owner/repo`. */
	github?: string
	/** `@user@instance.tld`. */
	mastodon?: string
	/** `company/name` or `in/name`. */
	linkedin?: string
}

/**
 * The app's public identity. **Deliberately not `Provenanced`**, on
 * `ThemeSpec`'s terms: it is whole-document last-wins state rather than a
 * reviewable row, and the audit trail is the `site.set` entry in the op log
 * (origin + timestamp + diff), same as any op.
 *
 * Whole-document last-wins also means every optional key is cleared by a
 * `site.set` that omits it. That is the right shape for an identity — "the
 * site's description is now this" is a complete statement, and a merge would
 * make removing a stale tagline unspellable.
 */
export interface SiteSpec {
	/**
	 * The origin every derived absolute URL is built against —
	 * `https://example.com`, scheme and host (and port, if not the default), with
	 * **no path and no trailing slash**. Validated at op time by
	 * {@link siteDomainErrors}.
	 */
	domain: string
	/**
	 * What the app calls itself. Appears as the site name in OG cards and as the
	 * suffix of every derived page title, so it is the string that shows up in a
	 * search result next to somebody's brand.
	 */
	name: string
	/** A short phrase, used where a name alone is too bare to be a title. */
	tagline?: string
	/**
	 * The fallback meta description for a public route that declares none.
	 * Bounded by {@link META_DESCRIPTION_MIN}/{@link META_DESCRIPTION_MAX}
	 * because it is emitted verbatim as a page's description, and a fallback that
	 * would fail the gate on the page that uses it is a fallback that has to be
	 * fixed at every call site instead of here.
	 */
	description?: string
	social?: SiteSocial
	/**
	 * The card image a public route falls back to when it declares none. Either
	 * an absolute `https://` URL or a root-relative path (`/og.png`) resolved
	 * against {@link SiteSpec.domain}.
	 *
	 * Root-relative is the common and better spelling: it keeps the image on the
	 * same origin as the page, so moving the app to a new domain moves its cards
	 * with it rather than leaving them pointing at the old one.
	 */
	defaultOgImage?: string
}

// ===========================================================================
// Shapes and bounds
// ===========================================================================

/**
 * The longest title a derived page may emit. Sixty is where mainstream search
 * results truncate; a title that gets cut off mid-word is a title whose most
 * specific half — the end — is the half nobody sees.
 */
export const META_TITLE_MAX = 60

/**
 * The bounds on a derived meta description. Under fifty characters a
 * description is not a sentence and gets discarded in favour of scraped body
 * text; over a hundred and sixty it is truncated.
 *
 * Both halves are enforced, and the lower bound is the one that matters more
 * here: a too-long description still describes the page, while a three-word one
 * means the page ships whatever a crawler happened to scrape.
 */
export const META_DESCRIPTION_MIN = 50
/** @see META_DESCRIPTION_MIN */
export const META_DESCRIPTION_MAX = 160

/** How long a site name may be. Long enough for a real product name, short
 * enough that appending it to a title cannot alone blow {@link META_TITLE_MAX}. */
export const MAX_SITE_NAME_LENGTH = 40

/** How long a tagline may be — a phrase, not a paragraph. */
export const MAX_SITE_TAGLINE_LENGTH = 80

/** How long the declared domain string may be. */
export const MAX_SITE_DOMAIN_LENGTH = 253

/** The only schemes a public identity may use. `http:` is permitted because an
 * intranet deployment is real, and refused for nothing else — a canonical is a
 * claim about where a page lives, not a security boundary. */
export const SITE_SCHEMES: readonly string[] = ['https:', 'http:']

/**
 * Hosts that are never a public identity, and the reason the refusal is
 * unconditional rather than gated on a dev flag.
 *
 * The spec package is pure by construction: nothing in it reads `NODE_ENV`, a
 * clock or the filesystem, because generation must be deterministic (§L4A — the
 * same rule that keeps `flags.ts` from letting generation read a flag's value).
 * So "is this a dev spec?" is a question this layer *cannot* ask without
 * breaking the invariant that makes the whole system reproducible.
 *
 * Given that, the honest design is to refuse outright: there is no spelling of
 * a localhost domain through `site.set`. Local development does not need one —
 * with no `SiteSpec` declared there is no canonical and no OG, which is exactly
 * the correct behaviour for an app running on a laptop, and strictly better than
 * one claiming `http://localhost:3000` as its identity in a file that gets
 * committed.
 */
export const LOCAL_HOST_REFUSAL: readonly string[] = [
	'localhost',
	'127.0.0.1',
	'0.0.0.0',
	'::1',
	'[::1]',
	'host.docker.internal',
]

/** Host suffixes that are never a public identity, for the same reason as
 * {@link LOCAL_HOST_REFUSAL} — these are reserved for local and test names. */
export const LOCAL_HOST_SUFFIX_REFUSAL: readonly string[] = [
	'.localhost',
	'.local',
	'.test',
	'.invalid',
	'.example',
]

/** A twitter/X handle: `@` plus the characters the platform actually allows. */
export const TWITTER_HANDLE_RE = /^@[A-Za-z0-9_]{1,15}$/

// ===========================================================================
// Validating the origin
// ===========================================================================

/** Whether a hostname is one of the local/reserved names that can never be a
 * public identity. Lowercased before comparison — `LocalHost` is `localhost`. */
export function isLocalHostname(hostname: string): boolean {
	const host = hostname.toLowerCase()
	return (
		LOCAL_HOST_REFUSAL.includes(host) ||
		LOCAL_HOST_SUFFIX_REFUSAL.some((suffix) => host.endsWith(suffix))
	)
}

/**
 * Everything wrong with a declared domain.
 *
 * Every message says what was wrong *and* what the right shape is, because this
 * is the field somebody types once and then does not look at again for a year —
 * an error that only says "invalid domain" costs a round trip to find out that
 * the trailing slash was the problem.
 */
export function siteDomainErrors(ctx: string, domain: unknown): string[] {
	if (typeof domain !== 'string' || domain.trim().length === 0)
		return [
			`${ctx}: domain is required and must be a non-empty string like "https://example.com" — there is no default, because a defaulted domain would put a canonical naming somebody else's origin on every page of this app`,
		]
	if (domain !== domain.trim())
		return [`${ctx}: domain "${domain}" has leading or trailing whitespace`]
	if (domain.length > MAX_SITE_DOMAIN_LENGTH)
		return [
			`${ctx}: domain is ${domain.length} characters, over the ${MAX_SITE_DOMAIN_LENGTH} maximum`,
		]

	let url: URL
	try {
		url = new URL(domain)
	} catch {
		return [
			`${ctx}: domain "${domain}" is not a URL — it must include the scheme, as in "https://example.com"`,
		]
	}

	const errors: string[] = []
	if (!SITE_SCHEMES.includes(url.protocol))
		errors.push(
			`${ctx}: domain "${domain}" uses scheme "${url.protocol}" — only ${SITE_SCHEMES.join(' and ')} are a public identity`,
		)
	if (url.hostname.length === 0)
		errors.push(`${ctx}: domain "${domain}" has no host`)
	else if (isLocalHostname(url.hostname))
		errors.push(
			`${ctx}: domain "${domain}" is a local host. A canonical pointing at ${url.hostname} is worse than no canonical — it tells a crawler the real page lives on a host it cannot reach. Declare no site at all for local development: absent means no canonical and no OG, which is the correct answer for an app running on a laptop`,
		)
	if (url.username.length > 0 || url.password.length > 0)
		errors.push(
			`${ctx}: domain "${domain}" carries credentials — a public identity is a host, and a URL with a password in it must never be emitted into a page`,
		)
	if (url.search.length > 0)
		errors.push(`${ctx}: domain "${domain}" has a query string; origin only`)
	if (url.hash.length > 0)
		errors.push(`${ctx}: domain "${domain}" has a fragment; origin only`)
	// `new URL('https://example.com')` normalizes pathname to '/', so the only
	// way to tell "no path" from "a trailing slash" is to re-read the input.
	if (url.pathname !== '/')
		errors.push(
			`${ctx}: domain "${domain}" has a path ("${url.pathname}") — declare the origin only, as in "${url.origin}". Paths belong to the routes derived against it`,
		)
	else if (domain.endsWith('/'))
		errors.push(
			`${ctx}: domain "${domain}" has a trailing slash — declare "${url.origin}". Every URL derived from this is built by appending a rooted path, so a trailing slash here produces "//" on every page`,
		)
	return errors
}

/**
 * Everything wrong with a whole site declaration. Returns `[]` for a valid one.
 *
 * Shaped as a collect-all rather than a throw-on-first so a person fixing a
 * hand-edited `site.json` sees every problem in one pass — the same posture
 * `portalErrors` and `liveSubscriptionErrors` take.
 */
export function siteErrors(ctx: string, site: unknown): string[] {
	if (site === null || typeof site !== 'object')
		return [`${ctx}: site must be an object`]
	const s = site as Partial<SiteSpec>
	const errors: string[] = [...siteDomainErrors(ctx, s.domain)]

	if (typeof s.name !== 'string' || s.name.trim().length === 0)
		errors.push(
			`${ctx}: name is required and must be a non-empty string — it is the site name in every OG card and the suffix of every derived title`,
		)
	else if (s.name.length > MAX_SITE_NAME_LENGTH)
		errors.push(
			`${ctx}: name is ${s.name.length} characters, over the ${MAX_SITE_NAME_LENGTH} maximum — it is appended to every page title, which is bounded at ${META_TITLE_MAX}`,
		)

	if (s.tagline !== undefined) {
		if (typeof s.tagline !== 'string' || s.tagline.trim().length === 0)
			errors.push(`${ctx}: tagline must be a non-empty string when present`)
		else if (s.tagline.length > MAX_SITE_TAGLINE_LENGTH)
			errors.push(
				`${ctx}: tagline is ${s.tagline.length} characters, over the ${MAX_SITE_TAGLINE_LENGTH} maximum — a tagline is a phrase, not a paragraph`,
			)
	}

	if (s.description !== undefined) {
		if (typeof s.description !== 'string')
			errors.push(`${ctx}: description must be a string when present`)
		else if (
			s.description.length < META_DESCRIPTION_MIN ||
			s.description.length > META_DESCRIPTION_MAX
		)
			errors.push(
				`${ctx}: description is ${s.description.length} characters; it must be ${META_DESCRIPTION_MIN}–${META_DESCRIPTION_MAX}. This string is emitted verbatim as the meta description of every public route that declares none, so a value outside the bound fails on the pages that use it rather than here`,
			)
	}

	if (s.defaultOgImage !== undefined)
		errors.push(...siteImageErrors(`${ctx}: defaultOgImage`, s.defaultOgImage))

	if (s.social !== undefined) {
		if (s.social === null || typeof s.social !== 'object')
			errors.push(`${ctx}: social must be an object when present`)
		else {
			const social = s.social as SiteSocial
			for (const [key, value] of Object.entries(social))
				if (value !== undefined && typeof value !== 'string')
					errors.push(`${ctx}: social.${key} must be a string`)
			if (
				typeof social.twitter === 'string' &&
				!TWITTER_HANDLE_RE.test(social.twitter)
			)
				errors.push(
					`${ctx}: social.twitter "${social.twitter}" is not a handle — it must look like "@example". This is emitted as twitter:site, which wants the handle rather than a profile URL`,
				)
		}
	}

	return errors
}

/** Everything wrong with a declared image reference — absolute `http(s)` URL or
 * a rooted path. A bare relative path is refused because it has no meaning in a
 * card: a crawler resolves it against whatever page it found the tag on. */
export function siteImageErrors(ctx: string, image: unknown): string[] {
	if (typeof image !== 'string' || image.trim().length === 0)
		return [`${ctx} must be a non-empty string`]
	if (image.startsWith('/')) return []
	if (/^https?:\/\//.test(image)) {
		try {
			new URL(image)
			return []
		} catch {
			return [`${ctx} "${image}" is not a valid URL`]
		}
	}
	return [
		`${ctx} "${image}" must be an absolute https URL or a rooted path like "/og.png" — a relative path in a card is resolved against whichever page a crawler found it on, so it names a different image per page`,
	]
}

// ===========================================================================
// Reading the layer
// ===========================================================================

/**
 * The declared site, or `undefined` for a spec that has never declared one.
 *
 * **There is deliberately no `resolveSite` with a default**, unlike
 * `resolveTheme`. A missing theme has an obviously correct fallback (zinc, which
 * looks like something); a missing identity does not, and every caller has to
 * handle absence explicitly because the correct behaviour without one — emit no
 * canonical, no OG, and `noindex` — is a decision rather than a degradation.
 */
export function findSite(spec: Pick<SpecSystem, 'site'>): SiteSpec | undefined {
	return spec.site
}

/** Whether this spec claims a public identity at all. */
export function hasSiteIdentity(spec: Pick<SpecSystem, 'site'>): boolean {
	return spec.site !== undefined
}

/**
 * An absolute URL for a rooted path against a declared site.
 *
 * Every derived canonical, OG image and sitemap entry goes through here rather
 * than concatenating, so the one place that could produce `//` or drop a segment
 * is the one place that is tested. A path that is not rooted is rooted; a
 * path that is already absolute is returned untouched, because a declared OG
 * image may legitimately live on a CDN.
 */
export function siteUrl(site: SiteSpec, path: string): string {
	if (/^https?:\/\//.test(path)) return path
	const rooted = path.startsWith('/') ? path : `/${path}`
	// The domain is validated to carry no path, so this is concatenation with a
	// guaranteed-single separator rather than URL resolution.
	return `${site.domain}${rooted === '/' ? '/' : rooted.replace(/\/+$/, '')}`
}

/**
 * The description a page falls back to — the site's, else its tagline, else
 * `undefined`. Never a fabricated sentence: a page with nothing to say about
 * itself emits no description, and the gate reports that rather than a
 * generated string passing a length check while meaning nothing.
 */
export function siteFallbackDescription(site: SiteSpec): string | undefined {
	if (site.description !== undefined) return site.description
	return undefined
}

/**
 * One line of prose for the workbench, the validate table and a diff summary.
 * It leads with the domain because that is the fact every derived URL depends
 * on and the one somebody is checking when they read this line at all.
 */
export function describeSite(site: SiteSpec): string {
	const extras: string[] = []
	if (site.description !== undefined) extras.push('description')
	if (site.defaultOgImage !== undefined) extras.push('OG image')
	if (site.social !== undefined) extras.push('social')
	const suffix = extras.length > 0 ? `, with ${extras.join(' + ')}` : ''
	return `"${site.name}" at ${site.domain}${suffix}`
}
