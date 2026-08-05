/**
 * CSV export/import over the introspected schema (Plan v5 task 34). Export is
 * the read-side dual of the field library: each cell is rendered to *plain text*
 * the same way `<Field>` renders it to JSX — dates as ISO, enums as their
 * option label, references as the resolved display value — so a spreadsheet
 * shows what the table shows. Import is the inverse: a header row maps back to
 * column names, yielding `create`-ready records.
 *
 * Pure and dependency-free (the parser is a small RFC-4180 reader); the only
 * browser-coupled piece is `downloadCsv`, kept separate so the codec is testable
 * without a DOM.
 */

import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import { detectFieldKind, humanizeLabel } from '../fields/field-semantics.ts'
import type { ReferenceResolution } from '../fields/reference-context.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'

export interface CsvColumn {
	name: string
	label?: string
	column?: IntrospectedColumn
}

export interface CsvExportOptions {
	/** Resolved FK display values, so a reference column exports its title, not
	 * its raw id (the same map `<ResourceList>` takes). */
	references?: ReferenceResolution
}

/** The columns to export for a resource — the visible set, mirroring
 * `<ResourceList>`'s rule (skip `hidden`; skip the PK unless asked). */
export function csvColumnsFor(
	resource: IntrospectedResource,
	options: { showPrimaryKey?: boolean } = {},
): CsvColumn[] {
	const out: CsvColumn[] = []
	for (const column of resource.columns) {
		const isPk = column.name === resource.primaryKey
		if (column.meta?.hidden === true) continue
		if (isPk && !options.showPrimaryKey) continue
		out.push({
			name: column.name,
			label: column.meta?.label ?? humanizeLabel(column.name),
			column,
		})
	}
	return out
}

/** Render one cell to plain text, matching `<Field>`'s presentation. */
export function cellToText(
	value: unknown,
	column: IntrospectedColumn | undefined,
	references?: ReferenceResolution,
): string {
	if (value === null || value === undefined) return ''
	if (!column) return String(value)
	const kind = detectFieldKind(column)
	switch (kind) {
		case 'reference': {
			const table = column.references?.table
			const id = String(value)
			return references?.[table ?? '']?.[id] ?? id
		}
		case 'enum': {
			const opt = column.meta?.options?.find((o) => o.value === String(value))
			return opt?.label ?? String(value)
		}
		case 'boolean':
			return value === true || value === 'true' ? 'true' : 'false'
		case 'date': {
			const d = value instanceof Date ? value : new Date(String(value))
			return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
		}
		default:
			return typeof value === 'object' ? JSON.stringify(value) : String(value)
	}
}

/** RFC-4180 field quoting: wrap in quotes and double any internal quote when the
 * value contains a comma, quote, or newline. */
function escapeField(text: string): string {
	if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
	return text
}

/** Serialize rows to a CSV string (header row = column labels). */
export function rowsToCsv(
	rows: Row[],
	columns: CsvColumn[],
	options: CsvExportOptions = {},
): string {
	const header = columns.map((c) => escapeField(c.label ?? c.name)).join(',')
	const lines = rows.map((row) =>
		columns
			.map((c) =>
				escapeField(cellToText(row[c.name], c.column, options.references)),
			)
			.join(','),
	)
	return [header, ...lines].join('\r\n')
}

/** Serialize a resource's visible columns straight from introspection. */
export function resourceToCsv(
	resource: IntrospectedResource,
	rows: Row[],
	options: CsvExportOptions & { showPrimaryKey?: boolean } = {},
): string {
	return rowsToCsv(rows, csvColumnsFor(resource, options), options)
}

/**
 * Parse CSV text into records keyed by the header row. A small RFC-4180 reader:
 * handles quoted fields, escaped quotes (`""`), and embedded commas/newlines.
 * Returns `[]` for empty input. Values stay strings — the caller coerces per the
 * target schema.
 */
export function parseCsv(text: string): Record<string, string>[] {
	const table = parseCsvGrid(text)
	if (table.length === 0) return []
	const [header, ...body] = table
	const keys = header as string[]
	return body
		.filter((cells) => cells.some((c) => c !== ''))
		.map((cells) => {
			const record: Record<string, string> = {}
			keys.forEach((key, i) => {
				record[key] = cells[i] ?? ''
			})
			return record
		})
}

/** Tokenize CSV text into a grid of cells (rows × fields). */
function parseCsvGrid(text: string): string[][] {
	const rows: string[][] = []
	let field = ''
	let row: string[] = []
	let inQuotes = false
	let i = 0
	const push = () => {
		row.push(field)
		field = ''
	}
	const endRow = () => {
		push()
		rows.push(row)
		row = []
	}
	while (i < text.length) {
		const ch = text[i]
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"'
					i += 2
					continue
				}
				inQuotes = false
				i++
				continue
			}
			field += ch
			i++
			continue
		}
		if (ch === '"') {
			inQuotes = true
			i++
		} else if (ch === ',') {
			push()
			i++
		} else if (ch === '\n') {
			endRow()
			i++
		} else if (ch === '\r') {
			// Swallow CRLF as one line break; a lone CR also ends the row.
			if (text[i + 1] === '\n') i++
			endRow()
			i++
		} else {
			field += ch
			i++
		}
	}
	// Flush the trailing field/row unless the text ended exactly on a newline.
	if (field !== '' || row.length > 0) endRow()
	return rows
}

/** Trigger a browser download of `csv` as `filename`. No-op outside a DOM. */
export function downloadCsv(filename: string, csv: string): void {
	if (
		typeof document === 'undefined' ||
		typeof URL.createObjectURL !== 'function'
	)
		return
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = filename
	a.style.display = 'none'
	document.body.appendChild(a)
	a.click()
	document.body.removeChild(a)
	URL.revokeObjectURL(url)
}
