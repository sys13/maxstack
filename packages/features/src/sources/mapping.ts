/**
 * Turning a response document into values a row can hold.
 *
 * Pure, and separated from `fetch.ts` on purpose: the mapping is the part
 * people will get wrong (a third party renames `number_of_pages` and everything
 * silently stops landing), and a pure function is one they can test against a
 * saved response without a network, a clock or a queue.
 *
 * Two rules, both of which are about the same thing — a source must never make
 * a row *worse* than it was:
 *
 * 1. **A value that cannot be coerced is refused, not written.** The target
 *    column's declared type is the authority (`coerceToFieldType`), and a
 *    refusal comes back as a reason attached to the run rather than as a `NaN`
 *    in the column or an exception on the page.
 * 2. **Absent is absent.** A path that resolves to nothing produces no entry at
 *    all — not `null`. A book with no cover must keep the cover somebody typed
 *    in by hand, and a mapping that writes `null` over it is a source that
 *    deletes data every time the provider has a gap.
 */

import {
	type CoercionResult,
	coerceToFieldType,
	type EntitySpec,
	parseSourcePath,
	readSourcePath,
	type SourceSpec,
} from '@maxstack/spec'

/** One mapping that did not land, and why — reported, never swallowed. */
export interface MappingRefusal {
	/** The field id the value was destined for. */
	field: string
	/** The response path it came from. */
	from: string
	reason: string
}

/** What a document produced: the values to write, and what was refused. */
export interface MappedValues {
	/** Field id → value. Only fields the document actually supplied. */
	values: Record<string, string | number | boolean | null>
	refusals: MappingRefusal[]
}

/**
 * Apply a source's declared mapping to one response document.
 *
 * `entity` supplies the types — that is what makes this typed without the
 * mapping carrying a second type declaration that could drift from the
 * column's. A mapping onto a field the entity no longer has is a refusal rather
 * than a crash: entities and sources are edited by different people on
 * different days.
 */
export function applyMapping(
	source: SourceSpec,
	entity: EntitySpec,
	document: unknown,
): MappedValues {
	const byId = new Map(entity.fields.map((f) => [f.id, f]))
	const values: MappedValues['values'] = {}
	const refusals: MappingRefusal[] = []

	for (const entry of source.mapping) {
		const field = byId.get(entry.to)
		if (!field) {
			refusals.push({
				field: entry.to,
				from: entry.from,
				reason: `"${entry.to}" is no longer a field on ${entity.id}`,
			})
			continue
		}
		const segments = parseSourcePath(entry.from)
		if (!segments) {
			refusals.push({
				field: entry.to,
				from: entry.from,
				reason: 'not a response path',
			})
			continue
		}
		const raw = readSourcePath(document, segments)
		// Absent is absent. Writing null here is how a source deletes the value a
		// person typed in, every time the provider has a gap.
		if (raw === undefined) continue
		const coerced: CoercionResult = coerceToFieldType(raw, field.type)
		if (!coerced.ok) {
			refusals.push({
				field: entry.to,
				from: entry.from,
				reason: coerced.reason,
			})
			continue
		}
		values[entry.to] = coerced.value
	}

	return { values, refusals }
}

/**
 * The records a sync run takes in, in declaration order, bounded by the
 * declared `maxRecords`.
 *
 * Returns the bound separately from the records: a run that hit the cap has to
 * be able to *say so*, because "we synced 100 of 4,000 contacts" and "there are
 * 100 contacts" are different facts and only one of them is a problem.
 */
export function readCollection(
	source: SourceSpec,
	document: unknown,
): { records: unknown[]; truncated: number } {
	const collection = source.collection
	if (!collection) return { records: [], truncated: 0 }
	const root = collection.path
		? readSourcePath(document, parseSourcePath(collection.path) ?? [])
		: document
	if (!Array.isArray(root)) return { records: [], truncated: 0 }
	const records = root.slice(0, collection.maxRecords)
	return { records, truncated: Math.max(0, root.length - records.length) }
}

/** The stable remote id of one record, or `null` when it has none. */
export function remoteIdOf(source: SourceSpec, record: unknown): string | null {
	const collection = source.collection
	if (!collection) return null
	const segments = parseSourcePath(collection.idPath)
	if (!segments) return null
	const raw = readSourcePath(record, segments)
	if (raw === null || raw === undefined) return null
	// A remote id is an opaque string. Numbers happen (many APIs return integer
	// ids) and stringify losslessly; anything structured does not have an
	// identity we can key on.
	if (typeof raw === 'string') return raw.length > 0 ? raw : null
	if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
	return null
}
