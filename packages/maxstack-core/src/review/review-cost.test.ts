/**
 * The review-cost model.
 *
 * The assertions worth reading here are the ones about what the metric refuses to
 * say: that an overnight gap is not review time, that an unknown elapsed time
 * stays `null` rather than borrowing the engaged number, and that cost is per
 * *proposal* rather than per decision — the three ways this measurement would
 * quietly become a lie.
 */

import { describe, expect, it } from 'vitest'
import type { WorkbenchEvent } from './events.ts'
import {
	compareReviewCost,
	costReview,
	describeReviewCost,
	formatDuration,
	IDLE_CUTOFF_MS,
	RUN_OPENING_MS,
} from './review-cost.ts'

/** An event at `t` seconds past a fixed epoch, for readable fixtures. */
const T0 = Date.parse('2026-07-29T10:00:00.000Z')
function at(seconds: number): string {
	return new Date(T0 + seconds * 1000).toISOString()
}

function ev(
	kind: WorkbenchEvent['kind'],
	seconds: number,
	extra: Partial<WorkbenchEvent> = {},
): WorkbenchEvent {
	return { kind, at: at(seconds), ...extra }
}

describe('engaged time', () => {
	it('charges a decision everything engaged since the previous decision', () => {
		const { decisions } = costReview([
			ev('view', 0),
			ev('focus', 10),
			ev('accept', 25, { targetId: 'e-order' }),
		])
		expect(decisions).toHaveLength(1)
		// 5s to arrive, 10s orienting, 15s on the focused node: the maintainer was at
		// this surface for 25 seconds and every one of them belongs to this decision.
		//
		// An earlier version charged only the last gap (15s), silently dropping the
		// 10s before it. That understated every review, and understated *bulk* review
		// worst — all the reading before a single batch click vanished — so the one
		// feature this metric exists to evaluate could not help but look cheap.
		expect(decisions[0]?.engagedMs).toBe(RUN_OPENING_MS + 10_000 + 15_000)
	})

	it('attributes every engaged second to exactly one decision', () => {
		// The invariant that replaces the dropped-gap behaviour: no double counting,
		// and nothing silently discarded. Two decisions in one run split the run
		// between them at the first decision.
		const { decisions, summary } = costReview([
			ev('view', 0),
			ev('focus', 10),
			ev('accept', 25),
			ev('focus', 40),
			ev('reject', 60),
		])
		expect(decisions[0]?.engagedMs).toBe(RUN_OPENING_MS + 25_000)
		expect(decisions[1]?.engagedMs).toBe(35_000)
		expect(summary.totalEngagedMs).toBe(RUN_OPENING_MS + 60_000)
	})

	it('charges the opening cost when a decision starts a run', () => {
		const { decisions } = costReview([ev('accept', 0)])
		expect(decisions[0]?.engagedMs).toBe(RUN_OPENING_MS)
	})

	it('does not charge an overnight gap as review time', () => {
		// The property the whole model exists for: a proposal sitting overnight is
		// not a proposal that took twelve hours to review.
		const overnight = 12 * 60 * 60
		const { decisions, summary } = costReview([
			ev('view', 0),
			ev('accept', overnight, { targetId: 'e-order' }),
		])
		// The overnight gap itself is not charged; the run-opening cost of arriving,
		// then leaving, then coming back is (twice — once per run).
		expect(decisions[0]?.engagedMs).toBe(RUN_OPENING_MS * 2)
		expect(summary.totalEngagedMs).toBeLessThan(60_000)
	})

	it('treats a gap just under the cutoff as engaged and just over as idle', () => {
		const under = costReview([
			ev('focus', 0),
			ev('accept', IDLE_CUTOFF_MS / 1000 - 1),
		])
		// The focus event opens the run (charged RUN_OPENING_MS), then the gap.
		expect(under.decisions[0]?.engagedMs).toBe(
			RUN_OPENING_MS + IDLE_CUTOFF_MS - 1000,
		)

		const over = costReview([
			ev('focus', 0),
			ev('accept', IDLE_CUTOFF_MS / 1000 + 1),
		])
		// The gap is idle, so the decision opens a new run: two openings, no gap.
		expect(over.decisions[0]?.engagedMs).toBe(RUN_OPENING_MS * 2)
	})

	it('honours a caller-supplied cutoff, and reports which one it used', () => {
		// The cutoff is a parameter, not a constant baked into stored numbers, so a
		// run can be re-derived by anybody who thinks ours is wrong.
		const events = [ev('focus', 0), ev('accept', 300)]
		// Default cutoff: the 300s gap is idle, so both events open runs.
		expect(costReview(events).decisions[0]?.engagedMs).toBe(RUN_OPENING_MS * 2)
		const generous = costReview(events, { idleCutoffMs: 600_000 })
		expect(generous.decisions[0]?.engagedMs).toBe(RUN_OPENING_MS + 300_000)
		expect(generous.summary.idleCutoffMs).toBe(600_000)
	})

	it('sorts an out-of-order log before costing it', () => {
		const ordered = costReview([ev('view', 0), ev('accept', 20)])
		const shuffled = costReview([ev('accept', 20), ev('view', 0)])
		expect(shuffled.decisions[0]?.engagedMs).toBe(
			ordered.decisions[0]?.engagedMs,
		)
	})
})

describe('elapsed time is separate, and never substituted', () => {
	it('reports elapsed alongside engaged when the proposal time is known', () => {
		const { decisions } = costReview([
			ev('view', 0),
			ev('accept', 30, { proposedAt: at(-3600) }),
		])
		expect(decisions[0]?.engagedMs).toBe(RUN_OPENING_MS + 30_000)
		// The point of the test: elapsed is an hour, engaged is half a minute, and
		// they are reported as two different facts.
		expect(decisions[0]?.elapsedMs).toBe((3600 + 30) * 1000)
	})

	it('leaves elapsed null when the proposal time is unknown', () => {
		const { decisions, summary } = costReview([ev('view', 0), ev('accept', 30)])
		expect(decisions[0]?.elapsedMs).toBeNull()
		expect(summary.meanElapsedMs).toBeNull()
		expect(summary.elapsedKnown).toBe(0)
	})

	it('refuses to subtract a date-only proposal time', () => {
		// The CLI write verbs stamp `appliedAt` as `YYYY-MM-DD`. That parses happily
		// to midnight UTC and would report "ten hours to review" for a proposal made
		// and reviewed in the same minute — a fabricated number wearing a measured
		// one's clothes.
		const { decisions } = costReview([
			ev('view', 0),
			ev('accept', 30, { proposedAt: '2026-07-29' }),
		])
		expect(decisions[0]?.elapsedMs).toBeNull()
	})

	it('discards a negative elapsed rather than reporting it', () => {
		const { decisions } = costReview([
			ev('accept', 0, { proposedAt: at(3600) }),
		])
		expect(decisions[0]?.elapsedMs).toBeNull()
	})

	it('counts how many decisions had a knowable elapsed time', () => {
		const { summary } = costReview([
			ev('view', 0),
			ev('accept', 10, { proposedAt: at(-100) }),
			ev('accept', 20),
			ev('accept', 30, { proposedAt: at(-200) }),
		])
		expect(summary.decisions).toBe(3)
		expect(summary.elapsedKnown).toBe(2)
	})
})

describe('cost is per proposal, not per decision', () => {
	it("divides a bulk decision's engaged time by its batch size", () => {
		const { decisions } = costReview([
			ev('view', 0),
			ev('accept', 90, { mode: 'bulk', batchSize: 40 }),
		])
		expect(decisions[0]?.engagedMs).toBe(RUN_OPENING_MS + 90_000)
		expect(decisions[0]?.engagedMsPerProposal).toBe(
			(RUN_OPENING_MS + 90_000) / 40,
		)
	})

	it('shows bulk review as cheaper — the comparison #199 has to win', () => {
		// 40 proposals, one at a time at 20s each…
		const individually: WorkbenchEvent[] = [ev('view', 0)]
		for (let i = 1; i <= 40; i++) {
			individually.push(ev('accept', i * 20, { mode: 'individual' }))
		}
		// …versus the same 40 read as one batch over 90 seconds.
		const inBulk: WorkbenchEvent[] = [
			ev('view', 0),
			ev('accept', 90, { mode: 'bulk', batchSize: 40 }),
		]

		const comparison = compareReviewCost(individually, inBulk)
		expect(comparison.beforeProposals).toBe(40)
		expect(comparison.afterProposals).toBe(40)
		expect(comparison.after).toBeLessThan(comparison.before)
		expect(comparison.ratio).toBeLessThan(0.2)
	})

	it('would show no improvement at all on a per-decision metric', () => {
		// Stated as a test because it is the trap: per *decision*, the bulk accept
		// (90s) looks nearly five times worse than an individual one (20s). The
		// denominator is the whole point.
		const bulk = costReview([
			ev('view', 0),
			ev('accept', 90, { mode: 'bulk', batchSize: 40 }),
		])
		const single = costReview([ev('view', 0), ev('accept', 20)])
		expect(bulk.decisions[0]?.engagedMs).toBeGreaterThan(
			single.decisions[0]?.engagedMs ?? 0,
		)
		expect(bulk.summary.engagedMsPerProposal).toBeLessThan(
			single.summary.engagedMsPerProposal,
		)
	})

	it('infers bulk from a batch size an older log did not label', () => {
		const { decisions } = costReview([ev('accept', 0, { batchSize: 5 })])
		expect(decisions[0]?.mode).toBe('bulk')
	})

	it('treats a missing or nonsense batch size as one proposal', () => {
		for (const batchSize of [undefined, 0, -3]) {
			const { decisions } = costReview([ev('accept', 0, { batchSize })])
			expect(decisions[0]?.batchSize).toBe(1)
			expect(decisions[0]?.mode).toBe('individual')
		}
	})
})

describe('the summary and the curve', () => {
	const session = (): WorkbenchEvent[] => [
		ev('view', 0),
		ev('focus', 5),
		ev('accept', 20, { targetId: 'e-order' }),
		ev('focus', 25),
		ev('reject', 40, { targetId: 'e-draft' }),
		ev('resolve', 55, { targetId: 'd-store', detail: 'o-pglite' }),
		// …then a break, then one more.
		ev('view', 4000),
		ev('accept', 4020, { mode: 'bulk', batchSize: 3 }),
	]

	it('counts outcomes and modes by proposals cleared', () => {
		const { summary } = costReview(session())
		expect(summary.decisions).toBe(4)
		expect(summary.proposals).toBe(6) // 1 + 1 + 1 + 3
		expect(summary.byOutcome).toEqual({ accept: 4, reject: 1, resolve: 1 })
		expect(summary.byMode).toEqual({ individual: 3, bulk: 3 })
	})

	it('reports a median alongside the mean', () => {
		const { summary } = costReview(session())
		expect(summary.medianEngagedMsPerProposal).toBeGreaterThan(0)
		expect(summary.engagedMsPerProposal).toBeGreaterThan(0)
	})

	it('walks the curve over cumulative proposals, not decisions', () => {
		const { curve } = costReview(session())
		expect(curve.map((p) => p.n)).toEqual([1, 2, 3, 6])
		// The cumulative series is monotone in n by construction; each point's mean
		// is total engaged over total proposals.
		const last = curve.at(-1)
		expect(last?.cumulativeEngagedMsPerProposal).toBeCloseTo(
			costReview(session()).summary.totalEngagedMs / 6,
			6,
		)
	})

	it('is empty and zero-valued on an empty log, without dividing by zero', () => {
		const { summary, curve, decisions } = costReview([])
		expect(decisions).toEqual([])
		expect(curve).toEqual([])
		expect(summary.proposals).toBe(0)
		expect(summary.engagedMsPerProposal).toBe(0)
		expect(summary.meanElapsedMs).toBeNull()
	})

	it('ignores non-decision events as decisions while still using their timing', () => {
		const withReads = costReview([
			ev('view', 0),
			ev('focus', 10),
			ev('accept', 20),
		])
		const withoutReads = costReview([ev('accept', 20)])
		expect(withReads.summary.decisions).toBe(1)
		expect(withoutReads.summary.decisions).toBe(1)
		// The reads are what make the engaged time measurable at all — and all of it
		// lands on the decision they led to, not just the final gap.
		expect(withReads.decisions[0]?.engagedMs).toBe(RUN_OPENING_MS + 20_000)
		expect(withoutReads.decisions[0]?.engagedMs).toBe(RUN_OPENING_MS)
	})
})

describe('display', () => {
	it('formats durations at three scales', () => {
		expect(formatDuration(840)).toBe('840ms')
		expect(formatDuration(2_400)).toBe('2.4s')
		expect(formatDuration(72_000)).toBe('1m 12s')
	})

	it('carries the qualification with the number', () => {
		// A headline that can be quoted without "engaged" and without the cutoff is
		// a headline that will be.
		const { summary } = costReview([ev('view', 0), ev('accept', 20)])
		const line = describeReviewCost(summary)
		expect(line).toMatch(/engaged per proposal/)
		expect(line).toMatch(/idle cutoff/)
	})

	it('says nothing rather than zero when there is nothing to say', () => {
		expect(describeReviewCost(costReview([]).summary)).toBe(
			'no reviews recorded yet',
		)
	})
})

// ===========================================================================
// What bulk review is supposed to do to this number
// ===========================================================================

describe('the effect of a batch on cost per proposal', () => {
	/**
	 * #199's last exit criterion is "a measured drop in time-per-proposal", and this
	 * is the half of it that is a *property* rather than a field measurement: the
	 * model must charge a batch per proposal, so that clearing twelve rows in one
	 * decision costs a twelfth as much per proposal as clearing one.
	 *
	 * That is not a tautology — it is the thing the obvious implementation gets
	 * wrong. Cost per *decision* would report a batch as the most expensive review
	 * in the log (one decision, twelve rows' worth of attention) and the feature
	 * would show up as a regression in its own metric.
	 *
	 * What this cannot establish is whether a reviewer actually spends comparable
	 * engaged time on a batch as on a single row. That needs a human over days, is
	 * tracked as #247, and is why the criterion is reported as partly met rather
	 * than closed.
	 */
	const session = (extra: Partial<WorkbenchEvent>) => [
		ev('view', 0),
		ev('focus', 8),
		ev('accept', 26, extra),
	]

	it('divides the same attention across the rows the batch settled', () => {
		const individual = costReview(session({ mode: 'individual', batchSize: 1 }))
		const batch = costReview(session({ mode: 'bulk', batchSize: 12 }))

		// Identical engaged time — the same 26 seconds of attention either way.
		expect(batch.summary.totalEngagedMs).toBe(individual.summary.totalEngagedMs)
		// And a twelfth of the cost per proposal, which is the number that matters.
		expect(batch.summary.engagedMsPerProposal).toBeCloseTo(
			individual.summary.engagedMsPerProposal / 12,
			5,
		)
		expect(batch.summary.proposals).toBe(12)
		expect(batch.summary.decisions).toBe(1)
	})

	it('reports the drop as a comparison, with its denominators', () => {
		const cmp = compareReviewCost(
			session({ mode: 'individual', batchSize: 1 }),
			session({ mode: 'bulk', batchSize: 12 }),
		)
		expect(cmp.after).toBeLessThan(cmp.before)
		expect(cmp.ratio).toBeCloseTo(1 / 12, 5)
		// The sample sizes travel with the ratio, because this is the number most
		// likely to be quoted off a handful of decisions.
		expect(cmp.beforeProposals).toBe(1)
		expect(cmp.afterProposals).toBe(12)
	})

	it('does not let a batch flatter the log it is measured in', () => {
		// A batch of 12 that took twelve times as long is not an improvement, and the
		// model must not report one. Guards against `batchSize` being treated as a
		// discount rather than as the denominator it is.
		// Built as a run of events inside the idle cutoff rather than one long gap:
		// a single 216s jump would be scored as idle and charged the 5s run opening,
		// which is the model working and would have made this assertion vacuous.
		const slow = costReview([
			ev('view', 0),
			...Array.from({ length: 20 }, (_, i) => ev('focus', 8 + i * 18)),
			ev('accept', 8 + 20 * 18, { mode: 'bulk', batchSize: 12 }),
		])
		const individual = costReview(session({ mode: 'individual', batchSize: 1 }))
		expect(slow.summary.engagedMsPerProposal).toBeGreaterThanOrEqual(
			individual.summary.engagedMsPerProposal,
		)
	})
})
