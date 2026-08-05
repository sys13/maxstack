/**
 * The review-cost opt-in gate.
 *
 * The assertion that matters most is the boring one: **default off**. Everything
 * else in #201 is a measurement question; this is a consent question, and the
 * failure mode is not a wrong number but instrumenting somebody's project because
 * we shipped the runtime they installed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reviewCostSummary, reviewMetricsMode } from './review-cost.server'

/** The env keys this suite manipulates, restored after each test. */
const KEYS = ['MAXSTACK_REVIEW_METRICS', 'MAXSTACK_DATA_DIR', 'VITEST'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
	saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
})

afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k]
		else process.env[k] = saved[k]
	}
})

/** A project dir with the given `maxstack.json`, wired as the data dir. */
async function project(config: Record<string, unknown>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'maxstack-reviewcost-'))
	await writeFile(
		join(dir, 'maxstack.json'),
		JSON.stringify({ name: 'fixture', ...config }),
	)
	process.env.MAXSTACK_DATA_DIR = dir
	return dir
}

describe('reviewMetricsMode', () => {
	it('is off when no project config says otherwise', async () => {
		const dir = await project({})
		try {
			expect(reviewMetricsMode()).toBe('off')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('is off for a project that has no config at all', () => {
		delete process.env.MAXSTACK_DATA_DIR
		delete process.env.MAXSTACK_REVIEW_METRICS
		expect(reviewMetricsMode()).toBe('off')
	})

	it('is on when the project opted in', async () => {
		const dir = await project({ reviewMetrics: 'local' })
		try {
			expect(reviewMetricsMode()).toBe('local')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('lets the env turn it on for one session', async () => {
		const dir = await project({})
		try {
			process.env.MAXSTACK_REVIEW_METRICS = 'local'
			expect(reviewMetricsMode()).toBe('local')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('lets the env turn it OFF over a config that opted in', async () => {
		// The direction that matters for a config somebody inherited from a
		// template: opting out must not require editing a file.
		const dir = await project({ reviewMetrics: 'local' })
		try {
			process.env.MAXSTACK_REVIEW_METRICS = 'off'
			expect(reviewMetricsMode()).toBe('off')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('refuses any value that is not exactly off or local', async () => {
		const dir = await project({})
		try {
			for (const value of ['on', 'true', '1', 'hosted', 'LOCAL', 'yes']) {
				process.env.MAXSTACK_REVIEW_METRICS = value
				expect(reviewMetricsMode(), `"${value}" enabled metrics`).toBe('off')
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('is off when the config is malformed', async () => {
		// An unreadable config must never be the reason telemetry switches on.
		const dir = await mkdtemp(join(tmpdir(), 'maxstack-reviewcost-bad-'))
		try {
			await writeFile(join(dir, 'maxstack.json'), '{ not json')
			process.env.MAXSTACK_DATA_DIR = dir
			delete process.env.MAXSTACK_REVIEW_METRICS
			expect(reviewMetricsMode()).toBe('off')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('finds the config from a nested data dir', async () => {
		// `maxstack dev` points the data dir at `<root>/.maxstack`, so the config is
		// a level up. A gate that only looked in the data dir would read every real
		// CLI project as un-instrumented.
		const root = await mkdtemp(join(tmpdir(), 'maxstack-reviewcost-nested-'))
		try {
			await writeFile(
				join(root, 'maxstack.json'),
				JSON.stringify({ name: 'nested', reviewMetrics: 'local' }),
			)
			process.env.MAXSTACK_DATA_DIR = join(root, '.maxstack')
			delete process.env.MAXSTACK_REVIEW_METRICS
			expect(reviewMetricsMode()).toBe('local')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('agreement with the CLI host', () => {
	/**
	 * The same table `apps/maxstack/src/lib/review-cost.test.ts` asserts against
	 * `reviewMetricsEnabled`. The rule is written twice — the boundary policy
	 * forbids the CLI importing this app — and a divergence would be a *consent*
	 * bug: one surface measuring a project the other correctly treats as opted out.
	 * Enumerated case by case rather than left to two readings of the same prose.
	 */
	const CASES: [
		description: string,
		reviewMetrics: string | undefined,
		env: string | undefined,
		expected: 'off' | 'local',
	][] = [
		['nothing configured', undefined, undefined, 'off'],
		['config off', 'off', undefined, 'off'],
		['config local', 'local', undefined, 'local'],
		['env local over nothing', undefined, 'local', 'local'],
		['env local over config off', 'off', 'local', 'local'],
		['env off over config local', 'local', 'off', 'off'],
		['env garbage over config local', 'local', 'yes', 'local'],
		['env garbage over nothing', undefined, 'yes', 'off'],
		['env uppercase is not local', undefined, 'LOCAL', 'off'],
		['env "true" is not local', undefined, 'true', 'off'],
		['env "1" is not local', undefined, '1', 'off'],
		['env "hosted" is not local', undefined, 'hosted', 'off'],
	]

	for (const [description, reviewMetrics, env, expected] of CASES) {
		it(`${description} → ${expected}`, async () => {
			const dir = await project(
				reviewMetrics === undefined ? {} : { reviewMetrics },
			)
			try {
				if (env === undefined) delete process.env.MAXSTACK_REVIEW_METRICS
				else process.env.MAXSTACK_REVIEW_METRICS = env
				expect(reviewMetricsMode()).toBe(expected)
			} finally {
				await rm(dir, { recursive: true, force: true })
			}
		})
	}
})

describe('reviewCostSummary', () => {
	it('is null — not zero — when the project has not opted in', async () => {
		// A zero would let a comparison treat an un-instrumented arm as a fast one.
		const dir = await project({})
		try {
			expect(await reviewCostSummary()).toBeNull()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
