/**
 * `<BulkActionBar>` and `<RowActionButtons>` — declared list actions, rendered.
 *
 * ## What these do NOT do
 *
 * They do not write. Every control here calls `onRun`, which the route wires to
 * a POST at `/api/:resource/actions/:key`; the browser never loops over updates,
 * never composes a payload, and never learns what the action writes. That is the
 * whole difference between this and React Admin's bulk action, and it is
 * structural rather than promised: **there is nothing in this file that could
 * write a row even if everything in it were wrong.** The cap, the role, the
 * write set and the option list are all enforced in `opRunAction`, below every
 * surface, and a hand-crafted `fetch` past this component meets the identical
 * refusals.
 *
 * What the declaration buys the UI is what to *offer*: which buttons exist, what
 * they are called, whether an action needs a choice and which choices are legal.
 * Getting any of that wrong here makes a button that 400s, not a button that
 * does something nobody declared.
 *
 * ## Why the cap is shown and also enforced
 *
 * The bar disables itself past `maxSelection` and says the number. That is a
 * courtesy, not a control — the server refuses the run *whole* rather than
 * truncating it, so the honest thing is to say so before somebody ticks four
 * hundred rows and loses the lot to a refusal. This package never imports a
 * router and holds no state beyond the pending choice, so a disabled button here
 * is a hint about a rule that lives somewhere else.
 */

import { useState } from 'react'
import { cn } from '../lib/cn.ts'

/** One declared action, as much of it as a control needs. Structurally the
 *  runtime's `ActionPlan` minus what only the server uses, so a route can hand
 *  the plan straight through without a mapping step that could drift. */
export interface ListActionDescriptor {
	key: string
	label: string
	description: string
	arity: 'row' | 'selection' | 'both'
	/** Present iff the action needs a value picked when it is run. */
	choose?: { column: string; options: string[] }
	maxSelection: number
	undoable: boolean
}

/** What a control asks the route to do. `choice` is present iff the action
 *  declares `choose`. */
export type RunAction = (
	action: ListActionDescriptor,
	ids: string[],
	choice?: string,
) => void

const BUTTON =
	'inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-sm font-medium shadow-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50'

/**
 * One action as a control: a plain button, or a select-plus-button when the
 * action declares a choice.
 *
 * The choice is a `<select>` over the *declared* options rather than a free
 * input, which is why `choose` carries them. A text box here would be a control
 * that looks constrained and is not — the server would still refuse an
 * undeclared value, but the person typing would find out afterwards.
 */
function ActionControl({
	action,
	ids,
	onRun,
	disabled,
	busy,
}: {
	action: ListActionDescriptor
	ids: string[]
	onRun: RunAction
	disabled?: boolean
	busy?: boolean
}) {
	const [choice, setChoice] = useState<string>(
		() => action.choose?.options[0] ?? '',
	)
	const over = ids.length > action.maxSelection
	const title = over
		? `${action.label} takes at most ${action.maxSelection} row(s) at a time — ${ids.length} are selected, and the run would be refused whole rather than applied to the first ${action.maxSelection}.`
		: action.description
	const stopped = disabled || busy || over || ids.length === 0

	if (!action.choose)
		return (
			<button
				type="button"
				className={BUTTON}
				title={title}
				disabled={stopped}
				onClick={() => onRun(action, ids)}
			>
				{action.label}
			</button>
		)

	return (
		<span className="inline-flex items-center gap-1">
			<select
				className="h-8 rounded-md border border-border bg-background px-2 text-sm"
				aria-label={`${action.label}: ${action.choose.column}`}
				value={choice}
				disabled={stopped}
				onChange={(e) => setChoice(e.target.value)}
			>
				{action.choose.options.map((option) => (
					<option key={option} value={option}>
						{option}
					</option>
				))}
			</select>
			<button
				type="button"
				className={BUTTON}
				title={title}
				disabled={stopped || !choice}
				onClick={() => onRun(action, ids, choice)}
			>
				{action.label}
			</button>
		</span>
	)
}

/**
 * The toolbar `<ResourceList>` renders above the table while a selection exists.
 *
 * It says how many rows are selected before it offers anything to do to them,
 * because the count is the fact somebody is about to act on and the one they
 * most often have wrong — a "select all on page" that ticked forty when they
 * thought it ticked twelve is exactly how a bulk action becomes an incident.
 */
export function BulkActionBar({
	actions,
	selectedIds,
	onRun,
	busy,
	disabled,
	className,
}: {
	actions: readonly ListActionDescriptor[]
	selectedIds: string[]
	onRun: RunAction
	/** A run is in flight — every control is inert until it settles, so a second
	 *  click cannot aim the same action at the same rows twice. */
	busy?: boolean
	disabled?: boolean
	className?: string
}) {
	const offered = actions.filter(
		(a) => a.arity === 'selection' || a.arity === 'both',
	)
	if (offered.length === 0) return null
	return (
		<div className={cn('flex flex-wrap items-center gap-2', className)}>
			<span className="text-sm text-muted-foreground">
				{selectedIds.length} selected
			</span>
			{offered.map((action) => (
				<ActionControl
					key={action.key}
					action={action}
					ids={selectedIds}
					onRun={onRun}
					busy={busy}
					disabled={disabled}
				/>
			))}
		</div>
	)
}

/**
 * The controls on one row.
 *
 * A row action is the same primitive at arity one — the corpus's largest
 * interaction cluster ("move this deal's stage", "suspend this card") — so it
 * goes through the identical endpoint with a one-id selection rather than
 * through a second, cheaper-looking path. A row control that wrote directly
 * would be the client-side loop again, with the loop unrolled to one.
 */
export function RowActionButtons({
	actions,
	rowId,
	onRun,
	busy,
	disabled,
}: {
	actions: readonly ListActionDescriptor[]
	rowId: string
	onRun: RunAction
	busy?: boolean
	disabled?: boolean
}) {
	const offered = actions.filter((a) => a.arity === 'row' || a.arity === 'both')
	if (offered.length === 0) return null
	return (
		<span className="inline-flex items-center gap-1">
			{offered.map((action) => (
				<ActionControl
					key={action.key}
					action={action}
					ids={[rowId]}
					onRun={onRun}
					busy={busy}
					disabled={disabled}
				/>
			))}
		</span>
	)
}

/**
 * What a finished run reads as, for the banner a surface shows afterwards.
 *
 * A partial run gets a sentence naming the failures rather than a count,
 * because "412 of 500 succeeded" with no way to learn which 88 did not is a
 * result that makes somebody re-read the whole list. The ids are the answer to
 * "which ones do I look at".
 */
export function describeActionRun(result: {
	action: string
	requested: number
	applied: { id: string }[]
	failed: { id: string; error?: string }[]
}): string {
	if (result.failed.length === 0)
		return `${result.action}: ${result.applied.length} row(s) updated.`
	if (result.applied.length === 0)
		return `${result.action}: nothing was changed. ${result.failed[0]?.error ?? 'Every row was refused.'}`
	return `${result.action}: ${result.applied.length} of ${result.requested} row(s) updated. Refused: ${result.failed
		.map((f) => `${f.id} (${f.error ?? 'unknown reason'})`)
		.join('; ')}`
}
