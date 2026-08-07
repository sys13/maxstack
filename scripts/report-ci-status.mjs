#!/usr/bin/env node

/**
 * The second opinion, reported where somebody is already looking.
 *
 * A green `pnpm validate` is not proof the tree is good — it is proof the tree
 * is good *on this machine*. CI runs on a Linux runner, sharded, with no global
 * `maxstack` on PATH and none of a maintainer's environment. When a test reads
 * the machine, the two disagree, and the local gate keeps saying green.
 *
 * That is not a hypothetical: issue #363 is fifteen consecutive commits of red
 * CI, every one of them behind a green local gate, because `init.test.ts`
 * asserted on a warning that fires only when no usable `maxstack` is on PATH —
 * false on the maintainer's laptop, true on the runner. Nobody looked at CI for
 * fifteen commits, so nobody knew.
 *
 * Looking at CI is a habit, and the fifteen commits are the evidence that habits
 * fail. This makes it a mechanism: `pnpm validate` ends by telling you what the
 * last CI run on `origin/main` did. It would have surfaced that on commit one.
 *
 * ## What this is not
 *
 * It is **not a gate**. It never fails, never blocks, and never makes the
 * validate gate red — not when CI is red, not when `gh` is missing, not when the
 * network is down. A report that can fail your local run for someone else's
 * broken push is a report you learn to skip, and skipping is the disease. Every
 * exit path here is 0, including the internal-error path.
 *
 * It is also **not a substitute for reading the run**. It prints a URL. A red
 * line here means open it.
 *
 * ## Degrading
 *
 * `gh` absent, unauthenticated, offline, rate-limited, or just slow all collapse
 * to one outcome: a dimmed "unknown" line naming the reason. The probe is killed
 * at a hard wall-clock deadline, so no network condition can hang the gate — the
 * failure mode of a check that hangs is that the whole gate gets bypassed.
 *
 * Dependency-free Node, like the other scripts here.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Hard wall-clock ceiling for the whole probe.
 *
 * `--timeout=<ms>` overrides it, which exists so the degrade path can be
 * exercised by hand against a deliberately slow `gh`. Deliberately *not* an
 * environment variable: this file's whole subject is code that reads the
 * machine, and turbo's strict-env mode would strip an undeclared one anyway.
 */
const timeoutArg = process.argv.find((a) => a.startsWith('--timeout='))
const TIMEOUT_MS = timeoutArg
	? Number(timeoutArg.slice('--timeout='.length))
	: 8000

/** The workflow that *is* the gate. `release.yml` is not a health signal. */
const WORKFLOW = 'ci.yml'
const BRANCH = 'main'

const c = {
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	dim: '\x1b[2m',
	reset: '\x1b[0m',
}

// ---------------------------------------------------------------------------
// Classification (pure — self-tested below)
// ---------------------------------------------------------------------------

/**
 * @typedef {{status: string, conclusion: string, headSha: string, url: string,
 *            displayTitle: string, createdAt: string}} Run
 */

/**
 * Reduce `gh run list` output to the one line a human needs.
 *
 * The newest run is often still `in_progress`, which is not an answer — so the
 * newest *completed* run is the verdict, and an in-flight run is reported beside
 * it rather than instead of it. Reporting only the newest would print "pending"
 * forever on a repo that pushes often, which is indistinguishable from working.
 *
 * @param {Run[]} runs newest-first, as `gh run list` returns them
 * @param {string|null} originSha `origin/main`, to detect a verdict that predates it
 * @returns {{level: 'green'|'red'|'unknown', headline: string, detail: string[]}}
 */
export function summarize(runs, originSha) {
	if (!Array.isArray(runs) || runs.length === 0)
		return {
			level: 'unknown',
			headline: 'no CI runs found for this branch',
			detail: [],
		}

	const pending = runs.find((r) => r.status !== 'completed')
	const done = runs.find((r) => r.status === 'completed')

	if (!done)
		return {
			level: 'unknown',
			headline: `CI is still running on ${short(pending?.headSha)} — no verdict yet`,
			detail: pending?.url ? [pending.url] : [],
		}

	const detail = []
	const title = (done.displayTitle ?? '').trim()
	detail.push(`${short(done.headSha)}  ${truncate(title, 68)}`)
	if (done.url) detail.push(done.url)

	// A verdict on a sha that is no longer the tip is a verdict about older code.
	// Saying "green" about it without saying so is the same false comfort the
	// local gate was already giving.
	if (originSha && done.headSha && done.headSha !== originSha)
		detail.push(
			`${short(done.headSha)} is not origin/${BRANCH} (${short(originSha)}) — this verdict predates the tip`,
		)
	if (pending)
		detail.push(`a newer run is still in progress on ${short(pending.headSha)}`)

	if (done.conclusion === 'success')
		return {
			level: 'green',
			headline: `last CI run on origin/${BRANCH} passed`,
			detail,
		}
	if (done.conclusion === 'cancelled' || done.conclusion === 'skipped')
		return {
			level: 'unknown',
			headline: `last CI run on origin/${BRANCH} was ${done.conclusion} — no verdict`,
			detail,
		}
	return {
		level: 'red',
		headline: `last CI run on origin/${BRANCH} FAILED (${done.conclusion || 'failure'})`,
		detail,
	}
}

const short = (sha) => (sha ? sha.slice(0, 7) : '?')
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ---------------------------------------------------------------------------
// Self-test — prove the classifier before trusting what it prints
// ---------------------------------------------------------------------------
//
// Same reasoning as check-owned-writes.mjs: a reporter that always says
// "unknown" looks exactly like a reporter with nothing to report. The shapes
// below are real `gh run list` payloads from this repo, including the exact one
// that was on screen during #363 — newest run in flight, newest completed run a
// failure. If the classifier cannot call that red, it does not get to print.

const CASES = [
	{
		name: 'the #363 shape: newest in flight, newest completed is a failure',
		runs: [
			{ status: 'in_progress', conclusion: '', headSha: 'a'.repeat(40) },
			{ status: 'completed', conclusion: 'failure', headSha: 'b'.repeat(40) },
		],
		origin: 'a'.repeat(40),
		expect: 'red',
	},
	{
		name: 'a clean tip',
		runs: [
			{ status: 'completed', conclusion: 'success', headSha: 'c'.repeat(40) },
		],
		origin: 'c'.repeat(40),
		expect: 'green',
	},
	{
		name: 'timed out counts as red, not as unknown',
		runs: [
			{ status: 'completed', conclusion: 'timed_out', headSha: 'd'.repeat(40) },
		],
		origin: 'd'.repeat(40),
		expect: 'red',
	},
	{
		name: 'a cancelled run is not a verdict either way',
		runs: [
			{ status: 'completed', conclusion: 'cancelled', headSha: 'e'.repeat(40) },
		],
		origin: 'e'.repeat(40),
		expect: 'unknown',
	},
	{
		name: 'nothing completed yet',
		runs: [{ status: 'queued', conclusion: '', headSha: 'f'.repeat(40) }],
		origin: 'f'.repeat(40),
		expect: 'unknown',
	},
	{ name: 'no runs at all', runs: [], origin: null, expect: 'unknown' },
]

for (const { name, runs, origin, expect } of CASES) {
	const got = summarize(
		runs.map((r) => ({ url: '', displayTitle: '', createdAt: '', ...r })),
		origin,
	)
	if (got.level !== expect) {
		// Even this refuses to fail the gate — but it says so loudly, because a
		// broken reporter is worse than none: it is a green light nobody checked.
		console.error(
			`${c.yellow}! ci-status reporter is broken: "${name}" classified ${got.level}, expected ${expect}${c.reset}`,
		)
		process.exit(0)
	}
}

// A green verdict on a stale sha must still say the sha is stale — the "green"
// half is true and the missing half is the whole point.
{
	const got = summarize(
		[
			{
				status: 'completed',
				conclusion: 'success',
				headSha: '1'.repeat(40),
				url: '',
				displayTitle: '',
				createdAt: '',
			},
		],
		'2'.repeat(40),
	)
	if (!got.detail.some((d) => d.includes('predates the tip'))) {
		console.error(
			`${c.yellow}! ci-status reporter is broken: a stale green did not say it was stale${c.reset}`,
		)
		process.exit(0)
	}
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Run a command with a hard deadline. Resolves `{ok, stdout, reason}` and never
 * rejects — every failure is data, because the caller has nothing to do with an
 * exception but swallow it anyway.
 */
function capture(cmd, args, timeoutMs) {
	return new Promise((resolve) => {
		let child
		try {
			child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
		} catch {
			return resolve({ ok: false, reason: `${cmd} could not be started` })
		}
		let stdout = ''
		let stderr = ''
		let settled = false
		const finish = (v) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(v)
		}
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL')
			} catch {
				/* already gone */
			}
			finish({ ok: false, reason: `${cmd} did not answer in ${timeoutMs}ms` })
		}, timeoutMs)
		timer.unref?.()
		child.stdout.on('data', (d) => {
			stdout += d
		})
		child.stderr.on('data', (d) => {
			stderr += d
		})
		child.on('error', () =>
			finish({ ok: false, reason: `${cmd} is not installed` }),
		)
		child.on('close', (code) =>
			finish(
				code === 0
					? { ok: true, stdout }
					: {
							ok: false,
							reason: firstLine(stderr) || `${cmd} exited ${code}`,
						},
			),
		)
	})
}

const firstLine = (s) =>
	s
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)[0] ?? ''

function note(reason) {
	console.log(
		`${c.dim}· CI status on origin/${BRANCH}: unknown — ${reason}${c.reset}`,
	)
	console.log(
		`${c.dim}  (a local gate only proves this machine; check ${'https://github.com/sys13/maxstack/actions'})${c.reset}`,
	)
}

async function main() {
	const started = Date.now()

	const originShaResult = await capture(
		'git',
		['rev-parse', `origin/${BRANCH}`],
		2000,
	)
	const originSha = originShaResult.ok ? originShaResult.stdout.trim() : null

	const remaining = Math.max(1000, TIMEOUT_MS - (Date.now() - started))
	const res = await capture(
		'gh',
		[
			'run',
			'list',
			'--workflow',
			WORKFLOW,
			'--branch',
			BRANCH,
			'--limit',
			'10',
			'--json',
			'status,conclusion,headSha,url,displayTitle,createdAt',
		],
		remaining,
	)
	if (!res.ok) return note(res.reason)

	let runs
	try {
		runs = JSON.parse(res.stdout)
	} catch {
		return note('gh returned something that was not JSON')
	}

	const { level, headline, detail } = summarize(runs, originSha)
	const mark = level === 'green' ? '✓' : level === 'red' ? '✗' : '·'
	const colour = level === 'green' ? c.green : level === 'red' ? c.red : c.dim
	console.log(`${colour}${mark} ${headline}${c.reset}`)
	for (const d of detail) console.log(`${c.dim}  ${d}${c.reset}`)
	if (level === 'red')
		console.log(
			`${c.dim}  Your local gate is green and CI is not. Something in this suite reads the\n` +
				`${c.dim}  machine, or the runner differs from your laptop. Do not push over it.${c.reset}`,
		)
}

try {
	await main()
} catch (err) {
	note(`the reporter itself errored (${err?.message ?? err})`)
}
// Belt and braces: nothing about someone else's CI may change this exit code.
process.exit(0)
