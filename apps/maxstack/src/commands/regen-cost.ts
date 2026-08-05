/**
 * `maxstack regen-cost` — what a change costs this project, in files the platform
 * has to redraw.
 *
 * The counterpart to `maxstack review-cost`: that one measures the human half of
 * a change, this one measures the platform half. A maintainer asking "is my
 * project getting harder to change?" had the first and nothing for the second.
 *
 * ## What this deliberately is not
 *
 * It is not `weightPerSafeChange` and it does not report a figure by that name.
 * That metric is a replay: the harness drives a recorded ledger of *attempted*
 * changes through the real op and regeneration path and measures what each safe
 * one cost. A maintainer's project has an op log, which records what was applied
 * and not what was tried, and no replay harness. Printing the platform's number
 * here would look like theirs, which is worse than printing nothing.
 *
 * So this reports something smaller and true, and says which it is. See
 * `@maxstack/core/regen` for the full argument.
 */

import { describeRegenTrend, type RegenTrendReport } from '@maxstack/core/regen'
import { loadProject } from '../lib/project.ts'
import { projectRegenTrend } from '../lib/regen-log.ts'

interface RegenCostOptions {
	json?: boolean
}

function printReport(report: RegenTrendReport): void {
	console.log(`  ${describeRegenTrend(report)}`)
	console.log(
		`  ${report.generations} generation${report.generations === 1 ? '' : 's'} recorded · ` +
			`${report.stableRuns} rewrote nothing`,
	)
	if (report.meanFilesPerOp === null) return

	// The two most recent intervals, which is what a trend line is made of. Not a
	// plot: the question is directional, and three numbers answer it.
	for (const point of report.points.slice(-3)) {
		console.log(
			`  ${point.at}  ${point.opsLanded} op${point.opsLanded === 1 ? '' : 's'} → ` +
				`${point.filesTouched} file${point.filesTouched === 1 ? '' : 's'} ` +
				`(${point.filesPerOp.toFixed(2)} per op)`,
		)
	}
	// Stated every time, not once in the docs. This number is a proxy, and a proxy
	// that stops being described as one becomes a target.
	console.log(
		'\n  This is files-redrawn-per-op, not the platform’s weightPerSafeChange —' +
			'\n  that one needs a replay of attempted changes your project does not record.',
	)
}

export async function regenCostCommand(
	dir: string | undefined,
	opts: RegenCostOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const report = await projectRegenTrend(project)

	if (opts.json) {
		console.log(JSON.stringify(report, null, 2))
		return
	}
	console.log('regeneration cost')
	printReport(report)
}
