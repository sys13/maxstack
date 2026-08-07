#!/usr/bin/env node

/**
 * The published runtime payload has a budget, and nothing in it may be unreachable.
 *
 * # The failure this exists for
 *
 * `maxstack-runtime`'s `build/` is copied verbatim out of `apps/web/build` by
 * `apps/maxstack/scripts/stage-npm.ts`, so every byte here is a byte every
 * `npx maxstack@latest` downloads before the first command runs. Cold start is
 * a *download* problem — 87% of the measured 48.9s was the fetch — which makes
 * payload size a user-facing latency number, not housekeeping.
 *
 * It grew from 22.9MB to 41.5MB unpacked without anyone noticing, and 16.8MB of
 * that growth was **files nothing referenced**: `pglite.wasm` (10.1MB),
 * `pglite.data` (6.3MB) and `initdb.wasm` (0.4MB), emitted into the *client*
 * build. `@maxstack/core`'s `sprout/backend.ts` statically imports
 * `@electric-sql/pglite`, the `maxstack-packages` chunk group exists in both
 * environments, so the client build walked into pglite; rolldown then tree-shook
 * the code back out, but an asset emitted during transform is not un-emitted.
 * A browser was being asked to download Postgres-in-WASM that no chunk could
 * even name. `apps/web/vite.config.ts` now stubs pglite in the client
 * environment; this asserts the outcome.
 *
 * # Two checks, because they fail differently
 *
 * **Orphans** are the sharp one: a non-code asset no emitted file references is
 * *always* a defect, whatever its size, and it names the class rather than the
 * instance. A future dependency that emits its own wasm lands here on day one.
 *
 * **The total** is the blunt one, and it catches what orphan detection cannot —
 * a chunk that legitimately doubled, a dependency inlined by mistake, source
 * maps for something that should not be in the bundle at all. The budget below
 * is set from a measurement with headroom, not from an aspiration: it is meant
 * to sit still for months and then fail once, loudly, on a real regression.
 *
 * # Read the numbers, not the exit code
 *
 * This prints the measured bytes every run, passing or failing, and refuses to
 * report on a build it could not find or that contained no chunks. A gate that
 * silently measures nothing and exits 0 is worse than no gate — this repo has
 * shipped that mistake before.
 *
 * Run after a build:
 *   pnpm --filter @maxstack/web build && node scripts/check-payload-budget.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = resolve(root, 'apps/web/build')

const MIB = 1024 * 1024

/**
 * Ceiling for everything `maxstack-runtime` ships as `build/`.
 *
 * Measured at 18.4 MiB with the client pglite leak fixed (6.0 MiB client,
 * 12.4 MiB server — over half of the server half is source maps, which
 * `apps/web/vite.config.ts` ships on purpose). 24 MiB is ~30% headroom: room
 * for ordinary growth, while the 34.4 MiB payload that prompted this check
 * fails by a wide margin.
 *
 * Raising this is a decision about cold start, not a formality. At the measured
 * 64ms per megabyte fetched, every extra MiB here is ~67ms of somebody's first
 * sixty seconds — say what bought it in the commit message.
 */
const BUDGET_BYTES = 24 * MIB

/** Files that carry code or styling. Everything else is an emitted asset. */
const CODE = /\.(js|mjs|cjs|css|map|html|json|txt)$/

/** Every file under `dir`, recursively. */
function walk(dir) {
	const out = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) out.push(...walk(full))
		else out.push(full)
	}
	return out
}

function mib(bytes) {
	return `${(bytes / MIB).toFixed(2)} MiB`
}

let files
try {
	files = walk(buildDir)
} catch {
	console.error(
		`no build at ${relative(root, buildDir)} — run \`pnpm --filter @maxstack/web build\` first.\n` +
			'This check reads emitted files; there is nothing to measure before a build.',
	)
	process.exit(1)
}

// Self-check: a walk that finds nothing, or finds no chunks, means the layout
// moved and this check is measuring a shape that no longer exists. Report that
// as broken rather than as clean.
const chunks = files.filter((f) => f.endsWith('.js'))
if (chunks.length === 0) {
	console.error(
		`✗ check-payload-budget is broken: ${relative(root, buildDir)} holds ` +
			`${files.length} file(s) and not one .js chunk. Either the build ` +
			'failed or the output layout moved — fix this check before trusting it.',
	)
	process.exit(1)
}

const sizes = new Map(files.map((f) => [f, statSync(f).size]))
const total = [...sizes.values()].reduce((a, b) => a + b, 0)
const bytesUnder = (prefix) =>
	files
		.filter((f) => f.startsWith(resolve(buildDir, prefix)))
		.reduce((a, f) => a + sizes.get(f), 0)

// An asset counts as referenced if its emitted basename appears anywhere in the
// build's own text — a chunk, a stylesheet, a source map, react-router's
// manifest. Basename rather than path because that is the form every reference
// takes, and the hash in it makes a false match implausible.
const text = files
	.filter((f) => CODE.test(f))
	.map((f) => readFileSync(f, 'utf8'))
	.join('\n')
const orphans = files
	.filter((f) => !CODE.test(f) && !text.includes(basename(f)))
	.sort((a, b) => sizes.get(b) - sizes.get(a))
const orphanBytes = orphans.reduce((a, f) => a + sizes.get(f), 0)

console.log(`payload: ${mib(total)} in ${files.length} files`)
console.log(`  client  ${mib(bytesUnder('client'))}`)
console.log(`  server  ${mib(bytesUnder('server'))}`)
console.log(`  budget  ${mib(BUDGET_BYTES)}`)
console.log('  largest:')
for (const f of [...files]
	.sort((a, b) => sizes.get(b) - sizes.get(a))
	.slice(0, 5))
	console.log(`    ${mib(sizes.get(f)).padStart(9)}  ${relative(buildDir, f)}`)

let failed = false

if (orphans.length > 0) {
	failed = true
	console.error(
		`\n✗ ${orphans.length} emitted asset(s) — ${mib(orphanBytes)} — that no ` +
			'chunk, stylesheet, source map or manifest references:\n' +
			orphans
				.map(
					(f) =>
						`    ${mib(sizes.get(f)).padStart(9)}  ${relative(buildDir, f)}`,
				)
				.join('\n') +
			'\n\n  An unreferenced asset is downloaded by everyone and served to ' +
			'nobody.\n  It usually means the client build walked into a server-only ' +
			'package,\n  emitted its assets, then tree-shook the code that named ' +
			'them back out.\n  Keep that package out of the client environment (see ' +
			"apps/web/vite.config.ts's\n  pglite stub) rather than deleting the file.",
	)
}

if (total > BUDGET_BYTES) {
	failed = true
	console.error(
		`\n✗ payload is ${mib(total)}, over the ${mib(BUDGET_BYTES)} budget by ` +
			`${mib(total - BUDGET_BYTES)}.\n` +
			'  Every byte here is fetched before a stranger’s first command runs, ' +
			'at\n  roughly 67ms per MiB. Either shrink it, or raise BUDGET_BYTES in ' +
			'this\n  file and say in the commit message what the extra download buys.',
	)
}

if (failed) process.exit(1)
console.log(
	`✓ under budget by ${mib(BUDGET_BYTES - total)}, no unreferenced assets`,
)
