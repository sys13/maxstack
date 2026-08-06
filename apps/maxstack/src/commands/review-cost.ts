/**
 * `maxstack review-cost` — what approving a change costs the maintainer, in the
 * terminal.
 *
 * The workbench renders the same fold in a pane. This verb exists because of
 * and epic #167's gating line: **the workbench must never be the only
 * path.** A review-cost number you can only see in a browser is a number an agent
 * cannot read, a CI job cannot record, and #168's comparison cannot consume —
 * and this is the metric that whole comparison turns on, since "minutes, not
 * hours" has to include the human's minutes or it is measuring the wrong thing.
 *
 * `--json` is the machine surface. It emits the whole report (summary, per-decision
 * rows, curve) so a downstream consumer folds it rather than parsing prose.
 */

import {
	describeReviewCost,
	formatDuration,
	type ReviewCostReport,
} from '@maxstack/core/review'
import { loadProject } from '../lib/project.ts'
import { projectReviewCost } from '../lib/review-cost.ts'

interface ReviewCostOptions {
	json?: boolean
	/** Override the idle cutoff, in seconds — see the note on `--idle-cutoff`. */
	idleCutoff?: string
}

/** The human report — the headline, then the shape of the curve. */
function printReport(report: ReviewCostReport): void {
	const { summary, curve, decisions } = report
	console.log(`  ${describeReviewCost(summary)}`)
	if (summary.proposals === 0) return

	console.log(
		`  ${summary.byOutcome.accept} accepted · ${summary.byOutcome.reject} rejected · ` +
			`${summary.byOutcome.resolve} resolved`,
	)
	console.log(
		`  ${summary.byMode.bulk} proposal${summary.byMode.bulk === 1 ? '' : 's'} cleared in bulk · ` +
			`${summary.byMode.individual} individually`,
	)
	// Elapsed gets its own line and its own denominator — never folded into the
	// headline, because a proposal that sat overnight did not take twelve hours to
	// review and a blended number would say it did.
	console.log(
		summary.meanElapsedMs === null
			? '  elapsed: not knowable for any decision yet (needs a timestamped proposal)'
			: `  elapsed: ${formatDuration(summary.meanElapsedMs)} mean over ` +
					`${summary.elapsedKnown} of ${summary.decisions} decisions — wall clock, not attention`,
	)

	// The trend, stated as first-vs-last rather than plotted: the question is
	// whether reviewing is getting more expensive as the project grows.
	const first = curve[0]?.cumulativeEngagedMsPerProposal
	const last = curve.at(-1)?.cumulativeEngagedMsPerProposal
	if (first !== undefined && last !== undefined && curve.length > 1) {
		const direction = last > first ? 'up' : last < first ? 'down' : 'flat'
		console.log(
			`  trend: ${formatDuration(first)} → ${formatDuration(last)} per proposal (${direction}) ` +
				`over ${decisions.length} decisions`,
		)
	}
}

export async function reviewCostCommand(
	dir: string | undefined,
	opts: ReviewCostOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const idleCutoffMs = opts.idleCutoff
		? Number(opts.idleCutoff) * 1000
		: undefined
	if (idleCutoffMs !== undefined && !Number.isFinite(idleCutoffMs)) {
		throw new Error('--idle-cutoff must be a number of seconds')
	}

	const report = await projectReviewCost(project, { idleCutoffMs })
	if (!report) {
		// Refuse rather than compute-and-hide: a maintainer who ran this command
		// deserves to be told it is off and how to turn it on, and a report printed
		// from data they never consented to derive would be the wrong answer even
		// though the data is already on their disk.
		console.log('review cost is not measured in this project.')
		console.log(
			'  it is telemetry about your own reviewing, so it is off by default.',
		)
		console.log(
			'  turn it on:  "reviewMetrics": "local"  in maxstack.json' +
				'  (or MAXSTACK_REVIEW_METRICS=local for one session)',
		)
		console.log('  stays on this machine.')
		return
	}

	if (opts.json) {
		console.log(JSON.stringify(report, null, 2))
		return
	}
	console.log('review cost')
	printReport(report)
}
