/**
 * The bulk-review pane.
 *
 * The design problem is not "how do I add checkboxes". It is that a bulk accept is
 * the one control in the product that makes *not looking* efficient, so the surface
 * has to make the safe majority cheap while making the dangerous minority
 * impossible to sweep along. Three things do that work here:
 *
 *   1. **Needs-attention comes first, above the batchable groups.** The proposals
 *      that can never be batched are the ones a reviewer would otherwise never
 *      notice they were skipping, so they are at the top of the pane rather than
 *      filtered out of it.
 *   2. **A group with one high-risk member has no accept button at all** — not a
 *      disabled one, not one behind a confirm. The affordance is absent, because a
 *      present-but-guarded button is a thing people learn to click through.
 *   3. **The combined effect is stated before the action, in the button's own
 *      label** ("Accept 12 fields on e-order"), and every risk reason is on screen.
 *      A batch a reviewer cannot describe is a batch they did not review.
 *
 * There is deliberately **no select-all**. A control that grows silently as an agent
 * proposes more is a rubber stamp with extra steps.
 *
 * Server-rendered throughout: no state, no effects. Partly restraint, partly issue
 * #138 — a hydration mismatch here cannot be caught by a client-only `render()`
 * test, and this is the last surface where a silent one should be discovered.
 * Selection is plain checkboxes inside a `<Form>`, so the browser holds the state
 * and there is nothing to mismatch.
 */

import type {
	BulkReviewGroup,
	PendingProposal,
	RiskLevel,
} from '@maxstack/spec'
import { Form } from 'react-router'
import type { BulkReviewView } from './bulk-review.server'
import { paneClass } from './shared'

/** The form value identifying a target — parsed by `parseTargets`. */
function targetValue(p: PendingProposal): string {
	return `${p.target.kind}:${p.target.parentId ?? ''}:${p.target.id}`
}

const RISK_CLASS: Record<RiskLevel, string> = {
	high: 'bg-destructive/15 text-destructive',
	medium: 'bg-warning/15 text-warning',
	low: 'bg-muted text-muted-foreground',
}

function RiskChip({ level }: { level: RiskLevel }) {
	return (
		<span
			className={`rounded px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase ${RISK_CLASS[level]}`}
		>
			{level}
		</span>
	)
}

/** One proposal's row, with its risk reasons always visible. */
function ProposalRow({
	proposal,
	selectable,
}: {
	proposal: PendingProposal
	selectable: boolean
}) {
	const detail = (
		<span className="flex-1">
			<span className="font-medium">{proposal.label}</span>
			<span className="ml-1 text-muted-foreground">{proposal.target.kind}</span>
			<span className="ml-1">
				<RiskChip level={proposal.risk.level} />
			</span>
			{/* Every reason, not just the worst — a reviewer deciding needs the
			    whole picture, and the list is short by construction. */}
			<span className="block text-[0.72rem] text-muted-foreground">
				{proposal.risk.findings.map((f) => f.reason).join(' · ')}
			</span>
		</span>
	)
	const rowClass = 'flex items-start gap-1.5 text-[0.82rem]'
	return (
		<li className="border-border/60 border-b py-1 last:border-b-0">
			{selectable ? (
				<label className={rowClass}>
					<input
						type="checkbox"
						name="target"
						value={targetValue(proposal)}
						className="mt-1"
					/>
					{detail}
				</label>
			) : (
				// Not a label, and not a disabled checkbox either. There is no control
				// here to label, so wrapping the text in one would announce a form field
				// that does not exist to anyone using a screen reader — and a
				// present-but-refused affordance teaches sighted people to look for the
				// way round it. The row is text, because the decision is not available.
				<div className={rowClass}>
					<span
						aria-hidden="true"
						className="mt-0.5 w-[13px] text-center text-muted-foreground"
					>
						·
					</span>
					{detail}
				</div>
			)}
		</li>
	)
}

/**
 * A group of proposals that can be cleared together.
 *
 * The button label states the combined effect, because the confirmation a reviewer
 * actually reads is the one written on the thing they are about to press.
 */
function BatchableGroup({ group }: { group: BulkReviewGroup }) {
	const proposals = group.targets.map((target, i) => ({
		target,
		label: target.id,
		state: 'suggested' as const,
		risk: group.assessments[i] ?? {
			level: 'high' as const,
			findings: [],
			batchable: false,
		},
	}))
	return (
		<Form method="post" className="mb-3">
			<input type="hidden" name="intent" value="bulk-review" />
			<h3 className="mb-1 flex items-center gap-1.5 text-[0.85rem] font-semibold">
				{group.label}
				<span className="text-muted-foreground">
					({group.batchableCount} of {group.targets.length} selectable)
				</span>
				<RiskChip level={group.risk} />
			</h3>
			<ul className="m-0 list-none p-0">
				{proposals.map((p) => (
					<ProposalRow
						key={targetValue(p)}
						proposal={p}
						// Per member, not per group: the risky one inside an otherwise
						// routine group gets no checkbox while its neighbours keep theirs.
						selectable={p.risk.batchable}
					/>
				))}
			</ul>
			<div className="mt-1 flex gap-1.5">
				<button
					type="submit"
					name="action"
					value="accept"
					className="rounded-md border border-input bg-primary px-2 py-1 text-[0.78rem] font-medium text-primary-foreground"
				>
					Accept selected
				</button>
				<button
					type="submit"
					name="action"
					value="reject"
					className="rounded-md border border-input px-2 py-1 text-[0.78rem]"
				>
					Reject selected
				</button>
			</div>
			<p className="mt-1 text-[0.7rem] text-muted-foreground">
				Nothing selected lands nothing. Anything the batch refuses is reported
				back rather than skipped.
			</p>
		</Form>
	)
}

export function BulkReviewPane({ bulk }: { bulk: BulkReviewView }) {
	const { groups, needsAttention, undoable, undoWithheld, proposals } = bulk
	// Offered whenever *any* member can be batched, not only when all of them can.
	// A group with one access-control field among twenty routine ones is exactly the
	// case bulk review exists for: the twenty go in one action, and the one is left
	// behind with no checkbox. Gating the group on `batchable` made a single risky
	// field turn its neighbours back into twenty individual decisions.
	const batchable = groups.filter((g) => g.batchableCount > 0)

	return (
		<section className={paneClass}>
			<h2 className="mt-0 text-base font-semibold">
				Bulk review{' '}
				<span className="text-[0.8rem] font-normal text-muted-foreground">
					({proposals.length} pending)
				</span>
			</h2>

			{proposals.length === 0 ? (
				<p className="text-[0.82rem] text-muted-foreground">
					Nothing pending. Every proposal has been decided.
				</p>
			) : null}

			{/* Undo first: it is time-limited and the reviewer needs it before they
			    start the next batch. */}
			{undoable ? (
				<Form
					method="post"
					className="mb-3 rounded-md border border-border p-2"
				>
					<input type="hidden" name="intent" value="bulk-undo" />
					<input type="hidden" name="batchId" value={undoable.batchId} />
					<div className="text-[0.8rem]">
						Last batch settled{' '}
						<strong>
							{undoable.size} proposal{undoable.size === 1 ? '' : 's'}
						</strong>
						.
					</div>
					<button
						type="submit"
						className="mt-1 rounded-md border border-input px-2 py-1 text-[0.78rem]"
					>
						Undo that batch
					</button>
					<p className="mt-1 text-[0.7rem] text-muted-foreground">
						Returns those rows to undecided and records the reversal in the op
						log. Rows something else has decided since are left alone — the undo
						takes back the batch's decisions, not whatever the state is now.
					</p>
				</Form>
			) : null}

			{/* The expired offer says so. Dropping the section silently would leave a
			    reviewer who saw the button a minute ago with no account of where it
			    went, and no idea that the way back is now per-row. */}
			{undoWithheld ? (
				<div className="mb-3 rounded-md border border-dashed border-border p-2">
					<div className="text-[0.8rem]">
						Last batch settled{' '}
						<strong>
							{undoWithheld.size} proposal
							{undoWithheld.size === 1 ? '' : 's'}
						</strong>
						, and can no longer be undone in one action.
					</div>
					<p className="mt-1 text-[0.7rem] text-muted-foreground">
						Because {undoWithheld.reason}. Undoing the batch now would put the
						spec back and leave the generated files in place. Reset the rows
						individually in the queue, then regenerate.
					</p>
				</div>
			) : null}

			{/* Needs attention ABOVE the batchable groups. These are the ones a
			    reviewer would otherwise not notice they were skipping. */}
			{needsAttention.length > 0 ? (
				<div className="mb-3">
					<h3 className="mb-1 text-[0.85rem] font-semibold text-destructive">
						Needs your attention ({needsAttention.length})
					</h3>
					<p className="mb-1 text-[0.72rem] text-muted-foreground">
						Bulk review will not clear these at any size. Decide them
						individually in the queue above.
					</p>
					<ul className="m-0 list-none p-0">
						{needsAttention.map((p) => (
							<ProposalRow
								key={targetValue(p)}
								proposal={p}
								selectable={false}
							/>
						))}
					</ul>
				</div>
			) : null}

			{batchable.map((group) => (
				<BatchableGroup key={group.key} group={group} />
			))}

			{proposals.length > 0 && batchable.length === 0 ? (
				<p className="text-[0.82rem] text-muted-foreground">
					Nothing here can be cleared in a batch — every pending proposal needs
					individual attention. That is the system working, not a limitation.
				</p>
			) : null}
		</section>
	)
}
