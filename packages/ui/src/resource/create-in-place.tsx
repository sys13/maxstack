/**
 * The new-row form at the foot of a list (#444) — the one part of the
 * interaction layer's stage C that did not already exist.
 *
 * Everything else stage C asked for turned out to be built: in-place editing of
 * cells ships declared (`page.setBlockEditable`), and the reference-input asks
 * were a cap (#442) and a missing wire (#443). *Adding* a row without leaving
 * the list was covered by nothing — no op, no component, no route — and it is
 * what an editable line grid needs on top of editable cells, which is why
 * `ch-eject-lineitems` is one of the corpus's two interaction ejects.
 *
 * ## What this is, and is not
 *
 * It is presentation-pure, like the rest of `<ResourceList>`: it holds a draft,
 * renders one editor per collectable column, and emits the draft through
 * `onCreate`. It never touches the network, and it is not a `<form>` — the row
 * lives inside a `<table>`, and the caller's own submission path (in the
 * generated app, the resource's existing create route) is the write.
 *
 * ## Why the editors are not `EditableCell`'s
 *
 * A cell editor exists to answer "did this value change?", and all its machinery
 * — the `NO_CHANGE` sentinel, commit-on-blur, the round-trip guards against a
 * stray blur rewriting a stored timestamp — is in service of that question. A
 * new row has no stored value to change, so every one of those mechanisms would
 * be answering a question nobody asked, and commit-on-blur in particular would
 * mean tabbing between the boxes of one row submitted it three times.
 *
 * So the editors here are plain controlled inputs held open until the person
 * says Add. Their *shape* per column type is deliberately the same as a cell's,
 * because a person who has learned that a status column is a select in one row
 * has learned it for both.
 */

import { useMemo, useState } from 'react'
import {
	humanizeLabel,
	type IntrospectedColumn,
} from '../fields/field-semantics.ts'
import { cn } from '../lib/cn.ts'

const EDITOR_CLASS =
	'h-7 w-full min-w-24 rounded border border-border bg-background px-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

/** The draft a new row is being described by, keyed by column name. */
export type NewRowDraft = Record<string, unknown>

export interface NewRowEditorsProps {
	/** The columns to collect, in the order the list renders them. */
	columns: readonly IntrospectedColumn[]
	draft: NewRowDraft
	onChange: (draft: NewRowDraft) => void
	disabled?: boolean
}

/**
 * One editor per collectable column, typed by the column.
 *
 * Split out from the row itself so a caller rendering the new row *inside* a
 * table can place each editor in the cell under its own header — which is the
 * whole point of a line grid, and the reason this is not a modal with a
 * vertically stacked form in it.
 */
export function NewRowEditor({
	column,
	value,
	onChange,
	disabled,
}: {
	column: IntrospectedColumn
	value: unknown
	onChange: (value: unknown) => void
	disabled?: boolean
}) {
	const label = column.meta?.label ?? humanizeLabel(column.name)

	if (column.type === 'boolean')
		return (
			<input
				type="checkbox"
				aria-label={label}
				disabled={disabled}
				checked={value === true}
				onChange={(e) => onChange(e.target.checked)}
			/>
		)

	const options =
		column.meta?.options?.map((o) => ({ label: o.label, value: o.value })) ??
		(column.enumValues ?? []).map((v) => ({ label: v, value: v }))
	if (column.type === 'enum' || options.length > 0)
		return (
			<select
				aria-label={label}
				disabled={disabled}
				value={value == null ? '' : String(value)}
				onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value)}
				className={EDITOR_CLASS}
			>
				{/* Always offered, and always the starting state: a new row has said
				    nothing about this column yet, and pre-selecting the first option
				    would put a value in the record that nobody chose. Whether it may be
				    left there is the server's call — a required column refuses it. */}
				<option value="">—</option>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		)

	return (
		<input
			type={
				column.type === 'number'
					? 'number'
					: column.type === 'date'
						? 'date'
						: 'text'
			}
			aria-label={label}
			disabled={disabled}
			placeholder={label}
			value={value == null ? '' : String(value)}
			onChange={(e) => {
				const raw = e.target.value
				if (column.type !== 'number') return onChange(raw)
				// An empty number box is "not said", not `NaN` and not zero — the
				// caller drops empty strings, so this keeps the box clearable without
				// ever emitting a value the schema would refuse for the wrong reason.
				if (raw.trim() === '') return onChange('')
				const n = Number(raw)
				onChange(Number.isNaN(n) ? '' : n)
			}}
			className={EDITOR_CLASS}
		/>
	)
}

/**
 * The state a new-row form carries, and the two things a caller does to it.
 *
 * A hook rather than a self-contained component because the editors have to be
 * distributed across the cells of a `<tr>` the list owns, and the Add button
 * lives in a different cell again. The caller places the parts; this owns the
 * draft, the "is there anything to submit?" question and the reset.
 */
export function useNewRow(columns: readonly IntrospectedColumn[]) {
	const [draft, setDraft] = useState<NewRowDraft>({})
	const [busy, setBusy] = useState(false)
	const [failed, setFailed] = useState(false)
	const names = useMemo(() => columns.map((c) => c.name), [columns])

	/** Anything typed at all. The server decides whether it is *enough* — an
	 * emptiness check here would be a second, weaker copy of the create schema. */
	const filled = names.some((n) => {
		const v = draft[n]
		return v !== undefined && v !== null && v !== ''
	})

	return {
		draft,
		busy,
		/** The last submission was refused. Reset by the next one. */
		failed,
		filled,
		set: (name: string, value: unknown) =>
			setDraft((prev) => ({ ...prev, [name]: value })),
		/**
		 * Hand the draft over and clear it — but only once the caller's promise
		 * settles, and only on success.
		 *
		 * Clearing optimistically would erase what somebody typed the moment a 422
		 * came back, which is the version of this feature that costs the user their
		 * work. A refusal leaves the row exactly as it was so it can be corrected
		 * and resubmitted.
		 *
		 * A rejection is caught rather than re-thrown, and that is not swallowing
		 * it: nothing was written, the draft is intact, and {@link failed} says so
		 * on screen. Re-throwing would land in a click handler with nowhere to go —
		 * an unhandled rejection, and a row that sits there looking like the button
		 * missed. (In the generated app the fetcher does not reject at all; the
		 * refusal arrives as data and `<WriteRefusal>` prints the server's reason.
		 * This is the floor under callers that have no such channel.)
		 */
		submit: async (onCreate: (draft: NewRowDraft) => void | Promise<void>) => {
			if (!filled || busy) return
			setBusy(true)
			setFailed(false)
			try {
				await onCreate(draft)
				setDraft({})
			} catch {
				setFailed(true)
			} finally {
				setBusy(false)
			}
		},
		reset: () => setDraft({}),
	}
}

/**
 * The new row itself, as `<td>`s to be dropped into a `<tr>` the list owns.
 *
 * Rendered for every visible column — an editor where the column is collectable
 * and an empty cell where it is not — so the boxes line up under their headers
 * rather than under whichever column happens to come first.
 */
export function NewRowCells({
	columns,
	collectable,
	row,
	className,
}: {
	columns: readonly IntrospectedColumn[]
	collectable: ReadonlySet<string>
	row: ReturnType<typeof useNewRow>
	className?: string
}) {
	return (
		<>
			{columns.map((column) => (
				<td key={column.name} className={cn('px-3 py-2 text-sm', className)}>
					{collectable.has(column.name) ? (
						<NewRowEditor
							column={column}
							value={row.draft[column.name]}
							onChange={(v) => row.set(column.name, v)}
							disabled={row.busy}
						/>
					) : null}
				</td>
			))}
		</>
	)
}
