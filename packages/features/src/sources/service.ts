/**
 * Running a declared source — the part that fetches, maps, and
 * says what should be written.
 *
 * ## It produces intent, and never writes a row
 *
 * `runEnrichment` and `runSync` return {@link SourceWrite}s. The caller applies
 * them through the same validated write path a form posts to, which is the
 * settled shape from issue #185's inbound receivers and it is settled for the
 * same reason: a surface that writes rows itself is a surface that has its own
 * copy of validation, permissions, limits and the audit trail, and those copies
 * are wrong within a quarter. A field the third party supplies goes through the
 * column's own zod schema, the entity's WIP limits, and the op log, because it
 * goes through the identical code path a person typing into the form does.
 *
 * ## Failure is a normal outcome, not an exception
 *
 * A run returns a {@link SourceRunResult} whether it worked or not. Nothing
 * here throws at the caller for a third party being down — the outcome carries
 * the reason, the caller records it, and the app shows a stale badge. That is
 * the difference between "the provider is having a bad morning" and "the page
 * is broken", and only one of them should look like the other.
 *
 * Retries live in the job queue rather than in a loop here, so a source that is
 * down does not hold a worker for `maxAttempts × timeoutMs` — the declared
 * budget becomes the queue's backoff, and the wait is durable across a restart.
 */

import {
	coerceToFieldType,
	type EntitySpec,
	type FieldId,
	type SourceSpec,
} from '@maxstack/spec'
import {
	type FetchSourceDeps,
	fetchSource,
	type SourceFailure,
	SourceFetchError,
} from './fetch.ts'
import {
	applyMapping,
	type MappedValues,
	type MappingRefusal,
	readCollection,
	remoteIdOf,
} from './mapping.ts'

/** A row's values as the runtime holds them. */
export type RowValues = Record<string, unknown>

/**
 * What a run says should be written.
 *
 * `update` targets a row that already exists (an enrichment always does — it
 * was triggered by one). `upsert` is keyed on the remote id column, which is
 * what makes a sync safe to run again: the second run matches the rows the
 * first one made instead of making them a second time.
 */
export type SourceWrite =
	| {
			kind: 'update'
			entityId: string
			rowId: string
			values: Record<string, unknown>
	  }
	| {
			kind: 'upsert'
			entityId: string
			/** The declared remote-id column. */
			matchField: FieldId
			matchValue: string
			values: Record<string, unknown>
	  }

/** What one run did. Returned on success and on failure alike. */
export interface SourceRunResult {
	sourceKey: string
	ok: boolean
	writes: SourceWrite[]
	/** Values the response supplied that could not land, with reasons. */
	refusals: MappingRefusal[]
	/** Records dropped because the declared `maxRecords` bound was reached. */
	truncated: number
	/** Records skipped because they carried no stable remote id. */
	skippedWithoutId: number
	error?: {
		reason: SourceFailure | 'refiner'
		message: string
		retryable: boolean
	}
}

/**
 * The user-owned refiner slot's contract (`sources/<key>.refine.ts`).
 *
 * It is called with the raw remote record *and* the values the declared mapping
 * already produced, and returns the final values. That order matters: the
 * declaration does the boring 90% and the code only has to express the part
 * that is genuinely code — resolving a synced message to the contact whose
 * email it came from, reconciling two providers, applying a merge policy the
 * vocabulary deliberately does not model.
 *
 * Its return value is re-coerced against the entity's declared types, so a
 * refiner cannot write something a form could not. It is an extension point,
 * not a bypass.
 */
export type SourceRefiner = (
	ctx: SourceRefineContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>

export interface SourceRefineContext {
	sourceKey: string
	mode: SourceSpec['mode']
	/** The remote record exactly as it arrived, undecoded beyond JSON. */
	record: unknown
	/** What the declared mapping produced — field id → value. */
	values: Record<string, string | number | boolean | null>
	/** The remote id, for a sync record. `null` for an enrichment. */
	remoteId: string | null
}

export interface SourceRunDeps extends FetchSourceDeps {
	/** The generated registry: source key → the user's refiner, when filled. */
	refiners?: Record<string, SourceRefiner>
}

/** Re-coerce a refiner's output so an extension point cannot become a bypass. */
async function refine(
	source: SourceSpec,
	entity: EntitySpec,
	mapped: MappedValues,
	record: unknown,
	remoteId: string | null,
	deps: SourceRunDeps,
): Promise<MappedValues> {
	if (!source.refine) return mapped
	const refiner = deps.refiners?.[source.key]
	if (!refiner) return mapped
	const out = await refiner({
		sourceKey: source.key,
		mode: source.mode,
		record,
		values: mapped.values,
		remoteId,
	})
	const byId = new Map(entity.fields.map((f) => [f.id, f]))
	const values: MappedValues['values'] = {}
	const refusals = [...mapped.refusals]
	for (const [fieldId, raw] of Object.entries(out ?? {})) {
		const field = byId.get(fieldId as FieldId)
		if (!field) {
			refusals.push({
				field: fieldId,
				from: '(refiner)',
				reason: `"${fieldId}" is not a field on ${entity.id}`,
			})
			continue
		}
		const coerced = coerceToFieldType(raw, field.type)
		if (!coerced.ok) {
			refusals.push({
				field: fieldId,
				from: '(refiner)',
				reason: coerced.reason,
			})
			continue
		}
		values[fieldId] = coerced.value
	}
	return { values, refusals }
}

function failure(source: SourceSpec, err: unknown): SourceRunResult {
	const base = {
		sourceKey: source.key,
		ok: false,
		writes: [],
		refusals: [],
		truncated: 0,
		skippedWithoutId: 0,
	}
	if (err instanceof SourceFetchError)
		return {
			...base,
			error: {
				reason: err.reason,
				message: err.message,
				retryable: err.retryable,
			},
		}
	return {
		...base,
		error: {
			reason: 'refiner',
			message: err instanceof Error ? err.message : String(err),
			retryable: false,
		},
	}
}

/**
 * Enrich one row: fetch what the third party knows about it, map the answer
 * onto its columns, and return the update.
 *
 * The row's own values resolve the request's placeholders. A row whose
 * `inputField` is empty is not fetched for at all — that is what stops an
 * enrichment from firing one request per row for the rows it has nothing to ask
 * about, and it is reported as a successful no-op rather than as a failure,
 * because a book with no ISBN is not an error.
 */
export async function runEnrichment(
	source: SourceSpec,
	entity: EntitySpec,
	row: RowValues & { id: string },
	deps: SourceRunDeps = {},
): Promise<SourceRunResult> {
	const empty: SourceRunResult = {
		sourceKey: source.key,
		ok: true,
		writes: [],
		refusals: [],
		truncated: 0,
		skippedWithoutId: 0,
	}
	const inputName = entity.fields.find((f) => f.id === source.inputField)?.name
	if (!inputName) return empty
	const input = row[inputName]
	if (input === null || input === undefined || input === '') return empty

	try {
		const { document } = await fetchSource(source, row, deps)
		const mapped = await refine(
			source,
			entity,
			applyMapping(source, entity, document),
			document,
			null,
			deps,
		)
		// The row keeps what it had when the response had nothing to say: an
		// update with no values is no update, not a row of nulls.
		const writes: SourceWrite[] =
			Object.keys(mapped.values).length === 0
				? []
				: [
						{
							kind: 'update',
							entityId: source.entityId,
							rowId: row.id,
							values: mapped.values,
						},
					]
		return { ...empty, writes, refusals: mapped.refusals }
	} catch (err) {
		return failure(source, err)
	}
}

/**
 * Pull a remote collection and return one upsert per record.
 *
 * A record with no stable remote id is **skipped, not inserted**. Inserting it
 * would produce a row the next run cannot match, so every run would add it
 * again — the duplicate-rows failure that this whole primitive exists to make
 * impossible. The count of skipped records comes back so the gap is visible.
 */
export async function runSync(
	source: SourceSpec,
	entity: EntitySpec,
	deps: SourceRunDeps = {},
): Promise<SourceRunResult> {
	const collection = source.collection
	if (!collection)
		return {
			sourceKey: source.key,
			ok: false,
			writes: [],
			refusals: [],
			truncated: 0,
			skippedWithoutId: 0,
			error: {
				reason: 'refused-url',
				message: `source "${source.key}" is sync mode with no declared collection`,
				retryable: false,
			},
		}

	try {
		const { document } = await fetchSource(source, {}, deps)
		const { records, truncated } = readCollection(source, document)
		const writes: SourceWrite[] = []
		const refusals: MappingRefusal[] = []
		let skippedWithoutId = 0
		for (const record of records) {
			const remoteId = remoteIdOf(source, record)
			if (!remoteId) {
				skippedWithoutId++
				continue
			}
			const mapped = await refine(
				source,
				entity,
				applyMapping(source, entity, record),
				record,
				remoteId,
				deps,
			)
			refusals.push(...mapped.refusals)
			writes.push({
				kind: 'upsert',
				entityId: source.entityId,
				matchField: collection.idField,
				matchValue: remoteId,
				// The remote id is written too, so a row created by this run is one
				// the next run can match. A key that only exists in the matcher is a
				// key that does not exist.
				values: { ...mapped.values, [collection.idField]: remoteId },
			})
		}
		return {
			sourceKey: source.key,
			ok: true,
			writes,
			refusals,
			truncated,
			skippedWithoutId,
		}
	} catch (err) {
		return failure(source, err)
	}
}
