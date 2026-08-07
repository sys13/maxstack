#!/usr/bin/env node

/**
 * Owned-code write enforcement — the filesystem half of the write-path registry.
 *
 * `scripts/check-write-paths.mjs` is an allowlist over **spec-op** writes: it
 * finds every `applyOp(` call site and refuses one no registry entry names. That
 * gate could never have caught issue #360, because the bug was not an op.
 *
 * `maxstack add view <resource>` wrote its scaffold with a bare `fs.write`, so
 * the one command whose output is stamped THIS FILE IS YOURS was also the one
 * command that would silently overwrite it — and then re-flip the manifest entry
 * it had itself already set to `ejected`. It shipped that way, and the existing
 * suite called `addViewCommand(dir, 'post')` three times without noticing. That
 * is strictly worse than an unattributed op: an op is logged, diffed and
 * revertible, whereas an overwritten ejected module is gone.
 *
 * The invariant held everywhere else only by convention — every other writer
 * *happened* to route through the ownership layer. This makes it structural.
 *
 * ## The rule
 *
 * A destructive write to a path a user's owned code can live at may only be made
 * by the ownership layer, or by a writer this registry names. Two ways exist to
 * reach such a path, and both are checked:
 *
 *   A. **the `Fs` port** — `createNodeFs(project.appPath)` is jailed to the
 *      project's app tree by construction, so *every* `.write()` / `.remove()`
 *      on a disk-backed port lands inside the user's code. This is the #360
 *      shape.
 *   B. **raw `node:fs`** — `writeFile(resolve(project.appPath, …), …)` and
 *      friends, where the *destination* argument derives from `appPath`.
 *
 * An entry does not exempt a *file*, it exempts a **target expression**. That is
 * the load-bearing detail: `apps/maxstack/src/commands/view.ts` is allowed to
 * write `MANIFEST_FILENAME` and nothing else, so the exact line #360 removed is
 * still a failure even though the file it lived in is on the list. A gate whose
 * escape hatch is "add your file" is a gate that gets added to; one whose escape
 * hatch is "say which path" is one somebody has to lie in a diff to get past.
 *
 * ## What is deliberately NOT policed
 *
 * Raw `node:fs` writes that do not target `appPath`: `maxstack init`'s scaffolder
 * writing a *new* project, `maxstack build`'s vendoring into `.maxstack/runtime`,
 * the release scripts, the storage backend, tests and fixtures. Those are ~20
 * files, they are all legitimate, and an allowlist that broad would be
 * suppression wearing a gate's clothes — every entry a shrug. The narrow rule is
 * the one worth having, because `appPath` is where owned code lives.
 *
 * Deliberately dependency-free Node, like check-boundaries.mjs, so it runs in a
 * bare `governance` job with no install. Exits 0 when clean; prints file:line
 * pointers and exits 1 on violations.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const CONFIG_PATH = 'scripts/owned-writes.config.json'
const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))

/** The ownership layer — unrestricted, because it *is* the never-clobber rule. */
const LAYER = config.layer
/** The adapter inside the layer that is allowed to touch `node:fs` directly. */
const LAYER_FS_ADAPTER = config.layerFsAdapter
/** The sanctioned entry points a violator is told to route through. */
const WRITERS = config.writers ?? []
/** @type {{id: string, file: string, kind: string, targets: string[], why: string}[]} */
const exceptions = config.exceptions ?? []

// ---------------------------------------------------------------------------
// Call-site extraction
// ---------------------------------------------------------------------------

/**
 * Destructive `node:fs` calls, mapped to the index of their **destination**
 * argument. `cp(project.appPath, mirror)` reads the app tree and writes
 * elsewhere — flagging it on argument 0 would be a false positive on the
 * vendoring step, which is exactly the noise that gets a gate suppressed.
 */
const RAW_FS_CALLS = {
	writeFile: 0,
	writeFileSync: 0,
	appendFile: 0,
	appendFileSync: 0,
	truncate: 0,
	truncateSync: 0,
	unlink: 0,
	unlinkSync: 0,
	rm: 0,
	rmSync: 0,
	rmdir: 0,
	rmdirSync: 0,
	createWriteStream: 0,
	copyFile: 1,
	copyFileSync: 1,
	cp: 1,
	cpSync: 1,
	rename: 1,
	renameSync: 1,
}

/** Split a source string at top-level commas, respecting nesting and strings. */
function splitArgs(text) {
	const out = []
	let depth = 0
	let start = 0
	let quote = null
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (quote) {
			if (ch === '\\') i++
			else if (ch === quote) quote = null
			continue
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch
		else if (ch === '(' || ch === '[' || ch === '{') depth++
		else if (ch === ')' || ch === ']' || ch === '}') depth--
		else if (ch === ',' && depth === 0) {
			out.push(text.slice(start, i).trim())
			start = i + 1
		}
	}
	out.push(text.slice(start).trim())
	return out
}

/**
 * The argument list of the call whose `(` is at `open`, or null if unbalanced.
 * Reads the *call*, not the line — every manifest persist in this workspace that
 * the formatter wrapped puts its target on a continuation line, and a line-only
 * scan would read `fs.write(` with no arguments at all and wave it through.
 */
function argsAt(src, open) {
	let depth = 0
	let quote = null
	for (let i = open; i < src.length; i++) {
		const ch = src[i]
		if (quote) {
			if (ch === '\\') i++
			else if (ch === quote) quote = null
			continue
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch
		else if (ch === '(') depth++
		else if (ch === ')') {
			depth--
			if (depth === 0) return splitArgs(src.slice(open + 1, i))
		}
	}
	return null
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length

/**
 * Every destructive write in one file that can land in a user's app tree.
 *
 * @returns {{line: number, kind: 'fs-port'|'raw-fs', call: string, target: string}[]}
 */
export function destructiveWrites(src) {
	/** Bindings holding a disk-backed `Fs` port. */
	const diskPorts = new Set()
	/** Bindings holding the in-memory double — it cannot destroy anything. */
	const memPorts = new Set()
	for (const m of src.matchAll(
		/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?create(Node|Mem)Fs\s*\(/g,
	)) {
		;(m[2] === 'Node' ? diskPorts : memPorts).add(m[1])
	}
	// A parameter or field annotated `: Fs` is the port too, and at a call site
	// there is no telling which adapter arrives — `apps/maxstack/src/lib/generate.ts`
	// threads a real `createNodeFs` into functions typed exactly this way. Treated
	// as disk-backed, because the safe assumption about an injected port is that
	// it is the one that reaches a disk.
	for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*Fs\b/g)) {
		if (!memPorts.has(m[1])) diskPorts.add(m[1])
	}

	/** Locals derived from the project's app tree — `resolve(appPath, …)`. */
	const appPathDerived = new Set()
	for (const m of src.matchAll(
		/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*(?:\n(?![ \t]*(?:const|let|var|return|await|if|for|\}))[^\n]*)*)/g,
	)) {
		if (/\bappPath\b/.test(m[2])) appPathDerived.add(m[1])
	}
	const targetsAppTree = (arg) =>
		/\bappPath\b/.test(arg) ||
		[...appPathDerived].some((n) => new RegExp(`\\b${n}\\b`).test(arg))

	const found = []

	// A. the Fs port
	for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.(write|remove)\s*\(/g)) {
		if (!diskPorts.has(m[1])) continue
		const args = argsAt(src, m.index + m[0].length - 1)
		found.push({
			line: lineOf(src, m.index),
			kind: 'fs-port',
			call: `${m[1]}.${m[2]}`,
			target: args?.[0] ?? '<unparsed>',
		})
	}

	// B. raw node:fs, destination inside the app tree
	for (const m of src.matchAll(/(^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/gm)) {
		const name = m[2]
		const destIndex = RAW_FS_CALLS[name]
		if (destIndex === undefined) continue
		const args = argsAt(src, m.index + m[0].length - 1)
		const dest = args?.[destIndex]
		if (!dest || !targetsAppTree(dest)) continue
		found.push({
			line: lineOf(src, m.index),
			kind: 'raw-fs',
			call: name,
			target: dest,
		})
	}

	return found.sort((a, b) => a.line - b.line)
}

// ---------------------------------------------------------------------------
// Self-test — prove the matcher fires before trusting its silence
// ---------------------------------------------------------------------------
//
// check-boundaries.mjs reported clean for its whole life while blind to 35% of
// the workspace's imports (issue #268), and nothing caught it because every run
// was over a compliant tree. This gate has the same failure mode and a worse
// consequence, so it starts by feeding itself the code #360 actually shipped and
// refusing to report at all if it cannot see it.

const MUST_FIND = [
	{
		name: 'the #360 shape (bare Fs-port write of a scaffolded module)',
		src: [
			'const fs = createNodeFs(project.appPath)',
			'await fs.write(file, content)',
		].join('\n'),
		expect: { kind: 'fs-port', target: 'file' },
	},
	{
		name: 'a wrapped Fs-port write',
		src: [
			'const fs = createNodeFs(project.appPath)',
			'await fs.write(',
			'\tMANIFEST_FILENAME,',
			'\tserializeManifest(next),',
			')',
		].join('\n'),
		expect: { kind: 'fs-port', target: 'MANIFEST_FILENAME' },
	},
	{
		name: 'an Fs-port remove',
		src: [
			'async function p(fs: Fs) {',
			'\tawait fs.remove(entry.file)',
			'}',
		].join('\n'),
		expect: { kind: 'fs-port', target: 'entry.file' },
	},
	{
		name: 'a raw node:fs write into the app tree',
		src: [
			'const path = resolve(project.appPath, artifact.path)',
			"await writeFile(path, artifact.content, 'utf8')",
		].join('\n'),
		expect: { kind: 'raw-fs', target: 'path' },
	},
	{
		name: 'a raw node:fs copy whose DESTINATION is the app tree',
		src: 'await cp(source, resolve(project.appPath, "routes"), { recursive: true })',
		expect: { kind: 'raw-fs', target: 'resolve(project.appPath, "routes")' },
	},
]

for (const { name, src, expect } of MUST_FIND) {
	const hit = destructiveWrites(src).find(
		(w) => w.kind === expect.kind && w.target === expect.target,
	)
	if (!hit) {
		console.error(`✗ check-owned-writes is broken: it cannot see ${name}.`)
		console.error(
			`\n  Read: ${JSON.stringify(destructiveWrites(src))}\n  Expected: ${JSON.stringify(expect)}`,
		)
		console.error(
			'\n  Refusing to report "clean" from a matcher that has not demonstrated it',
		)
		console.error(
			'  can find the bug it exists for. A gate that finds nothing looks exactly',
		)
		console.error('  the same whether it is working or blind.')
		process.exit(1)
	}
}

// …and that it stays quiet on the writes that are legitimately none of its
// business, or it becomes the thing everybody suppresses.
const MUST_MISS = [
	{
		name: 'the in-memory double',
		src: ['const fs = createMemFs()', 'await fs.write(file, content)'].join(
			'\n',
		),
	},
	{
		name: 'vendoring: the app tree is the SOURCE, the destination is .maxstack',
		src: 'await cp(project.appPath, projectMirror, { recursive: true })',
	},
	{
		name: 'a scaffolder writing a new project',
		src: "await writeFile(resolve(dir, 'maxstack.json'), body)",
	},
	{
		name: 'reading the manifest out of the app tree',
		src: [
			'const manifestPath = resolve(project.appPath, MANIFEST_FILENAME)',
			"const raw = await readFile(manifestPath, 'utf8')",
		].join('\n'),
	},
	{
		name: 'a response stream that merely has a .write',
		src: "res.write('chunk')",
	},
]

for (const { name, src } of MUST_MISS) {
	const hits = destructiveWrites(src)
	if (hits.length > 0) {
		console.error(
			`✗ check-owned-writes is broken: it flagged ${name} — ${JSON.stringify(hits)}`,
		)
		process.exit(1)
	}
}

// ---------------------------------------------------------------------------
// Scan
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
 * Tests are exempt. They drive the writers rather than being them, over
 * `mkdtemp` scratch dirs and the in-memory double, and a test that could not
 * write a file by hand could not prove the refusal it is asserting.
 */
const isTest = (rel) => /\.(test|spec)\.tsx?$/.test(rel)

function sourceFiles(dir) {
	const out = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
				out.push(...sourceFiles(full))
		} else if (SOURCE_RE.test(entry.name)) out.push(full)
	}
	return out
}

/** @type {string[]} */
const violations = []
/** @type {Map<string, Set<string>>} rel file -> targets actually written */
const seen = new Map()
let scanned = 0
let callSites = 0

/**
 * file -> permitted target expressions, unioned across entries.
 *
 * A file may hold more than one entry: `lib/generate.ts` persists the manifest
 * *and* lands the derived artifacts, and those are two different arguments with
 * two different reasons, so they are two declarations rather than one entry with
 * a hedged `why`.
 */
const permitted = new Map()
for (const e of exceptions) {
	const set = permitted.get(e.file) ?? new Set()
	for (const t of e.targets) set.add(t)
	permitted.set(e.file, set)
}

for (const scanRoot of ['packages', 'apps'].map((d) => join(root, d))) {
	for (const file of sourceFiles(scanRoot)) {
		const rel = relative(root, file).split('\\').join('/')
		if (isTest(rel)) continue
		const src = readFileSync(file, 'utf8')
		scanned++

		const inLayer = rel.startsWith(`${LAYER}/`)
		if (inLayer) {
			// Rule 5: the layer goes through its own port. That is what keeps it
			// testable in memory, and what makes the port the only door into a
			// project — a `node:fs` call here would reopen the hole one level down.
			if (rel === LAYER_FS_ADAPTER) continue
			for (const w of destructiveWrites(src).filter((x) => x.kind === 'raw-fs'))
				violations.push(
					`${rel}:${w.line}  the ownership layer reached node:fs directly (${w.call}).\n` +
						`      It must go through the injected Fs port; ${LAYER_FS_ADAPTER} is the\n` +
						'      one adapter allowed to touch the disk.',
				)
			continue
		}

		const writes = destructiveWrites(src)
		if (writes.length === 0) continue
		const allowed = permitted.get(rel)
		for (const w of writes) {
			callSites++
			if (allowed?.has(w.target)) {
				;(seen.get(rel) ?? seen.set(rel, new Set()).get(rel)).add(w.target)
				continue
			}
			violations.push(
				`${rel}:${w.line}  destructive write to owned code, outside the ownership layer.\n` +
					`      ${w.call}(${w.target}, …)${allowed ? ` — the file is declared, but "${w.target}" is not one of its\n      permitted targets [${[...allowed].join(', ')}]` : ''}\n` +
					`      Route it through the ownership layer (${WRITERS.join(', ')}), which\n` +
					'      refuses to overwrite a file the manifest says the user owns — that is\n' +
					'      the bug this gate exists for (#360). If it genuinely cannot, declare\n' +
					`      the target in ${CONFIG_PATH} with a written why.`,
			)
		}
	}
}

// Rule 3: no stale declarations. An exception nobody exercises is a permission
// left lying around, and the next write into that file inherits it for free.
for (const e of exceptions) {
	if (!existsSync(join(root, e.file))) {
		violations.push(
			`${CONFIG_PATH}  "${e.id}" names file "${e.file}", which does not exist.`,
		)
		continue
	}
	for (const t of e.targets) {
		if (!seen.get(e.file)?.has(t))
			violations.push(
				`${CONFIG_PATH}  "${e.id}" permits target "${t}" in ${e.file}, which no longer writes it.\n` +
					'      Either the write moved (update the entry) or it is gone (delete it).',
			)
	}
	if (typeof e.why !== 'string' || e.why.trim().length < 40)
		violations.push(
			`${CONFIG_PATH}  "${e.id}" has no why. Writing a user's code from outside the\n` +
				'      ownership layer needs a sentence somebody can disagree with in a diff.',
		)
}

// Rule 4: the sanctioned writers still exist. The error message above points at
// them, and a list of functions that have been renamed away is advice that sends
// the next person looking for something that is not there.
const layerSrc = readFileSync(join(root, LAYER, 'write.ts'), 'utf8')
for (const w of WRITERS) {
	if (!new RegExp(`export async function ${w}\\b`).test(layerSrc))
		violations.push(
			`${CONFIG_PATH}  writer "${w}" is not exported from ${LAYER}/write.ts.\n` +
				'      Update the list — it is what a violation is told to route through.',
		)
}

// ---------------------------------------------------------------------------

if (violations.length === 0) {
	console.log(
		`✓ owned writes clean (${scanned} files scanned; ${callSites} destructive ` +
			`write(s) to the app tree outside ${LAYER}, all declared)`,
	)
	// Printed on success. This is the whole list of code that may write a user's
	// files without the manifest's permission, and a list nobody ever sees is a
	// list that grows.
	for (const e of exceptions)
		console.log(`  ${e.file} → ${e.targets.join(', ')}  (${e.id})`)
	process.exit(0)
}
console.error(`✗ ${violations.length} owned-write violation(s):\n`)
for (const v of violations) console.error(`  ${v}`)
console.error(`\nPolicy: CONTRIBUTING.md. The registry is ${CONFIG_PATH}.`)
process.exit(1)
