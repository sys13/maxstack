/**
 * `<ConfirmButton>` — a destructive submit that asks first.
 *
 * A record's Delete used to be one unguarded click sitting next to Save: the
 * row was gone, with no confirmation and no undo. That sits oddly beside the
 * spec layer's stated invariant that regeneration never deletes manual items —
 * the data layer had no equivalent guard at all.
 *
 * The confirmation is **in-page**, deliberately: native `confirm()` blocks the
 * event loop and wedges browser automation (the whole session stops responding
 * until a human dismisses it), so this is a two-step button instead. The first
 * click is inert (`type="button"`, nothing submitted); it swaps in a confirm /
 * cancel pair, and only the confirm is a real `type="submit"`. Which means a
 * caller wires it exactly like the plain `<Button type="submit">` it replaces —
 * the enclosing `<Form>` and its hidden `intent` are unchanged.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/primitives.tsx'

export interface ConfirmButtonProps {
	/** Resting label — what the action is ("Delete"). */
	label: string
	/** The armed question (default `"<label>?"`). */
	confirmLabel?: string
	/** Label while the submission is in flight; also disables the control. */
	pendingLabel?: string
	/** Back-out label (default "Cancel"). */
	cancelLabel?: string
	pending?: boolean
	disabled?: boolean
	className?: string
}

export function ConfirmButton({
	label,
	confirmLabel,
	pendingLabel,
	cancelLabel = 'Cancel',
	pending = false,
	disabled = false,
	className,
}: ConfirmButtonProps) {
	const [armed, setArmed] = useState(false)
	const confirmRef = useRef<HTMLButtonElement>(null)

	// Arming moves the confirm into the same screen position the resting button
	// occupied, so a second reflexive click would land on it. Focusing it makes
	// the keyboard path work and — more to the point — makes the state change
	// something a screen reader announces rather than a silent relabel.
	useEffect(() => {
		if (armed) confirmRef.current?.focus()
	}, [armed])

	if (pending) {
		return (
			<Button
				type="submit"
				variant="destructive"
				disabled
				className={className}
			>
				{pendingLabel ?? `${label}…`}
			</Button>
		)
	}

	if (!armed) {
		return (
			<Button
				type="button"
				variant="destructive"
				disabled={disabled}
				onClick={() => setArmed(true)}
				className={className}
			>
				{label}
			</Button>
		)
	}

	return (
		<div className="flex items-center gap-2">
			<span className="text-sm text-muted-foreground">
				{confirmLabel ?? `${label}?`}
			</span>
			<Button
				ref={confirmRef}
				type="submit"
				variant="destructive"
				disabled={disabled}
				className={className}
			>
				{label}
			</Button>
			<Button type="button" variant="outline" onClick={() => setArmed(false)}>
				{cancelLabel}
			</Button>
		</div>
	)
}
