/**
 * Zod schema generation from an introspected resource.
 * See the reference design.
 *
 * Improvement over the specbase original: the validation-relevant metadata
 * keys (minLength/maxLength/pattern/min/max/required/format) ARE honored here.
 * The original derived purely from column type/flags and silently dropped every
 * meta constraint from server validation.
 */

import { z } from 'zod'
import type { SproutColumn, SproutResource } from './types.ts'

export type ValidationMode = 'create' | 'update'

const TIMESTAMP_NAMES = new Set([
	'createdAt',
	'updatedAt',
	'created_at',
	'updated_at',
])

/**
 * The form a `date` column reads back as. A spec `date` is a `timestamp`
 * (without zone) in `mode: 'string'`, so the store hands back
 * `2026-03-08 09:00:00` — a space where ISO 8601 wants a `T`.
 */
const SPACE_SEPARATED_DATETIME =
	/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)$/

/**
 * A trailing zone marker: `Z`, or a `±HH:MM` / `±HHMM` offset.
 *
 * Only meaningful after a *time* — a bare `2026-03-08` has no tail to strip.
 */
const ZONE_SUFFIX =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Put an incoming date value into the one form a spec `date` column stores: a
 * **wall clock** with no zone.
 *
 * Two normalizations, both deliberate:
 *
 * 1. The space separator of a read-back timestamp becomes a `T`.
 *     Without this a row is not round-trippable through its own API: read it,
 *     post it back unchanged, and the date column 422s against the very form
 *     the platform emitted.
 *  2. A trailing `Z` or `±HH:MM` is **dropped, keeping the reading as written**
 *. A spec `date` is a `timestamp` WITHOUT time zone, so an offset
 *     names an instant a zone-less column cannot hold. Postgres already
 *     discards it on cast; doing it here makes the rule the platform's own
 *     statement rather than a backend side effect, makes every store agree,
 *     and — the point of #316 — makes it true that the stored value is the one
 *     that was sent, instead of one silently moved by the offset.
 *
 * A `Date` is likewise an instant, so it is read as the wall clock it shows in
 * UTC; leaving it as an object would hand the store the same ambiguity in
 * another shape.
 */
function normalizeDateInput(value: unknown): unknown {
	if (value instanceof Date)
		return Number.isNaN(value.getTime())
			? value
			: value.toISOString().replace(/Z$/, '')
	if (typeof value !== 'string') return value
	const separated = SPACE_SEPARATED_DATETIME.exec(value)
	const isoish = separated ? `${separated[1]}T${separated[2]}` : value
	const zoned = ZONE_SUFFIX.exec(isoish)
	return zoned ? zoned[1] : isoish
}

/**
 * The days that exist — leap years included. Mirrors zod's own `z.iso.date()`
 * body, which stays in use for the date-only branch; this copy exists so the
 * date-*time* branch can be spelled with a **zone-less** tail.
 */
const CALENDAR_DATE = String.raw`(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))`

/**
 * The canonical form of a spec `date` carrying a time: a wall clock with **no
 * zone**. This is what the generated API contract publishes as its `pattern`
 * (see `WALL_CLOCK_DATE_TIME_JSON_SCHEMA`), in place of what zod renders for
 * `z.iso.datetime({local: true})` — which gets two things wrong for a client
 * reading the contract to learn what to send:
 *
 *  - a `(?:Z|)` tail — an *empty alternation*, which makes the zone optional by
 *    accident rather than by statement, and still shows `Z` as canonical.
 *  - `format: "date-time"`, and RFC 3339 `date-time` REQUIRES an offset.
 *    Advertising it on a `timestamp` WITHOUT time zone tells a strict client
 *    the exact opposite of the truth: that the wall clock this column stores is
 *    the one shape it may not send.
 */
const WALL_CLOCK_DATE_TIME_PATTERN = String.raw`^${CALENDAR_DATE}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$`

/**
 * What a spec `date` stores, in the client's own vocabulary — published into
 * the generated API contract by `entityApiContract`, which is the payload a
 * client reads instead of probing a running server.
 *
 * It is not a `.describe()` on the schema itself: a description there is the
 * *form label* for the generated UI (`zodToFormFields`), and a paragraph of
 * contract prose is not a label. This is the one statement JSON Schema cannot
 * derive anyway — it describes the preprocess, which runs before validation.
 *
 * Before #316 the two payloads of the same MCP server disagreed: `data.addField`
 * warned that re-zoning a wall clock moves it by the offset, while the contract
 * generated from that same field advertised `format: "date-time"` with an
 * offset-accepting pattern and said nothing about the value moving.
 */
export const WALL_CLOCK_DATE_TIME_JSON_SCHEMA = {
	type: 'string',
	pattern: WALL_CLOCK_DATE_TIME_PATTERN,
	description:
		'A wall clock, not an instant: stored in a `timestamp` WITHOUT time zone. ' +
		'Send `2026-03-08T09:00:00`. A trailing `Z` or `±HH:MM` is accepted but ' +
		'DISCARDED — the reading is stored exactly as written and is never shifted ' +
		'by the offset, so convert to the wall clock you mean before sending.',
} as const

/**
 * One shared instance, not one per column: `z.toJSONSchema(…, {reused: 'ref'})`
 * hoists a schema it meets twice into `$defs`, so an entity with two date
 * fields costs one copy of the pattern in the contract instead of two.
 */
const DATE_SCHEMA = z.preprocess(
	normalizeDateInput,
	// Post-normalization the value is always zone-less, so `local` — which
	// rejects an offset — is the honest branch. `z.date()` is gone: it rendered
	// as the empty schema `{}`, and an `anyOf` containing `{}` accepts anything,
	// which collapsed the whole published union to "any value".
	z.iso.datetime({ local: true }).or(z.iso.date()),
)

/** JSON.parse a string when possible; leave every other value untouched. */
function parseJsonText(value: unknown): unknown {
	if (typeof value !== 'string') return value
	try {
		return JSON.parse(value)
	} catch {
		return value
	}
}

function baseFieldSchema(column: SproutColumn): z.ZodType {
	// An array reference (task 38) stores a list of FK ids — validate it as a
	// string[] (not the generic json record its column type would imply) so the
	// multi-value picker's repeated inputs round-trip as an array.
	if (column.meta.arrayReference) return z.array(z.string())
	switch (column.type) {
		case 'string':
		case 'uuid': {
			let s = z.string()
			const { minLength, maxLength, pattern, format } = column.meta
			if (typeof minLength === 'number') s = s.min(minLength)
			if (typeof maxLength === 'number') s = s.max(maxLength)
			if (pattern instanceof RegExp) s = s.regex(pattern)
			if (format === 'email') s = s.email()
			if (format === 'url') s = s.url()
			return s
		}
		case 'number': {
			let n = z.number()
			const { min, max } = column.meta
			if (typeof min === 'number') n = n.min(min)
			if (typeof max === 'number') n = n.max(max)
			return n
		}
		case 'boolean':
			return z.boolean()
		case 'date':
			// Accept what real clients actually send: offset/UTC datetimes (JSON),
			// timezone-less datetimes (<input type="datetime-local">), bare dates
			// (<input type="date">), Date objects from in-process calls, and the
			// space-separated form this very column reads back as — all folded to
			// one zone-less wall clock by the preprocess first.
			return DATE_SCHEMA
		case 'enum':
			return column.enumValues && column.enumValues.length > 0
				? z.enum(column.enumValues as [string, ...string[]])
				: z.string()
		case 'json':
			// Any JSON container — a top-level array is legitimate JSON, and the
			// natural shape for e.g. an allowed-values list. A string is JSON.parsed
			// first so the JSON-textarea widget's serialized value validates too; a
			// string that isn't valid JSON survives the preprocess unchanged and fails
			// the union.
			return z.preprocess(
				parseJsonText,
				z.union(
					[
						z.record(z.string(), z.unknown()),
						// Not z.array(): Conform's client-side coercion auto-wraps a lone
						// string into a one-element array, which would silently accept
						// invalid JSON textarea text as `[text]`. z.custom is opaque to
						// that coercion, so bad text fails the union instead.
						z.custom<unknown[]>((value) => Array.isArray(value)),
					],
					{ error: 'Expected a JSON object or array' },
				),
			)
		default: {
			const exhaustive: never = column.type
			throw new Error(`Unhandled column type: ${String(exhaustive)}`)
		}
	}
}

/** Should this column appear in an input schema? PKs and defaulted timestamps
 * are excluded (matches the specbase original). */
function includeColumn(column: SproutColumn): boolean {
	if (column.isPrimaryKey) return false
	if (TIMESTAMP_NAMES.has(column.name) && column.hasDefault) return false
	return true
}

export function generateValidationSchema(
	resource: SproutResource,
	mode: ValidationMode = 'create',
): z.ZodObject {
	const shape: Record<string, z.ZodType> = {}
	for (const column of resource.columns) {
		if (!includeColumn(column)) continue
		let field = baseFieldSchema(column)
		const required = column.meta.required === true
		if (mode === 'update') {
			// Update mode makes every column optional, but it must not drop the
			// column's nullability along the way. A nullable column
			// that create mode accepts `null` for, and that the read path emits
			// `null` for, has to accept `null` back — otherwise the API refuses
			// the very value it just handed out, an optional field can never be
			// cleared once set, and clients are pushed into overloading a real
			// value (`0`, `""`) as a sentinel for empty. Same round-trippability
			// principle as #218, applied to the nullability axis.
			field =
				column.nullable && !required
					? field.nullable().optional()
					: field.optional()
		} else if (column.nullable && !required) {
			field = field.nullable().optional()
		} else if (column.hasDefault && !required) {
			field = field.optional()
		}
		shape[column.name] = field
	}
	return z.object(shape)
}

// ===========================================================================
// Refusals that are sufficient to fix the call
// ===========================================================================

/**
 * What a column accepts, in a sentence, plus a value that would work.
 *
 * This exists because `{"finishedOn":["Invalid input"]}` names no cause, no
 * expectation and no received value. A caller that reads it runs a probe matrix
 * — four round trips — and can still finish with the wrong idea about intent. A
 * caller that reads "expected a wall-clock date-time, or null to clear; received
 * string \"tomorrow\"" writes the correct call on the next try.
 *
 * It is also the cheapest documentation there is, because it arrives exactly
 * when the caller is wrong and nowhere else.
 */
export interface FieldContract {
	type: string
	required: boolean
	nullable: boolean
	/** One sentence naming everything this column will accept. */
	accepts: string
	/** Concrete values that would be accepted, JSON-rendered. */
	examples: string[]
}

const DATE_ACCEPTS =
	'a wall-clock date-time ("2026-07-31T09:00:00"), or a bare date ("2026-07-31") — a trailing "Z" or "+HH:MM" is accepted but discarded, because this column is a timestamp WITHOUT time zone'

function acceptsFor(column: SproutColumn): {
	accepts: string
	examples: string[]
} {
	if (column.meta.arrayReference)
		return {
			accepts: 'an array of id strings',
			examples: ['["01H…", "01J…"]', '[]'],
		}
	switch (column.type) {
		case 'string':
		case 'uuid': {
			const { minLength, maxLength, pattern, format } = column.meta
			const bounds: string[] = []
			if (typeof minLength === 'number')
				bounds.push(`at least ${minLength} characters`)
			if (typeof maxLength === 'number')
				bounds.push(`at most ${maxLength} characters`)
			if (format === 'email') bounds.push('an email address')
			if (format === 'url') bounds.push('a URL')
			if (pattern instanceof RegExp) bounds.push(`matching ${pattern}`)
			return {
				accepts: bounds.length ? `a string (${bounds.join(', ')})` : 'a string',
				examples: format === 'email' ? ['"a@example.com"'] : ['"some text"'],
			}
		}
		case 'number': {
			const { min, max } = column.meta
			const bounds: string[] = []
			if (typeof min === 'number') bounds.push(`>= ${min}`)
			if (typeof max === 'number') bounds.push(`<= ${max}`)
			return {
				accepts: bounds.length ? `a number (${bounds.join(', ')})` : 'a number',
				examples: [String(column.meta.min ?? 1)],
			}
		}
		case 'boolean':
			return { accepts: 'true or false', examples: ['true', 'false'] }
		case 'date':
			return { accepts: DATE_ACCEPTS, examples: ['"2026-07-31T09:00:00"'] }
		case 'enum': {
			const values = column.enumValues ?? []
			return {
				accepts: values.length
					? `one of ${values.map((v) => JSON.stringify(v)).join(' | ')}`
					: 'a string',
				examples: values.length ? [JSON.stringify(values[0])] : ['"some text"'],
			}
		}
		case 'json':
			return {
				accepts: 'a JSON object or array',
				examples: ['{"key":"value"}', '[]'],
			}
		default:
			return { accepts: 'a value', examples: [] }
	}
}

/** The full accepted contract for one column, in the given mode. */
export function describeColumn(
	column: SproutColumn,
	mode: ValidationMode = 'create',
): FieldContract {
	const required = column.meta.required === true
	const nullable = column.nullable && !required
	const { accepts, examples } = acceptsFor(column)
	const clauses = [accepts]
	if (nullable) clauses.push('or null to clear it')
	if (mode === 'update') clauses.push('or omit the key to leave it unchanged')
	else if (!required) clauses.push('or omit the key')
	return {
		type: column.type,
		required,
		nullable,
		accepts: clauses.join(', '),
		examples: [...examples, ...(nullable ? ['null'] : [])],
	}
}

/** A short, safe rendering of the value that actually arrived. */
function receivedDescription(value: unknown): string {
	if (value === undefined) return 'nothing (the key was absent)'
	if (value === null) return 'null'
	const type = Array.isArray(value) ? 'array' : typeof value
	const json = JSON.stringify(value) ?? String(value)
	return `${type} ${json.length > 80 ? `${json.slice(0, 77)}…` : json}`
}

/** The value at a zod issue's path, for the "received" half of the message. */
function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
	let current: unknown = data
	for (const key of path) {
		if (current === null || typeof current !== 'object') return undefined
		current = (current as Record<PropertyKey, unknown>)[key]
	}
	return current
}

export interface ValidationResult<T = Record<string, unknown>> {
	success: boolean
	data?: T
	/**
	 * Per-field messages. Each one states the expectation, the value that
	 * arrived, and how to fix it — see {@link FieldContract}. The shape is
	 * unchanged (`Record<string, string[]>`), so every existing consumer,
	 * `DynamicForm`'s `serverErrors` included, keeps working.
	 */
	fieldErrors?: Record<string, string[]>
	/** The accepted contract of each rejected field, machine-readable. */
	fields?: Record<string, FieldContract>
	/** One line naming the resource, the mode and every rejected field. */
	summary?: string
}

/**
 * The keys an input schema for `mode` accepts — what a caller may send.
 *
 * Read off the generated schema rather than re-filtering the columns, so a
 * refusal that lists "unknown" keys can never name a set the validator would
 * actually have kept. Its one caller is the empty-update refusal in `opUpdate`
 * (#388), which has to tell a caller *which* of the keys it sent were dropped;
 * a list derived from a second rule would eventually name the wrong ones.
 */
export function writableFields(
	resource: SproutResource,
	mode: ValidationMode = 'create',
): string[] {
	return Object.keys(generateValidationSchema(resource, mode).shape)
}

export function validateData(
	resource: SproutResource,
	data: unknown,
	mode: ValidationMode = 'create',
): ValidationResult {
	const schema = generateValidationSchema(resource, mode)
	const result = schema.safeParse(data)
	if (result.success) {
		return { success: true, data: result.data as Record<string, unknown> }
	}

	const byName = new Map(resource.columns.map((c) => [c.name, c]))
	const fieldErrors: Record<string, string[]> = {}
	const fields: Record<string, FieldContract> = {}

	const push = (name: string, message: string): void => {
		const existing = fieldErrors[name]
		if (existing) existing.push(message)
		else fieldErrors[name] = [message]
	}

	for (const issue of result.error.issues) {
		const name = String(issue.path[0] ?? '')
		const column = byName.get(name)
		const received = receivedDescription(valueAt(data, issue.path))
		if (!column) {
			// A path with no column behind it (an unknown key, a nested path): say
			// what zod said rather than inventing a contract we cannot describe.
			push(name, `${issue.message}; received ${received}.`)
			continue
		}
		const contract = describeColumn(column, mode)
		fields[name] = contract
		const example = contract.examples[0]
		push(
			name,
			`expected ${contract.accepts}; received ${received}` +
				(example ? ` — send e.g. ${example}.` : '.'),
		)
	}

	const rejected = Object.keys(fieldErrors)
	return {
		success: false,
		fieldErrors,
		fields,
		summary: `${resource.name} ${mode}: ${rejected.length} field(s) rejected — ${rejected.join(', ')}. Nothing was written.`,
	}
}
