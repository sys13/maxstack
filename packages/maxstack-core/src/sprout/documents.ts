/**
 * The layout behind a declared document template.
 *
 * This module has one job and one property, and the property is the reason the
 * job is a module rather than two renderers.
 *
 * **Neither backend reads the template.** A grounded {@link DocumentPlan} plus
 * the rows a caller was allowed to read compile to a {@link DocumentLayout} — a
 * flat list of headings, paragraphs, labelled pairs, tables and rules — and the
 * HTML and PDF backends serialize *that*. They can therefore disagree about
 * pixels and never about content: there is exactly one place that decides what a
 * `number` field looks like printed, one place that resolves a `{placeholder}`,
 * and one place that decides a table was truncated. Two renderers reading the
 * template would be two implementations of every one of those, drifting quietly,
 * with the symptom being that the PDF a customer received says something the
 * HTML preview did not.
 *
 * ## Why the plan carries no ids
 *
 * Same layering `SearchIndexPlan` lives under: `@maxstack/core` does not depend
 * on `@maxstack/spec`, so the spec's field *ids* are resolved to column *names*
 * before they arrive. Grounding is also where a partially-rejected spec is
 * caught — a section naming a field that is no longer accepted does not ground,
 * so it cannot reach here and print a blank cell.
 *
 * ## Determinism
 *
 * Every formatter here is locale-free and clock-free, and that is a requirement
 * rather than a simplification. `Intl` output depends on the ICU build and the
 * process's locale, so an invoice rendered on a server in Frankfurt would differ
 * byte-for-byte from the same invoice rendered in Ohio — and "the copy we have
 * on file does not match the copy you received" is the one failure a document
 * feature cannot have. `Date.now()` never appears: there is no `{today}`, and an
 * issue date is a `date` field on the row, which is where it belongs anyway.
 *
 * Currency symbols and locale-aware number formatting are deliberately absent
 * for the same reason: they are a *declaration* somebody has to make, not
 * something to infer from the process the render happened to run in. See
 * `docs/documents.md`.
 */

// ===========================================================================
// The grounded plan
// ===========================================================================

/** The physical paper. Mirrors the spec's `DocumentPageSize`. */
export type DocumentPageSize = 'a4' | 'letter'

/** The render targets. Mirrors the spec's `DocumentFormat`. */
export type DocumentFormat = 'html' | 'pdf'

/**
 * The printable types, structurally duplicated from the spec's
 * `printableFieldTypes` for the layering reason above and pinned to it by
 * `documents.agreement.test.ts` in `@maxstack/features` — the lowest package
 * that may import both. A value in one list and not the other would either
 * refuse a valid template at boot or, in the dangerous direction, let a `json`
 * column print its punctuation onto something a customer receives.
 */
export type DocumentValueType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'date'
	| 'enum'

/** Runtime guard for {@link DocumentValueType}. */
export const DOCUMENT_VALUE_TYPES: readonly DocumentValueType[] = [
	'string',
	'number',
	'boolean',
	'date',
	'enum',
]

/** One printable value: where to read it, what to call it, how to format it. */
export interface DocumentFieldPlan {
	/** The row key — a grounded column name, or a derived value's accessor. */
	column: string
	/** The printed label. The field's own name, so renaming a field renames its label. */
	label: string
	type: DocumentValueType
	/** For `enum`: stored value → shown label. Absent values print as themselves. */
	options?: Record<string, string>
}

export type DocumentSectionPlan =
	| { kind: 'heading'; level: 1 | 2; text: string }
	| { kind: 'text'; text: string }
	| {
			kind: 'fields'
			columns: 1 | 2
			caption?: string
			fields: DocumentFieldPlan[]
	  }
	| {
			kind: 'table'
			caption?: string
			/** The resource name of the many side — fetched through its own read gate. */
			resource: string
			/** The foreign-key column on that resource pointing back at this row. */
			via: string
			orderBy?: string
			direction: 'asc' | 'desc'
			fields: DocumentFieldPlan[]
	  }
	| { kind: 'rule' }
	| { kind: 'slot'; name: string }

/**
 * The visual identity, resolved from the app's theme at grounding
 * time.
 *
 * A template declares none of this. That is the answer to the issue's gate about
 * not shipping a second UI system: "make the invoice match the product" is a
 * `theme.set` that already existed, and a document-specific palette would be a
 * second set of tokens to keep in step with the first.
 */
export interface DocumentStyle {
	/** Maps to a CSS stack in HTML and to a base-14 family in PDF. */
	font: 'sans' | 'serif' | 'mono'
	/** `#rrggbb`. The theme's accent, used for rules and the document title. */
	accent: string
	density: 'comfortable' | 'compact'
	typeScale: 'compact' | 'default' | 'relaxed'
}

export interface DocumentPlan {
	key: string
	description: string
	/** The resource whose row this template renders. */
	resource: string
	pageSize: DocumentPageSize
	style: DocumentStyle
	/**
	 * Whether `delivery.download` is on — may this template be served over HTTP
	 *.
	 *
	 * It did not reach the runtime before, and the omission was not cosmetic: the
	 * document route served **every** declared template, so turning `download`
	 * off retired a template from the exposure report and from nothing else. A
	 * template still delivered by email or written to storage kept a public URL
	 * that the declaration said it did not have.
	 *
	 * Carried on the plan rather than re-read from the spec at request time
	 * because the plan is what the runtime has: `registry.findDocument` answers
	 * from grounded config, and a second lookup into the spec would be a second
	 * copy of the answer that can disagree with the first.
	 */
	download: boolean
	sections: DocumentSectionPlan[]
	/**
	 * Every printable value on the template's own entity, keyed by name — what a
	 * `{placeholder}` resolves through.
	 *
	 * Keyed by *name* rather than id because that is what a person writing
	 * "Invoice {number}" types, and because the runtime's rows are keyed by name
	 * too: a grounded column and a derived value's accessor both land on the row
	 * under the field's name.
	 */
	values: Record<string, DocumentFieldPlan>
}

/** The most related rows one `table` section prints. Mirrors the spec's bound. */
export const MAX_DOCUMENT_TABLE_ROWS = 500

// ===========================================================================
// The layout — what both backends actually serialize
// ===========================================================================

export type DocumentBlock =
	| { kind: 'heading'; level: 1 | 2; text: string }
	| { kind: 'paragraph'; text: string }
	| {
			kind: 'pairs'
			columns: 1 | 2
			caption?: string
			pairs: { label: string; value: string }[]
	  }
	| {
			kind: 'table'
			caption?: string
			columns: { label: string; align: 'left' | 'right' }[]
			rows: string[][]
			/**
			 * A stated truncation, printed under the table.
			 *
			 * Never silent. A document that quietly omits billable lines is the worst
			 * bug this feature could ship, so the bound is enforced by saying so on
			 * the page the customer is holding.
			 */
			note?: string
	  }
	| { kind: 'rule' }

export interface DocumentLayout {
	/** The document's own title — the first level-1 heading, else the plan key. */
	title: string
	blocks: DocumentBlock[]
}

/** A row as the store returns it. */
export type DocumentRow = Record<string, unknown>

/**
 * Everything a render needs beyond the plan: the row, the related rows each
 * `table` section asked for, and any slot fills.
 *
 * The related rows are keyed by **section index** rather than by resource
 * because two sections may print two different slices of the same resource, and
 * because the fetch is the caller's job: `opRenderDocument` runs each one
 * through that resource's own read gate. Handing the renderer rows rather than
 * a store handle is what makes it impossible for this module to reach a row
 * nobody checked.
 */
export interface DocumentData {
	row: DocumentRow
	related: Record<number, DocumentRow[]>
	/** Slot name → the blocks an owned module returned. Absent = the slot renders nothing. */
	slots?: Record<string, DocumentBlock[]>
}

// ===========================================================================
// Formatting — one implementation, both backends
// ===========================================================================

/** What an absent value prints as. An em dash, so a blank line is visibly blank. */
export const DOCUMENT_EMPTY = '—'

/**
 * Group an integer's digits in threes with `,`.
 *
 * Hand-rolled rather than `toLocaleString` because the latter's output depends
 * on the ICU build and the process locale — see the module comment. The
 * separator is not configurable *yet*, and when it becomes configurable it will
 * be because somebody declared it, not because the server guessed.
 */
function groupDigits(digits: string): string {
	let out = ''
	for (let i = 0; i < digits.length; i++) {
		if (i > 0 && (digits.length - i) % 3 === 0) out += ','
		out += digits[i]
	}
	return out
}

/**
 * Print one value.
 *
 * The rules are short on purpose, and each one is a choice about being read on
 * paper rather than in a browser:
 *
 * - **numbers** keep the digits they have, grouped in threes. No forced two
 *   decimals, because this layer does not know that a column is money — that is
 *   a declaration nobody has made yet, and printing `Quantity: 3.00` to imply it
 *   would be worse than printing `3`.
 * - **dates** print as `YYYY-MM-DD`, which is unambiguous in every country a
 *   document might be read in. `03/04` is not.
 * - **booleans** print as `Yes`/`No` rather than `true`/`false`.
 * - **enums** print their declared label, falling back to the stored value, so a
 *   document never shows an option that was renamed in the UI but not here.
 */
export function formatDocumentValue(
	value: unknown,
	field: Pick<DocumentFieldPlan, 'type' | 'options'>,
): string {
	if (value === null || value === undefined || value === '')
		return DOCUMENT_EMPTY
	switch (field.type) {
		case 'number': {
			const n = typeof value === 'number' ? value : Number(value)
			if (!Number.isFinite(n)) return String(value)
			const negative = n < 0
			const [int = '0', frac] = Math.abs(n).toString().split('.')
			const body = frac ? `${groupDigits(int)}.${frac}` : groupDigits(int)
			return negative ? `-${body}` : body
		}
		case 'boolean':
			return value ? 'Yes' : 'No'
		case 'date': {
			// A spec `date` is a timestamp without a zone, so the date part is read
			// off the ISO string rather than through a `Date`, which would apply the
			// process's offset and could move an invoice a day either way.
			const text = value instanceof Date ? value.toISOString() : String(value)
			const match = /^(\d{4}-\d{2}-\d{2})/.exec(text)
			return match?.[1] ?? text
		}
		case 'enum': {
			const key = String(value)
			return field.options?.[key] ?? key
		}
		default:
			return String(value)
	}
}

/** Whether a column is printed right-aligned. Numbers, and only numbers. */
export function isNumericColumn(field: DocumentFieldPlan): boolean {
	return field.type === 'number'
}

/**
 * Resolve `{placeholder}` against a row.
 *
 * A name the plan does not know prints as `DOCUMENT_EMPTY` rather than as the
 * literal `{name}`. The spec validator has already refused every unresolvable
 * placeholder at declare time, so reaching this branch means the field was
 * rejected after the template was declared — and an em dash on a document is a
 * gap somebody notices, where `{clientName}` is a bug report from a customer.
 */
export function resolveDocumentText(
	text: string,
	row: DocumentRow,
	values: Record<string, DocumentFieldPlan>,
): string {
	return text.replace(/\{([^{}]+)\}/g, (_, rawName: string) => {
		const name = rawName.trim()
		const field = values[name]
		if (!field) return DOCUMENT_EMPTY
		return formatDocumentValue(row[field.column], field)
	})
}

// ===========================================================================
// Compilation
// ===========================================================================

/**
 * Compile a plan and its data into the layout both backends render.
 *
 * Pure: no IO, no clock, no randomness. Given the same plan and the same rows it
 * returns a deeply-equal layout, which is the property the byte-identical
 * guarantee is built on — the backends below it are pure too, so determinism is
 * a consequence of the pipeline's shape rather than a discipline anyone has to
 * maintain.
 */
export function compileDocument(
	plan: DocumentPlan,
	data: DocumentData,
): DocumentLayout {
	const blocks: DocumentBlock[] = []
	const text = (raw: string) => resolveDocumentText(raw, data.row, plan.values)

	plan.sections.forEach((section, index) => {
		switch (section.kind) {
			case 'heading':
				blocks.push({
					kind: 'heading',
					level: section.level,
					text: text(section.text),
				})
				break
			case 'text':
				blocks.push({ kind: 'paragraph', text: text(section.text) })
				break
			case 'fields':
				blocks.push({
					kind: 'pairs',
					columns: section.columns,
					caption: section.caption ? text(section.caption) : undefined,
					pairs: section.fields.map((field) => ({
						label: field.label,
						value: formatDocumentValue(data.row[field.column], field),
					})),
				})
				break
			case 'table': {
				const all = data.related[index] ?? []
				const rows = all.slice(0, MAX_DOCUMENT_TABLE_ROWS)
				blocks.push({
					kind: 'table',
					caption: section.caption ? text(section.caption) : undefined,
					columns: section.fields.map((field) => ({
						label: field.label,
						align: isNumericColumn(field) ? 'right' : 'left',
					})),
					rows: rows.map((row) =>
						section.fields.map((field) =>
							formatDocumentValue(row[field.column], field),
						),
					),
					note:
						all.length > rows.length
							? `Showing the first ${rows.length} of ${all.length} rows.`
							: undefined,
				})
				break
			}
			case 'rule':
				blocks.push({ kind: 'rule' })
				break
			case 'slot':
				// An unfilled slot renders nothing rather than a placeholder. A
				// declared-but-empty slot is a normal state while a document is being
				// authored, and the same rule a page's slot follows.
				blocks.push(...(data.slots?.[section.name] ?? []))
				break
		}
	})

	const firstHeading = blocks.find((b) => b.kind === 'heading' && b.level === 1)
	return {
		title:
			firstHeading && firstHeading.kind === 'heading'
				? firstHeading.text
				: plan.key,
		blocks,
	}
}

/**
 * Resolve a stored object key from a delivery path template.
 *
 * Placeholder values are slug-cleaned before they land in a key: a value with a
 * `/` in it would silently create a directory level, and one with a `..` in it
 * would climb out of the prefix the template declared. Neither is a
 * hypothetical — an invoice number is user-entered text.
 */
export function resolveDocumentPath(
	path: string,
	row: DocumentRow,
	values: Record<string, DocumentFieldPlan>,
): string {
	return path.replace(/\{([^{}]+)\}/g, (_, rawName: string) => {
		const name = rawName.trim()
		const field = values[name]
		const raw = field
			? formatDocumentValue(row[field.column], field)
			: DOCUMENT_EMPTY
		const slug = raw
			.replace(/[^A-Za-z0-9._-]+/g, '-')
			.replace(/^[-.]+|[-.]+$/g, '')
		return slug.length > 0 ? slug : 'untitled'
	})
}
