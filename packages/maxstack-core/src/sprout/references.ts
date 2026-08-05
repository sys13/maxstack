/**
 * Reference resolution — turn a page of rows' foreign keys into display values
 * in one batched pass (Plan v5 task 32). A list of stories carrying `authorId`
 * becomes a `{ author: { "<id>": "Ada Lovelace" } }` map the read side's
 * `<ReferenceField>` looks up, so an FK renders as the referenced record's
 * title instead of a raw uuid — and without an N+1 (one `getMany` per referenced
 * table, ids merged across every FK column that points at it).
 *
 * Kept store-agnostic: the caller (a loader) supplies `getMany`; core never
 * reaches for a driver. `displayFieldFor` fills in a target table's display
 * column when the FK itself didn't carry one (drizzle-native FKs have no
 * `meta.reference.displayField`; the spec bridge sets one).
 */

import type { Row } from './store.ts'
import type { SproutColumn, SproutResource } from './types.ts'

/** `table → (referenced id → display string)`. Serializable, so it crosses a
 * loader boundary straight into `<ResourceList>`/`<Show>`'s `references` prop. */
export type ReferenceMap = Record<string, Record<string, string>>

/** The FK columns of a resource — those carrying a `references` target. */
export function referenceColumns(resource: SproutResource): SproutColumn[] {
	return resource.columns.filter((c) => c.references)
}

/** The array-reference columns (Plan v5 task 38) — those whose `meta` names an
 * {@link SproutColumnReference} target for an array of foreign keys (`tags`). */
export function arrayReferenceColumns(
	resource: SproutResource,
): SproutColumn[] {
	return resource.columns.filter((c) => c.meta?.arrayReference)
}

/** Normalize an array-reference cell to a list of id strings. The value may be a
 * real array (drizzle `json`) or a JSON-encoded string (crossed a wire), and any
 * null/blank member is dropped. Anything unparseable yields `[]` — a bad cell
 * never throws mid-resolve. */
export function parseIdArray(value: unknown): string[] {
	let arr: unknown = value
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (trimmed === '') return []
		try {
			arr = JSON.parse(trimmed)
		} catch {
			return []
		}
	}
	if (!Array.isArray(arr)) return []
	return arr
		.filter((v) => v !== null && v !== undefined && v !== '')
		.map((v) => String(v))
}

/**
 * One declared edge pointing *at* a table — the inverse of an FK column.
 * `comment.storyId → story` read backwards is "the comments of this story",
 * which is what a detail page's related-records panel renders.
 */
export interface InverseReference {
	/** The resource whose rows point at the target table. */
	resource: string
	/** The FK column on that resource holding the target row's id. */
	column: string
	/** The column on the target the FK points at (usually its primary key). */
	targetColumn: string
}

/**
 * Every FK pointing at `table`, across `resources` — the inverse of the graph
 * {@link resolveReferences} walks forward.
 *
 * Derived, never declared: `data.setFieldReference` already states the edge, so
 * the reverse is a scan of the same grounded columns rather than a second
 * declaration that can disagree with the first. A related-records panel that
 * asks this question renders whatever the spec says today, including a relation
 * added five minutes ago, with no per-app wiring.
 *
 * **Self-references are included.** A `task.parentId → task` is a real inverse
 * ("subtasks") and the commonest one in practice; excluding it would make the
 * one relation people hand-write the one relation this cannot derive.
 *
 * Array references (`meta.arrayReference`, the many-to-many side) are *not*
 * included: their inverse is not an equality filter on a column, so the read
 * that would back it does not exist here. `<ReferenceManyToManyField>` is the
 * surface for those, and it is loader-walked.
 *
 * Order follows `resources`, then column order within a resource — stable, so
 * a panel's sections do not reshuffle between requests.
 */
export function inverseReferences(
	resources: readonly SproutResource[],
	table: string,
): InverseReference[] {
	const out: InverseReference[] = []
	for (const resource of resources) {
		for (const column of resource.columns) {
			const ref = column.references
			if (!ref || ref.table !== table) continue
			out.push({
				resource: resource.name,
				column: column.name,
				targetColumn: ref.column,
			})
		}
	}
	return out
}

export interface ReferenceFetch {
	/** Batch-fetch rows of `table` by primary key. */
	getMany(table: string, ids: string[]): Promise<Row[]>
	/** The display column for `table` when the FK didn't name one. */
	displayFieldFor?: (table: string) => string | undefined
}

interface TargetPlan {
	displayField?: string
	/** The referenced column to key the fetched rows by (usually `id`). */
	keyColumn: string
	ids: Set<string>
}

/**
 * Resolve every FK in `rows` to a display string. Groups ids by target table
 * (so two FK columns pointing at `user` share one `getMany`), fetches each
 * table once, and keys the result by the referenced column.
 */
export async function resolveReferences(
	resource: SproutResource,
	rows: readonly Row[],
	fetch: ReferenceFetch,
): Promise<ReferenceMap> {
	const plans = new Map<string, TargetPlan>()

	const planFor = (ref: SproutColumn['references'] & object): TargetPlan => {
		let plan = plans.get(ref.table)
		if (!plan) {
			plan = {
				displayField: ref.displayField ?? fetch.displayFieldFor?.(ref.table),
				keyColumn: ref.column,
				ids: new Set(),
			}
			plans.set(ref.table, plan)
		}
		return plan
	}

	// Single FKs — one id per cell.
	for (const col of referenceColumns(resource)) {
		const ref = col.references
		if (!ref) continue
		const plan = planFor(ref)
		for (const row of rows) {
			const value = row[col.name]
			if (value !== null && value !== undefined && value !== '')
				plan.ids.add(String(value))
		}
	}

	// Array references — a list of ids per cell, merged into the same table plan
	// so a `tags` array and a scalar FK to the same table share one `getMany`.
	for (const col of arrayReferenceColumns(resource)) {
		const ref = col.meta.arrayReference
		if (!ref) continue
		const plan = planFor(ref)
		for (const row of rows) {
			for (const id of parseIdArray(row[col.name])) plan.ids.add(id)
		}
	}

	const map: ReferenceMap = {}
	for (const [table, plan] of plans) {
		const fetched = await fetch.getMany(table, [...plan.ids])
		const byId: Record<string, string> = {}
		for (const row of fetched) {
			const key = String(row[plan.keyColumn])
			const display = plan.displayField ? row[plan.displayField] : undefined
			byId[key] =
				display !== null && display !== undefined && display !== ''
					? String(display)
					: key
		}
		map[table] = byId
	}
	return map
}
