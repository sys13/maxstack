/**
 * GDPR export — walks every registered resource that has a
 * conventional owner column (see owner.ts), pulls the rows belonging to one
 * user, and produces a single JSON-serializable dump. Goes straight to the
 * `SproutStore`, not through `opList` — an export is a data-subject right, not
 * a normal authorized read, and it deliberately includes soft-deleted rows
 * (still the user's data until the retention window purges them, see
 * `purge-job.ts`) which the ops-layer read path would otherwise filter out.
 *
 * `extra` is an escape hatch for data this module doesn't own — the account
 * record, sessions, audit history, consent — so this stays free of a direct
 * dependency on `@maxstack/features/auth` or `/audit`; the caller (settings
 * route) already has that data and just folds it in.
 */

import type { ResourceRegistry, Row, SproutStore } from '@maxstack/core'
import {
	assertRetentionCoverage,
	collectSubjectRows,
	type RetentionPolicy,
} from './retention.ts'

export interface GdprExportOptions {
	registry: ResourceRegistry
	store: SproutStore
	/**
	 * The retention classification for every registered resource.
	 * Required: an export that runs against a half-classified schema produces a
	 * partially correct dump, which the subject cannot tell apart from a correct
	 * one. {@link assertRetentionCoverage} throws before anything is read.
	 */
	policies: RetentionPolicy[]
	/** Per-resource cap so one pathological owner can't produce an unbounded
	 * export; generous for a demo-scale app. */
	perResourceLimit?: number
}

export interface GdprExport {
	userId: string
	exportedAt: string
	/** Owned rows keyed by resource name. A resource with zero owned rows is
	 * omitted (not an empty array) so the dump stays compact. */
	resources: Record<string, Row[]>
	/** Non-resource data the caller folded in (account, sessions, audit, consent). */
	extra?: Record<string, unknown>
	/**
	 * Resources reached only by traversing the relation graph — rows the
	 * owner-column convention alone would have missed. Reported so
	 * "completeness" is a visible property of a given export rather than a claim
	 * about the code.
	 */
	viaRelation: string[]
	/** Resources on legal hold: included here, and retained on erasure. */
	legalHold: string[]
}

/**
 * Export every row belonging to `userId`, derived from the relation graph, plus
 * whatever the caller passes as `extra`.
 *
 * Refuses to run against a schema with any unclassified table — see
 * {@link assertRetentionCoverage}. `legal-hold` tables are *included*: the
 * subject has a right to see a record that is being retained about them, even
 * though the erasure will not delete it.
 */
export async function exportUserData(
	opts: GdprExportOptions,
	userId: string,
	extra?: Record<string, unknown>,
): Promise<GdprExport> {
	const policies = assertRetentionCoverage(opts.registry, opts.policies)
	const collected = await collectSubjectRows(
		{
			registry: opts.registry,
			store: opts.store,
			policies,
			perResourceLimit: opts.perResourceLimit,
		},
		userId,
	)
	const resources: Record<string, Row[]> = {}
	for (const [name, rows] of collected.rows) {
		// An operational table holds no personal data by declaration, so exporting
		// it would be exporting somebody's schema rather than their data.
		if (policies.get(name)?.class === 'operational') continue
		resources[name] = rows
	}
	return {
		userId,
		exportedAt: new Date().toISOString(),
		resources,
		extra,
		viaRelation: collected.viaRelation,
		legalHold: collected.legalHold,
	}
}
