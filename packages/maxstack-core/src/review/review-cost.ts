/**
 * Review cost — what it costs the *human* to approve a change.
 *
 * The platform measures `weightPerSafeChange`: what it costs the *platform* to
 * land a change. It has never measured the review step, which is the one the
 * whole positioning rests on and the one most likely to degrade silently under
 * agent throughput. If review time per proposal grows, people stop reviewing —
 * and until this file existed there was no instrumentation that would show it.
 *
 * ## Engaged, not elapsed
 *
 * The measurement that matters is **engaged** time. A proposal sitting overnight
 * is not a proposal that took twelve hours to review, and a metric that says it
 * did is worse than no metric: it would make an idle weekend look like a
 * usability collapse and a genuine slowdown look like noise.
 *
 * Engaged time is derived from the append-only workbench event log by the
 * standard session method: consecutive events belong to the same **run** of
 * activity while the gap between them stays under {@link IDLE_CUTOFF_MS}; a
 * longer gap ends the run. The first event of a run is charged
 * {@link RUN_OPENING_MS} rather than zero, because arriving at the surface is not
 * free.
 *
 * A decision is charged **all engaged time since the previous decision** — the
 * focusing, the preview, the diff-reading that led to it. So every engaged second
 * is attributed to exactly one decision: none double counted, none dropped.
 *
 * The first version charged only the gap since the immediately preceding *event*,
 * which discarded every earlier gap in the run. It understated every review, and
 * it understated **bulk** review worst of all: a reviewer who worked through a
 * batch for four minutes and then clicked once was charged the final gap alone, so
 * a batch could not help but look cheap. A metric that flatters the feature it was
 * built to evaluate is not a metric — and #199's exit criterion depends on this
 * one being real.
 *
 * Two consequences worth stating plainly, since a measurement whose limits are
 * unstated gets quoted as if it had none:
 *
 *   - **Engaged time is a floor, not the truth.** It cannot see thinking that
 *     happens away from the keyboard, and it charges reading time to whichever
 *     decision followed it.
 *   - **The idle cutoff is a choice.** It is a parameter here, not a constant
 *     baked into stored numbers, precisely so a run can be re-derived under a
 *     different cutoff by anybody who thinks ours is wrong.
 *
 * Elapsed time is reported *alongside* and separately, never blended, and only
 * when the proposal's creation time is actually known (see
 * `WorkbenchEvent.proposedAt`). Any published figure has to say which one it is.
 *
 * ## What this must never become
 *
 * This measures whether the **surface** is cheap, not whether the **human** is
 * fast. Nothing gates on it and nothing should: a review-speed target would make
 * a reviewer rush, which destroys exactly the thing the metric exists to protect.
 * The one comparison it is *for* is before-and-after a surface change — #199's
 * bulk review has to move `engagedMsPerProposal` down or it did not work.
 *
 * Pure (no I/O, no clock) so it unit-tests and so the same fold can run over a
 * dogfood log, or a fixture. The host that reads the
 * JSONL and the opt-in gate live in `review-cost.server.ts`.
 */

import type { WorkbenchEvent, WorkbenchEventKind } from './events.ts'

// ===========================================================================
// Parameters
// ===========================================================================

/**
 * A gap longer than this ends a run of activity: the maintainer walked away.
 * Two minutes is deliberately generous for a surface where reading a structural
 * diff is the slow part — it charges a genuinely long read as engaged time
 * rather than truncating it, and errs toward *over*-reporting review cost, which
 * is the safe direction for a number used to argue that review is cheap.
 */
export const IDLE_CUTOFF_MS = 120_000

/**
 * What the first event of a run is charged. Arriving at the review surface,
 * orienting, and finding the queue is real cost that no preceding event can
 * measure; charging zero would make a session of one decision look free.
 */
export const RUN_OPENING_MS = 5_000

/** The event kinds that are decisions — the things whose cost is being measured. */
const DECISION_KINDS: readonly WorkbenchEventKind[] = [
	'accept',
	'reject',
	'resolve',
]

function isDecision(event: WorkbenchEvent): boolean {
	return DECISION_KINDS.includes(event.kind)
}

// ===========================================================================
// Types
// ===========================================================================

export type ReviewOutcome = 'accept' | 'reject' | 'resolve'

/** One costed decision. */
export interface ReviewDecision {
	/** 1-based index in the log's decision order — the x-axis of the curve. */
	n: number
	outcome: ReviewOutcome
	/** ISO timestamp of the decision. */
	at: string
	targetId?: string
	/** Engaged ms attributed to this decision (idle-capped — see the module note). */
	engagedMs: number
	/**
	 * Wall-clock ms from the proposal becoming reviewable to this decision, or
	 * `null` when the proposal time is unknown. **Never** substituted with engaged
	 * time: they answer different questions and blending them is how a metric
	 * starts lying.
	 */
	elapsedMs: number | null
	/** How many proposals this one decision covered. */
	batchSize: number
	mode: 'individual' | 'bulk'
	/**
	 * `engagedMs / batchSize` — the number that actually has to come down. A bulk
	 * accept of 40 rows that takes 90 seconds costs 2.25s per proposal; the same
	 * 40 reviewed one at a time at 20s each costs 20s. Per-*decision* cost would
	 * show the bulk review as *slower*.
	 */
	engagedMsPerProposal: number
}

export interface ReviewCostSummary {
	/** Decisions recorded. */
	decisions: number
	/** Proposals cleared — the sum of batch sizes, which is what N means here. */
	proposals: number
	/** Mean engaged ms per proposal. The headline. */
	engagedMsPerProposal: number
	/** Median engaged ms per proposal — reported because the mean is skewed by
	 *  the one decision somebody agonised over. */
	medianEngagedMsPerProposal: number
	/** Total engaged ms across every decision. */
	totalEngagedMs: number
	/** Mean elapsed ms, over the decisions where it is known (`null` if none). */
	meanElapsedMs: number | null
	/** How many decisions had a knowable elapsed time — the honesty denominator. */
	elapsedKnown: number
	byOutcome: Record<ReviewOutcome, number>
	/** Proposals cleared in bulk, and individually. */
	byMode: Record<'individual' | 'bulk', number>
	/** The idle cutoff this fold used, carried so a reported number is
	 *  self-describing rather than depending on the reader knowing the default. */
	idleCutoffMs: number
}

/** One point on the review-cost curve — cumulative through proposal `n`. */
export interface ReviewCostPoint {
	/** Cumulative proposals cleared. */
	n: number
	/** Cumulative mean engaged ms per proposal through `n`. */
	cumulativeEngagedMsPerProposal: number
	/** This decision's own per-proposal cost — the noisy series. */
	engagedMsPerProposal: number
	mode: 'individual' | 'bulk'
	at: string
}

export interface ReviewCostReport {
	summary: ReviewCostSummary
	decisions: ReviewDecision[]
	curve: ReviewCostPoint[]
}

// ===========================================================================
// The fold
// ===========================================================================

function median(values: readonly number[]): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 1) return sorted[mid] ?? 0
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Milliseconds between two ISO timestamps, or `null` if either is unparseable. */
function msBetween(from: string, to: string): number | null {
	const a = Date.parse(from)
	const b = Date.parse(to)
	if (Number.isNaN(a) || Number.isNaN(b)) return null
	return b - a
}

/**
 * A `proposedAt` we are willing to compute an elapsed *duration* from. A
 * date-only stamp (`2026-07-29`, which the CLI write verbs produce) parses
 * happily to midnight UTC and would yield an elapsed time of "fourteen hours"
 * for a proposal made and reviewed in the same minute. Requiring a time
 * component is the difference between an unknown and a fabricated number.
 */
function hasTimeComponent(iso: string): boolean {
	return iso.includes('T')
}

/**
 * Cost every decision in an event log.
 *
 * `events` may be in any order — it is sorted by timestamp here rather than
 * trusting the file, because the log is appended by a server that can restart
 * and because a hand-merged JSONL is a realistic input.
 */
export function costReview(
	events: readonly WorkbenchEvent[],
	opts: { idleCutoffMs?: number; runOpeningMs?: number } = {},
): ReviewCostReport {
	const idleCutoffMs = opts.idleCutoffMs ?? IDLE_CUTOFF_MS
	const runOpeningMs = opts.runOpeningMs ?? RUN_OPENING_MS

	const ordered = [...events].sort(
		(a, b) => Date.parse(a.at) - Date.parse(b.at),
	)

	const decisions: ReviewDecision[] = []
	let previousAt: string | null = null
	// Engaged time seen since the last *decision*. Attention spent on the events
	// between two decisions — focusing a row, opening its preview, reading the
	// diff — belongs to the decision it led to, so it accumulates here and is
	// charged in full when that decision arrives.
	//
	// The first implementation charged a decision only the gap since the
	// immediately preceding event, which dropped every earlier gap in the run. It
	// understated every review, and it understated *bulk* review worst of all: a
	// reviewer who spent four minutes working through a batch and then clicked once
	// was charged the final gap alone, so a batch could not help but look cheap. A
	// metric that flatters the feature it was built to evaluate is not a metric,
	// and #199's own exit criterion depends on this number being one.
	let pendingEngagedMs = 0

	for (const event of ordered) {
		const gap = previousAt === null ? null : msBetween(previousAt, event.at)
		// The engaged slice this event sits at the end of: the gap since the last
		// event, unless that gap says the maintainer had left (or there is no
		// previous event in this run at all).
		const engagedSlice =
			gap === null || gap > idleCutoffMs || gap < 0
				? runOpeningMs
				: Math.max(gap, 0)
		previousAt = event.at
		pendingEngagedMs += engagedSlice

		if (!isDecision(event)) continue

		// Claim everything since the previous decision, and reset. Every engaged
		// second is therefore attributed to exactly one decision — no double
		// counting, and nothing silently dropped.
		const engagedMs = pendingEngagedMs
		pendingEngagedMs = 0

		const batchSize =
			typeof event.batchSize === 'number' && event.batchSize > 0
				? Math.floor(event.batchSize)
				: 1
		const mode = event.mode ?? (batchSize > 1 ? 'bulk' : 'individual')
		const elapsedMs =
			event.proposedAt && hasTimeComponent(event.proposedAt)
				? msBetween(event.proposedAt, event.at)
				: null

		decisions.push({
			n: decisions.length + 1,
			outcome: event.kind as ReviewOutcome,
			at: event.at,
			targetId: event.targetId,
			engagedMs,
			// A negative elapsed (clock skew, a hand-edited log) is not information.
			elapsedMs: elapsedMs !== null && elapsedMs >= 0 ? elapsedMs : null,
			batchSize,
			mode,
			engagedMsPerProposal: engagedMs / batchSize,
		})
	}

	// ---- the curve, cumulative over *proposals* cleared ---------------------
	const curve: ReviewCostPoint[] = []
	let cumulativeProposals = 0
	let cumulativeEngaged = 0
	for (const d of decisions) {
		cumulativeProposals += d.batchSize
		cumulativeEngaged += d.engagedMs
		curve.push({
			n: cumulativeProposals,
			cumulativeEngagedMsPerProposal: cumulativeEngaged / cumulativeProposals,
			engagedMsPerProposal: d.engagedMsPerProposal,
			mode: d.mode,
			at: d.at,
		})
	}

	// ---- the summary --------------------------------------------------------
	const byOutcome: Record<ReviewOutcome, number> = {
		accept: 0,
		reject: 0,
		resolve: 0,
	}
	const byMode: Record<'individual' | 'bulk', number> = {
		individual: 0,
		bulk: 0,
	}
	const elapsed: number[] = []
	for (const d of decisions) {
		byOutcome[d.outcome] += d.batchSize
		byMode[d.mode] += d.batchSize
		if (d.elapsedMs !== null) elapsed.push(d.elapsedMs)
	}

	const proposals = cumulativeProposals
	return {
		summary: {
			decisions: decisions.length,
			proposals,
			engagedMsPerProposal: proposals === 0 ? 0 : cumulativeEngaged / proposals,
			medianEngagedMsPerProposal: median(
				decisions.map((d) => d.engagedMsPerProposal),
			),
			totalEngagedMs: cumulativeEngaged,
			meanElapsedMs:
				elapsed.length === 0
					? null
					: elapsed.reduce((a, b) => a + b, 0) / elapsed.length,
			elapsedKnown: elapsed.length,
			byOutcome,
			byMode,
			idleCutoffMs,
		},
		decisions,
		curve,
	}
}

// ===========================================================================
// Comparison — the one use this metric is actually for
// ===========================================================================

export interface ReviewCostComparison {
	before: number
	after: number
	/** `after / before` — below 1 is an improvement. `null` when `before` is 0. */
	ratio: number | null
	/** Proposals in each arm, so a comparison over three decisions can be seen
	 *  for what it is rather than quoted as a result. */
	beforeProposals: number
	afterProposals: number
}

/**
 * Compare engaged cost per proposal across two event logs — the before-and-after
 * a surface change like #199's bulk review has to show. Deliberately returns the
 * sample sizes alongside the ratio: this is the number most likely to be quoted
 * off a handful of decisions, and a ratio without its denominator invites that.
 */
export function compareReviewCost(
	before: readonly WorkbenchEvent[],
	after: readonly WorkbenchEvent[],
	opts: { idleCutoffMs?: number } = {},
): ReviewCostComparison {
	const a = costReview(before, opts).summary
	const b = costReview(after, opts).summary
	return {
		before: a.engagedMsPerProposal,
		after: b.engagedMsPerProposal,
		ratio:
			a.engagedMsPerProposal === 0
				? null
				: b.engagedMsPerProposal / a.engagedMsPerProposal,
		beforeProposals: a.proposals,
		afterProposals: b.proposals,
	}
}

// ===========================================================================
// Display
// ===========================================================================

/** Milliseconds as a short human duration: `840ms`, `2.4s`, `1m 12s`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const minutes = Math.floor(ms / 60_000)
	const seconds = Math.round((ms % 60_000) / 1000)
	return `${minutes}m ${seconds}s`
}

/**
 * The one-line headline, written so it cannot be quoted without its
 * qualification — "engaged" and the cutoff travel with the number.
 */
export function describeReviewCost(summary: ReviewCostSummary): string {
	if (summary.proposals === 0) return 'no reviews recorded yet'
	return (
		`${formatDuration(summary.engagedMsPerProposal)} engaged per proposal ` +
		`(median ${formatDuration(summary.medianEngagedMsPerProposal)}) over ` +
		`${summary.proposals} proposal${summary.proposals === 1 ? '' : 's'} in ` +
		`${summary.decisions} decision${summary.decisions === 1 ? '' : 's'} · ` +
		`idle cutoff ${formatDuration(summary.idleCutoffMs)}`
	)
}
