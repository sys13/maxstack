/**
 * Who last wrote a cell, in words (#460) — the visible half of per-cell
 * provenance: a maintainer looking at a record should be able to see *why* a
 * field holds what it holds, and in particular that a sync is leaving it alone
 * because a person corrected it.
 *
 * Structural, like everything in this package: the stamps arrive in the row
 * under the column whose meta says `cellProvenance`, shaped as core's
 * `CellStamp`, and nothing here imports core to know that.
 */

import type { IntrospectedColumn } from './field-semantics.ts'

/** Structurally core's `CellStamp`. */
export interface CellWriterStamp {
	by: string
	origin: string
	source?: string
	importer?: string
	at: string
}

/** The stamp one column's cell carries in this row, when it carries one. */
export function cellStampOf(
	columns: readonly IntrospectedColumn[],
	row: Record<string, unknown>,
	column: string,
): CellWriterStamp | null {
	const stampsColumn = columns.find((c) => c.meta?.cellProvenance === true)
	if (!stampsColumn) return null
	let raw = row[stampsColumn.name]
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			return null
		}
	}
	if (!raw || typeof raw !== 'object') return null
	const stamp = (raw as Record<string, unknown>)[column]
	if (!stamp || typeof stamp !== 'object') return null
	const { by, origin, at } = stamp as Record<string, unknown>
	if (
		typeof by !== 'string' ||
		typeof origin !== 'string' ||
		typeof at !== 'string'
	)
		return null
	return stamp as CellWriterStamp
}

/**
 * The writer, in a phrase — and whether it is a person, which is what decides
 * whether `humanEditWins` holds the cell. Kept in step with core's
 * `isHumanStamp`: a session or a portal is a person, any source or importer key
 * makes it a machine whatever the origin.
 */
export function describeCellWriter(stamp: CellWriterStamp): {
	text: string
	human: boolean
} {
	if (stamp.source) return { text: `synced from ${stamp.source}`, human: false }
	if (stamp.importer)
		return { text: `imported by ${stamp.importer}`, human: false }
	switch (stamp.origin) {
		case 'session':
			return { text: 'edited by hand', human: true }
		case 'portal':
			return { text: 'entered on a portal', human: true }
		case 'mcp':
			return { text: 'written by an agent', human: false }
		case 'api-key':
			return { text: 'written with an api key', human: false }
		default:
			return { text: 'written by the system', human: false }
	}
}
