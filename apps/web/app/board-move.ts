/**
 * Moving a card on a board.
 *
 * The sibling of `reschedule.ts`, and for the same reason: this module answers
 * one question — *what does a record look like after its card is dropped in a
 * different column?* — and answers it as **plain values**, not as a write. The
 * values it returns are submitted to the record's ordinary edit route, the same
 * route, action and content type `<DynamicForm>` posts to, so a drag goes
 * through the identical server-side validation, permission check, WIP-limit
 * enforcement and audit trail as editing that field in the form.
 *
 * That is the security property the issue gates on, and it is structural rather
 * than promised: there is no board endpoint. The WIP limit in particular is
 * enforced in `opUpdate` — which means it holds for a REST client that has never
 * seen this page, and it would hold even if everything in this file were wrong.
 *
 * ## The rank key
 *
 * A move writes at most two fields: the group column, and the rank key that
 * places the card among its new neighbours. The key is computed with
 * `rankForDrop`, so a reorder is *one row's write* — never a renumbering pass
 * over the column, which is the thing two people dragging at once would tear.
 * Concurrency, in full: two drops into the same gap produce the same key and the
 * tie is broken by primary key. Nothing is lost, nothing is corrupted, and no
 * migration is needed to repair it. See `packages/ui/src/resource/rank.ts`.
 */

import { type BoardDrop, compareRanked, rankForDrop } from '@maxstack/ui'
import type { PageBoardView } from './project-routes'

/** A record as the runtime hands it around — the same shape the board renders. */
type Row = Record<string, unknown>

/**
 * The field values that move `row` to `drop`'s column and position, or `null`
 * when the move is not allowed or not meaningful.
 *
 * `null` — rather than an empty object — for every refusal, so a caller cannot
 * accidentally submit a no-op update that still writes an audit entry:
 *
 *  - the board did not declare `move`;
 *  - the destination is not one of the group column's declared values;
 *  - the card is already exactly where it was dropped.
 *
 * Only the board's own declared columns are ever returned. A drag cannot name a
 * field, which is why it can never become a way to write one the board does not
 * arrange by — and in particular it can never write a column the viewer's form
 * would not have let them write.
 */
export function boardMoveValues(
	view: PageBoardView,
	row: Row,
	drop: BoardDrop,
	/** Every row the board is showing, the moved one included. */
	rows: readonly Row[],
	primaryKey: string,
): Record<string, string> | null {
	if (!view.move) return null
	// The destination has to be a value the *spec* declares. Without this a
	// crafted payload could write any string into the grouping column through a
	// path whose UI only ever offers three.
	const values = view.options.map((o) => o.value)
	if (!values.includes(drop.value)) return null

	const id = String(row[primaryKey])
	const from = String(row[view.groupField] ?? '')
	const result: Record<string, string> = {}
	if (from !== drop.value) result[view.groupField] = drop.value

	const rankField = view.rankField
	if (rankField) {
		const ranked = (r: Row) => ({
			rank: typeof r[rankField] === 'string' ? (r[rankField] as string) : null,
			id: String(r[primaryKey]),
		})
		const siblings = rows
			.filter(
				(r) =>
					String(r[primaryKey]) !== id &&
					String(r[view.groupField] ?? '') === drop.value,
			)
			.map(ranked)
			.sort(compareRanked)
		// A drop that lands the card exactly where it already sits writes nothing.
		// `rankForDrop` would happily mint a *different* key for the *same*
		// position, and every such write is an audit entry recording that nothing
		// happened.
		const here = siblings.filter(
			(s) => compareRanked(s, ranked(row)) < 0,
		).length
		if (from !== drop.value || here !== drop.index)
			result[rankField] = rankForDrop(siblings, drop.index)
	}

	return Object.keys(result).length > 0 ? result : null
}
