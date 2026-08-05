/**
 * Implicit confusion signals beyond the friction fold in `confusion.ts` — the
 * two heuristics issue #16 asks for specifically:
 *
 *  - **rapid re-reject**: a maintainer flips a decision (accept↔reject) on the
 *    same node back and forth in quick succession — server-derivable straight
 *    off the existing telemetry log (accept/reject events are already
 *    recorded with timestamps by `workbench.server.ts`), no new client
 *    mechanism needed.
 *  - **focus-thrash**: repeated real focus/blur cycling on the currently-open
 *    node — genuinely client-side. The server-recorded `focus` telemetry
 *    event only fires once per route load (see `telemetry.ts`'s module note),
 *    so it can't see this; the browser has to track it and report only once
 *    the pattern is real (see `use-confusion-signal.ts`).
 *
 * Both are pure/testable here (no DOM, no fs, no spec/platform) — timestamps
 * and thresholds in, a small result out. The append-into-`Feedback` step
 * (with its dedupe-per-target gate) lives in `workbench.server.ts`, which is
 * where the same `Feedback`/`ReviewTarget` shape from #9/#10 gets stamped.
 */

import type { WorkbenchEvent } from './telemetry'

const DECISION_KINDS: readonly WorkbenchEvent['kind'][] = ['accept', 'reject']

// ---------------------------------------------------------------------------
// Rapid re-reject (accept <-> reject flip-flop)
// ---------------------------------------------------------------------------

export interface ReversalOptions {
	/** Two opposite decisions on the same target this close together count as
	 *  one flip. Default 60s — long enough to catch a maintainer working
	 *  through a queue, short enough that it isn't just "changed my mind a
	 *  day later" (a legitimate, unrelated re-review). */
	windowMs?: number
	/** Minimum flips within the window before it reads as confusion, not just
	 *  a single correction. Default 2 (i.e. 3 decisions: accept→reject→accept
	 *  or the mirror). */
	threshold?: number
}

export interface ReversalResult {
	flips: number
	/** The most recent flip's timestamp — the synthesized `at`. */
	lastAt: string
}

/** The decision (accept/reject) subsequence for one target, in log order —
 *  the input {@link detectRapidReversal} expects. */
export function decisionsForTarget(
	events: readonly WorkbenchEvent[],
	targetId: string,
): WorkbenchEvent[] {
	return events.filter(
		(e) => e.targetId === targetId && DECISION_KINDS.includes(e.kind),
	)
}

/**
 * Pure fold: given one target's decision events (already time-ordered), count
 * rapid accept↔reject flips inside the window and report the threshold
 * crossing. Returns `null` when the target never crossed it.
 */
export function detectRapidReversal(
	decisions: readonly WorkbenchEvent[],
	options: ReversalOptions = {},
): ReversalResult | null {
	const windowMs = options.windowMs ?? 60_000
	const threshold = options.threshold ?? 2
	let flips = 0
	let lastAt = ''
	for (let i = 1; i < decisions.length; i++) {
		const prev = decisions[i - 1]
		const cur = decisions[i]
		if (!prev || !cur || cur.kind === prev.kind) continue
		const dt = Date.parse(cur.at) - Date.parse(prev.at)
		if (dt >= 0 && dt <= windowMs) {
			flips++
			lastAt = cur.at
		}
	}
	return flips >= threshold ? { flips, lastAt } : null
}

// ---------------------------------------------------------------------------
// Focus-thrash — genuinely client-side (real focus/blur DOM cycling)
// ---------------------------------------------------------------------------

export interface FocusThrashOptions {
	/** How far back a focus cycle still counts toward the cluster. Default
	 *  30s — long enough to catch someone bouncing off a field they can't
	 *  decide on, short enough to not fire on ordinary review pacing. */
	windowMs?: number
	/** Minimum focus cycles inside the window before it reads as thrash.
	 *  Default 3 — one re-focus is normal; three within 30s is churn. */
	threshold?: number
}

/**
 * Pure: does the recent cluster of focus timestamps (ms epoch, any order) for
 * one target cross the thrash threshold as of `now`? The hook in
 * `use-confusion-signal.ts` is the only caller that has to touch the DOM;
 * this is the whole decision, extracted so it's unit-testable without one.
 */
export function isFocusThrash(
	focusTimestamps: readonly number[],
	now: number,
	options: FocusThrashOptions = {},
): boolean {
	const windowMs = options.windowMs ?? 30_000
	const threshold = options.threshold ?? 3
	const recent = focusTimestamps.filter((t) => t <= now && now - t <= windowMs)
	return recent.length >= threshold
}
