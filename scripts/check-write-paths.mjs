#!/usr/bin/env node

/**
 * Write-path coverage enforcement.
 *
 * "Nothing an agent does becomes an unattributed change" is the load-bearing
 * promise of the review surface, and the thing most likely to break it is not a
 * bad decision — it is a *new write path nobody thought about*. L1 adds bundles
 * and L2 adds op families, each with its own install path, and every one of them
 * is a new way to reach `applyOp`.
 *
 * `ApplyMeta.actor` being required means a new path cannot land an op with no
 * attribution at all: the typechecker refuses. This script covers the other half
 * — that somebody *declared and tested* the path, rather than passing a plausible
 * actor literal and moving on. It is an allowlist, so silence is a failure:
 *
 *   1. every `applyOp(` call site in the workspace lives in a file declared as a
 *      `site` in scripts/write-paths.config.json;
 *   2. every declared `site` still exists and still contains a call site (no
 *      stale entries accumulating as the real paths move);
 *   3. every declared `surface` is one of `OP_SURFACES` in
 *      packages/spec/src/base/actor.ts;
 *   4. every declared path's `coveredBy` test exists and names the path's `id`,
 *      so the declaration points at a test that actually mentions it;
 *   5. every `id` is unique, and exactly one path claims `canAccept` per surface
 *      that has one — an accept is a review, and a second way to perform one
 *      without going through a review surface is the bug this file exists for.
 *
 * Deliberately dependency-free Node, like check-boundaries.mjs, so it runs in a
 * bare `governance` job with no install.
 *
 * Exits 0 when clean; prints file pointers and exits 1 on violations.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const CONFIG_PATH = 'scripts/write-paths.config.json'
const ACTOR_PATH = 'packages/spec/src/base/actor.ts'

const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
/** @type {{id: string, surface: string, site: string, kind: string, coveredBy: string, canAccept?: boolean}[]} */
const paths = config.paths ?? []

// ---------------------------------------------------------------------------
// The surface vocabulary, read out of the type that defines it
// ---------------------------------------------------------------------------
//
// Regex over one stable array literal rather than a second copy of the list here:
// a hardcoded duplicate is exactly the drift the single-derivation rule exists to
// stop, and it would drift silently (a surface added to the union but not here
// reads as "unknown surface" on a perfectly correct config).

const actorSource = readFileSync(join(root, ACTOR_PATH), 'utf8')
const surfaceBlock = actorSource.match(
	/export const OP_SURFACES = \[([\s\S]*?)\] as const/,
)
if (!surfaceBlock) {
	console.error(
		`✗ could not read OP_SURFACES out of ${ACTOR_PATH} — did the declaration move?`,
	)
	console.error(
		'  This script derives the surface vocabulary from that array rather than',
	)
	console.error(
		'  keeping a second copy. Update the regex here if the shape changed.',
	)
	process.exit(1)
}
const surfaces = new Set(
	[...surfaceBlock[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]),
)

// ---------------------------------------------------------------------------
// Find every applyOp call site in the workspace
// ---------------------------------------------------------------------------

const SOURCE_RE = /\.(ts|tsx|mts|cts)$/
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
 * Skipped by exact workspace-relative path, not by directory name — the same
 * distinction check-boundaries.mjs draws, and for the same reason.
 * captures them, and it is a declared write path.
 */
const SKIP_PATHS = new Set([])

/**
 * Files exempt from rule 1 because they are not write *paths*:
 *   - the op engine itself, which defines `applyOp`;
 *   - tests, which drive the paths rather than being them.
 * A test can still land ops — over throwaway in-memory systems, which is the
 * point of a test — so exempting them costs nothing an audit trail needs.
 */
const ENGINE = 'packages/spec/src/base/spec-ops.ts'
const isTest = (rel) => /\.test\.tsx?$/.test(rel)

/** Recursively list source files under dir. */
function sourceFiles(dir) {
	/** @type {string[]} */
	const out = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			const rel = relative(root, full).split('\\').join('/')
			if (
				!SKIP_DIRS.has(entry.name) &&
				!SKIP_PATHS.has(rel) &&
				!entry.name.startsWith('.')
			) {
				out.push(...sourceFiles(full))
			}
		} else if (SOURCE_RE.test(entry.name)) {
			out.push(full)
		}
	}
	return out
}

// `examples/` is deliberately not scanned. The registry exists to account for
// every path that can land a spec op *in a user's project*; the example apps
// build SpecSystems in memory as documentation and test fixtures, and are never
// a write path into anyone's spec.
const scanRoots = ['packages', 'apps'].map((d) => join(root, d))
/** @type {Map<string, number[]>} rel file -> line numbers holding applyOp( */
const callSites = new Map()
for (const scanRoot of scanRoots) {
	for (const file of sourceFiles(scanRoot)) {
		const rel = relative(root, file).split('\\').join('/')
		if (rel === ENGINE || isTest(rel)) continue
		const lines = readFileSync(file, 'utf8').split('\n')
		/** @type {number[]} */
		const hits = []
		for (let i = 0; i < lines.length; i++) {
			// A call, not a mention: `applyOp(` with a word boundary before it, so
			// `validateOpDryRun` docs and `typeof applyOp` don't false-positive.
			if (/(^|[^\w.])applyOp\(/.test(lines[i])) hits.push(i + 1)
		}
		if (hits.length) callSites.set(rel, hits)
	}
}

// ---------------------------------------------------------------------------
// The five rules
// ---------------------------------------------------------------------------

/** @type {string[]} */
const violations = []

/**
 * A path's `site` is where the path *is* — the command, the loader, the installer
 * a reviewer would go read. That is often not the file holding the `applyOp` call:
 * five CLI verbs share `lib/land.ts`, and the workbench form applies through
 * `view-model.ts`. `via` names that shared file, so both facts stay true without
 * either being fudged — `site` keeps pointing at something worth reading, and
 * every real call site is still accounted for.
 */
const accountedFor = new Set(
	paths.flatMap((p) => [p.site, ...(p.via ? [p.via] : [])]),
)

// 1. no undeclared call site
for (const [rel, lines] of callSites) {
	if (accountedFor.has(rel)) continue
	violations.push(
		`${rel}:${lines[0]}  undeclared write path — reaches applyOp() but is named by no entry in ${CONFIG_PATH}.\n` +
			'      Declare it (id, surface, kind, authorKind, coveredBy, why) and cover it\n' +
			'      with an invariant test that names the id. If it applies on behalf of an\n' +
			"      already-declared path, name it as that path's `via`.\n" +
			'      See docs/write-paths.md.',
	)
}

// 2. no stale declaration
for (const p of paths) {
	for (const [field, value] of [
		['site', p.site],
		...(p.via ? [['via', p.via]] : []),
	]) {
		if (!existsSync(join(root, value))) {
			violations.push(
				`${CONFIG_PATH}  "${p.id}" names ${field} "${value}", which does not exist.`,
			)
		}
	}
	// The path has to reach applyOp *somewhere* — through its own file, its `via`,
	// or (for the dry-run entry) the engine itself.
	const reaches =
		callSites.has(p.site) ||
		(p.via && callSites.has(p.via)) ||
		p.site === ENGINE
	if (!reaches && existsSync(join(root, p.site))) {
		violations.push(
			`${CONFIG_PATH}  "${p.id}" no longer reaches applyOp() through site "${p.site}"` +
				`${p.via ? ` or via "${p.via}"` : ''}.\n` +
				'      Either the path moved (update `site`/`via`) or it is gone (delete the entry).',
		)
	}
}

// 3. known surface
for (const p of paths) {
	if (!surfaces.has(p.surface)) {
		violations.push(
			`${CONFIG_PATH}  "${p.id}" declares surface "${p.surface}", which is not in OP_SURFACES\n` +
				`      (${[...surfaces].join(', ')}) — add it to ${ACTOR_PATH} first.`,
		)
	}
	if (p.kind !== 'write' && p.kind !== 'preflight') {
		violations.push(
			`${CONFIG_PATH}  "${p.id}" declares kind "${p.kind}" (expected "write" or "preflight").`,
		)
	}
}

// 4. covered by a test that names it
for (const p of paths) {
	if (!p.coveredBy) {
		violations.push(`${CONFIG_PATH}  "${p.id}" has no coveredBy.`)
		continue
	}
	const testPath = join(root, p.coveredBy)
	if (!existsSync(testPath)) {
		violations.push(
			`${CONFIG_PATH}  "${p.id}" is coveredBy "${p.coveredBy}", which does not exist.`,
		)
		continue
	}
	if (!readFileSync(testPath, 'utf8').includes(p.id)) {
		violations.push(
			`${p.coveredBy}  does not mention write path "${p.id}".\n` +
				'      A declaration pointing at a test that never names it is an uncovered\n' +
				"      path wearing a covered path's clothes — the exact failure this gate\n" +
				'      exists to make loud. Assert the invariants for it by name.',
		)
	}
}

// 5. unique ids; accept is a review, and reviews are rare and named
const seen = new Set()
for (const p of paths) {
	if (seen.has(p.id))
		violations.push(`${CONFIG_PATH}  duplicate write-path id "${p.id}".`)
	seen.add(p.id)
}
// Flipping isAccepted null->true IS the review step, so a path claiming that
// power is the most consequential declaration in this file. It is checked by
// demanding a written justification rather than by capping the count.
//
// The cap was the first attempt and it was the wrong shape: `> 2` is satisfiable
// by a two-character diff, which is precisely the "config edit" its own error
// message warned against. A required rationale cannot be satisfied that way —
// somebody has to state, in the registry, why this path is entitled to settle a
// decision on a human's behalf, and that sentence is then in the diff for a
// reviewer to disagree with.
const accepting = paths.filter((p) => p.canAccept === true)
for (const p of accepting) {
	if (p.kind !== 'write') {
		violations.push(
			`${CONFIG_PATH}  "${p.id}" claims canAccept but is kind "${p.kind}" — a preflight cannot settle a review.`,
		)
	}
	if (
		typeof p.acceptRationale !== 'string' ||
		p.acceptRationale.trim().length < 40
	) {
		violations.push(
			`${CONFIG_PATH}  "${p.id}" claims canAccept without an acceptRationale.\n` +
				'      Settling a review is the one thing this platform promises a human does.\n' +
				'      A path that does it has to say why it is entitled to — in the registry,\n' +
				'      where the sentence lands in the diff and somebody can disagree with it.',
		)
	}
}

// ---------------------------------------------------------------------------

if (violations.length === 0) {
	const writes = paths.filter((p) => p.kind === 'write').length
	console.log(
		`✓ write paths clean (${paths.length} declared: ${writes} write, ` +
			`${paths.length - writes} preflight; ${callSites.size} call sites in ` +
			`${surfaces.size} surfaces)`,
	)
	// Printed on success, not just on failure. The set of paths that may settle a
	// review is the shortest and most important list in the project, and a list
	// nobody ever sees is a list that grows.
	console.log(`  may settle a review (${accepting.length}):`)
	for (const p of accepting) console.log(`    ${p.id} — ${p.acceptRationale}`)
	process.exit(0)
}
console.error(`✗ ${violations.length} write-path violation(s):\n`)
for (const v of violations) console.error(`  ${v}`)
console.error(
	`\nPolicy: maxstack/docs/write-paths.md. The registry is ${CONFIG_PATH}.`,
)
process.exit(1)
