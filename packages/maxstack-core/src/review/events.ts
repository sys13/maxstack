/**
 * Workbench interaction telemetry — the append-only event log the design
 * asks for ("interaction telemetry from first commit… interaction events
 * flowing"). This is the *minimum-mechanism* cut (§3-L1): a durable, ordered
 * record of what the maintainer did in the review surface, nothing more. The
 * research-grade interaction studies (§3-L4B — questioning-strategy trials,
 * canvas-vs-chat) stay deferred until there is a real user population; this just
 * makes the raw event stream exist so a later phase has data to fold.
 *
 * Pure here (types + serialize/parse/summarize) so it is unit-testable; the
 * in-memory store lives in {@link ./telemetry.server}. Mirrors the harness
 * metrics DB shape (`serializeRunHistory`/`parseRunHistory`): JSONL, one event
 * per line, append-only.
 */

/** The interactions the review surface records. */
export type WorkbenchEventKind =
	| 'view' // loaded the workbench
	| 'focus' // zoomed into a spec node
	| 'accept' // accepted a suggestion
	| 'reject' // rejected a suggestion
	| 'resolve' // resolved a decision

export interface WorkbenchEvent {
	kind: WorkbenchEventKind
	/** ISO timestamp; injected (deterministic in tests). */
	at: string
	/** The spec node / decision the event is about, when it has one. */
	targetId?: string
	/** Free-form extra context (e.g. the chosen option id on a resolve). */
	detail?: string

	// -------------------------------------------------------------------------
	// Review-cost facts
	// -------------------------------------------------------------------------
	//
	// Only these three are *recorded*; everything else the review-cost model
	// reports (engaged time, elapsed time, per-decision cost) is **derived** from
	// the event stream by `review-cost.ts`. That split is deliberate: a stored
	// duration is a number nobody can recheck, while a derivation over an
	// append-only log can be re-run with a different idle cutoff when somebody
	// disagrees with the one we chose.

	/**
	 * Whether this decision was made on its own or as part of a batch.
	 * Absent on non-decision events, and on decisions recorded before #201.
	 */
	mode?: 'individual' | 'bulk'
	/**
	 * How many proposals the decision covered. `1` for an individual decision,
	 * *n* for a bulk accept of *n* rows. The point of recording it is that cost
	 * per *proposal* is the number that matters — clearing 40 proposals in one
	 * reviewed batch is the win bulk review is supposed to deliver, and a
	 * per-*decision* metric would show no improvement at all.
	 */
	batchSize?: number
	/**
	 * When the reviewed proposal became reviewable, if the surface could
	 * determine it — the other end of elapsed time. Absent rather than guessed:
	 * many op-log entries carry a date-granular `appliedAt` (the CLI stamps
	 * `YYYY-MM-DD`), and deriving an elapsed *duration* from a date would produce
	 * a number that looks like minutes and is really rounding.
	 */
	proposedAt?: string
}

// ===========================================================================
// Serialize / parse — JSONL, append-only (same shape as the metrics DB)
// ===========================================================================

/** One event → one JSON line. */
export function serializeEvent(event: WorkbenchEvent): string {
	return JSON.stringify(event)
}

/** A whole log → JSONL text (trailing newline, so appends concatenate cleanly). */
export function serializeEvents(events: readonly WorkbenchEvent[]): string {
	return events
		.map(serializeEvent)
		.map((l) => `${l}\n`)
		.join('')
}

/** Parse JSONL back into events, skipping blank lines. */
export function parseEvents(jsonl: string): WorkbenchEvent[] {
	return jsonl
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as WorkbenchEvent)
}

// ===========================================================================
// Summary — the small headline the UI shows
// ===========================================================================

export interface TelemetrySummary {
	total: number
	byKind: Record<WorkbenchEventKind, number>
}

const EVENT_KINDS: readonly WorkbenchEventKind[] = [
	'view',
	'focus',
	'accept',
	'reject',
	'resolve',
]

export function summarizeEvents(
	events: readonly WorkbenchEvent[],
): TelemetrySummary {
	const byKind = Object.fromEntries(EVENT_KINDS.map((k) => [k, 0])) as Record<
		WorkbenchEventKind,
		number
	>
	for (const e of events) byKind[e.kind]++
	return { total: events.length, byKind }
}

/** The most recent `n` events, newest first — the activity feed. */
export function recentEvents(
	events: readonly WorkbenchEvent[],
	n = 8,
): WorkbenchEvent[] {
	return [...events].slice(-n).reverse()
}
