#!/usr/bin/env node

/**
 * MAXSTACK validate gate.
 *
 * Runs the standard chain from the design (§3-L2):
 *   typecheck && lint && test  (e2e && spec-validate wired in later phases)
 *
 * A single command that either exits 0 (green) or reports which step failed.
 * Pass --fix to auto-fix lint before validating.
 *
 * `--skip=a,b` drops named steps. It exists for one caller: CI splits this gate
 * into a checks job and a matrix of test shards, so the checks job
 * runs `--skip=test` and the shards run the tests on their own runners. An
 * unknown name is a hard error — a skip list that silently matches nothing
 * would quietly stop running a step while still reporting green.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const c = {
	red: '\x1b[31m',
	green: '\x1b[32m',
	blue: '\x1b[34m',
	dim: '\x1b[2m',
	reset: '\x1b[0m',
}

const fix = process.argv.includes('--fix')

/** @type {{ name: string, cmd: string, args: string[] }[]} */
const steps = [
	{ name: 'lint', cmd: 'pnpm', args: ['run', fix ? 'lint:fix' : 'lint'] },
	{ name: 'boundaries', cmd: 'node', args: ['scripts/check-boundaries.mjs'] },
	// Write-path coverage: every place that can land a spec op is
	// declared and covered by an invariant test. An allowlist, so a new way to
	// write the spec fails until somebody accounts for it. Runs here as well as in
	// CI's ownership-safety job because it costs milliseconds and the failure it
	// catches — a write path nobody attributed — is cheapest to see before pushing.
	{ name: 'write-paths', cmd: 'node', args: ['scripts/check-write-paths.mjs'] },
	// The filesystem half of the same idea: a destructive write to a path a
	// user's owned code can live at may only come from the ownership layer or
	// from a target this registry names. The spec-op registry above could never
	// have caught issue #360 — `add view` clobbered an ejected module with a bare
	// `fs.write`, which touches no op at all — and an overwritten owned file is
	// worse than an unattributed op, because an op is logged and revertible.
	{
		name: 'owned-writes',
		cmd: 'node',
		args: ['scripts/check-owned-writes.mjs'],
	},
	// A braceless `if`/`else` may not guard an empty statement:
	// biome rewrites `if (cond) ;(expr)` into two statements and the expression
	// stops being guarded. It formats, typechecks and lints — only a diff read
	// catches it, so read it mechanically.
	{
		name: 'guarded-statements',
		cmd: 'node',
		args: ['scripts/check-guarded-statements.mjs'],
	},
	// No route module may reach a compiler: the ownership barrel
	// pulls ts-morph, React Router puts route modules in the client bundle, and
	// the resulting page server-renders correctly and then does nothing. The
	// production build tree-shakes it away, so only `pnpm dev` — the loop a
	// maintainer actually uses to dogfood — is broken, and only in the console.
	{
		name: 'client-safe-imports',
		cmd: 'node',
		args: ['scripts/check-client-safe-imports.mjs'],
	},
	// No gate may be disarmed in silence. Swallowed exit codes, non-failing CI
	// steps, skipped tests and fresh lint suppressions all turn a red signal
	// green while leaving the check apparently still in place — the one failure
	// mode a test suite cannot catch, because the suite is what got weakened.
	// The exact patterns are listed in the checker itself.
	{
		name: 'test-integrity',
		cmd: 'node',
		args: ['scripts/check-test-integrity.mjs'],
	},
	// The generated reference docs must match their source — a new CLI flag or
	// spec-op that never made it into docs/ is a stale-docs bug we can catch
	// mechanically.
	{
		name: 'docs-reference',
		cmd: 'pnpm',
		args: ['run', 'check:docs-reference'],
	},
	// Every package with a `test` task is named by exactly one CI shard, and no
	// shard resolves to zero test files. Runs here rather than only in CI
	// because the failure it catches — a new package whose tests no shard runs
	// — is invisible by construction: the gate stays green, having quietly
	// stopped testing something.
	{
		name: 'test-shards',
		cmd: 'node',
		args: ['scripts/test-shards.mjs', 'check'],
	},
	{ name: 'typecheck', cmd: 'pnpm', args: ['run', 'typecheck'] },
	{ name: 'test', cmd: 'pnpm', args: ['run', 'test'] },
]

const skipArg = process.argv.find((a) => a.startsWith('--skip='))
const skip = skipArg
	? skipArg.slice('--skip='.length).split(',').filter(Boolean)
	: []
const unknown = skip.filter((n) => !steps.some((s) => s.name === n))
if (unknown.length > 0) {
	console.error(
		`${c.red}✗ validate: --skip names no such step: ${unknown.join(', ')}${c.reset}`,
	)
	console.error(`  known steps: ${steps.map((s) => s.name).join(', ')}`)
	process.exit(1)
}
const selected = steps.filter((s) => !skip.includes(s.name))

function run({ cmd, args }) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: true })
		child.on('close', (code) => resolve(code === 0))
		child.on('error', () => resolve(false))
	})
}

const failed = []
if (skip.length > 0)
	console.log(`${c.dim}(skipping: ${skip.join(', ')})${c.reset}`)
for (const step of selected) {
	console.log(`\n${c.blue}=== validate: ${step.name} ===${c.reset}`)
	const ok = await run(step)
	if (!ok) failed.push(step.name)
}

console.log('')
if (failed.length === 0)
	console.log(`${c.green}✓ validate gate green${c.reset}`)
else
	console.log(`${c.red}✗ validate gate failed: ${failed.join(', ')}${c.reset}`)

// The second opinion, last thing on screen. A green gate here proves the tree is
// good *on this machine*; CI runs on a Linux runner with none of a developer's
// environment, and when a test reads the machine the two disagree while this
// line keeps saying green. That is not hypothetical — #363 is fifteen
// consecutive commits of red CI behind a green local gate, unnoticed because
// looking at CI was a habit rather than a step.
//
// It is a report, never a gate: it cannot fail this run, and it cannot hang it.
// Skipped under CI, where it would only be reporting on itself.
if (!process.env.CI) {
	console.log('')
	await run({ cmd: 'node', args: ['scripts/report-ci-status.mjs'] })
}

process.exit(failed.length === 0 ? 0 : 1)
