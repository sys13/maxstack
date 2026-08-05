#!/usr/bin/env node

/**
 * Nothing a browser loads may reach a compiler.
 *
 * # The failure this exists for
 *
 * Every project route served by `apps/web` under `pnpm dev` failed to hydrate:
 *
 *     SyntaxError: The requested module '…/ts-morph/dist/ts-morph.js'
 *     does not provide an export named 'IndentationText'
 *
 * The client bundle never evaluated, so nothing interactive worked on the
 * generated surfaces — no fetchers, no slot components with state, no forms.
 * Server rendering was unaffected, which is why it was easy to miss: the page
 * looked right and did nothing.
 *
 * It was invisible three ways at once. `pnpm dev` is the documented way to
 * dogfood a project (`apps/web/.claude/skills/verify`), so the loop a maintainer
 * actually uses could not exercise any client behaviour; the **production build**
 * was fine, because its transform tree-shook what dev does not; and no test
 * looked, because a hydration failure is a console error in a browser, not a
 * failing assertion.
 *
 * # Why the check is static rather than a browser load
 *
 * #217 suggested a headless load of a project route asserting an empty console.
 * That is the honest end-to-end guard and it needs a dev server, a browser and a
 * project data dir — minutes, and a whole job shape. This is the *cause* rather
 * than the symptom, in milliseconds, in the dependency-free `governance` job:
 * a route module that reaches a compiler cannot ship, so the console error it
 * would produce cannot happen.
 *
 * The rule: a file under `apps/web/app/routes/` is a **route module**, and React
 * Router puts route modules in the client bundle (minus `loader`/`action`, which
 * it strips — but only from the route module itself, never from a plain module it
 * imports). So a route module may not import, directly, any barrel that pulls a
 * compiler in. It must reach for the client-safe leaf instead:
 *
 *     ✗ import { blockSlotId } from '@maxstack/core/ownership'
 *     ✓ import { blockSlotId } from '@maxstack/core/ownership/block-slots'
 *
 * `block-slots.ts` has **no imports at all**, which is what makes it safe, and it
 * is exported as its own subpath so reaching it does not drag its neighbours.
 *
 * Server-only work belongs in a `.server.ts` sibling, which the bundler drops
 * from the client graph wholesale — the pattern `project.*` and `admin.*` already
 * follow.
 *
 * Exits 0 when clean; prints file:line pointers and exits 1 on violations.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Directories whose modules the client bundler will include, and why.
 *
 * Only route modules today. A component directory does not need listing: it is
 * only in the bundle because a route module imported it, and that route module is
 * checked — the edge into the client graph is what matters, not every node past it.
 */
const CLIENT_ROOTS = [
	{
		dir: 'apps/web/app/routes',
		why: 'React Router puts every route module in the client bundle',
	},
]

/**
 * Import specifiers that reach a compiler, and the client-safe thing to use.
 *
 * Matched as a prefix, so `@maxstack/core/ownership` catches the barrel while
 * `@maxstack/core/ownership/block-slots` is a longer, allowed specifier — hence
 * the explicit allow list, checked first.
 */
const FORBIDDEN = [
	{
		prefix: '@maxstack/core/ownership',
		reach: 'ts-morph, through the ownership barrel re-exporting emit.ts',
		instead:
			"'@maxstack/core/ownership/block-slots' for blockSlotId / isSlotBlockType, or a .server.ts sibling for anything that genuinely needs the generator",
	},
	{
		prefix: 'ts-morph',
		reach: 'the TypeScript compiler API, directly',
		instead:
			'a .server.ts sibling — a browser has no business parsing TypeScript',
	},
]

/** Specifiers that start with a forbidden prefix but are known client-safe. */
const ALLOWED = ['@maxstack/core/ownership/block-slots']

/** Every `.ts`/`.tsx` under `dir`, recursively, excluding `.server.ts` files. */
function sourceFiles(dir) {
	const out = []
	let entries
	try {
		entries = readdirSync(join(root, dir))
	} catch {
		return out
	}
	for (const entry of entries) {
		const rel = join(dir, entry)
		if (statSync(join(root, rel)).isDirectory()) {
			out.push(...sourceFiles(rel))
			continue
		}
		if (!/\.tsx?$/.test(entry)) continue
		// A `.server.ts` module is dropped from the client graph wholesale, which
		// is exactly where compiler work is supposed to live.
		if (/\.server\.tsx?$/.test(entry)) continue
		if (/\.test\.tsx?$/.test(entry)) continue
		out.push(rel)
	}
	return out
}

/**
 * Every `from '<spec>'` clause, over the whole file rather than line by line.
 *
 * `check-boundaries.mjs` matches a line that *begins* with `import`/`export`,
 * which silently misses the multi-line form — and the multi-line form is what the
 * real import looks like:
 *
 *     import {
 *       blockSlotId,
 *     } from '@maxstack/core/ownership/block-slots'
 *
 * The first version of this file inherited that regex and reported clean against a
 * planted violation, which is the only reason the gap was noticed. (It is still
 * there in `check-boundaries.mjs`; that is its own fix, not this one's.)
 */
const SPEC_RE = /\bfrom\s+['"]([^'"]+)['"]/g

const violations = []

for (const { dir, why } of CLIENT_ROOTS) {
	for (const file of sourceFiles(dir)) {
		const text = readFileSync(join(root, file), 'utf8')
		for (const match of text.matchAll(SPEC_RE)) {
			const spec = match[1]
			if (!spec) continue
			const i = text.slice(0, match.index).split('\n').length - 1
			if (ALLOWED.some((a) => spec === a || spec.startsWith(`${a}/`))) continue
			const bad = FORBIDDEN.find(
				(f) => spec === f.prefix || spec.startsWith(`${f.prefix}/`),
			)
			if (!bad) continue
			violations.push({
				file: relative(root, join(root, file)),
				line: i + 1,
				spec,
				reach: bad.reach,
				instead: bad.instead,
				why,
			})
		}
	}
}

if (violations.length === 0) {
	const checked = CLIENT_ROOTS.reduce(
		(n, r) => n + sourceFiles(r.dir).length,
		0,
	)
	console.log(`✓ client-safe imports clean (${checked} route modules checked)`)
	process.exit(0)
}

console.error(`✗ ${violations.length} client-unsafe import(s):\n`)
for (const v of violations) {
	console.error(`  ${v.file}:${v.line}  imports '${v.spec}'`)
	console.error(`      reaches ${v.reach}`)
	console.error(`      ${v.why}, so this ships to the browser`)
	console.error(`      use ${v.instead}`)
}
console.error(
	'\nThis is issue #217: the client bundle fails to evaluate, so the page',
)
console.error(
	'server-renders correctly and then does nothing — no fetchers, no slot state,',
)
console.error('no forms. It does not fail the production build, only dev.')
process.exit(1)
