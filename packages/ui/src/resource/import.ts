/**
 * CSV import over the introspected schema (Plan v5 task 49) — the write-side
 * dual of `csv.ts`'s export. The flow is upload → map columns → validate →
 * bulk-create with a per-row report, and every step here is pure so it tests
 * without a DOM or a backend: `suggestColumnMapping` auto-matches CSV headers to
 * columns by name/label, `coerceValue` turns a string cell into the column's
 * type, and `validateImportRows` produces `create`-ready records plus a report
 * naming every rejected row and why. The React import wizard and the actual
 * `useCreate` calls sit on top; this module is the engine.
 */

import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import { detectFieldKind } from '../fields/field-semantics.ts'
import type { IntrospectedResource, Row } from './resource-types.ts'

/** A header→column mapping: each CSV header maps to a resource column name, or
 * `null` to ignore that column on import. */
export type ColumnMapping = Record<string, string | null>

/** The columns a row can be imported into — writable, non-PK, non-hidden. */
export function importableColumns(
	resource: IntrospectedResource,
): IntrospectedColumn[] {
	return resource.columns.filter((c) => {
		if (c.name === resource.primaryKey) return false
		if (c.meta?.hidden === true) return false
		if (c.meta?.readOnly === true) return false
		return true
	})
}

function norm(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Auto-suggest a mapping from CSV headers to columns: exact (normalized) match on
 * column name first, then on the column's display label. Unmatched headers map to
 * `null` (ignored) so the user only has to fix the ambiguous ones.
 */
export function suggestColumnMapping(
	resource: IntrospectedResource,
	headers: string[],
): ColumnMapping {
	const cols = importableColumns(resource)
	const byName = new Map(cols.map((c) => [norm(c.name), c.name]))
	const byLabel = new Map(
		cols
			.filter((c) => c.meta?.label)
			.map((c) => [norm(c.meta?.label ?? ''), c.name]),
	)
	const mapping: ColumnMapping = {}
	for (const header of headers) {
		const key = norm(header)
		mapping[header] = byName.get(key) ?? byLabel.get(key) ?? null
	}
	return mapping
}

/** One thing wrong with a value in a row. */
export interface ImportFieldError {
	field: string
	message: string
}

/** Coerce a raw string cell into the value a column expects. Returns the typed
 * value, or an `ImportFieldError` when the cell can't satisfy the column. An
 * empty cell is `null` (rejected later only if the column is non-nullable). */
export function coerceValue(
	raw: string,
	column: IntrospectedColumn,
): { value: unknown } | { error: string } {
	const trimmed = raw.trim()
	if (trimmed === '') return { value: null }
	const kind = detectFieldKind(column)

	switch (kind) {
		case 'number':
		case 'rating':
		case 'duration': {
			const n = Number(trimmed)
			if (!Number.isFinite(n)) return { error: `"${raw}" is not a number` }
			return { value: n }
		}
		case 'boolean': {
			const t = trimmed.toLowerCase()
			if (['true', '1', 'yes', 'y'].includes(t)) return { value: true }
			if (['false', '0', 'no', 'n'].includes(t)) return { value: false }
			return { error: `"${raw}" is not a boolean` }
		}
		case 'enum': {
			const options =
				column.meta?.options?.map((o) => o.value) ?? column.enumValues ?? []
			if (options.length > 0 && !options.includes(trimmed))
				return { error: `"${raw}" is not one of: ${options.join(', ')}` }
			return { value: trimmed }
		}
		case 'date': {
			const d = new Date(trimmed)
			if (Number.isNaN(d.getTime())) return { error: `"${raw}" is not a date` }
			return { value: d.toISOString() }
		}
		case 'json': {
			try {
				return { value: JSON.parse(trimmed) }
			} catch {
				return { error: `"${raw}" is not valid JSON` }
			}
		}
		default:
			return { value: trimmed }
	}
}

/** The outcome of validating one CSV row. */
export interface ImportRowReport {
	/** 0-based index into the parsed records (i.e. data rows, header excluded). */
	index: number
	ok: boolean
	/** The coerced, create-ready record (present whether or not `ok`). */
	values: Row
	errors: ImportFieldError[]
}

export interface ImportResult {
	/** Only the rows that passed — ready to hand to `useCreate` in a loop/batch. */
	valid: Row[]
	/** Every row's outcome, in input order (for the per-row report UI). */
	report: ImportRowReport[]
	validCount: number
	errorCount: number
}

/**
 * Validate parsed CSV records against the resource schema under a mapping. For
 * each record: map headers to columns, coerce each cell, and check non-nullable
 * columns are present. Produces create-ready records + a full report — the
 * task-49 exit ("importing a CSV creates records with a validation report").
 */
export function validateImportRows(
	resource: IntrospectedResource,
	records: Record<string, string>[],
	mapping: ColumnMapping,
): ImportResult {
	const cols = new Map(importableColumns(resource).map((c) => [c.name, c]))
	// Which columns are actually targeted (so we can check required ones).
	const mapped = new Set(
		Object.values(mapping).filter((v): v is string => v != null),
	)

	const report: ImportRowReport[] = records.map((record, index) => {
		const values: Row = {}
		const errors: ImportFieldError[] = []

		for (const [header, colName] of Object.entries(mapping)) {
			if (colName == null) continue
			const column = cols.get(colName)
			if (!column) continue
			const raw = record[header] ?? ''
			const result = coerceValue(raw, column)
			if ('error' in result) {
				errors.push({ field: colName, message: result.error })
			} else if (result.value !== null) {
				values[colName] = result.value
			}
		}

		// Required (non-nullable) targeted columns must end up present.
		for (const colName of mapped) {
			const column = cols.get(colName)
			if (!column) continue
			const required = column.nullable === false
			if (required && values[colName] === undefined) {
				errors.push({ field: colName, message: `${colName} is required` })
			}
		}

		return { index, ok: errors.length === 0, values, errors }
	})

	const valid = report.filter((r) => r.ok).map((r) => r.values)
	return {
		valid,
		report,
		validCount: valid.length,
		errorCount: report.length - valid.length,
	}
}
