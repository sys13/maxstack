/**
 * Agreement: every prose site that describes `reviewMode` agrees with
 * {@link DEFAULT_CONFIG} about which mode a scaffolded project actually gets.
 *
 * This is a drift pin, not a behaviour test. The drift it pins already
 * happened (#357): `ProjectConfig.reviewMode`'s own doc comment said "`review`
 * (default)" while the constant three screens below it wrote `auto`, and four
 * more sites — the README, the quickstart, the user guide, the `init` scaffold
 * — split two-and-two behind them. A reader could not learn the default from
 * the documentation at all, and the observable symptom (`Review queue (0)` on
 * a fresh project) reads as a bug in the queue for exactly as long as the docs
 * claim writes queue by default.
 *
 * Prose is where this class of drift hides, because prose has no compiler. The
 * two rules below are the two ways it went wrong, stated so a regex can catch
 * them:
 *
 *   - **Never tell a reader to set the value they already have.** "Set
 *     `"reviewMode": "auto"` to get that by default" is instructions for the
 *     opposite product, and is what four sites said.
 *   - **Never label the non-default mode as the default.**
 *
 * And a third rule keeps the list honest: any new file that mentions
 * `reviewMode` must be added to {@link SITES}, so a sixth site cannot quietly
 * appear outside the pin. Being on the list costs nothing when the prose is
 * right.
 *
 * Deliberately *not* pinned: which mode is the default. That is a live product
 * question (#357 again — the `init` CTA is `cd <dir>; claude`, so an agent's
 * writes queueing would mean onboarding generates nothing). Flipping the
 * default should turn this file green by flipping every doc with it, not
 * green by editing the assertion.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from './project.ts'

/** Repo root, from `apps/maxstack/src/lib/`. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** Every non-test file that mentions `reviewMode` in prose a user can read. */
const SITES = [
	'apps/maxstack/README.md',
	'apps/maxstack/src/commands/add-entity.ts',
	'apps/maxstack/src/commands/init.ts',
	'apps/maxstack/src/commands/op.ts',
	'apps/maxstack/src/lib/project.ts',
	'apps/maxstack/templates/_shared/.claude/skills/build-app/SKILL.md',
	'docs/quickstart.md',
	'docs/user-guide.md',
]

/** The mode a scaffolded project gets, and the one it does not. */
const DEFAULT_MODE = DEFAULT_CONFIG.reviewMode
const OTHER_MODE = DEFAULT_MODE === 'auto' ? 'review' : 'auto'

const read = (site: string): string => readFileSync(join(ROOT, site), 'utf8')

/**
 * Where the search for unregistered sites looks. Scoped to the trees that ship
 * prose about the CLI's own config; the web app and packages describe review
 * state, never this key.
 */
const SEARCH_DIRS = ['docs', 'apps/maxstack/src', 'apps/maxstack/templates']
const SEARCH_FILES = ['apps/maxstack/README.md', 'README.md']

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === 'dist' || entry === '.maxstack')
			continue
		const path = join(dir, entry)
		if (statSync(path).isDirectory()) yield* walk(path)
		else yield path
	}
}

/** Matches from a `set`/`leave` verb through to the mode literal it names. */
const INSTRUCTION =
	/\b(?:set|leave)\b[^.\n]{0,120}?reviewMode[^.\n]{0,20}?["'`](auto|review)["'`]/gi
/** Matches a mode literal and the word `default` on either side of it. */
const LABELLED_DEFAULT = [
	/reviewMode[^.\n]{0,90}?["'`](auto|review)["'`][^.\n]{0,60}?\bdefault\b/gi,
	/\bdefault\b[^.\n]{0,80}?reviewMode[^.\n]{0,40}?["'`](auto|review)["'`]/gi,
]

describe('reviewMode documentation agrees with the scaffold default', () => {
	it.each(SITES)('%s never tells you to set the default you have', (site) => {
		const text = read(site)
		const told = [...text.matchAll(INSTRUCTION)].map((m) => m[1]?.toLowerCase())
		// Every "set reviewMode to X" is advice to leave the default, so X is the
		// mode you do *not* already have.
		for (const mode of told) expect({ site, mode }).toEqual({
			site,
			mode: OTHER_MODE,
		})
	})

	it.each(SITES)('%s calls the right mode the default', (site) => {
		const text = read(site)
		for (const pattern of LABELLED_DEFAULT) {
			for (const match of text.matchAll(pattern)) {
				expect({ site, labelled: match[1]?.toLowerCase() }).toEqual({
					site,
					labelled: DEFAULT_MODE,
				})
			}
		}
	})

	it("ProjectConfig's own doc comment states the default, correctly", () => {
		const source = read('apps/maxstack/src/lib/project.ts')
		// The JSDoc block immediately above the `reviewMode:` property — the site
		// that was wrong, and the one a reader in an editor hits first.
		const doc = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*reviewMode:/.exec(source)?.[1]
		expect(doc, 'reviewMode has no doc comment').toBeTruthy()
		const marked = [
			...(doc ?? '').matchAll(
				/["'`](auto|review)["'`][^.]{0,80}?\bdefault\b|\bdefault\b[^.]{0,80}?["'`](auto|review)["'`]/gi,
			),
		].map((m) => (m[1] ?? m[2])?.toLowerCase())
		expect(marked.length, 'the doc comment names no default at all').toBeGreaterThan(0)
		for (const mode of marked) expect(mode).toBe(DEFAULT_MODE)
	})

	it('finds no reviewMode site missing from the list', () => {
		const found = new Set<string>()
		const candidates = [
			...SEARCH_DIRS.flatMap((dir) => [...walk(join(ROOT, dir))]),
			...SEARCH_FILES.map((f) => join(ROOT, f)),
		]
		for (const path of candidates) {
			if (!/\.(md|ts|tsx)$/.test(path) || /\.test\.tsx?$/.test(path)) continue
			if (readFileSync(path, 'utf8').includes('reviewMode'))
				found.add(relative(ROOT, path))
		}
		expect([...found].sort()).toEqual([...SITES].sort())
	})
})
