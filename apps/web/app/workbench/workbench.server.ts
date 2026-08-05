/**
 * Server wiring for the workbench route — the thin seam between the platform
 * context (the same {@link PlatformContext} singleton the MCP tools drive) and
 * the pure view-model. Kept out of the route module so the route stays a render
 * function and this stays unit-reachable.
 *
 * Every read/write also appends an interaction event (§5: "interaction events
 * flowing"), so the review surface is instrumented from the first commit.
 */

import type {
	Feedback,
	ReviewTarget,
	RiskContext,
	SpecSystem,
} from '@maxstack/spec'
import {
	classifyReviewRisk,
	deriveProvenanceState,
	locateReviewChildren,
	locateReviewTarget,
	resolveDecision,
} from '@maxstack/spec'
import { getPlatform } from '~/sprout.server'
import { ownershipContext } from './bulk-review.server'
import { decisionsForTarget, detectRapidReversal } from './confusion-signals'
import { allFeedback, captureFeedback } from './feedback.server'
import { renderGeneratedPage } from './preview.server'
import { allWorkbenchEvents, recordEvent } from './telemetry.server'
import {
	applyReviewAction,
	buildDetail,
	buildTargetHistory,
	buildWorkbench,
	type FocusDetail,
	type ReviewAction,
	type ReviewKind,
	type ReviewRef,
	type TargetHistoryEntry,
	type WorkbenchView,
} from './view-model'

/** A generated artifact previewed in the live-preview pane. */
export interface PreviewFile {
	path: string
	content: string
}

export interface WorkbenchPageData {
	view: WorkbenchView
	detail: FocusDetail | null
	/** The focused node's per-target audit trail, for `<History>` (#12's free
	 * win — today the op-log audit trail only surfaces on `/admin`). */
	history: TargetHistoryEntry[]
	/** The code the `page` generator emits for the focused page, if any. */
	preview: PreviewFile[] | null
	previewNotes: string[]
	/** The generated page, actually rendered (the emitted modules evaluated). */
	previewHtml: string | null
	previewError: string | null
}

/**
 * Load everything the route renders: the three panes, the focused-node detail
 * (when `focusId` is set), and — for a focused page — a **live preview** of the
 * code the ownership generator emits for it (the spec→code link made real, run
 * through the same `page` generator the MCP `run_generator` tool exposes).
 */
export async function loadWorkbench(
	focusId?: string | null,
): Promise<WorkbenchPageData> {
	const platform = getPlatform()
	const spec = await platform.spec.load()
	const view = buildWorkbench(spec)
	const detail = buildDetail(spec, focusId)
	const history = buildTargetHistory(spec, focusId)

	await recordEvent('view')
	if (detail) await recordEvent('focus', { targetId: detail.id })

	let preview: PreviewFile[] | null = null
	let previewNotes: string[] = []
	let previewHtml: string | null = null
	let previewError: string | null = null
	if (detail?.previewPageId) {
		const result = await platform.generators.run('page', spec, {
			pageId: detail.previewPageId,
		})
		preview = result.artifacts
		previewNotes = result.notes
		// Run the emitted modules and render the page itself — the live preview
		// is the generated app rendering, not just its source.
		const rendered = renderGeneratedPage(result.artifacts)
		previewHtml = rendered.html
		previewError = rendered.error
	}

	return {
		view,
		detail,
		history,
		preview,
		previewNotes,
		previewHtml,
		previewError,
	}
}

const REVIEW_KINDS: readonly ReviewKind[] = [
	'entity',
	'field',
	'page',
	'block',
	'tier',
]

// ===========================================================================
// Implicit confusion feedback — the two heuristics fold into the
// same `Feedback` pipeline #9/#10 use, gated so each is a one-shot per target
// (a maintainer who keeps flip-flopping or keeps re-focusing doesn't spam the
// log with a fresh row every time; one flagged row is the signal).
// ===========================================================================

/** No real spec-generation versioning exists yet — `'gen-1'` is the
 *  placeholder the rest of the workbench already uses (see the `DEMO_FEEDBACK`
 *  fixtures in `review-queue.server.ts`); kept consistent here rather than
 *  inventing a second convention. */
const PLACEHOLDER_SPEC_VERSION = 'gen-1'

const REVERSAL_MARKER = 'rapid accept/reject reversal'
const THRASH_MARKER = 'focus/blur cycling'

/** Has this exact implicit signal already been flagged for this target? Keeps
 *  the append a one-shot per target+reason instead of a row per crossing. */
function alreadyFlagged(
	feed: readonly Feedback[],
	target: ReviewTarget,
	marker: string,
): boolean {
	return feed.some(
		(f) =>
			f.source === 'telemetry' &&
			f.kind === 'confusion' &&
			f.target.kind === target.kind &&
			f.target.id === target.id &&
			f.target.parentId === target.parentId &&
			f.body.includes(marker),
	)
}

/**
 * Rapid re-reject: server-derivable straight off the telemetry log already
 * recorded for every accept/reject (no client involvement needed — the
 * decision itself, and its timing, is already durable). Called after each
 * review decision; a no-op unless this target just crossed the reversal
 * threshold and hasn't been flagged before.
 */
export async function flagReversalIfThrashing(
	target: ReviewTarget,
): Promise<void> {
	const decisions = decisionsForTarget(await allWorkbenchEvents(), target.id)
	const reversal = detectRapidReversal(decisions)
	if (!reversal) return
	const feed = await allFeedback()
	if (alreadyFlagged(feed, target, REVERSAL_MARKER)) return
	await captureFeedback({
		source: 'telemetry',
		target,
		kind: 'confusion',
		body: `Synthesized from telemetry: ${reversal.flips} ${REVERSAL_MARKER}s on this node within 60s — likely indecision.`,
		specVersion: PLACEHOLDER_SPEC_VERSION,
	})
}

/** Minimum cycle count the server accepts on a client confusion-signal post —
 *  mirrors the client-side threshold in `use-confusion-signal.ts`. Re-checked
 *  here (rather than trusted from the client) so a tampered or stale post
 *  can't force a row below the noise floor into the `Feedback` log. */
const CONFUSION_SIGNAL_MIN_CYCLES = 3

/**
 * Focus-thrash: the client already decided the pattern crossed
 * its threshold (`use-confusion-signal.ts`) and posted once; this re-applies
 * the same gate server-side and, if it still holds and this target hasn't
 * already been flagged, appends one implicit confusion `Feedback` row — the
 * same shape and log #9/#10 use, `source: 'telemetry'` marking it as implicit
 * rather than a deliberate report.
 */
export async function submitConfusionSignal(form: FormData): Promise<void> {
	const kind = form.get('kind')
	const id = form.get('id')
	const cycles = Number(form.get('cycles'))

	if (typeof kind !== 'string' || !REVIEW_KINDS.includes(kind as ReviewKind))
		return
	if (typeof id !== 'string' || id.length === 0) return
	if (!Number.isFinite(cycles) || cycles < CONFUSION_SIGNAL_MIN_CYCLES) return

	const target: ReviewTarget = { kind: kind as ReviewKind, id }
	const feed = await allFeedback()
	if (alreadyFlagged(feed, target, THRASH_MARKER)) return

	await captureFeedback({
		source: 'telemetry',
		target,
		kind: 'confusion',
		body: `Synthesized from client telemetry: ${cycles} ${THRASH_MARKER} on this node within 30s — rapid re-focus reads as confusion.`,
		specVersion: PLACEHOLDER_SPEC_VERSION,
	})
}

/**
 * Apply one accept/reject decision from a submitted form and persist it. The
 * form fields come straight off the review row's hidden inputs; this validates
 * them before touching the store so a malformed post fails loudly.
 */
export async function submitReview(form: FormData): Promise<void> {
	const action = form.get('action')
	const kind = form.get('kind')
	const id = form.get('id')
	const parentId = form.get('parentId')
	// Queue rows submit cascade so one decision covers the node's undecided
	// fields/blocks; the detail pane's per-row buttons omit it.
	const cascade = form.get('cascade') === '1'

	if (action !== 'accept' && action !== 'reject')
		throw new Response(`bad review action: ${String(action)}`, { status: 400 })
	if (typeof kind !== 'string' || !REVIEW_KINDS.includes(kind as ReviewKind))
		throw new Response(`bad review kind: ${String(kind)}`, { status: 400 })
	if (typeof id !== 'string' || id.length === 0)
		throw new Response('missing review id', { status: 400 })

	const ref: ReviewRef = {
		kind: kind as ReviewKind,
		id,
		parentId: typeof parentId === 'string' && parentId ? parentId : undefined,
	}

	const platform = getPlatform()
	const spec = await platform.spec.load()

	// A cascade IS a bulk accept, so it answers to the same risk rules.
	//
	// Found by driving the real surface: clicking this queue row's Accept settled
	// three proposals including an access-control field, while the bulk pane two
	// sections down refused that same field by name. A risk signal the adjacent
	// button ignores does not just fail to help — it manufactures the false
	// confidence #199's gating explicitly forbids, because the reviewer has been
	// shown a surface that appears to be protecting them.
	//
	// So the cascade is refused when its subtree holds anything unbatchable, with
	// the reason named. The individual decision is always still available: this
	// narrows one shortcut, it does not block the review.
	if (cascade) {
		// The same ownership facts the bulk pane reads. Passing nothing here would
		// mean "unknown ownership", which the model reads as "assume everything is
		// owned" — every cascade would be refused, which reads as a working guard and
		// is actually a guard that has stopped classifying anything.
		const risky = cascadeRisks(spec, ref, await ownershipContext(spec))
		if (risky.length > 0) {
			throw new Response(
				`This would also settle ${risky.length} proposal${risky.length === 1 ? '' : 's'} that need${risky.length === 1 ? 's' : ''} individual review:\n` +
					risky.map((r) => `  ${r.id}: ${r.reason}`).join('\n') +
					'\nDecide those on their own, or accept this row without the cascade.',
				{ status: 409 },
			)
		}
	}

	// The review lands through the `provenance.review` op, so it is recorded in
	// the spec's op log as an audit entry — stamped `human`, because the
	// workbench is the human review surface (the MCP context's origin covers
	// agent-driven ops, not this).
	await platform.spec.save(
		applyReviewAction(
			spec,
			ref,
			action as ReviewAction,
			{
				id: platform.nextOpId(),
				origin: 'human',
				appliedAt: platform.now(),
				// The one write path in the codebase that is *definitionally* a human
				// review, which is why it is the only one allowed to flip
				// `isAccepted` null→true (asserted in the invariant suite).
				actor: { surface: 'web', path: 'web-submit-review' },
			},
			cascade,
		),
	)
	// The review-cost facts, measured against the spec as it was *before* the
	// decision landed: afterwards the rows are settled and the
	// question "how many proposals did this clear" has no answer.
	await recordEvent(action as ReviewAction, {
		targetId: id,
		mode: cascade ? 'bulk' : 'individual',
		batchSize: proposalsSettledBy(spec, ref, cascade),
		proposedAt: proposedAt(spec, id),
	})
	await flagReversalIfThrashing(ref)
}

/**
 * The still-undecided rows a cascade would sweep along that risk classification
 * says need individual review.
 *
 * Only the *nested* rows, never the target itself: the reviewer is looking at that
 * one and deciding about it, which is exactly what individual review means. What
 * they are not looking at is its subtree.
 */
function cascadeRisks(
	spec: SpecSystem,
	ref: ReviewTarget,
	context: RiskContext,
): { id: string; reason: string }[] {
	const out: { id: string; reason: string }[] = []
	for (const child of locateReviewChildren(spec, ref)) {
		if (!child || deriveProvenanceState(child.provenance) !== 'suggested')
			continue
		// `locateReviewChildren` hands back rows, not targets, so the child's kind is
		// inferred from the parent's: an entity's children are fields, a page's are
		// blocks. Anything else has no nested reviewable rows.
		const kind =
			ref.kind === 'entity' ? 'field' : ref.kind === 'page' ? 'block' : null
		if (!kind) continue
		const id = (child as { id?: string }).id
		if (!id) continue
		const risk = classifyReviewRisk(
			spec,
			{ kind, id, parentId: ref.id },
			context,
		)
		if (risk.batchable) continue
		out.push({
			id,
			reason:
				risk.findings
					.filter((f) => f.level === 'high')
					.map((f) => f.reason)
					.join('; ') || 'needs individual review',
		})
	}
	return out
}

/**
 * How many undecided proposals a decision will actually clear — the denominator
 * of review cost.
 *
 * Counted rather than assumed, and counted *before* the decision lands. A cascade
 * over a node with eleven undecided fields clears twelve proposals; the same
 * cascade over a node whose fields are all settled clears one. Charging the whole
 * engaged slice to "one decision" in both cases would make bulk review look
 * *slower* than reviewing one at a time, which is the opposite of the truth and
 * would sink the very change this metric exists to evaluate.
 *
 * Only `suggested` rows count, matching what `provenance.review` will actually
 * transition — a cascade never touches a settled or manual row, so counting those
 * would inflate the batch with work nobody did.
 */
function proposalsSettledBy(
	spec: SpecSystem,
	ref: ReviewTarget,
	cascade: boolean,
): number {
	const target = locateReviewTarget(spec, ref)
	const undecided = (
		row:
			| { provenance: Parameters<typeof deriveProvenanceState>[0] }
			| undefined,
	) =>
		row !== undefined && deriveProvenanceState(row.provenance) === 'suggested'
	let count = undecided(target) ? 1 : 0
	if (cascade) {
		for (const child of locateReviewChildren(spec, ref)) {
			if (undecided(child)) count++
		}
	}
	// Never zero: a decision on an already-settled row is still a decision
	// somebody made, and a zero denominator would divide review cost by nothing.
	return Math.max(count, 1)
}

/**
 * When the reviewed row became reviewable — the far end of *elapsed* time.
 *
 * Read off the op-log entry that introduced it, which is the only record of the
 * fact. Returns `undefined` rather than a guess when there is no such entry: a
 * row can predate the op log (a hand-authored `spec.json`), and an invented
 * proposal time would produce an elapsed duration that looks measured.
 *
 * The value is passed through verbatim, including a date-only `appliedAt` — the
 * cost model is the thing that decides a date is not precise enough to subtract
 * (`hasTimeComponent`), and it makes that call in one place rather than here.
 */
function proposedAt(spec: SpecSystem, targetId: string): string | undefined {
	for (let i = spec.opLog.length - 1; i >= 0; i--) {
		const entry = spec.opLog[i]
		if (
			entry &&
			entry.diff.targetId === targetId &&
			entry.diff.change === 'add'
		)
			return entry.appliedAt
	}
	return undefined
}

/**
 * Resolve a pending decision from the panel (the alternatives browser): append
 * a `resolved` entry to the append-only ledger via the settled
 * {@link resolveDecision} primitive. Validates the option belongs to the
 * decision (resolveDecision throws otherwise) and stamps the platform clock.
 */
export async function submitResolve(form: FormData): Promise<void> {
	const id = form.get('decisionId')
	const chosenOptionId = form.get('optionId')
	const rationale = form.get('rationale')

	if (typeof id !== 'string' || id.length === 0)
		throw new Response('missing decisionId', { status: 400 })
	if (typeof chosenOptionId !== 'string' || chosenOptionId.length === 0)
		throw new Response('missing optionId', { status: 400 })

	const platform = getPlatform()
	const now = platform.now()
	const spec = await platform.spec.load()
	const nextLedger = resolveDecision(spec.ledger, {
		id: id as Parameters<typeof resolveDecision>[1]['id'],
		chosenOptionId,
		rationale: typeof rationale === 'string' ? rationale : '',
		decidedAt: now,
		recordedAt: now,
		origin: 'human',
	})
	await platform.spec.save({ ...spec, ledger: nextLedger })
	await recordEvent('resolve', { targetId: id, detail: chosenOptionId })
}
