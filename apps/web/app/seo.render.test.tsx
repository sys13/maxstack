/**
 * @vitest-environment jsdom
 *
 * The head tags as a crawler receives them (#430).
 *
 * **Assertions read rendered HTML, not descriptor arrays.** Issue #430 is
 * explicit about this and the reason is the one that keeps biting this repo:
 * asserting the objects `pageMeta` returns tests `pageMeta`, and a helper that
 * returns a perfect canonical descriptor which no route ever renders is a green
 * test over a page with no canonical on it. So every assertion here runs the
 * descriptors through React Router's own `<Meta />` and greps the markup.
 *
 * What this file does *not* claim to cover, and where that coverage lives:
 *
 *  - It renders through `createRoutesStub` rather than the real route modules,
 *    because importing `routes/p.$key.tsx` pulls `~/portals.server` and boots
 *    pglite to assert a `<title>`. The route modules' own wiring — that the
 *    loader hands `meta` the right path, and that the served page really
 *    carries these tags — is checked against a **production build** by the
 *    validate gate in #432, which is the only place that can honestly claim it.
 *  - The source-level checks at the bottom pin the two facts a stub cannot: that
 *    root exports the default-deny `meta`, and that exactly three routes in the
 *    tree override it.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
	META_DESCRIPTION_MAX,
	META_TITLE_MAX,
	type SiteSpec,
} from '@maxstack/spec'
import { renderToString } from 'react-dom/server'
import { createRoutesStub, Meta } from 'react-router'
import { describe, expect, it } from 'vitest'
import {
	clampDescription,
	composeTitle,
	humanizeKey,
	NOINDEX,
	NOINDEX_META,
	type PageMetaInput,
	pageMeta,
} from './seo'

const site: SiteSpec = {
	domain: 'https://example.com',
	name: 'Taskly',
	description:
		'Taskly keeps a small team’s work in one list that everybody can actually see.',
	social: { twitter: '@taskly' },
	defaultOgImage: '/og.png',
}

/**
 * Render a route's `meta` through React Router's `<Meta />` and return the
 * emitted markup — the bytes, which is the only thing a crawler ever sees.
 */
function head(
	meta: () => ReturnType<typeof pageMeta>,
	{ withRoot = true }: { withRoot?: boolean } = {},
): string {
	const Stub = createRoutesStub([
		{
			path: '/',
			// Root's real default-deny export. A child that omits `meta` must
			// inherit this, which is the entire mechanism behind "noindex
			// everything else" — see the inheritance test below.
			...(withRoot ? { meta: () => NOINDEX_META } : {}),
			Component: () => <Meta />,
			children: [{ index: true, meta, Component: () => null }],
		},
	])
	return renderToString(<Stub initialEntries={['/']} />)
}

/** The head a route with NO `meta` export of its own emits. */
function inheritedHead(): string {
	const Stub = createRoutesStub([
		{
			path: '/',
			meta: () => NOINDEX_META,
			Component: () => <Meta />,
			children: [{ index: true, Component: () => null }],
		},
	])
	return renderToString(<Stub initialEntries={['/']} />)
}

const publicPage = (over: Partial<PageMetaInput> = {}) =>
	pageMeta(
		{
			title: 'Invoices',
			description:
				'Every invoice this workspace has issued, with its status and total.',
			path: '/p/invoices',
			...over,
		},
		site,
	)

describe('default deny', () => {
	it('emits noindex for a route that exports no meta at all', () => {
		// The mechanism the other 60-odd routes rely on. React Router resolves an
		// absent `meta` export by walking up to the nearest ancestor that has one,
		// so root's export reaches every route that does not override it. If this
		// ever stops being true, `/settings` and `/admin` become indexable
		// silently — which is why it is asserted on the markup rather than assumed
		// from the docs.
		expect(inheritedHead()).toContain(`content="${NOINDEX}"`)
	})

	it('noindex carries nofollow, so a crawler does not walk the login wall', () => {
		expect(NOINDEX).toBe('noindex, nofollow')
	})

	it('emits no canonical and no card on an inherited head', () => {
		const markup = inheritedHead()
		expect(markup).not.toContain('rel="canonical"')
		expect(markup).not.toContain('og:')
	})
})

describe('a public page with a declared site', () => {
	const markup = head(() => publicPage())

	it('emits exactly one title, and suffixes the site name', () => {
		expect(markup).toContain('<title>Invoices · Taskly</title>')
		expect(markup.match(/<title>/g)).toHaveLength(1)
	})

	it('emits an absolute canonical matching the route’s own URL', () => {
		expect(markup).toContain(
			'<link rel="canonical" href="https://example.com/p/invoices"/>',
		)
	})

	it('emits the description once, verbatim', () => {
		expect(markup).toContain(
			'name="description" content="Every invoice this workspace has issued, with its status and total."',
		)
	})

	it('emits an OG card with every URL absolute', () => {
		expect(markup).toContain(
			'property="og:url" content="https://example.com/p/invoices"',
		)
		expect(markup).toContain(
			'property="og:image" content="https://example.com/og.png"',
		)
		expect(markup).toContain('property="og:site_name" content="Taskly"')
		// No relative URL may survive into a card: a crawler resolves one against
		// whichever page it found the tag on.
		expect(markup).not.toMatch(/content="\/[^"]*"/)
	})

	it('emits a large-image twitter card and the site handle', () => {
		expect(markup).toContain(
			'name="twitter:card" content="summary_large_image"',
		)
		expect(markup).toContain('name="twitter:site" content="@taskly"')
	})

	it('does not emit robots at all — indexable is the absence of the tag', () => {
		expect(markup).not.toContain('name="robots"')
	})
})

describe('with no site declared', () => {
	const markup = head(() =>
		pageMeta(
			{ title: 'Invoices', description: 'Some invoices.', path: '/p/invoices' },
			undefined,
		),
	)

	it('emits noindex, and neither a canonical nor a card', () => {
		// Absence still means nothing is public. There is no origin to build a
		// canonical against, and a canonical is a claim about one.
		expect(markup).toContain(`content="${NOINDEX}"`)
		expect(markup).not.toContain('rel="canonical"')
		expect(markup).not.toContain('og:')
		expect(markup).not.toContain('twitter:')
	})

	it('still emits the page’s own title', () => {
		expect(markup).toContain('<title>Invoices</title>')
	})
})

describe('a noindex public-shaped page', () => {
	// A token or role portal renders exactly like a public one and must never be
	// indexed: a token portal's URL is a credential minted for one recipient.
	const markup = head(() => publicPage({ noindex: true }))

	it('emits noindex and drops the canonical and the card with it', () => {
		expect(markup).toContain(`content="${NOINDEX}"`)
		// Keeping the two mutually exclusive is what makes "noindex ⇒ absent from
		// the sitemap" checkable by looking at one tag.
		expect(markup).not.toContain('rel="canonical"')
		expect(markup).not.toContain('og:')
	})
})

describe('composeTitle', () => {
	it('drops the brand suffix rather than truncating the specific half', () => {
		const long = 'A portal title that is quite long indeed and keeps going on'
		const composed = composeTitle(long, site)
		expect(composed).toBe(long)
		// The specific half survives intact; the brand is what gives way.
		expect(composed).not.toContain('· Taskly')
	})

	it('keeps the suffix when it fits the budget', () => {
		expect(composeTitle('Invoices', site)).toBe('Invoices · Taskly')
		expect(composeTitle('Invoices', site).length).toBeLessThanOrEqual(
			META_TITLE_MAX,
		)
	})

	it('never repeats the site name on the home page', () => {
		expect(composeTitle(site.name, site)).toBe('Taskly')
		expect(composeTitle(undefined, site)).toBe('Taskly')
	})
})

describe('clampDescription', () => {
	it('truncates at a word boundary rather than mid-word', () => {
		const long = `${'word '.repeat(50)}end`
		const clamped = clampDescription(long)
		expect(clamped.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX)
		expect(clamped.endsWith('…')).toBe(true)
		expect(clamped).not.toMatch(/wor…$/)
	})

	it('leaves a description inside the bound completely alone', () => {
		const ok = 'A description comfortably inside the upper bound of the range.'
		expect(clampDescription(ok)).toBe(ok)
	})

	it('never pads a short one — the gate names the route instead', () => {
		// No code can write a better sentence, so a too-short description stays
		// too short and is reported rather than inflated past a length check.
		expect(clampDescription('Short.')).toBe('Short.')
	})

	it('clamps what pageMeta emits, so no page can exceed the bound', () => {
		const markup = head(() =>
			publicPage({ description: `${'word '.repeat(60)}end` }),
		)
		const emitted = markup.match(
			/name="description" content="([^"]*)"/,
		)?.[1] as string
		expect(emitted.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX)
	})
})

describe('humanizeKey', () => {
	it('turns a portal key into a label rather than a sentence', () => {
		expect(humanizeKey('client-invoices')).toBe('Client invoices')
		expect(humanizeKey('archive')).toBe('Archive')
	})
})

describe('the route tree’s indexing posture', () => {
	it('overrides root’s default-deny on exactly the public surfaces', async () => {
		// The list is the review artifact. A new `export const meta` anywhere else
		// in this tree fails here, which makes "we made a route indexable" a thing
		// somebody decided rather than a thing that happened.
		// Anchored on the vitest root rather than `import.meta.url`: this file runs
		// under jsdom, where `import.meta.url` is an http URL and `node:fs` refuses
		// it.
		const dir = join(process.cwd(), 'app', 'routes')
		const files = (await readdir(dir)).filter(
			(f) => /\.tsx?$/.test(f) && !f.includes('.test.'),
		)
		const overriding: string[] = []
		for (const file of files) {
			const src = await readFile(join(dir, file), 'utf8')
			if (/^export (function|const) meta\b/m.test(src)) overriding.push(file)
		}
		expect(overriding.sort()).toEqual([
			'home.tsx',
			'p.$key.$id.tsx',
			'p.$key.tsx',
		])
	})

	it('keeps the default-deny export on root', async () => {
		const src = await readFile(join(process.cwd(), 'app', 'root.tsx'), 'utf8')
		expect(src).toMatch(/^export const meta = \(\) => NOINDEX_META$/m)
	})
})
