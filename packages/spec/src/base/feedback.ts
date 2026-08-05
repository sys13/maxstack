/**
 * The `Feedback` base — the *demand side* of the review-&-feedback loop
 * (Capture stage).
 *
 * `provenance.review` already covers the *supply* side (a maintainer accepting
 * or rejecting an AI-suggested spec row). Feedback is its mirror: real signal
 * flowing *in* from users and the runtime, anchored to the **same**
 * {@link ReviewTarget} coordinates the review op uses. Sharing that taxonomy is
 * what lets capture, clustering, prioritization, and review land on
 * one loop instead of four disconnected tools — a feedback event, a telemetry
 * blip, a review decision, and a spec op all name the same surface coordinate.
 *
 * Modeled exactly on the workbench `telemetry.ts`: an append-only JSONL log,
 * one event per line, with pure serialize / parse / summarize helpers so it is
 * unit-testable in isolation. The write path is a direct `MAXSTACK_DATA_DIR`
 * append in the deployed runtime (single-tenant to start; a collection endpoint
 * can come later when apps go multi-user — the settled decision from #9).
 */

import type { ReviewTarget } from './spec-ops.ts'

/**
 * Where a piece of feedback came from. `end-user` is a human using the deployed
 * app; `telemetry` is implicit signal folded from interaction logs (
 * e.g. repeated back-and-forth on a field reads as `confusion`); `maintainer`
 * is the builder's own note against a surface coordinate.
 */
export type FeedbackSource = 'end-user' | 'telemetry' | 'maintainer'

/**
 * What the feedback *is*. Ordered by actionable severity elsewhere (the
 * harness `SEVERITY_WEIGHTS`: `bug > confusion > request`); `praise` is real
 * signal but carries no work, so it never lifts a candidate up the queue.
 */
export type FeedbackKind = 'bug' | 'confusion' | 'request' | 'praise'

/** Optional human-set urgency, independent of the kind. */
export type FeedbackSeverity = 'low' | 'med' | 'high'

/** One captured piece of demand-side signal. */
export interface Feedback {
	/** Stable id (assigned at capture). */
	id: string
	/** ISO timestamp; injected so tests are deterministic (like `telemetry.ts`). */
	at: string
	source: FeedbackSource
	/** The surface coordinate this is about — same taxonomy as `provenance.review`. */
	target: ReviewTarget
	kind: FeedbackKind
	/** The feedback text. */
	body: string
	/** Which spec generation the user actually saw when they gave it. */
	specVersion: string
	/** Who gave it, when known (an end-user handle, a maintainer name). */
	actor?: string
	/** Optional urgency the capturer set. */
	severity?: FeedbackSeverity
}

// ===========================================================================
// Serialize / parse — JSONL, append-only (same shape as telemetry + metrics DB)
// ===========================================================================

/** One feedback event → one JSON line. */
export function serializeFeedback(feedback: Feedback): string {
	return JSON.stringify(feedback)
}

/** A whole log → JSONL text (trailing newline so appends concatenate cleanly). */
export function serializeFeedbackLog(feed: readonly Feedback[]): string {
	return feed
		.map(serializeFeedback)
		.map((l) => `${l}\n`)
		.join('')
}

/** Parse JSONL back into feedback, skipping blank lines. */
export function parseFeedbackLog(jsonl: string): Feedback[] {
	return jsonl
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Feedback)
}

// ===========================================================================
// Summary — the small headline the capture UI shows
// ===========================================================================

const FEEDBACK_KINDS: readonly FeedbackKind[] = [
	'bug',
	'confusion',
	'request',
	'praise',
]

const FEEDBACK_SOURCES: readonly FeedbackSource[] = [
	'end-user',
	'telemetry',
	'maintainer',
]

export interface FeedbackSummary {
	total: number
	byKind: Record<FeedbackKind, number>
	bySource: Record<FeedbackSource, number>
	/** Reach per target coordinate — the demand proxy that feeds `computePriority`. */
	byTarget: { target: ReviewTarget; count: number }[]
}

/** A stable string key for a {@link ReviewTarget} — coordinates that address the
 *  same row collapse to one bucket (a field's `parentId` disambiguates it). */
export function targetKey(target: ReviewTarget): string {
	return target.parentId
		? `${target.kind}:${target.parentId}/${target.id}`
		: `${target.kind}:${target.id}`
}

/**
 * Fold a feedback log into the capture headline: totals by kind and source,
 * plus per-target reach sorted highest-first so the queue can read demand
 * straight off it. Pure — deterministic given the input order.
 */
export function summarizeFeedback(feed: readonly Feedback[]): FeedbackSummary {
	const byKind = Object.fromEntries(
		FEEDBACK_KINDS.map((k) => [k, 0]),
	) as Record<FeedbackKind, number>
	const bySource = Object.fromEntries(
		FEEDBACK_SOURCES.map((s) => [s, 0]),
	) as Record<FeedbackSource, number>
	const targets = new Map<string, { target: ReviewTarget; count: number }>()

	for (const f of feed) {
		byKind[f.kind]++
		bySource[f.source]++
		const key = targetKey(f.target)
		const hit = targets.get(key)
		if (hit) hit.count++
		else targets.set(key, { target: f.target, count: 1 })
	}

	const byTarget = [...targets.values()].sort(
		(a, b) =>
			b.count - a.count || (targetKey(a.target) < targetKey(b.target) ? -1 : 1),
	)
	return { total: feed.length, byKind, bySource, byTarget }
}

/** The most recent `n` feedback items, newest first — the capture activity feed. */
export function recentFeedback(feed: readonly Feedback[], n = 8): Feedback[] {
	return [...feed].slice(-n).reverse()
}
