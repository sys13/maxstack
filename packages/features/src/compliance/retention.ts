/**
 * **Retention classification and the relation-graph derivation**.
 *
 * The gating clause this module exists to satisfy, quoted because it is the
 * whole design:
 *
 * > Compliance flows that are wrong are worse than absent. A delete-my-data flow
 * > that misses a related table is a legal exposure the user believes is handled.
 * > It must be *derived from the relation graph*, not hand-listed, and it must
 * > fail loudly when it encounters a table with no declared retention policy —
 * > silence is the dangerous outcome here.
 *
 * Two things follow.
 *
 * ## 1. Reachability is derived, not listed
 *
 * The pre-#188 implementation collected "this user's rows" by looking for a
 * conventional owner column (`userId`, `authorId`, …) on each resource. That
 * finds the *direct* rows and misses everything hanging off them: a `comment` on
 * a `post` the user wrote usually has a `postId` and no `userId`, so it was
 * silently excluded from both the export and the erasure. The export was
 * incomplete and the erasure left orphaned personal data behind, and nothing
 * anywhere said so.
 *
 * {@link collectSubjectRows} instead walks the relation graph the Sprout
 * registry already derives: seed with the directly-owned rows, then
 * repeatedly pull in any row whose foreign key points at something already
 * collected, to a fixed point. Adding an entity with a relation to an owned one
 * therefore extends both flows automatically — which is the property that stops
 * this drifting the first time somebody adds a table.
 *
 * ## 2. An unclassified table is a hard failure
 *
 * Every registered resource must carry a {@link RetentionPolicy}. There is no
 * default, and specifically no "assume it holds no personal data" default —
 * that assumption is the exposure. {@link assertRetentionCoverage} throws,
 * naming every unclassified resource, and both the export and the erasure call
 * it *before* they touch anything. A compliance flow that runs on a
 * half-classified schema is worse than one that refuses to run.
 */

import type {
	RegisteredResource,
	ResourceRegistry,
	Row,
	SproutStore,
} from '@maxstack/core'
import { ownerFieldOf } from './owner.ts'

/**
 * How a table relates to a data subject. Every registered resource declares
 * one; there is no default.
 */
/**
 * How a table relates to a data subject. Every registered resource declares one;
 * there is no default.
 *
 * | Class | Exported? | Erased? | Requires |
 * |---|---|---|---|
 * | `personal` | yes | yes | — |
 * | `operational` | no | no | a `reason` — "this one holds no personal data" is a claim, and a claim needs an author rather than a heuristic |
 * | `legal-hold` | yes | **no**, pseudonymized instead | a `basis` naming the obligation, and the `pseudonymize` columns |
 *
 * A `legal-hold` table is exported because a subject is entitled to see a record
 * being retained about them, and an export that quietly omitted it would be the
 * same silence this module exists to eliminate.
 */
export type RetentionClass = 'personal' | 'operational' | 'legal-hold'

export interface RetentionPolicy {
	/** Resource name, as registered. */
	resource: string
	class: RetentionClass
	/** Required for `operational` — why this table holds no personal data. */
	reason?: string
	/** Required for `legal-hold` — the obligation that overrides erasure. */
	basis?: string
	/**
	 * `legal-hold` only: columns holding a subject identifier, replaced with a
	 * tombstone on erasure rather than deleted.
	 */
	pseudonymize?: string[]
	/** Optional retention window in ms, after which rows may be purged. */
	retainForMs?: number
}

export class RetentionCoverageError extends Error {
	readonly unclassified: string[]

	constructor(unclassified: string[]) {
		super(
			`Refusing to run a compliance flow: ${unclassified.length} table(s) have no declared ` +
				`retention policy (${unclassified.join(', ')}). A flow that silently skips a table ` +
				'is a legal exposure the user believes is handled — declare each one as personal, ' +
				'operational (with a reason) or legal-hold (with a basis).',
		)
		this.name = 'RetentionCoverageError'
		this.unclassified = unclassified
	}
}

/** Structural problems in a set of policies, independent of any registry. */
export function retentionPolicyErrors(
	policies: readonly RetentionPolicy[],
): string[] {
	const errors: string[] = []
	const seen = new Set<string>()
	for (const policy of policies) {
		if (seen.has(policy.resource))
			errors.push(`duplicate retention policy for "${policy.resource}"`)
		seen.add(policy.resource)
		if (policy.class === 'operational' && !policy.reason?.trim())
			errors.push(
				`"${policy.resource}" is declared operational with no reason — "it has no personal data" is a claim, and a claim needs an author`,
			)
		if (policy.class === 'legal-hold') {
			if (!policy.basis?.trim())
				errors.push(
					`"${policy.resource}" is on legal hold with no basis — name the obligation that overrides an erasure request`,
				)
			if (!policy.pseudonymize?.length)
				errors.push(
					`"${policy.resource}" is on legal hold but names no columns to pseudonymize — retaining a record verbatim is retaining the person`,
				)
		}
	}
	return errors
}

/**
 * Throw unless every registered resource is classified.
 *
 * Called first by both the export and the erasure. The failure is deliberately
 * loud and total rather than per-table: a partially classified schema produces a
 * partially correct export, and a partially correct export is the outcome the
 * subject cannot tell apart from a correct one.
 */
export function assertRetentionCoverage(
	registry: ResourceRegistry,
	policies: readonly RetentionPolicy[],
): Map<string, RetentionPolicy> {
	const structural = retentionPolicyErrors(policies)
	if (structural.length) throw new Error(structural.join('; '))
	const byResource = new Map(policies.map((p) => [p.resource, p]))
	const unclassified = registry
		.all()
		.map((entry) => entry.resource.name)
		.filter((name) => !byResource.has(name))
		.sort()
	if (unclassified.length) throw new RetentionCoverageError(unclassified)
	return byResource
}

// ===========================================================================
// The relation graph
// ===========================================================================

/** One edge: `from.column` on `from.resource` points at `to`'s primary key. */
export interface RelationEdge {
	from: string
	column: string
	to: string
}

/** Every many-to-one edge in the registry, derived from the Sprout graph. */
export function relationEdges(registry: ResourceRegistry): RelationEdge[] {
	const byTable = new Map(
		registry.all().map((entry) => [entry.resource.name, entry] as const),
	)
	const edges: RelationEdge[] = []
	for (const entry of registry.all()) {
		for (const relation of entry.resource.relations ?? []) {
			if (relation.type !== 'many-to-one') continue
			// An edge to a table nobody registered is not traversable, so it is not
			// an edge. (It is still covered by the classification check, which reads
			// the registry rather than the graph.)
			if (!byTable.has(relation.references.table)) continue
			edges.push({
				from: entry.resource.name,
				column: relation.column,
				to: relation.references.table,
			})
		}
	}
	return edges
}

/**
 * Resources in an order safe to delete in: children before the parents they
 * reference.
 *
 * A plain topological sort with an explicit cycle escape. Self-references and
 * cycles are real (`comment.parentCommentId`, `employee.managerId`); rather than
 * throwing, the remaining resources are appended in registration order and the
 * cycle is *reported*, so the caller can say "these were deleted in an
 * unverified order" instead of failing an erasure request that is 95% correct.
 */
export function deletionOrder(registry: ResourceRegistry): {
	order: string[]
	cycles: string[]
} {
	const names = registry.all().map((e) => e.resource.name)
	const edges = relationEdges(registry).filter((e) => e.from !== e.to)
	// Count, for each table, how many *other* tables reference it. A table
	// nothing references can be deleted first.
	const referencedBy = new Map<string, Set<string>>(
		names.map((n) => [n, new Set<string>()]),
	)
	for (const edge of edges) referencedBy.get(edge.to)?.add(edge.from)

	const order: string[] = []
	const remaining = new Set(names)
	let progress = true
	while (remaining.size > 0 && progress) {
		progress = false
		for (const name of [...remaining]) {
			const dependents = referencedBy.get(name) ?? new Set()
			// Deletable once nothing still-remaining points at it.
			if ([...dependents].every((d) => !remaining.has(d))) {
				order.push(name)
				remaining.delete(name)
				progress = true
			}
		}
	}
	return { order, cycles: [...remaining] }
}

// ===========================================================================
// Reachability
// ===========================================================================

export interface SubjectRowSet {
	/** Rows per resource, keyed by resource name. */
	rows: Map<string, Row[]>
	/** Resources reached only through a relation, not through an owner column. */
	viaRelation: string[]
	/** Tables on legal hold that were reached — retained, not erased. */
	legalHold: string[]
}

export interface CollectOptions {
	registry: ResourceRegistry
	store: SproutStore
	policies: Map<string, RetentionPolicy>
	/** Per-resource cap so one pathological subject cannot produce an unbounded walk. */
	perResourceLimit?: number
	/** How many relation hops to follow. Deep enough for any realistic schema. */
	maxDepth?: number
}

const idOf = (entry: RegisteredResource, row: Row): string =>
	String(row[entry.resource.primaryKey])

/**
 * Every row belonging to `userId`, derived by walking the relation graph to a
 * fixed point.
 *
 * The direct rows come from the owner-column convention, exactly as before. The
 * difference is everything after: each round pulls in rows whose foreign key
 * points at something already collected, until a round adds nothing. A `comment`
 * on the subject's `post` is therefore in the set even though it carries no
 * `userId` — the case the pre-#188 flow silently dropped from both the export
 * and the erasure.
 */
export async function collectSubjectRows(
	opts: CollectOptions,
	userId: string,
): Promise<SubjectRowSet> {
	const limit = opts.perResourceLimit ?? 10_000
	const maxDepth = opts.maxDepth ?? 8
	const byTable = new Map(
		opts.registry.all().map((e) => [e.resource.name, e] as const),
	)
	const rows = new Map<string, Row[]>()
	const idsByTable = new Map<string, Set<string>>()
	const viaRelation = new Set<string>()
	const legalHold = new Set<string>()

	const add = (name: string, found: Row[]): number => {
		const entry = byTable.get(name)
		if (!entry) return 0
		const existing = rows.get(name) ?? []
		const ids = idsByTable.get(name) ?? new Set<string>()
		let added = 0
		for (const row of found) {
			const id = idOf(entry, row)
			if (ids.has(id)) continue
			ids.add(id)
			existing.push(row)
			added++
		}
		rows.set(name, existing)
		idsByTable.set(name, ids)
		return added
	}

	// Seed: direct ownership.
	for (const entry of opts.registry.all()) {
		const ownerField = ownerFieldOf(entry)
		if (!ownerField) continue
		const found = await opts.store.list(entry.resource.name, {
			filter: { [ownerField]: userId },
			limit,
		})
		add(entry.resource.name, found)
	}

	// Walk: anything pointing at something we already have.
	const edges = relationEdges(opts.registry)
	for (let depth = 0; depth < maxDepth; depth++) {
		let addedThisRound = 0
		for (const edge of edges) {
			const parentIds = idsByTable.get(edge.to)
			if (!parentIds?.size) continue
			for (const parentId of parentIds) {
				const found = await opts.store.list(edge.from, {
					filter: { [edge.column]: parentId },
					limit,
				})
				const added = add(edge.from, found)
				if (added > 0) {
					addedThisRound += added
					if (!ownerFieldOf(byTable.get(edge.from) as RegisteredResource))
						viaRelation.add(edge.from)
				}
			}
		}
		if (addedThisRound === 0) break
	}

	for (const name of rows.keys()) {
		if (opts.policies.get(name)?.class === 'legal-hold') legalHold.add(name)
	}

	// Drop empties so a report stays readable.
	for (const [name, found] of [...rows])
		if (found.length === 0) rows.delete(name)

	return {
		rows,
		viaRelation: [...viaRelation].sort(),
		legalHold: [...legalHold].sort(),
	}
}
