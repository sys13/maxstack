/**
 * A cell's past values, newest first (#307) — what the record view shows under
 * a field that declares a history.
 *
 * Structural, like `cell-writer.ts`: the history arrives in the row under the
 * column whose meta says `cellHistory`, shaped as core's `CellHistoryEntry` (a
 * writer stamp plus the value), and nothing here imports core to know that.
 */

import type { CellWriterStamp } from './cell-writer.ts'
import type { IntrospectedColumn } from './field-semantics.ts'

/** Structurally core's `CellHistoryEntry`. */
export interface CellHistoryEntry extends CellWriterStamp {
	value: unknown
}

/**
 * The values one column's cell has held, newest first — the order a person
 * reads a history in. Malformed entries are skipped rather than failing the
 * view; a row with no history column, or none for this cell, gives `[]`.
 */
export function cellHistoryOf(
	columns: readonly IntrospectedColumn[],
	row: Record<string, unknown>,
	column: string,
): CellHistoryEntry[] {
	const historyColumn = columns.find((c) => c.meta?.cellHistory === true)
	if (!historyColumn) return []
	let raw = row[historyColumn.name]
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			return []
		}
	}
	if (!raw || typeof raw !== 'object') return []
	const entries = (raw as Record<string, unknown>)[column]
	if (!Array.isArray(entries)) return []
	return entries
		.filter(
			(e): e is CellHistoryEntry =>
				!!e &&
				typeof e === 'object' &&
				'value' in e &&
				typeof e.by === 'string' &&
				typeof e.origin === 'string' &&
				typeof e.at === 'string',
		)
		.reverse()
}
