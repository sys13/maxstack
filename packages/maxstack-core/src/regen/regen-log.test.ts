/**
 * The regeneration ledger.
 *
 * The assertions that matter are the ones about *absence*. This metric exists
 * because the honest alternative to showing the platform's `weightPerSafeChange`
 * on somebody else's project was showing nothing, so a version of it that reports
 * a confident `0.00` where it means "no data" would have reintroduced the exact
 * dishonesty it was built to avoid.
 */

import { describe, expect, it } from 'vitest'
import {
	describeRegenTrend,
	foldRegenTrend,
	parseRegenLog,
	type RegenEntry,
	serializeRegenEntry,
} from './regen-log.ts'

/** One run: `opCount` ops had landed, and it rewrote `touched` files. */
function entry(
	opCount: number,
	touched: number,
	at = '2026-07-30',
): RegenEntry {
	return {
		at,
		opCount,
		writes: {
			created: touched,
			overwritten: 0,
			unchanged: 3,
			skippedUserOwned: 1,
		},
		artifacts: 2,
		stable: touched === 0,
	}
}

describe('the fold refuses to invent a number', () => {
	it('reports null, not zero, for an empty ledger', () => {
		const report = foldRegenTrend([])
		expect(report.meanFilesPerOp).toBeNull()
		expect(report.trend).toBeNull()
		expect(report.generations).toBe(0)
	})

	it('reports null for a project generated once', () => {
		// One generation is not an interval. There is nothing between it and
		// anything else, so there is no rate.
		const report = foldRegenTrend([entry(4, 6)])
		expect(report.generations).toBe(1)
		expect(report.meanFilesPerOp).toBeNull()
	})

	it('reports null when every interval landed no ops', () => {
		// Running `gen` three times in a row is a normal thing to do and says
		// nothing about what a change costs. Counting those as zero-cost changes
		// would make the metric a measure of how often somebody regenerates.
		const report = foldRegenTrend([entry(4, 6), entry(4, 0), entry(4, 0)])
		expect(report.generations).toBe(3)
		expect(report.points).toEqual([])
		expect(report.meanFilesPerOp).toBeNull()
	})

	it('says so in words rather than printing a number', () => {
		expect(describeRegenTrend(foldRegenTrend([]))).toMatch(
			/no generations recorded/,
		)
		expect(describeRegenTrend(foldRegenTrend([entry(4, 6)]))).toMatch(
			/nothing to measure/,
		)
	})
})

describe('the rate', () => {
	it('divides files rewritten by the ops that landed since the last run', () => {
		// 4 ops landed between the two runs, and the second rewrote 8 files.
		const report = foldRegenTrend([entry(2, 0), entry(6, 8)])
		expect(report.points).toHaveLength(1)
		expect(report.points[0]?.opsLanded).toBe(4)
		expect(report.points[0]?.filesTouched).toBe(8)
		expect(report.points[0]?.filesPerOp).toBe(2)
		expect(report.meanFilesPerOp).toBe(2)
	})

	it('counts created and overwritten, and not the files nothing happened to', () => {
		// `unchanged` and `skipped-user-owned` are the writer deciding *not* to
		// write. A run that touched nothing cost nothing, however many files it
		// considered — counting them would make the number grow with project size
		// rather than with change difficulty, which inverts what it is for.
		const report = foldRegenTrend([
			entry(0, 0),
			{
				at: '2026-07-30',
				opCount: 2,
				writes: {
					created: 1,
					overwritten: 1,
					unchanged: 40,
					skippedUserOwned: 20,
				},
				artifacts: 0,
				stable: false,
			},
		])
		expect(report.points[0]?.filesTouched).toBe(2)
		expect(report.points[0]?.filesPerOp).toBe(1)
	})

	it('needs two points before it will call anything a trend', () => {
		expect(foldRegenTrend([entry(0, 0), entry(2, 4)]).trend).toBeNull()
		const three = foldRegenTrend([entry(0, 0), entry(2, 2), entry(4, 8)])
		expect(three.trend).toEqual({ first: 1, last: 4, direction: 'up' })
	})

	it('reads a ledger that was concatenated out of order', () => {
		// Ordering comes from `opCount`, not from file order — the op log is
		// append-only, the file might not be.
		const report = foldRegenTrend([entry(6, 8), entry(2, 0)])
		expect(report.points[0]?.opsLanded).toBe(4)
	})

	it('counts the runs that rewrote nothing', () => {
		expect(
			foldRegenTrend([entry(0, 0), entry(2, 4), entry(4, 0)]).stableRuns,
		).toBe(2)
	})
})

describe('the codec', () => {
	it('round-trips', () => {
		const entries = [entry(0, 0), entry(3, 5)]
		const raw = entries.map(serializeRegenEntry).join('')
		expect(parseRegenLog(raw)).toEqual(entries)
	})

	it('loses a damaged line rather than the ledger', () => {
		// Appended to by every `gen` a project ever runs, across every version it
		// has ever run. A half-written line from a killed process must cost the
		// reader that line and nothing else.
		const raw = `${serializeRegenEntry(entry(0, 0))}{"opCount":3,\n${serializeRegenEntry(entry(3, 5))}`
		expect(parseRegenLog(raw)).toHaveLength(2)
	})

	it('drops a line missing the fields the fold needs', () => {
		expect(parseRegenLog('{"at":"2026-07-30"}\n{"opCount":1}\n')).toEqual([])
	})
})
