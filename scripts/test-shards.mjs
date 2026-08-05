#!/usr/bin/env node

/**
 * Test-phase shards.
 *
 * `pnpm test` is `turbo run test --concurrency=50%`, the CI runner has 2 vCPUs,
 * and 50% of 2 is **1** — so the twelve test tasks ran strictly one after
 * another and the test phase was ~553s, the long pole of the whole PR gate.
 * Larger runners are configured in *organization* settings only and this repo
 * lives on a personal account, so the only way to buy parallelism is more
 * runners: a matrix of standard 2-core boxes, one job per shard.
 *
 * The risk that buys is not slowness, it is silence. A shard that matches no
 * package, or a new package that no shard names, runs zero tests and reports a
 * green check — the exact failure mode that hid every Postgres-gated test for
 * the life of two files (see `turbo.json`'s note on strict env mode). So the
 * shard table is not a list of `--filter` strings pasted into a workflow: it is
 * checked, on every shard, against the task list turbo itself derives.
 *
 * Three things must hold before any shard runs, and each is a hard failure:
 *
 *   1. every package turbo would run `test` for is named by exactly one shard
 *      (nothing dropped, nothing double-billed),
 *   2. every package a shard names actually has a `test` task (a rename or a
 *      typo fails loudly instead of quietly shrinking the run),
 *   3. every shard resolves to at least one package AND at least one file on
 *      disk that turbo hashes as a test file.
 *
 * (3) is the one that matters most: `vitest run --passWithNoTests` means a
 * package with no tests is green, so "the shard had packages" is not the same
 * claim as "the shard had tests". The counts are printed on every run, so the
 * run page says how much each shard covered rather than only that it passed.
 *
 * Usage:
 *   node scripts/test-shards.mjs check        # invariants only (fast, no tests)
 *   node scripts/test-shards.mjs run <shard>  # invariants, then that shard
 *   node scripts/test-shards.mjs list         # shard names as JSON (matrix input)
 */

import { execFileSync } from 'node:child_process'

/**
 * Balanced against measured CI durations: web 123s · core 91s · ui 74s ·
 * features 67s · maxstack 57s · spec-derive 20s · mcp 15s · examples 9s ·
 * spec 7s.
 *
 * Longest-first packing, so the four shards land at roughly 130/115/131/87s
 * and wall clock tends toward the slowest rather than the sum. The pairings
 * also keep the two heaviest pglite suites (`core`, `features`) in different
 * shards, since running them together is where the contention shows up.
 *
 * Rebalancing is safe: `check` refuses any table that drops a package or
 * empties a shard, so the only way to get this wrong is to get it wrong loudly.
 */
const SHARDS = {
	web: ['@maxstack/web', '@maxstack/spec'],
	core: ['@maxstack/core', '@maxstack/mcp', '@maxstack/examples'],
	cli: ['@maxstack/ui', 'maxstack'],
	features: ['@maxstack/features', '@maxstack/spec-derive'],
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/

const root = new URL('..', import.meta.url).pathname

/** Ask turbo which packages actually have a `test` task, and which files it hashes. */
function discover() {
	const out = execFileSync(
		'pnpm',
		['exec', 'turbo', 'run', 'test', '--dry=json', '--concurrency=1'],
		{ cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
	)
	const plan = JSON.parse(out)
	/** @type {Map<string, number>} package -> number of test files turbo hashes */
	const packages = new Map()
	for (const task of plan.tasks) {
		if (task.task !== 'test') continue
		const files = Object.keys(task.inputs ?? {}).filter((f) =>
			TEST_FILE.test(f),
		)
		packages.set(task.package, files.length)
	}
	return packages
}

function fail(lines) {
	console.error(`\n✗ test-shards: ${lines.join('\n  ')}\n`)
	process.exit(1)
}

/** Every invariant in the docblock. Returns per-shard test-file counts. */
function check() {
	const discovered = discover()
	const problems = []

	// (1) + (2): the declared union is exactly the discovered set.
	/** @type {Map<string, string[]>} package -> shards claiming it */
	const claimedBy = new Map()
	for (const [shard, pkgs] of Object.entries(SHARDS)) {
		for (const pkg of pkgs) {
			claimedBy.set(pkg, [...(claimedBy.get(pkg) ?? []), shard])
		}
	}
	for (const [pkg, shards] of claimedBy) {
		if (!discovered.has(pkg)) {
			problems.push(
				`shard "${shards[0]}" names ${pkg}, which has no \`test\` task — renamed or removed?`,
			)
		}
		if (shards.length > 1) {
			problems.push(
				`${pkg} is claimed by more than one shard: ${shards.join(', ')}`,
			)
		}
	}
	for (const pkg of discovered.keys()) {
		if (!claimedBy.has(pkg)) {
			problems.push(
				`${pkg} has a \`test\` task but no shard runs it — add it to SHARDS in scripts/test-shards.mjs`,
			)
		}
	}

	// (3): no shard covers nothing.
	/** @type {Record<string, number>} */
	const counts = {}
	for (const [shard, pkgs] of Object.entries(SHARDS)) {
		if (pkgs.length === 0) problems.push(`shard "${shard}" names no packages`)
		const files = pkgs.reduce((n, pkg) => n + (discovered.get(pkg) ?? 0), 0)
		counts[shard] = files
		if (files === 0) {
			problems.push(
				`shard "${shard}" resolves to zero test files — it would pass green having run nothing`,
			)
		}
	}

	if (problems.length > 0) fail(problems)
	return { counts, discovered }
}

const [mode, arg] = process.argv.slice(2)

if (mode === 'list') {
	console.log(JSON.stringify(Object.keys(SHARDS)))
	process.exit(0)
}

if (mode === 'check') {
	const { counts, discovered } = check()
	const total = [...discovered.values()].reduce((a, b) => a + b, 0)
	console.log(
		`✓ test-shards: ${discovered.size} packages / ${total} test files across ${Object.keys(SHARDS).length} shards`,
	)
	for (const [shard, n] of Object.entries(counts)) {
		console.log(
			`  ${shard.padEnd(8)} ${String(n).padStart(3)} test files  (${SHARDS[shard].join(', ')})`,
		)
	}
	process.exit(0)
}

if (mode === 'run') {
	if (!arg || !(arg in SHARDS)) {
		fail([
			`unknown shard "${arg}" — expected one of: ${Object.keys(SHARDS).join(', ')}`,
		])
	}
	const { counts } = check()
	console.log(
		`▸ shard "${arg}": ${counts[arg]} test files in ${SHARDS[arg].length} packages — ${SHARDS[arg].join(', ')}\n`,
	)
	// Concurrency stays at the repo default rather than rising to 100%: the box
	// still has 2 vCPUs and vitest sizes its own pool per core, and #67/#224 were
	// both closed by narrowing that pipe. The parallelism bought here is more
	// runners, deliberately, not more contention on one.
	const args = ['exec', 'turbo', 'run', 'test', '--concurrency=50%']
	for (const pkg of SHARDS[arg]) args.push(`--filter=${pkg}`)
	try {
		execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' })
	} catch {
		process.exit(1)
	}
	process.exit(0)
}

fail(['expected one of: check | run <shard> | list'])
