/**
 * The SEO gate: parse the **served head**, never the declaration (#432).
 *
 * Everything else in this epic is derivation, and derivation rots quietly. This
 * repo's own history is the argument: the docs-site link checker discarded every
 * fragment while printing "all links resolve" (#367–#371), and three internal
 * governance ratchets were silently disarmed by the repo split and stayed green
 * for weeks. **A gate that reads the declaration and reports green is the
 * failure mode, not the fix.**
 *
 * So this boots the real thing and reads bytes:
 *
 *   1. Materialize a fixture project — a site, a public collection portal whose
 *      bound admits some rows and not others, a token portal, and a paused one.
 *   2. `react-router build` and serve the **production build**. Not `pnpm dev`:
 *      dev cannot hydrate project routes (#171), so a dev-server gate would be
 *      checking a different app than the one that ships.
 *   3. Seed rows over the REST surface, so the sitemap has something to be wrong
 *      about.
 *   4. Fetch every public route and parse the emitted `<head>`.
 *
 * ## What it asserts
 *
 * Per public route: exactly one non-empty `<title>`, unique app-wide, within the
 * title budget; a description within its bounds, unique app-wide; exactly one
 * `<h1>`; a canonical that is absolute and names the route's own URL; and no
 * `Set-Cookie` on the response. App-wide: nothing is both `noindex` and present
 * in `sitemap.xml`; every internal link resolves **including its fragment**; and
 * `robots.txt` disallows every route that is not a declared public surface.
 *
 * ## `ok: true` only when nothing went unchecked
 *
 * Every assertion is registered before it runs. A check that could not run —
 * because a page 500'd, because the fixture produced no rows, because the build
 * did not start — is a **failure**, not a silent pass. An unrunnable check is
 * not a pass, and a gate that quietly checks nothing is the thing this file
 * exists to prevent.
 *
 * ## What it does and does not cover
 *
 * It checks the *platform's derivation* against a fixture project, not a
 * customer's content. That is deliberate and it is the durable half: whether a
 * given app's descriptions are good prose is a judgement, whereas whether
 * `pageMeta` still emits a canonical after somebody refactors `seo.ts` is a
 * fact, and it is the fact that rots.
 *
 *   pnpm --filter @maxstack/web run check:seo
 *   pnpm --filter @maxstack/web run check:seo -- --skip-build --timings
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	applyOp,
	encodeSpecSystem,
	META_DESCRIPTION_MAX,
	META_DESCRIPTION_MIN,
	META_TITLE_MAX,
	newSpecSystem,
	type SpecOp,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(webDir, '..', '..')
const PORT = Number(process.env.SEO_GATE_PORT ?? 4177)
const BASE = `http://127.0.0.1:${PORT}`
const DOMAIN = 'https://seo-gate.example.com'

const c = {
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	dim: '\x1b[2m',
	reset: '\x1b[0m',
}

// ===========================================================================
// The check ledger — registered before run, so "did not run" is a failure
// ===========================================================================

type Status = 'pass' | 'fail' | 'unrun'
interface Check {
	route: string
	assertion: string
	status: Status
	detail?: string
}

const checks: Check[] = []

/** Whatever the server said for itself. Printed only when something failed. */
const serverLog: string[] = []

/** Register a check as unrun. Nothing may pass without having been declared. */
function declare(route: string, assertion: string): Check {
	const check: Check = { route, assertion, status: 'unrun' }
	checks.push(check)
	return check
}

function settle(check: Check, ok: boolean, detail?: string): void {
	check.status = ok ? 'pass' : 'fail'
	if (!ok && detail) check.detail = detail
}

/** Run an assertion that was already declared. */
function assert(
	route: string,
	assertion: string,
	ok: boolean,
	detail?: string,
): void {
	settle(declare(route, assertion), ok, detail)
}

// ===========================================================================
// The fixture project
// ===========================================================================

const meta = (n: number) => ({
	id: `op-${n}` as const,
	origin: 'human' as const,
	appliedAt: '2026-08-10' as const,
	// `harness`, and stamped with this path's registry id, on `web-demo-seed`'s
	// reasoning: a fixture the gate invented must never read as somebody's real
	// work, and an op that leaks out of here has to be findable by name.
	actor: { surface: 'harness' as const, path: 'seo-gate-fixture' },
})

const provenance = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}

/** A spec with one entity and three portals: public, token, paused.
 *
 * Exported for `app/seo-gate.write-path.invariant.test.ts`, which asserts this
 * path stamps `harness` and never reaches the project store. */
export function fixtureSpec(): SpecSystem {
	const ops: SpecOp[] = [
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
		},
		{
			op: 'site.set',
			args: {
				site: {
					domain: DOMAIN,
					name: 'SEO Gate',
					description:
						'A fixture project whose only job is to be crawled by the validate gate.',
					defaultOgImage: '/og.png',
				},
			},
		},
		{
			op: 'portals.declare',
			args: {
				portal: {
					id: 'ptl-archive',
					key: 'archive',
					// Deliberately inside the description bounds: this string is what
					// the derived meta description is, so it is the fixture's job to be
					// a legal one.
					description:
						'The public archive of every post this fixture project has published so far.',
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
				},
			},
		},
		{
			op: 'portals.declare',
			args: {
				portal: {
					id: 'ptl-client',
					key: 'client',
					description:
						'A token portal, which must never appear in the sitemap or robots.',
					entityId: 'e-post',
					audience: 'token',
					scope: 'row',
					token: { ttlHours: 24, maxUses: null },
					readFields: ['fld-title'],
					writes: [],
					layout: 'detail',
					paused: false,
					declaredAt: '2026-08-10',
					provenance,
				},
			},
		},
		{
			op: 'portals.declare',
			args: {
				portal: {
					id: 'ptl-old',
					key: 'old',
					description:
						'A paused portal, which must be neither reachable nor advertised.',
					entityId: 'e-post',
					audience: 'public',
					scope: 'collection',
					readFields: ['fld-title'],
					filter: { fieldId: 'fld-published', equals: true },
					writes: [],
					layout: 'feed',
					paused: true,
					declaredAt: '2026-08-10',
					provenance,
				},
			},
		},
	]
	let spec = newSpecSystem(tasklyPRD)
	ops.forEach((op, i) => {
		spec = applyOp(spec, op, meta(i + 1))
	})
	return spec
}

export async function writeFixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'maxstack-seo-gate-'))
	const specDir = join(dir, 'spec')
	await mkdir(specDir, { recursive: true })
	const encoded = encodeSpecSystem(fixtureSpec())
	for (const [name, contents] of Object.entries(encoded))
		await writeFile(join(specDir, name), contents, 'utf8')
	return dir
}

// ===========================================================================
// Build + serve
// ===========================================================================

function run(
	cmd: string,
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd ?? root,
			env: { ...process.env, ...opts.env },
			stdio: 'inherit',
			shell: true,
		})
		child.on('close', (code) => resolve(code ?? 1))
		child.on('error', () => resolve(1))
	})
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/health`)
			if (res.ok) return true
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 300))
	}
	return false
}

// ===========================================================================
// Head parsing
// ===========================================================================

/**
 * Focused extraction rather than a DOM parse. The markup under test is our own
 * server render, so the shapes are known; pulling in a parser to read six tags
 * would be a dependency in the gate that guards the dependency-free app.
 */
function headOf(html: string) {
	const titles = [...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map(
		(m) => (m[1] ?? '').trim(),
	)
	const metaTag = (name: string): string | undefined => {
		const re = new RegExp(
			`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`,
			'i',
		)
		const tag = html.match(re)?.[0]
		return tag?.match(/content=["']([\s\S]*?)["']/i)?.[1]
	}
	const canonical = html
		.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]
		?.match(/href=["']([^"']+)["']/i)?.[1]
	const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
		(m[1] ?? '').replace(/<[^>]+>/g, '').trim(),
	)
	const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)].map(
		(m) => m[1] ?? '',
	)
	const ids = new Set(
		[...html.matchAll(/\sid=["']([^"']+)["']/gi)].map((m) => m[1] ?? ''),
	)
	return {
		titles,
		title: titles[0],
		description: metaTag('description'),
		robots: metaTag('robots'),
		canonical,
		h1s,
		links,
		ids,
	}
}

/** Whether a robots.txt body disallows a path, longest-match-wins. */
function robotsDisallows(body: string, path: string): boolean {
	let bestAllow = -1
	let bestDisallow = -1
	for (const raw of body.split('\n')) {
		const line = raw.trim()
		const allow = line.match(/^Allow:\s*(\S+)$/i)?.[1]
		const disallow = line.match(/^Disallow:\s*(\S+)$/i)?.[1]
		const match = (rule: string) => {
			// `$` anchors the end of the path, which is how `Allow: /$` means "the
			// home page only" rather than "everything".
			if (rule.endsWith('$')) return path === rule.slice(0, -1)
			return path.startsWith(rule)
		}
		if (allow && match(allow)) bestAllow = Math.max(bestAllow, allow.length)
		if (disallow && match(disallow))
			bestDisallow = Math.max(bestDisallow, disallow.length)
	}
	return bestDisallow > bestAllow
}

// ===========================================================================
// The gate
// ===========================================================================

/** Routes that are not declared public surfaces and must be disallowed. */
const PRIVATE_ROUTES = [
	'/admin',
	'/workbench',
	'/settings',
	'/billing',
	'/jobs',
	'/team',
	'/api-keys',
	'/notifications',
	'/api/post',
	'/mcp',
	'/p/client',
	'/p/old',
]

interface Fetched {
	path: string
	status: number
	html: string
	setCookie: string | null
}

async function gate(): Promise<void> {
	const timings: Record<string, number> = {}
	const t = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
		const start = Date.now()
		const value = await fn()
		timings[label] = Date.now() - start
		return value
	}

	const projectDir = await writeFixture()
	let server: ReturnType<typeof spawn> | undefined

	try {
		if (!process.argv.includes('--skip-build')) {
			const code = await t('build', () =>
				run('pnpm', ['--filter', '@maxstack/web', 'build']),
			)
			if (code !== 0) {
				assert(
					'(build)',
					'the production build succeeds',
					false,
					`exit ${code}`,
				)
				return
			}
		}

		const booted = await t('boot', async () => {
			server = spawn('pnpm', ['start'], {
				cwd: webDir,
				env: {
					...process.env,
					PORT: String(PORT),
					MAXSTACK_DATA_DIR: projectDir,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: true,
			})
			// Captured rather than discarded: a 500 whose cause is not in the report
			// makes the gate say "this route is broken" and nothing else, which is a
			// bad enough report to send somebody to `pnpm dev` — the server this
			// gate exists to avoid trusting.
			server.stdout?.on('data', (b) => serverLog.push(String(b)))
			server.stderr?.on('data', (b) => serverLog.push(String(b)))
			return waitForHealth(90_000)
		})
		assert('(server)', 'the production build boots and reports healthy', booted)
		if (!booted) return

		// --- seed, so the sitemap has rows to be wrong about --------------------
		const seeded = await t('seed', async () => {
			const rows = [
				{ title: 'Cooking rice', published: true, internalNotes: 'private' },
				{ title: 'Shipping it', published: true, internalNotes: 'private' },
				{ title: 'A draft', published: false, internalNotes: 'private' },
			]
			let created = 0
			for (const row of rows) {
				const res = await fetch(`${BASE}/api/post`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(row),
				})
				if (res.ok) created++
			}
			return created
		})
		assert(
			'(fixture)',
			'the fixture seeds rows, so the sitemap is non-vacuous',
			seeded === 3,
			`created ${seeded} of 3`,
		)

		// --- robots + sitemap ---------------------------------------------------
		const robots = await fetch(`${BASE}/robots.txt`)
		const robotsBody = await robots.text()
		assert('/robots.txt', 'is served', robots.ok, `status ${robots.status}`)
		assert(
			'/robots.txt',
			'names the sitemap at the declared domain',
			robotsBody.includes(`Sitemap: ${DOMAIN}/sitemap.xml`),
			robotsBody,
		)
		for (const path of PRIVATE_ROUTES)
			assert(
				'/robots.txt',
				`disallows "${path}", which is not a declared public surface`,
				robotsDisallows(robotsBody, path),
				robotsBody,
			)
		assert(
			'/robots.txt',
			'allows the declared public portal',
			!robotsDisallows(robotsBody, '/p/archive'),
			robotsBody,
		)

		const sitemapRes = await fetch(`${BASE}/sitemap.xml`)
		const sitemapBody = await sitemapRes.text()
		assert(
			'/sitemap.xml',
			'is served',
			sitemapRes.ok,
			`status ${sitemapRes.status}`,
		)
		const sitemapUrls = [...sitemapBody.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
			(m) => m[1] ?? '',
		)
		assert(
			'/sitemap.xml',
			'lists only the rows the portal bound admits (2 of 3)',
			sitemapUrls.filter((u) => /\/p\/archive\/.+/.test(u)).length === 2,
			sitemapUrls.join(' '),
		)
		assert(
			'/sitemap.xml',
			'never lists a token or paused portal',
			!sitemapUrls.some((u) => u.includes('/p/client') || u.includes('/p/old')),
			sitemapUrls.join(' '),
		)
		assert(
			'/sitemap.xml',
			'every entry is absolute against the declared domain',
			sitemapUrls.length > 0 && sitemapUrls.every((u) => u.startsWith(DOMAIN)),
			sitemapUrls.join(' '),
		)

		// --- the public pages ---------------------------------------------------
		const rowPaths = sitemapUrls
			.filter((u) => /\/p\/archive\/.+/.test(u))
			.map((u) => u.slice(DOMAIN.length))
		const publicPaths = ['/', '/p/archive', ...rowPaths]

		const pages: Fetched[] = await t('fetch-public', () =>
			Promise.all(
				publicPaths.map(async (path) => {
					const res = await fetch(`${BASE}${path}`, { redirect: 'manual' })
					return {
						path,
						status: res.status,
						html: await res.text(),
						setCookie: res.headers.get('set-cookie'),
					}
				}),
			),
		)

		const seenTitles = new Map<string, string>()
		const seenDescriptions = new Map<string, string>()

		for (const page of pages) {
			const route = page.path
			assert(
				route,
				'responds 200',
				page.status === 200,
				`status ${page.status}`,
			)
			if (page.status !== 200) continue
			const h = headOf(page.html)

			assert(
				route,
				'emits exactly one non-empty <title>',
				h.titles.length === 1 && (h.title ?? '').length > 0,
				`titles: ${JSON.stringify(h.titles)}`,
			)
			assert(
				route,
				`title is within the ${META_TITLE_MAX}-character budget`,
				(h.title ?? '').length <= META_TITLE_MAX,
				`${(h.title ?? '').length}: ${h.title}`,
			)
			const titleOwner = seenTitles.get(h.title ?? '')
			assert(
				route,
				'title is unique across public pages',
				titleOwner === undefined,
				`shared with ${titleOwner}`,
			)
			if (h.title) seenTitles.set(h.title, route)

			assert(
				route,
				`description is ${META_DESCRIPTION_MIN}–${META_DESCRIPTION_MAX} characters`,
				h.description !== undefined &&
					h.description.length >= META_DESCRIPTION_MIN &&
					h.description.length <= META_DESCRIPTION_MAX,
				`${h.description?.length ?? 'absent'}: ${h.description ?? ''}`,
			)
			const descOwner = seenDescriptions.get(h.description ?? '')
			assert(
				route,
				'description is unique across public pages',
				descOwner === undefined,
				`shared with ${descOwner}`,
			)
			if (h.description) seenDescriptions.set(h.description, route)

			assert(
				route,
				'emits exactly one <h1>',
				h.h1s.length === 1,
				`h1s: ${JSON.stringify(h.h1s)}`,
			)

			const expected = `${DOMAIN}${route === '/' ? '/' : route}`
			assert(
				route,
				'canonical is absolute and names this route’s own URL',
				h.canonical === expected,
				`got ${h.canonical ?? 'none'}, expected ${expected}`,
			)

			// A page in the sitemap must not also be asking not to be indexed.
			const inSitemap = sitemapUrls.includes(expected)
			assert(
				route,
				'is not both noindex and present in sitemap.xml',
				!(inSitemap && (h.robots ?? '').includes('noindex')),
				`robots=${h.robots ?? 'none'} inSitemap=${inSitemap}`,
			)

			// A public marketing or portal GET that sets a session cookie is a
			// cache-poisoning report waiting to happen.
			assert(
				route,
				'sets no cookie on a public GET',
				page.setCookie === null,
				page.setCookie ?? '',
			)
		}

		// --- internal links, fragments included ---------------------------------
		// The #367–#371 lesson: a link check that drops the fragment while printing
		// "all links resolve" is worse than no link check.
		const targets = new Map<string, Set<string>>()
		for (const page of pages)
			for (const href of headOf(page.html).links) {
				if (/^(?:[a-z]+:|\/\/|#|mailto:)/i.test(href)) continue
				const url = new URL(href, `${BASE}${page.path}`)
				if (url.origin !== BASE) continue
				const set = targets.get(url.pathname + url.search) ?? new Set()
				if (url.hash) set.add(url.hash.slice(1))
				targets.set(url.pathname + url.search, set)
			}

		const linkCheck = declare('(links)', 'every internal link resolves')
		const fragmentCheck = declare(
			'(links)',
			'every internal link’s fragment exists on its target',
		)
		const brokenLinks: string[] = []
		const brokenFragments: string[] = []
		await t('fetch-links', async () => {
			for (const [path, fragments] of targets) {
				const res = await fetch(`${BASE}${path}`, { redirect: 'manual' })
				if (res.status >= 400) {
					brokenLinks.push(`${path} → ${res.status}`)
					continue
				}
				if (fragments.size === 0) continue
				const ids = headOf(await res.text()).ids
				for (const fragment of fragments)
					if (!ids.has(fragment)) brokenFragments.push(`${path}#${fragment}`)
			}
		})
		settle(linkCheck, brokenLinks.length === 0, brokenLinks.join(', '))
		// Asserted even when there are no fragments to check — but recorded as
		// such, so "no fragments existed" never reads as "every fragment resolved".
		settle(
			fragmentCheck,
			brokenFragments.length === 0,
			brokenFragments.join(', '),
		)
	} finally {
		server?.kill()
		await rm(projectDir, { recursive: true, force: true })
	}

	report(timings)
}

function report(timings: Record<string, number>): void {
	const failed = checks.filter((ch) => ch.status === 'fail')
	const unrun = checks.filter((ch) => ch.status === 'unrun')

	for (const ch of failed)
		console.log(
			`${c.red}✗${c.reset} ${ch.route}: ${ch.assertion}\n  ${c.dim}${ch.detail ?? ''}${c.reset}`,
		)
	if (failed.length > 0 && serverLog.length > 0) {
		console.log(`${c.dim}--- server output (last 40 lines) ---${c.reset}`)
		console.log(serverLog.join('').trimEnd().split('\n').slice(-40).join('\n'))
		console.log('')
	}
	for (const ch of unrun)
		console.log(
			`${c.yellow}?${c.reset} ${ch.route}: ${ch.assertion} ${c.dim}(did not run)${c.reset}`,
		)

	console.log('')
	if (process.argv.includes('--timings') || process.env.CI)
		for (const [label, ms] of Object.entries(timings))
			console.log(`${c.dim}  ${label}: ${(ms / 1000).toFixed(1)}s${c.reset}`)

	// `ok: true` only when nothing went unchecked. An unrunnable check is not a
	// pass, so an empty ledger is a failure rather than a green run over nothing.
	const ok = failed.length === 0 && unrun.length === 0 && checks.length > 0
	console.log(
		ok
			? `${c.green}✓ seo: ${checks.length} assertions, all checked${c.reset}`
			: `${c.red}✗ seo: ${failed.length} failed, ${unrun.length} unrun, of ${checks.length}${c.reset}`,
	)
	process.exit(ok ? 0 : 1)
}

// Only when run as the command. The fixture builder above is imported by the
// write-path invariant suite, and importing a module must not build an app and
// start a server.
if (process.argv[1]?.endsWith('check-seo.ts')) await gate()
