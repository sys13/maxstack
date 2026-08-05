/**
 * Editing one cell of a list, in place.
 *
 * The third sibling of `reschedule.ts` and `board-move.ts`, and for the same
 * reason: this module answers one question — *what does a record look like after
 * one of its cells is typed into?* — and answers it as **plain values**, not as
 * a write. The values it returns are submitted to the record's ordinary edit
 * route, the same route, action and content type `<DynamicForm>` posts to, so an
 * inline edit goes through the identical server-side validation, permission
 * check, value-limit enforcement and audit trail as editing that field in the
 * form. It lands in the op log and the review queue as a form edit does.
 *
 * That is the security property the issue gates on, and it is structural rather
 * than promised: **there is no inline-edit endpoint.** If everything in this file
 * were wrong, the update would 422 exactly as a garbage form submission does,
 * and an unauthorized viewer would be refused exactly as they are refused on the
 * form — the permission check lives in `opUpdate`, not on a route.
 *
 * ## Two gates, and why both
 *
 * A field is editable here only if the *spec block* names it **and** the
 * *column's own declaration* can be edited by a cell. The first is the
 * reviewable line — "this list can be written from, in these fields". The second
 * is derivation from the field spec, and it is not redundant: a spec op
 * validated `status` as an editable enum months ago, and the field has since
 * become a reference, a file, or read-only. The declaration is stale; the column
 * is the current fact. The stricter of the two wins, always, which means the
 * only direction drift can take is *fewer* editable cells.
 */

import type { SproutColumn } from '@maxstack/core'

/** A record as the runtime hands it around — the same shape the list renders. */
type Row = Record<string, unknown>

/**
 * Whether one column's value can be edited from a list cell, derived from the
 * column's own metadata.
 *
 * The runtime half of `inlineEditRefusal` in `@maxstack/spec` — it reads the
 * introspected column rather than the field spec, because by the time a page
 * renders, the column is what exists and the declaration is what someone once
 * wrote. The two rules agree by construction on everything the spec can express;
 * this one additionally catches what only the runtime knows (a primary key, a
 * hidden column, a rank key stamped by the bridge).
 */
export function isInlineEditableColumn(column: SproutColumn): boolean {
	if (column.isPrimaryKey) return false
	const meta = column.meta
	// `readOnly` covers the rank key, which the spec bridge marks explicitly, and
	// anything else a generator declares a person may not type into.
	if (meta.readOnly === true || meta.hidden === true || meta.rankKey === true)
		return false
	// A reference holds a foreign key; a cell editor for it would be a raw-id text
	// box. The form offers a name picker, and that is where an FK is edited.
	if (meta.reference || meta.arrayReference) return false
	if (meta.isFile === true) return false
	// `uuid` and `json` have no single-line editor a person can use correctly.
	return column.type !== 'json' && column.type !== 'uuid'
}

/**
 * The columns a list may edit in place: the block's declared names, narrowed to
 * the ones that still exist and can still be edited.
 *
 * Returned as a name array because that is what `<ResourceList editable>` takes.
 * A declared name that no longer resolves is dropped rather than fatal — the
 * same rule `tableColumns` follows for a spec/DB skew, and the safe direction:
 * the cell renders read-only instead of the page 500ing.
 */
export function inlineEditableFields(
	columns: readonly SproutColumn[],
	declared: readonly string[],
): string[] {
	return declared.filter((name) => {
		const column = columns.find((c) => c.name === name)
		return column !== undefined && isInlineEditableColumn(column)
	})
}

/**
 * The field values that write `value` into `row`'s `name` cell, or `null` when
 * the edit is not allowed or not meaningful.
 *
 * `null` — rather than an empty object — for every refusal, so a caller cannot
 * accidentally submit a no-op update that still writes an audit entry:
 *
 *  - the block did not declare this field editable;
 *  - the column does not exist, or cannot be edited by a cell;
 *  - the value is what was already there.
 *
 * Exactly one field is ever returned, and only ever one the block declared. A
 * cell edit cannot name a field, which is why it can never become a way to write
 * one the list does not offer — and in particular it can never write a column
 * the viewer's own form would not have let them write.
 *
 * ## `null` is a value here, not an absence
 *
 * Clearing a nullable cell submits `{ [name]: null }`, and that has to survive
 * the whole way down. It is the one shape a JSON body can carry that a form body
 * cannot express, so it is the one that goes untested by every form test in the
 * repo: update-mode validation dropping `.nullable()` was a real defect, and its
 * signature is an API that *emits* `null` and then refuses it on the way back
 * in. Hence the explicit `undefined` check below rather than a truthiness test —
 * a `null`, a `0`, a `false` and an empty string are all values a cell may
 * legitimately save, and only `undefined` means "nothing to write".
 */
export function inlineEditValues(
	columns: readonly SproutColumn[],
	declared: readonly string[],
	row: Row,
	name: string,
	value: unknown,
): Record<string, unknown> | null {
	if (value === undefined) return null
	if (!inlineEditableFields(columns, declared).includes(name)) return null
	// A save of the value already on screen is an audit entry recording that
	// nothing happened. `Object.is` so `NaN` from a mistyped number box, which the
	// cell editor already refuses to emit, cannot slip through as "changed".
	if (Object.is(row[name], value)) return null
	return { [name]: value }
}
