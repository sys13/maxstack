#!/usr/bin/env node

/**
 * Test-integrity gate.
 *
 * Every other check in this repo proves the code is right. This one proves the
 * checks themselves are still armed — the single failure mode a test suite
 * cannot catch, because the suite is what got weakened. A skipped test, a
 * swallowed exit code, a fresh lint suppression: each turns a red signal green
 * while leaving the check apparently still in place, and each is invisible in a
 * summary that only reports pass/fail.
 *
 * Two kinds of rule:
 *
 * - **Forbidden** — patterns with no sanctioned use here. The tree is at zero
 *   for all of them, so the bar is zero and any introduction is a hard failure.
 * - **Ratcheted** — patterns with legitimate uses that should only ever get
 *   rarer. The committed ceiling may be lowered, never raised. Lowering it is
 *   the point; raising it to accommodate a new suppression is how the ratchet
 *   becomes decoration.
 *
 * If a rule genuinely needs an exception, the honest move is to argue it in
 * review and lower the bar elsewhere — not to widen the pattern until the
 * gate stops matching.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SCAN_DIRS = ['apps', 'packages', 'examples', 'scripts', '.github']
const SCAN_EXT = /\.(ts|tsx|mjs|js|yml|yaml)$/
const IGNORE_DIRS = new Set([
	'node_modules',
	'dist',
	'dist-npm',
	'build',
	'.turbo',
	'.react-router',
	'templates',
	'coverage',
])

/** This file names every pattern it forbids, so it must not scan itself. */
const SELF = relative(root, fileURLToPath(import.meta.url))

const RULES = [
	{
		name: 'skipped tests',
		re: /\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/g,
		max: 0,
		why: 'A skipped test reports as passing. Delete it or fix it.',
	},
	{
		name: 'focused tests',
		re: /\b(?:it|test|describe)\s*\.\s*only\s*\(/g,
		max: 0,
		why: '`.only` silently stops running every other test in the file.',
	},
	{
		name: 'swallowed exit codes',
		re: /\|\|\s*true\b/g,
		max: 0,
		why: 'A command that cannot fail is not a check.',
	},
	{
		name: 'continue-on-error',
		re: /continue-on-error\s*:\s*true/g,
		max: 0,
		why: 'A CI step that cannot fail the job is not a gate.',
	},
	{
		name: 'typechecker suppressions',
		re: /@ts-(?:ignore|expect-error|nocheck)\b/g,
		max: 0,
		why: 'Fix the type or narrow it; do not silence the compiler.',
	},
	{
		name: 'lint suppressions',
		re: /biome-ignore\b/g,
		max: 52,
		why: 'Ratchet only goes down. Justify in review and lower the ceiling.',
	},
]

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
	let entries
	try {
		entries = readdirSync(dir)
	} catch {
		return out // an optional scan root that does not exist yet
	}
	for (const entry of entries) {
		if (IGNORE_DIRS.has(entry)) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) walk(full, out)
		else if (SCAN_EXT.test(entry)) out.push(full)
	}
	return out
}

const files = SCAN_DIRS.flatMap((d) => walk(join(root, d), []))

/** @type {Map<string, {file: string, line: number, text: string}[]>} */
const hits = new Map()
for (const rule of RULES) hits.set(rule.name, [])

for (const file of files) {
	const rel = relative(root, file)
	if (rel === SELF) continue
	const lines = readFileSync(file, 'utf8').split('\n')
	lines.forEach((text, i) => {
		for (const rule of RULES) {
			rule.re.lastIndex = 0
			if (rule.re.test(text)) {
				hits.get(rule.name).push({ file: rel, line: i + 1, text: text.trim() })
			}
		}
	})
}

const c = {
	red: '\x1b[31m',
	green: '\x1b[32m',
	dim: '\x1b[2m',
	reset: '\x1b[0m',
}
let failed = false

for (const rule of RULES) {
	const found = hits.get(rule.name)
	if (found.length <= rule.max) {
		const slack = rule.max - found.length
		console.log(
			`${c.green}✓${c.reset} ${rule.name}: ${found.length}/${rule.max}` +
				(slack > 0
					? `${c.dim} — ceiling can be lowered to ${found.length}${c.reset}`
					: ''),
		)
		continue
	}
	failed = true
	console.error(
		`${c.red}✗ ${rule.name}: ${found.length} found, ceiling is ${rule.max}${c.reset}`,
	)
	console.error(`  ${rule.why}`)
	for (const h of found.slice(0, 10)) {
		console.error(
			`${c.dim}    ${h.file}:${h.line}  ${h.text.slice(0, 100)}${c.reset}`,
		)
	}
	if (found.length > 10) {
		console.error(`${c.dim}    … and ${found.length - 10} more${c.reset}`)
	}
}

if (failed) {
	console.error(`\n${c.red}✗ test-integrity: a gate was weakened${c.reset}`)
	process.exit(1)
}
console.log(`${c.green}✓ test-integrity green${c.reset}`)
