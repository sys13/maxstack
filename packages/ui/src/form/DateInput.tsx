/**
 * `<DateInput>` — a date field you can actually type into.
 *
 * ## The bug this replaces, and why it was not ours to fix
 *
 * A generated form rendered `<input type="date">`. Typing `2026-07-10` into one,
 * in real Chrome, produces `202607-10-dd`. Reproduced rather than inferred, and
 * the cause is native:
 *
 *  - Chrome's **year segment accepts six digits**, because years run to 275760.
 *    After `2026` it therefore keeps waiting rather than advancing.
 *  - **`-` is not a segment-advance key.** It is swallowed.
 *  - So `2026` `-` `07` lands as the year `202607`, and everything after it is
 *    shifted by one segment.
 *
 * The trap is that the control **displays `yyyy-mm-dd`** as its own format hint,
 * which is precisely the string that cannot be typed. There is no version of our
 * code that fixes that: the segmented editor is the browser's, and the fix is to
 * stop using it as a text entry surface.
 *
 * ## What this does instead
 *
 * A plain text input that accepts `YYYY-MM-DD` typed literally — inserting the
 * dashes for you, so `20260710` and `2026-07-10` both work — beside a button
 * that opens the **native calendar picker**. Nothing is lost: the picker is the
 * same one, via `showPicker()` on a visually-hidden native input, and mobile
 * still gets its native wheel through that path.
 *
 * ## The other half of #139: it is now testable
 *
 * The issue could not be closed by a build because **Playwright cannot type into
 * a Chrome date input at all** — it drives the value, not the segments — so the
 * regression could only ever be caught by a person. A text input has no
 * segments, so `fill()` and `type()` both work, jsdom can drive it, and the
 * behaviour is pinned by ordinary tests. That is the difference between fixing
 * this bug and being able to keep it fixed.
 */

import { useId, useRef, useState } from 'react'
import { cn } from '../lib/cn.ts'
import { Input } from '../ui/primitives.tsx'

/**
 * Format digits as the user types: `20260710` → `2026-07-10`.
 *
 * Dashes are re-derived from the digits rather than preserved from the input, so
 * a paste, a partial edit and a fresh type all normalize the same way — and a
 * caller who types the dashes themselves is not punished for it.
 */
export function formatDateTyping(raw: string): string {
	const digits = raw.replace(/\D/g, '').slice(0, 8)
	if (digits.length <= 4) return digits
	if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`
	return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`
}

/**
 * Whether a string is a real calendar date, not merely well-shaped.
 *
 * `2026-02-31` matches the pattern and is not a day, so the round-trip check is
 * the test: build the date and require it to print back what it was given. A
 * form that accepted the 31st of February would push the problem to the column.
 */
export function isCompleteDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
	const date = new Date(`${value}T00:00:00Z`)
	return (
		!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
	)
}

export interface DateInputProps {
	name: string
	id?: string
	defaultValue?: string
	disabled?: boolean
	required?: boolean
	className?: string
	'aria-describedby'?: string
	'aria-invalid'?: boolean
	onValueChange?: (value: string) => void
}

export function DateInput({
	name,
	id,
	defaultValue = '',
	disabled,
	required,
	className,
	onValueChange,
	...aria
}: DateInputProps) {
	const [value, setValue] = useState(defaultValue)
	const pickerRef = useRef<HTMLInputElement>(null)
	const fallbackId = useId()
	const inputId = id ?? fallbackId

	const commit = (next: string) => {
		setValue(next)
		onValueChange?.(next)
	}

	return (
		<div className={cn('flex items-center gap-2', className)}>
			{/*
			  The field that carries the value to the form. `type="text"` on purpose —
			  see the module comment. `inputMode="numeric"` still brings up the number
			  pad on a phone, so typing is no worse there than it was.
			*/}
			<Input
				id={inputId}
				name={name}
				type="text"
				inputMode="numeric"
				autoComplete="off"
				placeholder="YYYY-MM-DD"
				value={value}
				disabled={disabled}
				required={required}
				// A pattern rather than a `type` the browser validates its own way:
				// this one reports against the string the person actually typed.
				pattern="\d{4}-\d{2}-\d{2}"
				onChange={(event) => commit(formatDateTyping(event.target.value))}
				{...aria}
			/>
			{/*
			  The native picker, kept. `showPicker()` needs a real date input, so one
			  exists — visually hidden, never focusable, and carrying no name, so it
			  cannot submit a second value for this field.
			*/}
			<input
				ref={pickerRef}
				type="date"
				tabIndex={-1}
				aria-hidden="true"
				className="sr-only"
				value={isCompleteDate(value) ? value : ''}
				onChange={(event) => commit(event.target.value)}
			/>
			<button
				type="button"
				disabled={disabled}
				aria-label="Open calendar"
				className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
				onClick={() => {
					const picker = pickerRef.current
					if (!picker) return
					// `showPicker` is unavailable in older browsers and throws if the
					// element is not user-activated. Focus is the honest fallback: the
					// person still has a working text field either way, so a missing
					// picker degrades to typing rather than to nothing.
					try {
						picker.showPicker?.()
					} catch {
						picker.focus()
					}
				}}
			>
				<svg
					aria-hidden="true"
					viewBox="0 0 16 16"
					className="h-4 w-4"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
				>
					<title>Calendar</title>
					<rect x="2" y="3.5" width="12" height="10" rx="1.5" />
					<path d="M2 6.5h12M5.5 2v3M10.5 2v3" />
				</svg>
			</button>
		</div>
	)
}
