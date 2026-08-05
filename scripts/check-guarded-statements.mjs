#!/usr/bin/env node

/**
 * A braceless `if`/`else` may not have an empty statement for a body.
 *
 * This repo's style omits semicolons, so a statement that begins with `(` or `[`
 * is written with a leading `;`. Put that form in the body of a braceless `if`
 * and `biome format` rewrites
 *
 *     if (cond) ;(expr)
 *
 * into
 *
 *     if (cond);
 *     (expr)
 *
 * which is valid, formatted, type-checking, lint-clean — and different code. The
 * `if` now guards an empty statement and the expression runs unconditionally. It
 * was found by reading a diff, which is not a control that scales, so this is the
 * mechanical version of that read.
 *
 * Both shapes are violations: the source form is the trap, and the formatted form
 * is the damage. Neither is ever what anyone meant — an intentionally empty branch
 * is written `{}`, which this gate allows and `noEmptyBlockStatements` judges.
 *
 * Exits 0 when clean; prints file:line pointers and exits 1 on violations.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs)$/
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
 * Pinned fixture trees are read as bytes by other gates and
 * templates are emitted, not compiled here — neither is source this repo formats.
 */
const SKIP_PATHS = new Set(['apps/maxstack/templates'])

/** Recursively list source files under dir. */
function sourceFiles(dir) {
	/** @type {string[]} */
	const out = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		const rel = relative(root, full).split('\\').join('/')
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(rel))
				out.push(...sourceFiles(full))
		} else if (SOURCE_RE.test(entry.name)) {
			out.push(full)
		}
	}
	return out
}

/**
 * Replace the contents of comments and string/template literals with spaces,
 * preserving every character position and line break so reported line numbers
 * still point at the real source.
 *
 * This is a scanner, not a parser: it does not track regex literals, so a regex
 * containing an unpaired quote could desynchronize it. That is tolerable because
 * the failure mode is a false positive on a construct nobody writes, and the gate
 * is verified clean against the whole workspace — a desync would show up as noise
 * immediately, not silently.
 */
function blankLiterals(source) {
	const out = source.split('')
	let i = 0
	const blankTo = (end) => {
		for (; i < end && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '
	}
	while (i < source.length) {
		const ch = source[i]
		const next = source[i + 1]
		if (ch === '/' && next === '/') {
			const end = source.indexOf('\n', i)
			blankTo(end === -1 ? source.length : end)
		} else if (ch === '/' && next === '*') {
			const end = source.indexOf('*/', i + 2)
			blankTo(end === -1 ? source.length : end + 2)
		} else if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch
			let j = i + 1
			while (j < source.length) {
				if (source[j] === '\\') j += 2
				else if (source[j] === quote) break
				else j++
			}
			i++ // keep the opening quote so the token boundary survives
			blankTo(j)
			i = j + 1
		} else {
			i++
		}
	}
	return out.join('')
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(source, open) {
	let depth = 0
	for (let i = open; i < source.length; i++) {
		if (source[i] === '(') depth++
		else if (source[i] === ')' && --depth === 0) return i
	}
	return -1
}

/** First index at or after `from` holding a non-whitespace character. */
function skipSpace(source, from) {
	let i = from
	while (i < source.length && /\s/.test(source[i])) i++
	return i
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length

/** @type {{ file: string, line: number, message: string }[]} */
const violations = []

for (const file of sourceFiles(root)) {
	const original = readFileSync(file, 'utf8')
	if (!original.includes(';')) continue
	const code = blankLiterals(original)
	const rel = relative(root, file).split('\\').join('/')

	// `if (…)` — the body starts after the condition's closing paren.
	for (const match of code.matchAll(/\bif\s*\(/g)) {
		const open = match.index + match[0].length - 1
		const close = matchParen(code, open)
		if (close === -1) continue
		const body = skipSpace(code, close + 1)
		if (code[body] === ';')
			violations.push({
				file: rel,
				line: lineOf(code, body),
				message:
					'braceless `if` with an empty statement for a body — the condition guards nothing',
			})
	}

	// `else` — same trap, one keyword earlier. `else if` is untouched.
	for (const match of code.matchAll(/\belse\b/g)) {
		const body = skipSpace(code, match.index + match[0].length)
		if (code[body] === ';')
			violations.push({
				file: rel,
				line: lineOf(code, body),
				message:
					'braceless `else` with an empty statement for a body — the branch runs nothing',
			})
	}
}

if (violations.length === 0) {
	console.log('✓ no empty-bodied `if`/`else` branches')
	process.exit(0)
}
console.error(`✗ ${violations.length} empty-bodied branch(es):\n`)
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.message}`)
console.error(
	`
This is almost always the biome-format rewrite of a \`;\`-prefixed body:

    if (cond) ;(expr)     ->     if (cond);
                                 (expr)

The expression now runs unconditionally. Brace the body instead:

    if (cond) {
      ;(expr)
    }
`,
)
process.exit(1)
