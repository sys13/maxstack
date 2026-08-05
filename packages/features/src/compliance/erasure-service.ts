/**
 * GDPR erasure — hard-deletes every row `userId` owns across the
 * registered resources with a conventional owner column (see owner.ts).
 *
 * SAFETY: this is a narrowly-scoped, single-user operation by construction —
 * every delete is filtered by `[ownerField]: userId` before it ever reaches
 * the store, so there is no code path here that can touch another user's row.
 * `eraseUserData` also refuses to run unless the caller passes the same id
 * twice (`requestedBy === userId`), a cheap belt-and-suspenders check against
 * a call site accidentally wiring in an admin/session id instead of the
 * target's.
 *
 * Policy note (documented per issue #59's ask): erasure always *hard*-deletes,
 * even for a `softDelete: true` resource — a right-to-erasure request is not
 * the same action as a moderation soft-delete, and must not wait out a
 * retention window. It goes straight to `store.delete`, not `opDelete`, for
 * exactly that reason (`opDelete` would soft-delete a `softDelete` resource).
 * Full hard-erase is only wired for resources that carry a per-row owner
 * column; a resource with no owner column has no way to know which rows are
 * this user's, so it is left untouched (same scope `exportUserData` uses —
 * the two must agree on what "this user's data" means).
 */

import type { ResourceRegistry, SproutStore } from '@maxstack/core'
import {
	assertRetentionCoverage,
	collectSubjectRows,
	deletionOrder,
	type RetentionPolicy,
} from './retention.ts'

export interface EraseUserDataOptions {
	registry: ResourceRegistry
	store: SproutStore
	/**
	 * The retention classification for every registered resource.
	 * Required, and checked before a single row is touched: a deletion that
	 * silently skips a table is the exposure this feature exists to prevent.
	 */
	policies: RetentionPolicy[]
}

export interface ErasureReportEntry {
	resource: string
	erased: number
	/** Rows retained rather than deleted, because the table is on legal hold. */
	retained?: number
	/** How the rows were reached: directly owned, or via the relation graph. */
	via?: 'owner' | 'relation'
}

/** What an erasure actually did — the thing a subject is owed an answer about. */
export interface ErasureReport {
	entries: ErasureReportEntry[]
	/**
	 * Resources reached only through the relation graph. Reported because these
	 * are exactly the rows a hand-listed flow misses.
	 */
	viaRelation: string[]
	/**
	 * Tables on legal hold: the subject's identifiers were replaced with a
	 * tombstone and the record kept. See.
	 */
	pseudonymized: string[]
	/**
	 * Resources whose foreign keys form a cycle, so no safe deletion order
	 * exists. Deleted last, in registration order, and named here rather than
	 * quietly — an unverifiable ordering is a fact the caller should have.
	 */
	unorderedCycles: string[]
}

/**
 * What a pseudonymized subject identifier becomes. A constant rather than
 * `null`, so a retained audit row still reads as "somebody did this" — which is
 * what makes the trail useful — while no longer saying who.
 */
export const ERASED_SUBJECT = 'erased-subject'

export class ScopeMismatchError extends Error {
	constructor() {
		super('Erasure must be requested by the same user it targets')
		this.name = 'ScopeMismatchError'
	}
}

/**
 * Erase everything belonging to `userId`, derived from the relation graph.
 *
 * `requestedBy` must equal `userId` — see the SAFETY note above.
 *
 * Three things this does that the owner-column-only version did not:
 *
 *  - **Reaches related rows.** A `comment` on the subject's `post` is deleted
 *    even though it carries no `userId`, because it is reachable in the graph.
 *  - **Deletes in foreign-key order.** Children before parents
 *    ({@link deletionOrder}), so a delete cannot fail on a constraint and leave
 *    the erasure half-applied. A genuine cycle is deleted last and *named* in
 *    the report rather than silently attempted.
 *  - **Honors legal holds.** A table declared `legal-hold` is not deleted; its
 *    declared subject-identifier columns are overwritten with a tombstone
 * instead, so the record survives and the person does not.
 */
export async function eraseUserData(
	opts: EraseUserDataOptions,
	userId: string,
	requestedBy: string,
): Promise<ErasureReport> {
	if (requestedBy !== userId) throw new ScopeMismatchError()
	const policies = assertRetentionCoverage(opts.registry, opts.policies)
	const collected = await collectSubjectRows(
		{ registry: opts.registry, store: opts.store, policies },
		userId,
	)
	const byTable = new Map(
		opts.registry.all().map((e) => [e.resource.name, e] as const),
	)
	const { order, cycles } = deletionOrder(opts.registry)
	const sequence = [...order, ...cycles]

	const entries: ErasureReportEntry[] = []
	const pseudonymized: string[] = []
	for (const name of sequence) {
		const rows = collected.rows.get(name)
		const entry = byTable.get(name)
		if (!rows?.length || !entry) continue
		const policy = policies.get(name)
		if (policy?.class === 'operational') continue

		if (policy?.class === 'legal-hold') {
			// Retained, pseudonymized. The columns are declared, not guessed: a
			// heuristic that decides which column identifies a person is a heuristic
			// that eventually leaves one behind.
			let retained = 0
			for (const row of rows) {
				const patch: Record<string, unknown> = {}
				for (const column of policy.pseudonymize ?? [])
					if (column in row) patch[column] = ERASED_SUBJECT
				if (Object.keys(patch).length === 0) continue
				await opts.store.update(
					name,
					String(row[entry.resource.primaryKey]),
					patch,
				)
				retained++
			}
			if (retained > 0) {
				entries.push({ resource: name, erased: 0, retained })
				pseudonymized.push(name)
			}
			continue
		}

		let erased = 0
		for (const row of rows) {
			const id = String(row[entry.resource.primaryKey])
			const ok = await opts.store.delete(name, id)
			if (ok) erased += 1
		}
		if (erased > 0)
			entries.push({
				resource: name,
				erased,
				via: collected.viaRelation.includes(name) ? 'relation' : 'owner',
			})
	}

	return {
		entries,
		viaRelation: collected.viaRelation,
		pseudonymized: pseudonymized.sort(),
		unorderedCycles: cycles,
	}
}
