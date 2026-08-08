#!/usr/bin/env node

/**
 * Every repo path a published document cites in backticks must exist here.
 *
 * Prose is where a repository makes promises about its own contents, and those
 * promises rot in one direction only: a file moves or never crosses a split, and
 * the sentence naming it keeps reading like an instruction. Nothing else catches
 * it — the path is inside a string of English, so typecheck, lint and every test
 * are structurally blind to it, and the page renders perfectly while telling a
 * stranger to open a file that is not there.
 *
 * That is not hypothetical: extracting this repo out of the maintainer's own
 * repository left seven such citations behind (#368), including three in
 * [`development.md`](../docs/development.md) — the page in the Contributing
 * group an outside contributor is most likely to follow literally — that named
 * `scripts/…` for scripts living under `apps/maxstack/scripts/`.
 *
 * A citation of machinery that genuinely lives elsewhere is not fixed by
 * inventing a path for it. Say where it lives instead, the way
 * [`combination-safety.md`](../docs/combination-safety.md) and
 * [`upgrade-safety.md`](../docs/upgrade-safety.md) say it of the measurement
 * apparatus, and drop the repo-relative shape that makes it look openable.
 *
 * Deliberately narrow, because a doc gate that cries wolf gets muted: only
 * inline code spans are read, and only ones that look like a path into a
 * top-level directory of this repo. A bare `foo.ts` is a name, not a citation.
 *
 * Exits 0 when clean; prints file:line and the offending path, and exits 1
 * otherwise.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'dist-npm',
	'build',
	'coverage',
	'.git',
	'.maxstack',
	'.react-router',
	'.turbo',
])

/**
 * A changelog is a record of what happened, not a description of the tree as it
 * stands, so a path that was correct in the release it describes stays written
 * as it was — correcting it would be falsifying the history, not fixing a doc.
 */
const SKIP_FILES = new Set(['CHANGELOG.md', 'CHANGELOG.archive.md'])

/**
 * Paths that are absent on a clean checkout on purpose: each is gitignored and
 * written by a build or at runtime, so "not in the tree" is the documented
 * state rather than a broken citation.
 */
const GENERATED_PATHS = new Set(['apps/web/.maxstack/', 'apps/web/build'])

/**
 * The top-level directories a citation can point into. Anchoring on these keeps
 * the match to things that are unambiguously paths *in this repo*: `packages/…`
 * is a citation, `@electric-sql/pglite` and `feat/some-branch` are not.
 */
const ROOTS = ['apps', 'docs', 'examples', 'packages', 'scripts', 'skills']

const CITATION_RE = new RegExp(
	`\`([\\w./@-]*(?:${ROOTS.join('|')})/[\\w./-]+)\``,
	'g',
)

/** Recursively list markdown files under dir. */
function docFiles(dir) {
	/** @type {string[]} */
	const out = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name))
				out.push(...docFiles(join(dir, entry.name)))
		} else if (entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
			out.push(join(dir, entry.name))
		}
	}
	return out
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length

/**
 * Existence is judged against what git tracks, not against the working tree. A
 * reader clones the repo; they do not inherit the maintainer's build outputs.
 * On its first run this gate was green locally and red in CI over exactly that
 * — a citation of `apps/web/build`, which every local checkout has and no fresh
 * one does. Tracked-only means a gate that passes here passes there.
 */
function trackedPaths() {
	const files = execFileSync('git', ['ls-files', '-z'], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	})
		.split('\0')
		.filter(Boolean)
	const set = new Set(files)
	// A citation may name a directory, which git never lists on its own.
	for (const file of files) {
		for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1))
			set.add(file.slice(0, i))
	}
	return set
}

const tracked = trackedPaths()

/** @type {{ file: string, line: number, path: string }[]} */
const violations = []
let checked = 0

for (const file of docFiles(root)) {
	const source = readFileSync(file, 'utf8')
	const rel = relative(root, file).split('\\').join('/')
	for (const match of source.matchAll(CITATION_RE)) {
		// A leading `./` or `/` is a way of writing the same repo-relative path.
		const path = match[1].replace(/^\.?\//, '')
		if (GENERATED_PATHS.has(path)) continue
		checked++
		if (!tracked.has(path.replace(/\/$/, '')))
			violations.push({ file: rel, line: lineOf(source, match.index), path })
	}
}

if (violations.length === 0) {
	console.log(`✓ ${checked} cited repo path(s) in docs all exist`)
	process.exit(0)
}
console.error(
	`✗ ${violations.length} doc citation(s) of paths that do not exist:\n`,
)
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.path}`)
console.error(
	`
Each of these renders as a file a reader can open, and cannot be opened.

  moved      cite the path it is at now (\`apps/maxstack/scripts/publish.ts\`,
             not \`scripts/publish.ts\`)
  not here   say so — "lives in the maintainer's own repository rather than
             here" — and drop the repo-relative shape
  generated  if it is a gitignored path written by a build or at runtime, add
             it to GENERATED_PATHS in this file, with the reason
`,
)
process.exit(1)
