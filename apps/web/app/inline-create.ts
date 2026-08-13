/**
 * Adding a row to a list, without leaving it.
 *
 * The fourth sibling of `reschedule.ts`, `board-move.ts` and `inline-edit.ts`,
 * and the closest relative of the last. It answers one question — *what record
 * is the person at the bottom of this table describing?* — and answers it as
 * **plain values**, never as a write. The values it returns are submitted to the
 * resource's ordinary create route, the same route, action and content type the
 * New form posts to, so an inline create runs the identical server-side
 * validation, permission check, value-limit enforcement and audit entry as
 * filling in that form. It lands in the op log and the review queue the same way.
 *
 * That is the security property #444 gates on, and — as with inline edit — it is
 * structural rather than promised: **there is no inline-create endpoint.** If
 * everything in this file were wrong, the create would 422 exactly as a garbage
 * form submission does, and an unauthorized viewer would be refused exactly as
 * they are refused on the form, because the permission check lives in `opCreate`
 * and not on a route.
 *
 * ## Why this is not `inline-edit.ts` with a different verb
 *
 * The *field* rule is genuinely the same, and is shared rather than restated:
 * whatever a cell can edit is whatever a new-row cell can collect, so
 * {@link isInlineEditableColumn} is the single answer to both and there is no
 * second rule to drift. What differs is completeness.
 *
 * An inline edit writes one field of a row that already satisfies its
 * constraints. A new row has to satisfy all of them at once — which means a
 * `creatable` that omits a required field describes an affordance whose *every*
 * use is a 422, with no input that makes it work. That is refused in the spec
 * layer, at the op, by the name of the missing field (`inlineCreateErrors`),
 * because it is a property of the declaration and not of any particular click.
 * Nothing here re-checks it: by the time a page renders, the declaration was
 * validated, and the server is the wall regardless.
 *
 * ## An empty box is not a value
 *
 * The one asymmetry with a cell editor, and the reason {@link inlineCreateValues}
 * omits keys rather than sending `null` for them. Clearing an existing cell means
 * "make this empty", so `null` is the value and has to survive the wire. Leaving
 * a *new* row's box untouched means "I did not say", and the two are different
 * instructions: `null` overrides a column default, absence lets it apply. Sending
 * `null` for every blank would quietly defeat every `hasDefault` column in the
 * schema — a row created from the list would differ from the same row created
 * from the form, in fields nobody typed into.
 */

import type { SproutColumn } from '@maxstack/core'
import { inlineEditableFields, isInlineEditableColumn } from './inline-edit'

/** The draft a new-row form holds: a value per box the person has filled. */
type Draft = Record<string, unknown>

/**
 * The columns a list may collect a new row's values in: the block's declared
 * names, narrowed to the ones that still exist and can still be typed into.
 *
 * The same stricter-of-two rule the editable cells follow, and it is the same
 * function doing the narrowing — the spec block is the reviewable line, the
 * column is the current fact, and drift can only ever take the safe direction of
 * *fewer* boxes.
 *
 * That direction is safe for editing and worth a sentence here, because for
 * creating it is only safe *because the server is the wall*. A required field
 * whose column has since become a reference drops out of this list, the row form
 * no longer collects it, and the create is refused — which is the correct
 * outcome (the declaration is now unsatisfiable) arriving by the correct route (a
 * refusal, not a half-record). Re-deriving "is this still complete?" here would
 * turn a stale spec into a silently vanishing button instead.
 */
export function inlineCreatableFields(
	columns: readonly SproutColumn[],
	declared: readonly string[],
): string[] {
	return inlineEditableFields(columns, declared)
}

/**
 * The field values that create a row from `draft`, or `null` when there is
 * nothing to create.
 *
 * `null` — rather than an empty object — for every refusal, so a caller cannot
 * submit a create that writes an empty record and an audit entry to go with it:
 *
 *  - the block declared no creatable field, or none survives the narrowing;
 *  - every box the person could fill is still empty.
 *
 * Only declared, still-collectable fields are ever returned, and a draft key
 * naming anything else is dropped. A new-row form cannot name a field, which is
 * why it can never become a way to write one the list does not offer — in
 * particular it can never write a column the viewer's own form would not have let
 * them write.
 *
 * An empty string is an absence, not a value: it is what an untouched text box
 * holds and what a box the person typed into and then cleared holds, and those
 * are the same statement about a row that does not exist yet. Every other
 * value — `0`, `false`, a date — is kept, which is why the test is explicit
 * rather than a truthiness check.
 */
export function inlineCreateValues(
	columns: readonly SproutColumn[],
	declared: readonly string[],
	draft: Draft,
): Record<string, unknown> | null {
	const fields = inlineCreatableFields(columns, declared)
	const values: Record<string, unknown> = {}
	for (const name of fields) {
		const value = draft[name]
		if (value === undefined || value === null || value === '') continue
		values[name] = value
	}
	return Object.keys(values).length === 0 ? null : values
}

export { isInlineEditableColumn as isInlineCreatableColumn }
