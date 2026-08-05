/**
 * Retention purge — the other half of soft delete
 * (`ResourceConfig.softDelete`, `@maxstack/core`'s operations.ts): a row a user
 * deleted is recoverable (`opRestore`) only *within* a retention window; past
 * it, `purgeSoftDeleted` hard-deletes it for real. `schedulePurgeJob` wires
 * that up as a recurring background job on the task-59 job queue
 * (`@maxstack/features/jobs`), so it runs off the request path.
 *
 * Goes straight to `store.delete`, not `opDelete`/`opRestore` — a maintenance
 * sweep, not a user-authorized mutation (same shape as `erasure-service.ts`).
 * `deletedAt` is the fixed column name `softDelete: true` resources are
 * expected to carry (see operations.ts's `SOFT_DELETE_FIELD`).
 */

import type { ResourceRegistry, SproutStore } from '@maxstack/core'
import { type JobQueue, scheduleInterval } from '../jobs/service.ts'

/** 30 days — a reasonable default "recoverable within a window" for a
 * demo-scale app. Override via `PurgeOptions.retentionMs`. */
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export interface PurgeOptions {
	registry: ResourceRegistry
	store: SproutStore
	/** How long a soft-deleted row stays recoverable before the purge hard-deletes
	 * it. Default {@link DEFAULT_RETENTION_MS} (30 days). */
	retentionMs?: number
}

export interface PurgeReportEntry {
	resource: string
	purged: number
}

/** One purge sweep: for every `softDelete: true` resource, hard-delete rows
 * whose `deletedAt` is older than the retention window. `now` is injectable
 * for tests. */
export async function purgeSoftDeleted(
	opts: PurgeOptions,
	now: Date = new Date(),
): Promise<PurgeReportEntry[]> {
	const cutoff = new Date(
		now.getTime() - (opts.retentionMs ?? DEFAULT_RETENTION_MS),
	)
	const report: PurgeReportEntry[] = []
	for (const entry of opts.registry.all()) {
		if (!entry.config.softDelete) continue
		// No `opList` here: a maintenance sweep must see soft-deleted rows, which
		// the ops-layer default scope hides. `store.list` sees everything.
		const rows = await opts.store.list(entry.resource.name, { limit: 10_000 })
		let purged = 0
		for (const row of rows) {
			const raw = row.deletedAt
			if (raw == null) continue
			const deletedAt = raw instanceof Date ? raw : new Date(String(raw))
			if (Number.isNaN(deletedAt.getTime()) || deletedAt > cutoff) continue
			const id = String(row[entry.resource.primaryKey])
			const ok = await opts.store.delete(entry.resource.name, id)
			if (ok) purged += 1
		}
		if (purged > 0) report.push({ resource: entry.resource.name, purged })
	}
	return report
}

/** The job type `schedulePurgeJob` registers/enqueues. Exported so a caller
 * that only wants to enqueue-once (rather than schedule) can reuse the name. */
export const PURGE_JOB_TYPE = 'compliance.purge-soft-deleted'

/** Register the purge handler on `queue` and schedule it to run every
 * `intervalMs` (default once a day). Returns a `stop()`. */
export function schedulePurgeJob(
	queue: JobQueue,
	opts: PurgeOptions & { intervalMs?: number },
): () => void {
	queue.register(PURGE_JOB_TYPE, async () => purgeSoftDeleted(opts))
	return scheduleInterval(queue, {
		type: PURGE_JOB_TYPE,
		intervalMs: opts.intervalMs ?? 24 * 60 * 60 * 1000,
	})
}
