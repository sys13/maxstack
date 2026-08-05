/**
 * Review cost, read from a project on disk — the CLI's half of the
 * host that `apps/web/app/workbench/review-cost.server.ts` is the web's.
 *
 * Shared by `maxstack review-cost` and the `review_cost` MCP tool the `maxstack
 * mcp` server exposes, so an agent and a human asking the same question of the
 * same project get the same answer. That is the whole reason this file exists
 * rather than the logic sitting in the command: two readers of one event log that
 * could disagree is a worse outcome than either of them not existing.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
	costReview,
	parseEvents,
	type ReviewCostReport,
	type WorkbenchEvent,
} from '@maxstack/core/review'
import type { ProjectConfig } from './project.ts'

/**
 * Whether this project opted into review-cost reporting.
 *
 * Resolved exactly the way the web host resolves it: `MAXSTACK_REVIEW_METRICS`
 * wins over `maxstack.json`'s `reviewMetrics`, `local` is the only enabled value,
 * everything else is off.
 *
 * The rule is stated in two places (here and `review-cost.server.ts`) rather than
 * shared, because sharing would mean the CLI importing the web app — which the
 * boundary policy forbids, rightly. Two short readers is the cheaper trade, but a
 * silent divergence here would be a **consent** bug rather than a display bug, so
 * an agreement test pins the two against each other rather than trusting them
 * (`review-cost.test.ts`).
 */
export function reviewMetricsEnabled(
	config: Pick<ProjectConfig, 'reviewMetrics'>,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const fromEnv = env.MAXSTACK_REVIEW_METRICS?.trim()
	if (fromEnv === 'local') return true
	if (fromEnv === 'off') return false
	return config.reviewMetrics === 'local'
}

/**
 * A project's workbench event log. An absent file is an empty log, not an error:
 * a project nobody has reviewed in yet is a normal state, and it is the state
 * every project starts in.
 */
export async function readWorkbenchEvents(
	dataDir: string,
): Promise<WorkbenchEvent[]> {
	try {
		return parseEvents(
			await readFile(resolve(dataDir, 'telemetry.jsonl'), 'utf8'),
		)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw err
	}
}

/**
 * The review-cost report for a project, or `null` when it has not opted in.
 *
 * `null` rather than an empty report, because the two mean different things and
 * conflating them is how a metric starts lying: an empty report says "nobody has
 * reviewed anything", `null` says "nobody measured". A consumer that treated the
 * second as the first would score an un-instrumented project as a cheap one.
 */
export async function projectReviewCost(
	project: { root: string; config: ProjectConfig },
	opts: { idleCutoffMs?: number } = {},
): Promise<ReviewCostReport | null> {
	if (!reviewMetricsEnabled(project.config)) return null
	const dataDir = resolve(project.root, project.config.dataDir)
	return costReview(await readWorkbenchEvents(dataDir), opts)
}
