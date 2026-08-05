/**
 * Generic AI field extraction for a page's entity — free text in, the subset
 * of the entity's columns the text clearly supports out, typed and
 * enum-checked server-side. Powers consumer "describe it, we'll fill the
 * form" flows (voice dictation lands here as a transcript; audio never
 * reaches the server). Goes through the harness AI port, so `MOCK_AI=1` stays
 * keyless-deterministic and a missing key degrades to `ai-unavailable` —
 * callers treat that as "fill the form by hand".
 */

import type { SproutColumn } from '@maxstack/core'
import { selectAiClient } from '@maxstack/spec-derive'

export const MAX_TEXT_LENGTH = 4000

export type ParseEntityResult =
	| { fields: Record<string, unknown> }
	| { error: 'ai-unavailable' | 'unparseable'; detail?: string }

/** A reference field's pickable rows — exactly what the form's combobox loads. */
export interface ReferenceChoice {
	label: string
	value: string
}
export type ReferenceOptions = Record<string, ReferenceChoice[]>

/**
 * How many options of one reference field are offered to the model.
 *
 * The form loads up to 100 rows per field; pasting all of them for several
 * fields would dominate the prompt and push the description itself out of the
 * model's attention. Beyond this the field is simply left out — an unfilled
 * combobox the user picks from, which is the pre-existing behaviour.
 */
export const MAX_REFERENCE_OPTIONS = 40

/** Columns the model may fill: no PK/FK/file/json/hidden/readOnly. */
export function parseableColumns(resource: {
	primaryKey: string
	columns: SproutColumn[]
}): SproutColumn[] {
	return resource.columns.filter(
		(c) =>
			c.name !== resource.primaryKey &&
			c.meta.hidden !== true &&
			c.meta.readOnly !== true &&
			c.meta.isFile !== true &&
			!c.references &&
			c.type !== 'uuid' &&
			c.type !== 'json',
	)
}

/**
 * Reference (FK) columns the model may also fill, and the choices for each.
 *
 * Split from {@link parseableColumns} rather than folded into it because these
 * are matched by *label* and answered as an id — free text says "assigned to
 * Dana", never `a3f1…`. A field with no options, or more than
 * {@link MAX_REFERENCE_OPTIONS} of them, is omitted: with nothing to match
 * against, anything the model returned would be invented.
 */
export function referenceColumns(
	resource: { primaryKey: string; columns: SproutColumn[] },
	referenceOptions: ReferenceOptions,
): { column: SproutColumn; choices: ReferenceChoice[] }[] {
	const out: { column: SproutColumn; choices: ReferenceChoice[] }[] = []
	for (const column of resource.columns) {
		if (column.name === resource.primaryKey) continue
		if (column.meta.hidden === true || column.meta.readOnly === true) continue
		// The "many" side is a multi-select; one extracted label could not express
		// a set, so array references stay out of scope here.
		if (!column.references || column.meta.arrayReference) continue
		const choices = referenceOptions[column.name] ?? []
		if (choices.length === 0 || choices.length > MAX_REFERENCE_OPTIONS) continue
		out.push({ column, choices })
	}
	return out
}

function columnLine(c: SproutColumn): string {
	const notes: string[] = []
	if (c.type === 'enum')
		notes.push(`one of: ${(c.enumValues ?? []).join(' | ')}`)
	if (c.type === 'date') notes.push('format YYYY-MM-DD')
	if (c.meta.label) notes.push(c.meta.label)
	if (c.meta.description) notes.push(c.meta.description)
	return `- ${c.name} (${c.type}${notes.length ? `; ${notes.join('; ')}` : ''})`
}

function referenceLine(c: SproutColumn, choices: ReferenceChoice[]): string {
	const label = c.meta.label ? `; ${c.meta.label}` : ''
	// Labels, not ids: the description names people and things by name, and the
	// id is recovered from the label afterwards.
	return `- ${c.name} (one of these exact names: ${choices
		.map((o) => o.label)
		.join(' | ')}${label})`
}

export function buildPrompt(
	pageName: string,
	columns: SproutColumn[],
	text: string,
	references: { column: SproutColumn; choices: ReferenceChoice[] }[] = [],
): string {
	return [
		`Extract structured fields for one "${pageName}" record from the free-form description below.`,
		'',
		'Allowed JSON keys:',
		...columns.map(columnLine),
		...references.map((r) => referenceLine(r.column, r.choices)),
		'',
		'Rules:',
		'- Respond with ONLY one JSON object — no prose, no markdown fences.',
		'- Include a key only when the description clearly supports its value. Never guess or invent; omit anything not stated.',
		'- Dates as "YYYY-MM-DD" strings, numbers as JSON numbers, booleans as JSON booleans.',
		...(references.length > 0
			? [
					'- For the name-list fields above, copy one listed name exactly. If the description names someone or something that is not on the list, omit the key.',
				]
			: []),
		'',
		'Description:',
		'"""',
		text,
		'"""',
	].join('\n')
}

/** Exact parse first, then the outermost `{…}` span — models still chat sometimes. */
export function recoverObject(raw: string): Record<string, unknown> | null {
	const span = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
	for (const candidate of [raw, span]) {
		try {
			const parsed: unknown = JSON.parse(candidate)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				return parsed as Record<string, unknown>
		} catch {
			// fall through to the next candidate
		}
	}
	return null
}

/** Coerce one model value to the column's type; `undefined` = drop it. */
export function coerce(column: SproutColumn, value: unknown): unknown {
	if (value === null || value === undefined) return undefined
	switch (column.type) {
		case 'string': {
			const s = typeof value === 'string' ? value.trim() : undefined
			return s ? s : undefined
		}
		case 'number': {
			const n = typeof value === 'number' ? value : Number(String(value))
			return Number.isFinite(n) ? n : undefined
		}
		case 'boolean': {
			if (typeof value === 'boolean') return value
			if (value === 'true') return true
			if (value === 'false') return false
			return undefined
		}
		case 'date': {
			const s = String(value).trim()
			if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
			const t = Date.parse(s)
			return Number.isNaN(t)
				? undefined
				: new Date(t).toISOString().slice(0, 10)
		}
		case 'enum': {
			const s = String(value).trim()
			const hit = (column.enumValues ?? []).find(
				(v) => v.toLowerCase() === s.toLowerCase(),
			)
			return hit
		}
		default:
			return undefined
	}
}

/**
 * Resolve a model-supplied reference answer back to the id the form submits.
 *
 * Label first — that is what the model was shown and what free text contains —
 * then the raw id, so a description that happens to quote one still works.
 * Anything else is dropped: a near-miss on a name is exactly the case where
 * guessing would silently attach the record to the wrong row.
 */
export function coerceReference(
	choices: ReferenceChoice[],
	value: unknown,
): string | undefined {
	if (typeof value !== 'string' && typeof value !== 'number') return undefined
	const wanted = String(value).trim().toLowerCase()
	if (!wanted) return undefined
	const byLabel = choices.find((o) => o.label.trim().toLowerCase() === wanted)
	if (byLabel) return byLabel.value
	return choices.find((o) => o.value.toLowerCase() === wanted)?.value
}

/**
 * The whole pipeline: prompt the AI port with the parseable columns, recover
 * a JSON object from its reply, and keep only the keys that coerce cleanly to
 * a column's type. Soft failures come back as `{ error }`, never a throw —
 * the caller's fallback is always "fill the form by hand".
 */
export async function parseEntityFields(input: {
	resource: string
	pageName: string
	introspection: { primaryKey: string; columns: SproutColumn[] }
	text: string
	/** The form's loaded combobox rows, so FK fields can be filled by name. */
	referenceOptions?: ReferenceOptions
}): Promise<ParseEntityResult> {
	const columns = parseableColumns(input.introspection)
	const references = referenceColumns(
		input.introspection,
		input.referenceOptions ?? {},
	)
	let raw: string
	try {
		raw = await selectAiClient().complete({
			generator: 'parse-entity',
			key: input.resource,
			prompt: buildPrompt(
				input.pageName,
				columns,
				input.text.slice(0, MAX_TEXT_LENGTH),
				references,
			),
		})
	} catch (err) {
		return { error: 'ai-unavailable', detail: (err as Error).message }
	}

	const parsed = recoverObject(raw)
	if (!parsed) return { error: 'unparseable' }

	const fields: Record<string, unknown> = {}
	for (const column of columns) {
		const value = coerce(column, parsed[column.name])
		if (value !== undefined) fields[column.name] = value
	}
	for (const { column, choices } of references) {
		const value = coerceReference(choices, parsed[column.name])
		if (value !== undefined) fields[column.name] = value
	}
	return { fields }
}
