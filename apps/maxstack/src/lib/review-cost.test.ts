/**
 * The CLI's review-cost host, and the agreement between the two
 * places the opt-in rule is written.
 *
 * `reviewMetricsEnabled` here and `reviewMetricsMode` in
 * `apps/web/app/workbench/review-cost.server.ts` implement the same rule twice —
 * unavoidably, since the boundary policy forbids the CLI importing the web app.
 * A silent divergence between them would be a **consent** bug: one surface
 * measuring a project the other correctly treats as opted out. So the rule is
 * enumerated case by case here rather than left to two readings of the same prose.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeEvents, type WorkbenchEvent } from '@maxstack/core/review'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type ProjectConfig } from './project.ts'
import {
	projectReviewCost,
	readWorkbenchEvents,
	reviewMetricsEnabled,
} from './review-cost.ts'

const dirs: string[] = []
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true })
	}
})

async function tempDir(prefix = 'maxstack-review-cost-'): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
}

const config = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({
	...DEFAULT_CONFIG,
	name: 'fixture',
	...over,
})

describe('reviewMetricsEnabled — the opt-in rule, case by case', () => {
	/**
	 * Every case, as data. The web host's suite asserts the identical table against
	 * its own reader; if either surface changes the rule, one of the two goes red.
	 */
	const CASES: [
		description: string,
		reviewMetrics: ProjectConfig['reviewMetrics'],
		env: string | undefined,
		expected: boolean,
	][] = [
		['nothing configured', undefined, undefined, false],
		['config off', 'off', undefined, false],
		['config local', 'local', undefined, true],
		['env local over nothing', undefined, 'local', true],
		['env local over config off', 'off', 'local', true],
		['env off over config local', 'local', 'off', false],
		['env garbage over config local', 'local', 'yes', true],
		['env garbage over nothing', undefined, 'yes', false],
		['env uppercase is not local', undefined, 'LOCAL', false],
		['env "true" is not local', undefined, 'true', false],
		['env "1" is not local', undefined, '1', false],
		['env "hosted" is not local', undefined, 'hosted', false],
	]

	for (const [description, reviewMetrics, env, expected] of CASES) {
		it(`${description} → ${expected ? 'on' : 'off'}`, () => {
			expect(
				reviewMetricsEnabled(
					{ reviewMetrics },
					env === undefined ? {} : { MAXSTACK_REVIEW_METRICS: env },
				),
			).toBe(expected)
		})
	}

	it('defaults to off in a freshly scaffolded project', () => {
		// `maxstack init` writes DEFAULT_CONFIG. If this ever flips, every project
		// anybody scaffolds starts instrumented, which is the outcome the opt-in
		// exists to prevent.
		expect(DEFAULT_CONFIG).not.toHaveProperty('reviewMetrics', 'local')
		expect(reviewMetricsEnabled(config(), {})).toBe(false)
	})
})

describe('readWorkbenchEvents', () => {
	it('reads an absent log as empty rather than throwing', async () => {
		// A project nobody has reviewed in yet is the state every project starts in.
		expect(await readWorkbenchEvents(await tempDir())).toEqual([])
	})

	it('round-trips a written log', async () => {
		const dir = await tempDir()
		const events: WorkbenchEvent[] = [
			{ kind: 'view', at: '2026-07-29T10:00:00.000Z' },
			{
				kind: 'accept',
				at: '2026-07-29T10:00:20.000Z',
				targetId: 'e-order',
				mode: 'bulk',
				batchSize: 4,
			},
		]
		await writeFile(join(dir, 'telemetry.jsonl'), serializeEvents(events))
		expect(await readWorkbenchEvents(dir)).toEqual(events)
	})
})

describe('projectReviewCost', () => {
	it('is null — not an empty report — when the project opted out', async () => {
		// The two mean different things: an empty report says nobody has reviewed
		// anything, null says nobody measured. A consumer conflating them would
		// score an un-instrumented project as a cheap one.
		const root = await tempDir()
		expect(
			await projectReviewCost({ root, config: config({ reviewMetrics: 'off' }) }),
		).toBeNull()
	})

	it('costs the project log when it opted in', async () => {
		const root = await tempDir()
		const dataDir = join(root, '.maxstack')
		const { mkdir } = await import('node:fs/promises')
		await mkdir(dataDir, { recursive: true })
		await writeFile(
			join(dataDir, 'telemetry.jsonl'),
			serializeEvents([
				{ kind: 'view', at: '2026-07-29T10:00:00.000Z' },
				{
					kind: 'accept',
					at: '2026-07-29T10:00:30.000Z',
					mode: 'bulk',
					batchSize: 3,
				},
			]),
		)
		const report = await projectReviewCost({
			root,
			config: config({ reviewMetrics: 'local' }),
		})
		expect(report?.summary.proposals).toBe(3)
		// 5s to arrive plus the 30s gap, over three proposals: a decision is charged
		// everything engaged since the previous decision, not just the final gap.
		expect(report?.summary.engagedMsPerProposal).toBe(35_000 / 3)
	})

	it('honours a caller-supplied idle cutoff', async () => {
		const root = await tempDir()
		const dataDir = join(root, '.maxstack')
		const { mkdir } = await import('node:fs/promises')
		await mkdir(dataDir, { recursive: true })
		await writeFile(
			join(dataDir, 'telemetry.jsonl'),
			serializeEvents([
				{ kind: 'view', at: '2026-07-29T10:00:00.000Z' },
				// Five minutes later — idle under the default, engaged under a
				// ten-minute cutoff.
				{ kind: 'accept', at: '2026-07-29T10:05:00.000Z' },
			]),
		)
		const project = { root, config: config({ reviewMetrics: 'local' }) }
		const dflt = await projectReviewCost(project)
		const generous = await projectReviewCost(project, {
			idleCutoffMs: 600_000,
		})
		// Default cutoff: the five-minute gap is idle, so the view and the decision
		// each open a run and are charged the opening cost.
		expect(dflt?.summary.engagedMsPerProposal).toBe(10_000)
		// Generous cutoff: one run, so the opening plus the whole gap.
		expect(generous?.summary.engagedMsPerProposal).toBe(305_000)
	})
})
