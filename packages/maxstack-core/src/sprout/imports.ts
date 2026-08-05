/**
 * The plan behind a declared importer.
 *
 * This module holds the grounded shape, the plan a dry-run produces, and the
 * failure report. The two functions that actually touch data —
 * `planImport` and `opApplyImport` — live in `operations.ts`, beside
 * `opCreate`/`opUpdate`, because that is the layer `authorize()` guards and an
 * import is a write.
 *
 * ## Why the dry-run is structural rather than a rule
 *
 * `opApplyImport` takes an {@link ImportPlan} and **nothing else**. There is no
 * overload that takes bytes, no `{ dryRun: false }` flag, and no way to
 * construct a plan except by calling `planImport` — which reads the file,
 * validates every row, and resolves every upsert match. So "you must dry-run
 * first" is not a policy anybody has to remember or a check anybody can skip
 * under deadline; it is the only shape the call can have. This is the same trick
 * `opRenderDocument` uses to make "a document is a read of the row" structural
 *, applied to the most destructive surface in the vocabulary
 * instead of the most visible one.
 *
 * A rule would have been cheaper and would have held for about two quarters. The
 * first "we already validated this upstream, let us skip the plan" is always
 * reasonable, and it is always the one that runs against production.
 *
 * ## Why there is no delete path
 *
 * Deliberate, and recorded here so it stays deliberate. There is no
 * `deleteMissing`, no "replace the table", no truncate — not because it is hard,
 * but because the feature is always the same shape when it exists: a checkbox
 * that reads as tidy-up and means *delete every row this file does not mention*,
 * ticked by somebody who exported a filtered view. A destructive import behind a
 * friendly wizard is worse than no importer.
 *
 * Reconciling a local table against a remote truth is a real capability and it
 * has a different shape: a stable remote id, a run history, and a schedule. That
 * is `sources`, which already exists.
 *
 * ## Why the plan carries no ids
 *
 * The same layering `SearchIndexPlan` and `DocumentPlan` live under:
 * `@maxstack/core` does not depend on `@maxstack/spec`, so field *ids* are
 * resolved to column *names* before they arrive. Grounding is also where a
 * partially-rejected spec is caught — an importer whose mapping names a field
 * that is no longer accepted does not ground at all, so it cannot reach here and
 * write half a row.
 */

import type { Row } from './store.ts'

// ===========================================================================
// The grounded declaration
// ===========================================================================

/** The importable column types, mirroring the spec's `importableFieldTypes`. */
export type ImportValueType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'date'
	| 'enum'
	| 'json'

/** One file column landing on one grounded column. */
export interface ImportColumnPlan {
	/** The header name / object key in the file. */
	column: string
	/** The grounded database column it writes. */
	field: string
	/** The declared type, which is how the cell is read. */
	type: ImportValueType
}

/** A declared importer, grounded to column names. */
export interface ImportPlanShape {
	key: string
	description: string
	/** `csv` | `ndjson` | `json` | `custom`. Mirrors the spec's `ImportFormat`. */
	format: string
	/** The resource rows land in. */
	resource: string
	/** Present iff `format === 'custom'` — the user-owned parser module's name. */
	parserSlot?: string
	columns: ImportColumnPlan[]
	/**
	 * The grounded column matching decides an existing row, or `null` for
	 * insert-only. The single fact that decides whether running this importer can
	 * overwrite data somebody already has.
	 */
	upsertColumn: string | null
	maxRows: number
	paused: boolean
}

// ===========================================================================
// The plan a dry-run produces
// ===========================================================================

/** What one input line would do. */
export interface ImportRowPlan {
	/**
	 * The 1-based position of this record in the file, counting data records only
	 * (a CSV's header is not line 1). It is the number the failure report carries
	 * and the number somebody scrolls to in their spreadsheet.
	 */
	line: number
	action: 'create' | 'update' | 'invalid'
	/** The validated values, absent for an `invalid` row. */
	data?: Row
	/** The row an `update` would write, resolved through a gated, tenant-scoped list. */
	matchedId?: string
	/** Field → messages, in the exact shape every write surface already renders. */
	errors?: Record<string, string[]>
	/** The raw cells, kept for the failure report so it can quote what was wrong. */
	raw?: Record<string, string>
}

export interface ImportPlan {
	importer: ImportPlanShape
	key: string
	resource: string
	/** Bounded by `importer.maxRows`; a file that exceeds it fails the whole run. */
	rows: ImportRowPlan[]
	counts: { create: number; update: number; invalid: number }
	/**
	 * Always `false`, and present precisely so that stays true and visible.
	 *
	 * Exceeding `maxRows` throws rather than truncating, because a truncated
	 * import is indistinguishable from a successful one at every surface that
	 * reports it — same green banner, same "imported N rows" — and the absent rows
	 * are found weeks later by somebody who assumes they were never in the file.
	 */
	truncated: false
}

/** What an apply actually did. Reconciles with the plan it was given. */
export interface ImportResult {
	created: number
	updated: number
	/** Rows the plan marked invalid. Never attempted; carried so the totals add up. */
	skipped: number
	/**
	 * Rows that were fine in the plan and failed at write time — a racing writer,
	 * a WIP limit that filled, a unique constraint. Reported per line rather than
	 * rolling the whole run back: the rows that landed are correct, and undoing
	 * them would be this module inventing the delete path it does not have.
	 */
	failed: { line: number; reason: string }[]
}

/** Every count in a result adds up to the plan it came from. Cheap, and load-bearing. */
export function reconciles(plan: ImportPlan, result: ImportResult): boolean {
	return (
		result.created + result.updated + result.skipped + result.failed.length ===
			plan.rows.length &&
		result.skipped === plan.counts.invalid &&
		result.created + result.updated + result.failed.length ===
			plan.counts.create + plan.counts.update
	)
}

// ===========================================================================
// Reading a cell
// ===========================================================================

/**
 * Turn one raw cell into the value the generated Zod schema will see.
 *
 * Only two types are converted here, and only because Zod cannot accept their
 * text form: `number` and `boolean`. `string`, `enum`, `date` and `json` pass
 * through as text, because `validateData` already knows how to read each —
 * which is the point. Every conversion this module performs is a place the
 * import path could disagree with the form path, so there are as few as possible.
 *
 * **A blank cell is an absent value, not an empty one.** It is omitted from the
 * row rather than written as `''` or `null`, which matters most on the upsert
 * path: an export that is missing a column, or a row where somebody cleared a
 * cell, must not blank out data that is already there. Clearing a value is an
 * edit somebody makes deliberately; it is not something a partial export should
 * do to a thousand rows at once. Same instinct as the absent delete path, at cell
 * granularity.
 */
export function readCell(
	raw: string,
	type: ImportValueType,
): { present: false } | { present: true; value: unknown } | { error: string } {
	const text = raw.trim()
	if (text === '') return { present: false }
	switch (type) {
		case 'number': {
			// `Number('')` is 0 and `Number('12abc')` is NaN; the blank case is
			// already gone above, and the second must not reach the column as NaN.
			const parsed = Number(text)
			if (!Number.isFinite(parsed)) return { error: `"${raw}" is not a number` }
			return { present: true, value: parsed }
		}
		case 'boolean': {
			const lower = text.toLowerCase()
			if (['true', 'yes', 'y', '1'].includes(lower))
				return { present: true, value: true }
			if (['false', 'no', 'n', '0'].includes(lower))
				return { present: true, value: false }
			return {
				error: `"${raw}" is not a yes/no value (accepted: true/false, yes/no, y/n, 1/0)`,
			}
		}
		default:
			// `date` reaches the same ISO schema a `<input type="date">` posts to, and
			// `json` reaches the same preprocess a JSON textarea does. Re-implementing
			// either here would be a second parser to keep in step with the forms'.
			return { present: true, value: text }
	}
}

// ===========================================================================
// The failure report
// ===========================================================================

/** RFC 4180: quote when the value contains a quote, a comma or a line break. */
function csvCell(value: string): string {
	return /["\n\r,]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/**
 * The rejected rows, as a downloadable CSV — the issue's "partial-failure
 * reporting: which rows failed and why, downloadable".
 *
 * **One row per failing input line**, so the file is the same length as the list
 * of problems and can be worked through top to bottom. A line with two bad cells
 * lists both fields, both offending values and both reasons in its own row rather
 * than becoming two rows, because the unit somebody fixes is a line in their
 * spreadsheet.
 *
 * Deterministic byte-for-byte: no clock, no locale, no `Intl` (whose output
 * depends on the ICU build — the rule issue #176 established for documents, and
 * it applies here for the same reason, since this file is evidence somebody
 * attaches to a ticket and compares against a later run).
 */
export function importFailureCsv(plan: ImportPlan): string {
	const lines = ['line,fields,values,reasons']
	for (const row of plan.rows) {
		if (row.action !== 'invalid') continue
		const entries = Object.entries(row.errors ?? {})
		const fields = entries.map(([field]) => field)
		const values = fields.map((field) => {
			// The column whose *cell* produced the error, looked up back through the
			// mapping — the report quotes what the person typed, not the column name
			// the platform renamed it to.
			const mapped = plan.importer.columns.find((c) => c.field === field)
			return mapped ? (row.raw?.[mapped.column] ?? '') : ''
		})
		const reasons = entries.map(([, messages]) => messages.join(' '))
		lines.push(
			[
				String(row.line),
				csvCell(fields.join('; ')),
				csvCell(values.join('; ')),
				csvCell(reasons.join('; ')),
			].join(','),
		)
	}
	// CRLF, because this file is opened in a spreadsheet more often than in a
	// terminal, and RFC 4180 says CRLF.
	return `${lines.join('\r\n')}\r\n`
}

/** One line of prose for a plan — the confirm button's caption. */
export function describeImportPlan(plan: ImportPlan): string {
	const { create, update, invalid } = plan.counts
	const parts = [`${create} new`, `${update} updated`]
	if (invalid > 0) parts.push(`${invalid} rejected`)
	return parts.join(', ')
}
