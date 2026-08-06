#!/usr/bin/env node

/**
 * The built server bundle must have no cycles between its chunks.
 *
 * Why this is a gate and not a lint rule: a chunk cycle is invisible to every
 * other check we run. `pnpm validate` type-checks, lints and unit-tests the
 * *sources*, and none of those stages emits a chunk — the cycle is a property
 * of how the bundler grouped modules, which only exists after a build.
 *
 * And it is not a tidiness concern. Chunks initialize in one order. A
 * module-level binding that reads a value from the other side of a cycle can
 * evaluate before that value exists, so a `const` spreading an imported array
 * sees `undefined` and the process dies at boot with "is not iterable" — for a
 * symbol the type system guarantees is an array, in code that passed every
 * test. That is not hypothetical: it is how the first production boot of this
 * repo failed, on `SPEC_OP_NAMES` in `@maxstack/mcp`.
 *
 * `apps/web/vite.config.ts` groups each workspace package into one chunk, which
 * makes the specific cycle that caused that impossible. This asserts the
 * property rather than trusting the config to keep holding — a future
 * `advancedChunks` edit, a new package, or a bundler upgrade could reintroduce
 * one, and the failure it produces is a boot crash rather than a build error.
 *
 * Run after a build:
 *   pnpm --filter @maxstack/web build && node scripts/check-chunk-cycles.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = resolve(root, 'apps/web/build/server')

/** Every emitted chunk, recursively. Source maps are not code. */
function chunks(dir) {
	const out = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) out.push(...chunks(full))
		else if (entry.endsWith('.js')) out.push(full)
	}
	return out
}

let files
try {
	files = chunks(buildDir)
} catch {
	console.error(
		`no build at ${relative(root, buildDir)} — run \`pnpm --filter @maxstack/web build\` first.\n` +
			'This check reads emitted chunks; there is nothing to check before a build.',
	)
	process.exit(1)
}

if (files.length === 0) {
	console.error(`${relative(root, buildDir)} has no .js chunks — build failed?`)
	process.exit(1)
}

// Static imports only. A *dynamic* import across a cycle is fine — it resolves
// at call time, long after both chunks have initialized — so counting it would
// report cycles that cannot produce the boot failure this exists to catch.
const IMPORT =
	/(?:^|[\s;}])(?:import|export)[^'"]*?from\s*"([^"]+\.js)"|(?:^|[\s;}])import\s*"([^"]+\.js)"/g

/** @type {Map<string, Set<string>>} */
const edges = new Map()
for (const file of files) {
	const source = readFileSync(file, 'utf8')
	const targets = new Set()
	for (const match of source.matchAll(IMPORT)) {
		const spec = match[1] ?? match[2]
		if (!spec.startsWith('.')) continue
		const target = resolve(dirname(file), spec)
		if (target !== file && files.includes(target)) targets.add(target)
	}
	edges.set(file, targets)
}

/** Tarjan's SCC. Any component of >1 chunk is a cycle. */
function stronglyConnected() {
	const index = new Map()
	const low = new Map()
	const onStack = new Set()
	const stack = []
	const found = []
	let counter = 0

	for (const start of edges.keys()) {
		if (index.has(start)) continue
		// Iterative: the chunk graph is small, but a recursive walk over a
		// pathological one would blow the stack and report as a crash, not a
		// finding.
		const work = [[start, 0]]
		while (work.length > 0) {
			const frame = work[work.length - 1]
			const [node, childIndex] = frame
			if (childIndex === 0) {
				index.set(node, counter)
				low.set(node, counter)
				counter += 1
				stack.push(node)
				onStack.add(node)
			}
			const children = [...(edges.get(node) ?? [])]
			let descended = false
			for (let i = childIndex; i < children.length; i++) {
				const child = children[i]
				if (!index.has(child)) {
					frame[1] = i + 1
					work.push([child, 0])
					descended = true
					break
				}
				if (onStack.has(child)) {
					low.set(node, Math.min(low.get(node), index.get(child)))
				}
			}
			if (descended) continue

			if (low.get(node) === index.get(node)) {
				const component = []
				let popped
				do {
					popped = stack.pop()
					onStack.delete(popped)
					component.push(popped)
				} while (popped !== node)
				if (component.length > 1) found.push(component)
			}
			work.pop()
			if (work.length > 0) {
				const parent = work[work.length - 1][0]
				low.set(parent, Math.min(low.get(parent), low.get(node)))
			}
		}
	}
	return found
}

const cycles = stronglyConnected()
const name = (f) => relative(buildDir, f)

if (cycles.length > 0) {
	console.error(
		`${cycles.length} chunk cycle(s) in ${relative(root, buildDir)}:\n`,
	)
	for (const component of cycles) {
		console.error(`  cycle across ${component.length} chunks:`)
		for (const file of component.sort()) console.error(`    ${name(file)}`)
		// Name the crossing edges — the cycle is usually one stray symbol, and
		// without this the report says "these two chunks" and leaves the reader to
		// diff two megabytes of generated code to find out why.
		console.error('\n  edges inside the cycle:')
		for (const file of component) {
			for (const target of edges.get(file) ?? []) {
				if (component.includes(target)) {
					console.error(`    ${name(file)} → ${name(target)}`)
				}
			}
		}
		console.error('')
	}
	console.error(
		'A cycle means chunk initialization order decides whether a module-level\n' +
			'binding is defined when another chunk reads it. Group the packages\n' +
			'involved into one chunk in `apps/web/vite.config.ts` (`advancedChunks`),\n' +
			'or move the shared symbol so the import goes one way only.',
	)
	process.exit(1)
}

const edgeCount = [...edges.values()].reduce((n, set) => n + set.size, 0)
console.log(
	`chunk graph acyclic — ${files.length} chunks, ${edgeCount} static edges`,
)
