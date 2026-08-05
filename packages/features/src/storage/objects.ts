/**
 * The `file_object` registry — one row per stored blob, recording
 * what it is, who uploaded it, and which declared field it was uploaded for.
 *
 * Why a table and not just "the key is in the entity column":
 *
 *  - **Content type on read.** The gateway must answer with the right
 *    `Content-Type`, and it must be the one the *server* validated at upload,
 *    not one re-sniffed from bytes at read time.
 *  - **Derivatives are enumerable.** A read surface renders `@thumb` only if
 *    `@thumb` was actually produced; the row says which variants exist, so a
 *    failed derivative shows as a missing variant rather than a broken image.
 *  - **Orphans are findable.** A row deleted, or a file field overwritten,
 *    leaves bytes nothing points at. The registry makes that set computable —
 *    see {@link findOrphanedObjects} — which is the precondition for the
 *    issue's requirement that cleanup be *explicit and reviewable*.
 *
 * The schema is additive-only, like every spec entity: the bundle contributes
 * it through `data.addEntity`, so the v1 op vocabulary structurally cannot
 * express a destructive migration of it.
 *
 * **Nothing here deletes anything.** `findOrphanedObjects` returns a report. A
 * sweep that deleted on its own would be a background job that destroys user
 * data on the strength of a query that might be wrong (a key referenced from
 * owned code the sweep cannot see, a row mid-transaction), and no amount of
 * care makes that a safe default.
 */

import type { MaterializedDerivative } from './derivatives.ts'

/** A `file_object` row as the runtime reads and writes it. */
export interface FileObjectRecord {
	/** The storage key of the original (never a derivative's key). */
	key: string
	contentType: string
	size: number
	/** The filename the user chose. Display only — it never touches the key. */
	originalName: string
	/** Uploader's user id, or null for an anonymous upload. */
	uploadedBy: string | null
	/** Resource (table) the upload was for, e.g. `post`. */
	resource: string | null
	/** Column on that resource, e.g. `cover`. */
	field: string | null
	/** Variants that were actually materialized. */
	derivatives: MaterializedDerivative[]
	createdAt: string
}

/** Build the row for a completed upload. Pure so the write path is testable
 * without a database. */
export function fileObjectRow(input: {
	key: string
	contentType: string
	size: number
	originalName: string
	uploadedBy?: string | null
	resource?: string | null
	field?: string | null
	derivatives?: MaterializedDerivative[]
	now?: () => Date
}): FileObjectRecord {
	return {
		key: input.key,
		contentType: input.contentType,
		size: input.size,
		originalName: input.originalName,
		uploadedBy: input.uploadedBy ?? null,
		resource: input.resource ?? null,
		field: input.field ?? null,
		derivatives: input.derivatives ?? [],
		createdAt: (input.now?.() ?? new Date()).toISOString(),
	}
}

/** Every key a record occupies — the original plus each materialized variant.
 * What a cleanup would have to remove, if a human decided to run one. */
export function recordKeys(record: FileObjectRecord): string[] {
	return [record.key, ...record.derivatives.map((d) => d.key)]
}

export interface OrphanReport {
	/** Records no live row references any more. */
	orphans: FileObjectRecord[]
	/** Every key those records occupy. */
	keys: string[]
	/** Total bytes they hold, originals + variants. */
	bytes: number
	/**
	 * Keys referenced by a row but with **no registry record** — the opposite
	 * failure, and the more alarming one: a column pointing at bytes the app has
	 * no metadata for. Reported rather than ignored, because it means either an
	 * upload that half-failed or a hand-edited row, and both want a human.
	 */
	danglingReferences: string[]
}

/**
 * Compare the registry against the keys live rows actually reference.
 *
 * `minimumAgeMs` exists because "no row references this key" is the normal
 * state of an upload that is *in flight*: a user picks a file, it uploads, and
 * the form is not submitted for another minute. Without a grace period the
 * report would list every in-progress upload as garbage. It defaults to an hour
 * — generous, because this is a report a human reads, and a false positive here
 * is an invitation to delete something live.
 */
export function findOrphanedObjects(input: {
	records: readonly FileObjectRecord[]
	/** Keys currently referenced by rows, from a scan of every file column. */
	referencedKeys: Iterable<string>
	minimumAgeMs?: number
	now?: () => number
}): OrphanReport {
	const referenced = new Set(input.referencedKeys)
	const now = input.now?.() ?? Date.now()
	const minimumAge = input.minimumAgeMs ?? 60 * 60 * 1000

	const orphans: FileObjectRecord[] = []
	for (const record of input.records) {
		if (referenced.has(record.key)) continue
		const age = now - Date.parse(record.createdAt)
		// An unparseable timestamp is treated as brand new, i.e. never an orphan.
		// Reporting a record for deletion because we could not read its date is
		// the wrong way to fail.
		if (!Number.isFinite(age) || age < minimumAge) continue
		orphans.push(record)
	}

	const known = new Set(input.records.map((r) => r.key))
	const danglingReferences = [...referenced].filter((k) => !known.has(k)).sort()

	return {
		orphans,
		keys: orphans.flatMap(recordKeys),
		bytes: orphans.reduce(
			(total, r) =>
				total + r.size + r.derivatives.reduce((s, d) => s + d.size, 0),
			0,
		),
		danglingReferences,
	}
}

/**
 * Collect the storage keys a set of rows references, given which columns are
 * file columns. Used to build `referencedKeys` for the report — and kept here
 * so "what counts as a reference" is defined once.
 */
export function referencedFileKeys(
	rows: readonly Record<string, unknown>[],
	fileColumns: readonly string[],
): Set<string> {
	const keys = new Set<string>()
	for (const row of rows) {
		for (const column of fileColumns) {
			const value = row[column]
			if (typeof value === 'string' && value.length > 0) keys.add(value)
		}
	}
	return keys
}
