/**
 * The review-cost host: the opt-in gate, and the read side.
 *
 * ## Why there is a gate at all
 *
 * This is **maintainer telemetry in the maintainer's own project**. Instrumenting
 * our own dogfooding is legitimate; instrumenting other people's projects because
 * we happened to ship the runtime they installed is not, and it would be
 * especially indefensible for a product whose pitch is review-first trust. So:
 *
 *   - it is **off by default** in a user's project;
 *   - it is on in ours, by a config line in *our* repo, not by a special case in
 *     the code that ships;
 *   - nothing leaves the machine either way. The data is derived from
 *     `telemetry.jsonl` in the project's own gitignored data dir, and there is no
 *     transport in this file to send it anywhere.
 *
 * The gate covers the *reporting*, deliberately not the *recording*. The
 * workbench event log already existed before #201 and is load-bearing for the
 * activity feed and the implicit-confusion signals; gating it would break
 * those. What #201 adds is (a) three extra fields on a decision event and (b)
 * this cost model over the log — and it is the model, the pane and the published
 * numbers that stay dark unless the maintainer asked for them.
 *
 * ## Turning it on
 *
 *   maxstack.json          `"reviewMetrics": "local"`
 *   env                    `MAXSTACK_REVIEW_METRICS=local`
 *
 * `local` is the only enabled value and the name is the promise: local disk, no
 * transport. If a hosted mode ever exists it will be a different value with its
 * own consent conversation, so `local` can never quietly come to mean "uploaded".
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
	costReview,
	type ReviewCostReport,
	type ReviewCostSummary,
} from '@maxstack/core/review'
import { resolveDataDir } from '~/data-dir.server'
import { allWorkbenchEvents } from './telemetry.server'

/** The settings a project can hold. `off` is the default everywhere. */
export type ReviewMetricsMode = 'off' | 'local'

function parseMode(value: unknown): ReviewMetricsMode | null {
	return value === 'local' ? 'local' : value === 'off' ? 'off' : null
}

/** Walk up from the data dir to the project root holding `maxstack.json`. */
function findProjectRoot(dataDir: string): string | null {
	let dir = dataDir
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(dir, 'maxstack.json'))) return dir
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

/**
 * Whether review-cost reporting is enabled for this project.
 *
 * The env var wins over the config so a maintainer can turn it on for one session
 * without committing a line — and, more importantly, can turn it *off* for one
 * session without editing a file they may have inherited from a template.
 */
export function reviewMetricsMode(): ReviewMetricsMode {
	const fromEnv = parseMode(process.env.MAXSTACK_REVIEW_METRICS?.trim())
	if (fromEnv) return fromEnv

	const dataDir = resolveDataDir()
	if (!dataDir) return 'off'
	const root = findProjectRoot(dataDir)
	if (!root) return 'off'
	try {
		const config = JSON.parse(
			readFileSync(resolve(root, 'maxstack.json'), 'utf8'),
		) as { reviewMetrics?: unknown }
		return parseMode(config.reviewMetrics) ?? 'off'
	} catch {
		// A malformed config is the CLI's problem to report. Defaulting to `off`
		// here is the only safe direction: an unreadable config must never be the
		// reason telemetry reporting silently switches on.
		return 'off'
	}
}

/** What the workbench renders. `enabled: false` carries no numbers at all —
 *  not zeroes, which would read as "reviews are free". */
export type ReviewCostView =
	| { enabled: false; mode: ReviewMetricsMode }
	| { enabled: true; mode: 'local'; report: ReviewCostReport }

/**
 * The review-cost pane's data. Returns `{ enabled: false }` unless the project
 * opted in, and the caller renders the explanation rather than an empty chart.
 */
export async function reviewCostView(): Promise<ReviewCostView> {
	const mode = reviewMetricsMode()
	if (mode !== 'local') return { enabled: false, mode }
	return { enabled: true, mode, report: costReview(await allWorkbenchEvents()) }
}

/**
 * The summary alone, for callers that only want the headline (the CLI report and
 * #168's agent runs). `null` when the project has not opted in — an absent
 * measurement rather than a zero, so a comparison cannot silently treat an
 * un-instrumented arm as a fast one.
 */
export async function reviewCostSummary(): Promise<ReviewCostSummary | null> {
	if (reviewMetricsMode() !== 'local') return null
	return costReview(await allWorkbenchEvents()).summary
}

/**
 * The whole report, for the `review_cost` MCP tool. `null` on the same terms and
 * for the same reason: an agent that read a zero would conclude review is free,
 * when what happened is that nobody measured.
 */
export async function reviewCostReport(): Promise<ReviewCostReport | null> {
	if (reviewMetricsMode() !== 'local') return null
	return costReview(await allWorkbenchEvents())
}
