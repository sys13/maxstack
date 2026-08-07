/**
 * Edit-in-place cells (Plan v5 task 40) — the inline-edit variant of a list
 * cell. Display mode renders the same `<Field>` a read-only cell would; clicking
 * it swaps in a type-appropriate editor (text/number/date input, enum select,
 * boolean checkbox) that commits on Enter/change/blur and cancels on Escape.
 *
 * The component is presentation-pure like the rest of `<ResourceList>`: it emits
 * the parsed value through `onSave` and never touches the network. The one-line
 * wiring is task 33's `useUpdate`:
 *
 * ```tsx
 * const [update] = useUpdate('post')
 * <ResourceList editable={['title']} onCellSave={(row, name, v) =>
 *   update(String(row.id), { [name]: v })} … />
 * ```
 *
 * (`useUpdate` already patches every cached list optimistically and rolls back
 * + toasts on failure, so the cell needs no saving/error state of its own.)
 */

import { useRef, useState } from 'react'
import {
	humanizeLabel,
	type IntrospectedColumn,
} from '../fields/field-semantics.ts'
import { Field } from '../fields/fields.tsx'
import { cn } from '../lib/cn.ts'

export interface EditableCellProps {
	value: unknown
	column: IntrospectedColumn
	/** Persist the parsed value (numbers as numbers, booleans as booleans; an
	 * emptied input saves `null`). Not called when the value didn't change. */
	onSave: (value: unknown) => void | Promise<void>
	className?: string
}

export function EditableCell({
	value,
	column,
	onSave,
	className,
}: EditableCellProps) {
	const [editing, setEditing] = useState(false)
	const label = column.meta?.label ?? humanizeLabel(column.name)

	if (!editing) {
		return (
			<button
				type="button"
				onClick={() => setEditing(true)}
				aria-label={`Edit ${label}`}
				className={cn(
					'-mx-1 block w-full cursor-text rounded px-1 py-0.5 text-left hover:bg-muted/60',
					className,
				)}
			>
				<Field value={value} column={column} />
			</button>
		)
	}

	return (
		<CellEditor
			value={value}
			column={column}
			label={label}
			onDone={(next) => {
				setEditing(false)
				// `NO_CHANGE` covers both an explicit cancel and a commit of the
				// unchanged value — either way there's nothing to persist. So does
				// clearing a cell that was already empty: an absent key and a stored
				// `null` are the same emptiness to a person reading the row, and
				// writing one over the other is an audit entry recording nothing.
				if (next === NO_CHANGE || Object.is(next, value)) return
				if (next === null && value == null) return
				void onSave(next)
			}}
		/>
	)
}

/** Sentinel for "close the editor without saving". */
const NO_CHANGE = Symbol('no-change')

const EDITOR_CLASS =
	'h-7 w-full min-w-24 rounded border border-border bg-background px-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

/** Focus-on-mount without `autoFocus` (jsdom-friendly, lint-friendly). */
const focusOnMount = (el: HTMLElement | null) => el?.focus()

function CellEditor({
	value,
	column,
	label,
	onDone,
}: {
	value: unknown
	column: IntrospectedColumn
	label: string
	onDone: (next: unknown) => void
}) {
	// Enter commits and the unmounting input then blurs; guard the double-fire.
	const doneRef = useRef(false)
	function done(next: unknown) {
		if (doneRef.current) return
		doneRef.current = true
		onDone(next)
	}

	if (column.type === 'boolean') {
		return (
			<input
				ref={focusOnMount}
				type="checkbox"
				aria-label={label}
				defaultChecked={value === true}
				onChange={(e) => done(e.target.checked)}
				onBlur={() => done(NO_CHANGE)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') done(NO_CHANGE)
				}}
			/>
		)
	}

	const options =
		column.meta?.options?.map((o) => ({ label: o.label, value: o.value })) ??
		(column.enumValues ?? []).map((v) => ({ label: v, value: v }))
	if (column.type === 'enum' || options.length > 0) {
		const current = value == null ? '' : String(value)
		const known = options.some((o) => o.value === current)
		// A `<select>` can only ever show one of its own options, so with none
		// matching the stored value the browser silently selects the **first** one
		// — and the cell would then be displaying a value the database does not
		// have. Two bugs came out of that: an empty cell opened claiming the first
		// option, and choosing that option fired no change event, so it was the one
		// value an empty cell could never be set to.
		//
		// A blank option fixes both by telling the truth about "no value". Whether
		// it can be *chosen* is the column's own business: a nullable column can be
		// emptied through it, and a `NOT NULL` one gets it disabled — shown, because
		// the state is real, and unselectable, because committing it would be a
		// write the server is right to refuse.
		const clearable = column.nullable !== false
		return (
			<select
				ref={focusOnMount}
				aria-label={label}
				defaultValue={known ? current : ''}
				onChange={(e) => done(e.target.value === '' ? null : e.target.value)}
				onBlur={() => done(NO_CHANGE)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') done(NO_CHANGE)
				}}
				className={EDITOR_CLASS}
			>
				{(!known || clearable) && (
					<option value="" disabled={!clearable}>
						—
					</option>
				)}
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		)
	}

	const inputType =
		column.type === 'number'
			? 'number'
			: column.type === 'date'
				? 'date'
				: 'text'
	const initial = editorText(value, column)
	// What a single-line `<input>` can actually hold. The HTML value sanitization
	// algorithm strips every CR and LF from a text input's value, so a stored
	// string containing one comes back out flattened even when nobody typed:
	// `raw === initial` missed, and merely focusing the cell and tabbing away
	// committed the flattened string. Silent data loss, from an edit that was
	// never made. Prose columns are refused an editor upstream, but any string
	// column can hold a line break — one import or one API write is enough — so
	// the guard belongs here, where the sanitization happens.
	const holdable = initial.replace(/[\r\n]/g, '')
	function commit(raw: string) {
		// Untouched text is a cancel — this also keeps a stored ISO timestamp from
		// being rewritten as its truncated `YYYY-MM-DD` editor text on a stray blur.
		if (raw === initial || raw === holdable) return done(NO_CHANGE)
		if (column.type === 'number') {
			if (raw.trim() === '') return done(null)
			const n = Number(raw)
			return done(Number.isNaN(n) ? NO_CHANGE : n)
		}
		done(raw === '' ? null : raw)
	}
	return (
		<input
			ref={focusOnMount}
			type={inputType}
			aria-label={label}
			defaultValue={initial}
			onKeyDown={(e) => {
				if (e.key === 'Enter') commit(e.currentTarget.value)
				else if (e.key === 'Escape') done(NO_CHANGE)
			}}
			onBlur={(e) => commit(e.target.value)}
			className={EDITOR_CLASS}
		/>
	)
}

/** The text a fresh editor starts from. Dates are trimmed to `YYYY-MM-DD` so a
 * stored ISO timestamp round-trips through `<input type="date">`. */
function editorText(value: unknown, column: IntrospectedColumn): string {
	if (value == null) return ''
	if (column.type === 'date') {
		const iso = value instanceof Date ? value.toISOString() : String(value)
		return iso.slice(0, 10)
	}
	return String(value)
}
