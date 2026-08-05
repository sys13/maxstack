/**
 * Record diffing (Plan v5 task 46) — the engine behind revision history. Task 35
 * shipped an audit *feed* (who/what/when); this turns per-revision *snapshots*
 * (before/after state) into a field-level diff and lets a prior revision be
 * restored. Pure and dependency-free: `diffRecords` compares two records into
 * added/removed/changed fields, and `buildRevisions` walks a chronological
 * snapshot list into revisions each carrying their diff against the prior state.
 */

import type { Row } from '../resource/resource-types.ts'

export type ChangeKind = 'added' | 'removed' | 'changed'

export interface FieldDiff {
	field: string
	kind: ChangeKind
	before: unknown
	after: unknown
}

/** Deep-ish equality good enough for record fields: primitives by `Object.is`,
 * everything else by stable JSON (so `{a,b}`/`{b,a}` and `[1,2]` compare right). */
function equal(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (a === null || b === null || a === undefined || b === undefined)
		return false
	if (typeof a !== 'object' && typeof b !== 'object') return false
	return stableJson(a) === stableJson(b)
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_k, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([x], [y]) =>
						x < y ? -1 : x > y ? 1 : 0,
					),
				)
			: v,
	)
}

/**
 * Field-level diff of `before` → `after`. A field only in `after` is `added`,
 * only in `before` is `removed`, present in both but unequal is `changed`.
 * `ignore` drops noise fields (timestamps, the pk) from the comparison.
 */
export function diffRecords(
	before: Row | undefined,
	after: Row | undefined,
	options: { ignore?: string[] } = {},
): FieldDiff[] {
	const ignore = new Set(options.ignore ?? [])
	const a = before ?? {}
	const b = after ?? {}
	const fields = new Set([...Object.keys(a), ...Object.keys(b)])
	const out: FieldDiff[] = []
	for (const field of fields) {
		if (ignore.has(field)) continue
		const inA = field in a
		const inB = field in b
		if (inA && !inB) {
			out.push({ field, kind: 'removed', before: a[field], after: undefined })
		} else if (!inA && inB) {
			out.push({ field, kind: 'added', before: undefined, after: b[field] })
		} else if (!equal(a[field], b[field])) {
			out.push({ field, kind: 'changed', before: a[field], after: b[field] })
		}
	}
	return out.sort((x, y) =>
		x.field < y.field ? -1 : x.field > y.field ? 1 : 0,
	)
}

/** A point-in-time snapshot of a record, plus who/when produced it. */
export interface Snapshot {
	/** Stable revision id (e.g. the audit entry id or a version number). */
	id: string
	snapshot: Row
	userId?: string
	action?: string
	/** ISO-8601 timestamp. */
	createdAt: string
}

/** A revision = a snapshot + its diff against the previous snapshot. */
export interface Revision extends Snapshot {
	/** Field changes from the previous revision (empty for the first). */
	diff: FieldDiff[]
	/** True for the earliest revision (nothing before it). */
	isFirst: boolean
}

/**
 * Turn a chronological (oldest→newest) snapshot list into revisions, each with
 * its diff against the prior. Pass `newestFirst` snapshots and set
 * `order: 'desc'` to keep them that way in the output while still diffing
 * against the correct predecessor.
 */
export function buildRevisions(
	snapshots: Snapshot[],
	options: { ignore?: string[]; order?: 'asc' | 'desc' } = {},
): Revision[] {
	const asc =
		options.order === 'desc' ? [...snapshots].reverse() : [...snapshots]
	const revisions: Revision[] = asc.map((snap, i) => {
		const prev = i > 0 ? asc[i - 1] : undefined
		return {
			...snap,
			// The first revision has no predecessor to diff against — an empty diff
			// (the component labels it "Initial version" rather than listing every
			// field as added).
			diff:
				prev === undefined
					? []
					: diffRecords(prev.snapshot, snap.snapshot, {
							ignore: options.ignore,
						}),
			isFirst: i === 0,
		}
	})
	return options.order === 'desc' ? revisions.reverse() : revisions
}
