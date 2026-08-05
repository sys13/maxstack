/**
 * The per-project regeneration ledger — what a change costs the
 * *project*, as the counterpart to what review costs the *maintainer*.
 *
 * ## What this is not
 *
 * It is **not** `weightPerSafeChange`, and nothing here may be called that. That
 * metric is computed by the harness by replaying a recorded change ledger through
 * the real op and regeneration path and measuring what each safe change cost. It
 * needs two things a maintainer's project does not have: a ledger of changes
 * *attempted* (the op log records only what was applied), and a replay harness
 * willing to regenerate the project N times.
 *
 * Rendering the platform's figure on a maintainer's workbench would be worse than
 * showing nothing, because it would look like theirs. So this measures something
 * smaller and true: **how many files a regeneration rewrites per op that landed
 * since the last one.** A project getting harder to change shows up as that number
 * climbing. A project that is fine shows a flat line. Neither claim is
 * `weightPerSafeChange` and neither pretends to be.
 *
 * ## Why a log rather than a fold
 *
 * The spec cannot answer this about itself: it records what was applied, never
 * what regenerating from it produced. So the fact has to be written down at the
 * moment it is known, which is the end of a `maxstack gen` run — #249's option 2.
 * That also builds the ledger incrementally, which is the property that makes the
 * *real* metric computable later without inventing a change ledger now.
 *
 * Pure here — types, codec and the fold, no I/O and no clock. The append lives in
 * the CLI host, the same split `review-cost.ts` uses and for the same reason: a
 * model only one surface can evaluate is a number you can only see in one place.
 */

/** What one `maxstack gen` run did. One line of the ledger. */
export interface RegenEntry {
	/**
	 * The day the run happened, `YYYY-MM-DD`.
	 *
	 * A **date**, matching `appliedAt` across the op log, and deliberately not a
	 * timestamp. Nothing here needs sub-day resolution — the ordering comes from
	 * `opCount`, not from the clock — and a wall-clock time would turn a record
	 * about generated code into a record of when somebody was at their desk.
	 */
	at: string
	/**
	 * The op-log length this run generated from — the same watermark the ownership
	 * manifest carries.
	 *
	 * This is what makes the ledger orderable and differenceable without trusting
	 * a clock: the ops that landed between two runs is the difference between
	 * their counts, and the op log is append-only.
	 */
	opCount: number
	/** How the never-clobber writer treated each file it considered. */
	writes: {
		created: number
		overwritten: number
		unchanged: number
		/** Files the maintainer owns, which the writer refused to touch. */
		skippedUserOwned: number
	}
	/** Framework-owned artifacts (docs, e2e tests) written this run. */
	artifacts: number
	/**
	 * Whether the run rewrote nothing — every file already matched its derivation.
	 * A regeneration that is stable is one that had nothing to say.
	 */
	stable: boolean
}

// ===========================================================================
// Codec — JSONL, append-only, same shape as the event log and the metrics DB
// ===========================================================================

export function serializeRegenEntry(entry: RegenEntry): string {
	return `${JSON.stringify(entry)}\n`
}

/**
 * Parse a ledger, skipping lines that do not parse or do not carry the two
 * fields the fold needs.
 *
 * Lenient on purpose. This file is appended to by every `gen` across every
 * version a project has ever run, so a partial write from a killed process or a
 * line written by an older shape must cost the reader the line, not the report.
 */
export function parseRegenLog(raw: string): RegenEntry[] {
	const out: RegenEntry[] = []
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue
		try {
			const parsed = JSON.parse(line) as RegenEntry
			if (typeof parsed?.opCount !== 'number' || typeof parsed.at !== 'string')
				continue
			out.push(parsed)
		} catch {
			// A damaged line is not a damaged ledger.
		}
	}
	return out
}

// ===========================================================================
// The fold
// ===========================================================================

/** One measurable interval: the ops that landed between two generations. */
export interface RegenPoint {
	at: string
	/** Ops that landed since the previous run. Always ≥ 1 for a point to exist. */
	opsLanded: number
	/** Files the writer actually rewrote — created plus overwritten. */
	filesTouched: number
	/**
	 * `filesTouched / opsLanded` — the cost of a change to this project, in files
	 * the platform had to redraw.
	 */
	filesPerOp: number
}

export interface RegenTrendReport {
	/** Every run in the ledger, including the ones no interval could be drawn from. */
	generations: number
	/** The intervals a rate could be computed for. */
	points: RegenPoint[]
	/**
	 * Mean `filesPerOp` across the points, or **null** when there are none.
	 *
	 * Null and not zero. Zero is a real measurement — a project whose changes cost
	 * no regeneration — and a project nobody has generated twice has not made that
	 * measurement. Conflating them scores an un-instrumented project as a
	 * frictionless one, which is the direction that flatters.
	 */
	meanFilesPerOp: number | null
	/**
	 * First point versus last, or null when there are fewer than two points.
	 *
	 * The question this whole file exists for is "is my project getting harder to
	 * change?", and one point cannot answer it.
	 */
	trend: {
		first: number
		last: number
		direction: 'up' | 'down' | 'flat'
	} | null
	/** Runs that rewrote nothing — the derivation and the tree already agreed. */
	stableRuns: number
}

/**
 * Fold a ledger into the trend.
 *
 * Intervals with **no ops** between them are dropped rather than counted as zero.
 * Running `gen` twice in a row is a normal thing to do and it says nothing about
 * what a change costs; counting it would drag the mean toward zero in proportion
 * to how often somebody regenerates, which would make the metric a measure of
 * habit rather than of the project.
 *
 * Entries are sorted by `opCount` rather than trusted in file order, so a ledger
 * concatenated out of order still reads correctly. Ties keep their order.
 */
export function foldRegenTrend(
	entries: readonly RegenEntry[],
): RegenTrendReport {
	const sorted = [...entries].sort((a, b) => a.opCount - b.opCount)
	const points: RegenPoint[] = []

	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1]
		const cur = sorted[i]
		if (!prev || !cur) continue
		const opsLanded = cur.opCount - prev.opCount
		if (opsLanded <= 0) continue
		const filesTouched = cur.writes.created + cur.writes.overwritten
		points.push({
			at: cur.at,
			opsLanded,
			filesTouched,
			filesPerOp: filesTouched / opsLanded,
		})
	}

	const first = points[0]
	const last = points.at(-1)
	return {
		generations: sorted.length,
		points,
		meanFilesPerOp: points.length
			? points.reduce((sum, p) => sum + p.filesPerOp, 0) / points.length
			: null,
		trend:
			first && last && points.length > 1
				? {
						first: first.filesPerOp,
						last: last.filesPerOp,
						direction:
							last.filesPerOp > first.filesPerOp
								? 'up'
								: last.filesPerOp < first.filesPerOp
									? 'down'
									: 'flat',
					}
				: null,
		stableRuns: sorted.filter((e) => e.stable).length,
	}
}

/**
 * The report in one sentence, for a terminal or a pane.
 *
 * States absence as absence. "Not enough history yet" is the honest reading of a
 * project generated once, and it is what a maintainer needs to hear rather than a
 * confident-looking `0.00`.
 */
export function describeRegenTrend(report: RegenTrendReport): string {
	if (report.meanFilesPerOp === null) {
		return report.generations === 0
			? 'no generations recorded yet — run `maxstack gen` to start the ledger'
			: `${report.generations} generation${report.generations === 1 ? '' : 's'} recorded, but no change has landed between two of them yet — nothing to measure`
	}
	const mean = report.meanFilesPerOp.toFixed(2)
	const trend = report.trend
		? `, trending ${report.trend.direction} (${report.trend.first.toFixed(2)} → ${report.trend.last.toFixed(2)})`
		: ''
	return `${mean} files regenerated per op, over ${report.points.length} change${report.points.length === 1 ? '' : 's'}${trend}`
}
