/**
 * Per-cell history — the past values of a field that declares one, each with
 * who wrote it and when (#307).
 *
 * The audit log records *which* fields an update touched, never what they held,
 * so "what was this deal's stage on the 1st" had no answer short of an app
 * author building a history table, the hook that fills it and the query that
 * reads it, per entity. This module is the pure half: what an entry is, how one
 * write extends a row's history, and how a stored history is read back.
 * `opCreate`/`opUpdate` are the only writers, so REST, MCP, the page actions, a
 * source run and an import all leave the same record.
 *
 * ## Where the history lives, and why there
 *
 * In one `jsonb` column on the entity's own table, {@link CELL_HISTORY_COLUMN},
 * keyed by column name — for {@link CELL_PROVENANCE_COLUMN}'s reasons, which
 * apply here with the same force:
 *
 *  - **Atomic with the value.** `SproutStore` has no transaction. A shadow table
 *    is a second write after `store.update`, and a value that lands without its
 *    entry is a history that silently skips a step — the one thing a history
 *    must not do. In the row, the value and its entry are one `UPDATE`.
 *  - **Bounded by declaration.** Each field names how many values it keeps and
 *    the write that pushes one past that drops the oldest, so the column's size
 *    is fixed by the spec rather than by how busy the row has been.
 *  - **It dies with the row.** No orphaned history for a deleted record.
 *
 * The column is added by `from-spec.ts` only to an entity with at least one
 * declared history. It is `hidden` + `readOnly`, left out of every input
 * schema, and left out of list reads (a page of rows does not ship every row's
 * past); a record read carries it, which is what the record view renders.
 *
 * Each entry is the #460 writer stamp plus the value, so "who wrote it" means
 * exactly the same thing in the history as it does under the cell.
 */

import {
	CELL_PROVENANCE_COLUMN,
	type CellStamp,
	sameCellValue,
} from './cell-provenance.ts'
import type { Row } from './store.ts'
import type { SproutColumn } from './types.ts'

/**
 * The column a row's history lives in. Mirrors `CELL_HISTORY_COLUMN` in
 * `@maxstack/spec`, which reserves the name — core cannot import the spec, so
 * the literal is carried twice and `apps/web`'s grounding test pins them equal.
 */
export const CELL_HISTORY_COLUMN = '_maxstack_history'

/** One value a cell held: what it was, who wrote it, and when. */
export interface CellHistoryEntry extends CellStamp {
	value: unknown
}

/** A row's history, by column name, oldest entry first. */
export type CellHistory = Record<string, CellHistoryEntry[]>

const isEmpty = (value: unknown) =>
	value === null || value === undefined || value === ''

/**
 * JSON has no `Date`, and a `jsonb` value that is one would come back as the
 * string anyway — so it is stored as the string, and the entry reads back as
 * what was written.
 */
function storable(value: unknown): unknown {
	return value instanceof Date ? value.toISOString() : value
}

/**
 * The history a stored row carries, tolerating what a driver can hand back (an
 * object, or a string from anything that did not parse `jsonb`) and dropping
 * anything malformed entry by entry. Unreadable history reads as none rather
 * than failing the write that would extend it.
 */
export function readCellHistory(row: Row | null | undefined): CellHistory {
	let raw: unknown = row?.[CELL_HISTORY_COLUMN]
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			return {}
		}
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
	const out: CellHistory = {}
	for (const [column, entries] of Object.entries(raw)) {
		if (!Array.isArray(entries)) continue
		const kept = entries.filter(
			(e): e is CellHistoryEntry =>
				!!e &&
				typeof e === 'object' &&
				'value' in e &&
				typeof e.by === 'string' &&
				typeof e.origin === 'string' &&
				typeof e.at === 'string',
		)
		if (kept.length > 0) out[column] = kept
	}
	return out
}

/**
 * Extend a row's history with one write.
 *
 * For every column the payload names that declares a history, whose value
 * actually changes (or, on a create, is non-empty), the new value is appended
 * with the write's stamp, and the oldest entries beyond the declared `keep` are
 * dropped. Everything else passes through untouched, so an entity that declares
 * no history gets back exactly the payload it sent.
 *
 * Called on the payload *after* `mergeCellWrite`, so a cell a person's edit
 * held against a sync gets no entry — the sync did not write it, and a history
 * that said it had would be the lie #460 exists to stop the row telling.
 */
export function appendCellHistory(args: {
	columns: readonly SproutColumn[]
	/** The row as stored, or `null` for a create. */
	existing: Row | null
	/** The payload about to be written. */
	data: Row
	stamp: CellStamp
}): Row {
	const { columns, existing, data, stamp } = args
	const kept = columns.filter((c) => c.meta.history)
	if (kept.length === 0) return data

	const prior = readCellHistory(existing)
	const next: CellHistory = { ...prior }
	let appended = false

	for (const column of kept) {
		const name = column.name
		const keep = column.meta.history?.keep ?? 0
		if (!(name in data) || keep < 1) continue
		const value = data[name]
		if (
			existing ? sameCellValue(column, value, existing[name]) : isEmpty(value)
		)
			continue
		next[name] = [
			...(prior[name] ?? []),
			{ ...stamp, value: storable(value) },
		].slice(-keep)
		appended = true
	}

	return appended ? { ...data, [CELL_HISTORY_COLUMN]: next } : data
}

/**
 * Whether a payload key is one the platform adds, rather than a field a caller
 * asked to write. A payload holding nothing else writes nothing.
 */
export function isPlatformCellColumn(key: string): boolean {
	return key === CELL_PROVENANCE_COLUMN || key === CELL_HISTORY_COLUMN
}
