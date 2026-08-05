#!/usr/bin/env node

/**
 * Mechanical architecture boundary enforcement.
 *
 * Validates every static import in the workspace against the policy in
 * scripts/boundaries.config.json:
 *
 *   - a package may only import the workspace packages its policy entry lists
 *   - packages may never import apps; apps may never import other apps
 *   - relative imports may not escape their own package root
 *
 * Only line-leading static `import`/`export ... from` specifiers are checked, so
 * import statements embedded in string literals (codegen emit templates, test
 * expectations) don't false-positive. The *statement* is read rather than the line
 *: a wrapped named-import list puts `from '…'` on a continuation
 * line, and 35% of the workspace's imports are in that form — so a line-only scan
 * reported clean over two thirds of an allowlist it was supposed to be checking.
 *
 * The matcher self-tests on every run, before scanning anything. A checker that
 * finds nothing looks the same whether it is working or blind, and this one was
 * blind for its whole life without a single red run.
 *
 * Exits 0 when clean; prints file:line pointers and exits 1 on violations.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const config = JSON.parse(
	readFileSync(join(root, 'scripts/boundaries.config.json'), 'utf8'),
)
const packageRules = config.packages
const appNames = new Set(config.apps)
const knownNames = new Set([...Object.keys(packageRules), ...appNames])

/** Workspace member dirs, per pnpm-workspace.yaml. */
const memberDirs = [
	...readdirSync(join(root, 'packages')).map((d) => join('packages', d)),
	...readdirSync(join(root, 'apps')).map((d) => join('apps', d)),
	'examples',
]

/** @type {{ name: string, dir: string }[]} */
const members = []
for (const dir of memberDirs) {
	try {
		const pkg = JSON.parse(
			readFileSync(join(root, dir, 'package.json'), 'utf8'),
		)
		if (pkg.name) members.push({ name: pkg.name, dir })
	} catch {
		// not a package dir (e.g. stray file) — skip
	}
}

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs)$/
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'dist-npm',
	'build',
	'coverage',
	'.maxstack',
	'.react-router',
])

/**
 * Directories skipped by exact workspace-relative path rather than by name.
 *
 * Empty today. It exists for committed *project trees* — fixtures the gates
 * read as bytes rather than as this repo's own source. Match by path and not by
 * directory name: `packages/spec/src/fixtures` is real source and must stay
 * checked.
 */
const SKIP_PATHS = new Set([])

/** Recursively list source files under dir. */
function sourceFiles(dir) {
	/** @type {string[]} */
	const out = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const rel = relative(root, join(dir, entry.name)).split('\\').join('/')
			if (
				!SKIP_DIRS.has(entry.name) &&
				!SKIP_PATHS.has(rel) &&
				!entry.name.startsWith('.git')
			) {
				out.push(...sourceFiles(join(dir, entry.name)))
			}
		} else if (SOURCE_RE.test(entry.name)) {
			out.push(join(dir, entry.name))
		}
	}
	return out
}

// Static imports/re-exports at the start of a line (possibly indented):
//   import x from 'spec'   import 'spec'   export { x } from 'spec'
const IMPORT_RE =
	/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/

/** Does this line open a statement whose specifier is on a later line? */
const OPENS_WRAPPED = /^\s*(?:import|export)\b[^'"]*\{[^}]*$/

/**
 * The specifier of the import statement starting at `lines[i]`, or undefined.
 *
 * Reads the **statement**, not the line. This scanned line by line,
 * which silently missed every wrapped import:
 *
 *     import {
 *       blockSlotId,
 *     } from '@maxstack/core/ownership'
 *
 * 1,364 of the workspace's 3,890 import statements are in that form — 35% — and
 * which ones is decided by biome's print width, so adding a third named import
 * could move a line out of this checker's view with no diff near the policy. On an
 * **allowlist**, where silence is supposed to mean "nothing got past me", that is
 * the whole guarantee.
 *
 * Accumulation stops at the closing brace rather than scanning ahead freely: this
 * file is semicolon-free, so a permissive "keep going until a quote" rule can join
 * an unrelated `export const` to the import below it and report the wrong line.
 * The braces are what bound it, and a wrapped named-import list is the only
 * multi-line form the formatter produces.
 */
function specifierAt(lines, i) {
	const direct = lines[i].match(IMPORT_RE)
	if (direct) return direct[1] ?? direct[2]
	if (!OPENS_WRAPPED.test(lines[i])) return undefined
	let buffer = lines[i]
	for (let j = i + 1; j < lines.length; j++) {
		buffer += `\n${lines[j]}`
		if (!lines[j].includes('}')) continue
		// The statement is closed; either it names a specifier or it is not an
		// import at all (a wrapped `export { a, b }` with no `from`).
		const match = buffer.replace(/\n/g, ' ').match(IMPORT_RE)
		return match ? (match[1] ?? match[2]) : undefined
	}
	return undefined
}

/**
 * Prove the matcher can see the forms it exists to reject, before trusting it.
 *
 * This checker reported `✓ boundaries clean` for as long as it existed while
 * being blind to 35% of the workspace's imports. Nothing caught that,
 * because nothing ever fed it an import it was supposed to *find* — every run was
 * over a compliant tree, and a matcher that finds nothing looks identical whether
 * it is working or broken.
 *
 * So the run starts by asserting the matcher fires on each shape, and refuses to
 * report at all if it does not. Microseconds, no dependencies, and it converts
 * "silence means clean" from an assumption into something demonstrated on every
 * invocation.
 */
const SELF_TEST = [
	{ name: 'single-line', src: ["import { x } from '@scope/pkg'"] },
	{
		name: 'wrapped named import',
		src: ['import {', '\tx,', "} from '@scope/pkg'"],
	},
	{
		name: 'wrapped re-export',
		src: ['export {', '\tx,', "} from '@scope/pkg'"],
	},
	{ name: 'default import', src: ["import x from '@scope/pkg'"] },
	{ name: 'side-effect import', src: ["import '@scope/pkg'"] },
	{ name: 'type-only import', src: ["import type { X } from '@scope/pkg'"] },
]

for (const { name, src } of SELF_TEST) {
	const found = specifierAt(src, 0)
	if (found !== '@scope/pkg') {
		console.error(
			`✗ check-boundaries is broken: it cannot see a ${name} import ` +
				`(read '${found ?? 'nothing'}', expected '@scope/pkg').`,
		)
		console.error(
			'\n  Refusing to report "clean" from a matcher that has not demonstrated it',
		)
		console.error(
			'  can find a violation — that combination is issue #268, where this file',
		)
		console.error(
			'  passed every run while 35% of the workspace was never checked.',
		)
		process.exit(1)
	}
}

// …and that it does NOT claim an import where there is none, or the checker would
// start reporting violations against ordinary code.
for (const src of [
	['export const RE = /x/'],
	['export {', '\tlocalThing,', '}'],
	['const from = 1'],
]) {
	const found = specifierAt(src, 0)
	if (found !== undefined) {
		console.error(
			`✗ check-boundaries is broken: it read '${found}' out of a non-import: ${src.join(' ')}`,
		)
		process.exit(1)
	}
}

/** @type {{ file: string, line: number, message: string }[]} */
const violations = []

for (const { name, dir } of members) {
	const isApp = appNames.has(name)
	const allowed = new Set(packageRules[name] ?? [])
	const memberRoot = resolve(root, dir)

	for (const file of sourceFiles(memberRoot)) {
		const lines = readFileSync(file, 'utf8').split('\n')
		for (let i = 0; i < lines.length; i++) {
			const spec = specifierAt(lines, i)
			if (!spec) continue

			const rel = relative(root, file)
			if (spec.startsWith('.')) {
				const target = resolve(dirname(file), spec)
				if (!target.startsWith(`${memberRoot}/`) && target !== memberRoot) {
					violations.push({
						file: rel,
						line: i + 1,
						message: `relative import escapes package root: '${spec}'`,
					})
				}
				continue
			}

			// Match the longest known workspace name prefix (handles subpaths).
			const imported = [...knownNames].find(
				(n) => spec === n || spec.startsWith(`${n}/`),
			)
			if (!imported || imported === name) continue

			if (appNames.has(imported)) {
				violations.push({
					file: rel,
					line: i + 1,
					message: `${name} imports app '${imported}' — apps may never be imported`,
				})
			} else if (!isApp && !allowed.has(imported)) {
				violations.push({
					file: rel,
					line: i + 1,
					message: `${name} imports '${imported}', not in its allowed list [${[...allowed].join(', ')}]`,
				})
			}
		}
	}
}

if (violations.length === 0) {
	console.log(
		`✓ boundaries clean (${members.length} workspace members checked)`,
	)
	process.exit(0)
}
console.error(`✗ ${violations.length} boundary violation(s):\n`)
for (const v of violations) {
	console.error(`  ${v.file}:${v.line}  ${v.message}`)
}
console.error(
	'\nFix by moving code down the layer stack or extracting a shared module;',
)
console.error(
	'see docs/development.md ("Architecture boundaries") before editing the policy.',
)
process.exit(1)
