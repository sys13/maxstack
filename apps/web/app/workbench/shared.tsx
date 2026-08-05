// ---------------------------------------------------------------------------
// Shared bits — the library's own primitives, not hand-rolled ones
// ---------------------------------------------------------------------------

import { EnumChip } from '@maxstack/ui'
import { Form, Link } from 'react-router'
import type { QueueView } from './review-queue'
import type { ProvenanceCounts, ReviewRef } from './view-model'

/**
 * The state badge — and the one deliberate silence on this surface.
 *
 * `deriveProvenanceState` calls a row `accepted` the moment anything settled it,
 * including every op the maintainer's own agent authored. That is correct as a
 * provenance fact and a lie as a UI label: the workbench used to badge a `title`
 * field "accepted" to someone who had never reviewed anything, which trains the
 * reader that the badges mean nothing. So a settled row gets **no badge at all**
 * — it is simply part of the app. Only the two states that are *about the
 * reader* render: something is waiting for them, or they turned it down.
 *
 * `showSettled` is the escape hatch for the few places that genuinely report a
 * decision (the ledger, per-node history), where "accepted" is the subject
 * rather than the wallpaper.
 */
export function StateChip({
	state,
	showSettled,
}: {
	state?: string
	showSettled?: boolean
}) {
	if (!state) return null
	if (!showSettled && (state === 'accepted' || state === 'manual')) return null
	if (state === 'suggested')
		return (
			<span className="inline-flex items-center rounded border border-warning/50 bg-warning/10 px-1.5 py-0.5 text-[0.66rem] font-medium text-warning">
				needs your OK
			</span>
		)
	if (state === 'rejected')
		return (
			<span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[0.66rem] font-medium text-muted-foreground line-through">
				turned down
			</span>
		)
	// `showSettled`. The words match the filter dropdown's options exactly: a
	// filter offering "In your app" over rows chipped `accepted` is two names for
	// one state, which is the same failure as two panes called "Review queue".
	if (state === 'accepted')
		return (
			<span className="inline-flex items-center rounded border border-success/50 px-1.5 py-0.5 text-[0.66rem] font-medium text-success">
				in your app
			</span>
		)
	if (state === 'manual')
		return (
			<span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[0.66rem] font-medium text-muted-foreground">
				you wrote it
			</span>
		)
	return <EnumChip value={state} />
}

/**
 * Accept/reject/resolve/undo action styling, on theme tokens.
 *
 * This used to claim it was "semantic Tailwind … dark-mode aware", and the
 * emerald/red/indigo it named are neither: they are literal palette colours that
 * held still while every themed control around them moved, and each one needed a
 * hand-written `dark:` pair because a literal cannot follow the mode on its own.
 * A token carries both modes and every preset, so the pairs go away with the
 * literals.
 *
 * `resolve` takes the brand colour. It is the odd one out — not an approval and
 * not a refusal — so what it needs is to be *distinct from the other three*,
 * which `primary` is in every preset, rather than to be indigo in particular.
 */
export function actionClass(
	variant: 'accept' | 'reject' | 'neutral' | 'resolve',
) {
	const base =
		'inline-flex h-8 cursor-pointer items-center justify-center rounded-md border px-3 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'
	switch (variant) {
		case 'accept':
			return `${base} border-success/50 text-success hover:bg-success/10`
		case 'reject':
			return `${base} border-destructive/50 text-destructive hover:bg-destructive/10`
		case 'resolve':
			return `${base} border-primary/50 text-primary hover:bg-primary/10`
		default:
			return `${base} border-border text-muted-foreground hover:bg-muted`
	}
}

/**
 * The one number worth putting in a header: how much is waiting on the reader.
 *
 * It used to print all four provenance counts ("12 suggested · 40 accepted · 0
 * rejected · 3 manual"), which is a status line for whoever wrote the
 * provenance model, not for whoever is building the app.
 */
export function CountBar({ counts }: { counts: ProvenanceCounts }) {
	if (counts.total === 0) return null
	return (
		<span className="text-xs text-muted-foreground">
			{/* "things", explicitly: this counts individual rows, while the queue
			    below counts the *decisions* they group into, and those two numbers
			    differ. Two unlabelled counts that disagree is how a surface teaches
			    people to distrust all of its numbers. */}
			{counts.suggested === 0
				? `${counts.total} things in this app · nothing waiting on you`
				: `${counts.suggested} thing${counts.suggested === 1 ? '' : 's'} waiting for your OK`}
		</span>
	)
}

/** A count badge for a spine row — silent at zero, so an app with nothing
 *  pending reads as calm rather than as a wall of zeroes. */
export function PendingBadge({ count }: { count: number }) {
	if (count === 0) return null
	return (
		<span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-warning/15 px-1.5 text-[0.66rem] font-semibold text-warning">
			{count}
		</span>
	)
}

export const paneClass = 'min-w-0 rounded-lg border border-border p-4'

/** A single accept/reject pair for one review target — the row-level (not
 * bulk) action, kept as a plain form so cascade semantics stay explicit. */
export function ReviewButtons({
	target,
	cascade,
}: {
	target: ReviewRef
	/** Queue rows cascade (one decision covers the node's undecided children). */
	cascade?: boolean
}) {
	return (
		<Form method="post" className="inline-flex gap-1.5">
			<input type="hidden" name="kind" value={target.kind} />
			<input type="hidden" name="id" value={target.id} />
			{target.parentId ? (
				<input type="hidden" name="parentId" value={target.parentId} />
			) : null}
			{cascade ? <input type="hidden" name="cascade" value="1" /> : null}
			{/* "Accept"/"Reject" named the provenance transition. These name what
			    happens to the reader's app, and the `title`s say the part that is
			    genuinely non-obvious: turning something down never deletes it. */}
			<button
				type="submit"
				name="action"
				value="accept"
				title="Keep this in the app — it becomes part of your spec"
				className={actionClass('accept')}
			>
				Keep
			</button>
			<button
				type="submit"
				name="action"
				value="reject"
				title="Turn this down — it stays on record as declined, nothing is deleted"
				className={actionClass('reject')}
			>
				Turn down
			</button>
		</Form>
	)
}

export function focusHref(id: string) {
	return `?focus=${encodeURIComponent(id)}`
}

export function viewHref(view: QueueView) {
	return `?queue=${view}`
}

/** Preserves whatever's already in the URL (queue view, focus, filters) and
 *  sets/clears `?diff=` — so opening a diff never loses the maintainer's
 *  current filter/queue-view state. */
export function diffHref(params: URLSearchParams, key: string | null) {
	const next = new URLSearchParams(params)
	if (key) next.set('diff', key)
	else next.delete('diff')
	return `?${next.toString()}`
}

/**
 * The dual-view toggle. Same list, two orderings — but "Product roadmap" vs
 * "Platform backlog" only tells you which one to pick if you already know that
 * *platform* here means maxstack itself, not your app. Whoever is building an
 * app has no reason to know that, so the labels now say what each ordering is
 * sorted by, and {@link ViewExplainer} says who each one is for.
 */
export function ViewToggle({ view }: { view: QueueView }) {
	const tab = (v: QueueView, label: string) => (
		<Link
			to={viewHref(v)}
			className={`${actionClass(v === view ? 'resolve' : 'neutral')} no-underline ${
				// Matches `actionClass('resolve')`, which is the brand colour.
				v === view ? 'bg-primary/10' : ''
			}`}
		>
			{label}
		</Link>
	)
	return (
		<div className="inline-flex gap-1.5">
			{tab('product', 'Best value first')}
			{tab('platform', 'Hardest first')}
		</div>
	)
}

export function ViewExplainer({ view }: { view: QueueView }) {
	return (
		<p className="mt-0 mb-3 text-[0.8rem] text-muted-foreground">
			{view === 'product'
				? 'Most asked-for and cheapest to build, at the top — the order to work in if you are building your app.'
				: 'The asks maxstack has no cheap way to express, at the top — this ordering is for whoever is extending maxstack itself, not for building your app.'}
		</p>
	)
}

export function StatChip({ label, value }: { label: string; value: number }) {
	return (
		<div className="min-w-16 rounded-lg border border-border px-2.5 py-1.5">
			<div className="text-xl leading-none font-bold">{value}</div>
			<div className="text-[0.62rem] text-muted-foreground uppercase">
				{label}
			</div>
		</div>
	)
}
