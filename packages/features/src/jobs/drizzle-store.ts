/**
 * `createDrizzleJobStore` — the persisted `JobStore` (mirrors
 * `webhooks/service.ts` inserting straight into its own drizzle table, and
 * `audit/audit-log.ts`'s `createDrizzleAuditSink`). Kept separate from
 * `service.ts` so `JobQueue` itself never imports drizzle — the in-memory
 * store is enough to unit-test the queue/backoff/scheduler logic.
 *
 * The unique index on `idempotency_key` is deliberately **not** guarded by a
 * pre-check here: `insert` lets the violation propagate and `JobQueue.enqueue`
 * resolves it by reading the winner back. A pre-check would be a race with a
 * comfortable-looking shape — two processes can both read "absent" — and the
 * whole point of putting the claim in the database is that the database decides.
 */

import type { ScheduleRunAs } from '@maxstack/spec'
import { and, asc, desc, eq, isNotNull, lte } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import { job } from './schema.ts'
import type { JobRecord, JobStore } from './service.ts'

type Db = ReturnType<typeof drizzle>

function toRecord(row: typeof job.$inferSelect): JobRecord {
	return {
		id: row.id,
		type: row.type,
		payload: row.payload,
		status: row.status,
		attempts: row.attempts,
		maxAttempts: row.maxAttempts,
		result: row.result,
		error: row.error,
		idempotencyKey: row.idempotencyKey ?? null,
		runAs: (row.runAs as ScheduleRunAs | null) ?? null,
		scheduleKey: row.scheduleKey ?? null,
		scheduledFor: row.scheduledFor ?? null,
		deadLetteredAt: row.deadLetteredAt ?? null,
		availableAt: row.availableAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

export function createDrizzleJobStore(db: Db): JobStore {
	return {
		async insert(record) {
			await db.insert(job).values({
				id: record.id,
				type: record.type,
				payload: record.payload,
				status: record.status,
				attempts: record.attempts,
				maxAttempts: record.maxAttempts,
				result: record.result,
				error: record.error,
				idempotencyKey: record.idempotencyKey,
				runAs: record.runAs,
				scheduleKey: record.scheduleKey,
				scheduledFor: record.scheduledFor,
				deadLetteredAt: record.deadLetteredAt,
				availableAt: record.availableAt,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			})
		},
		async findByIdempotencyKey(key) {
			const rows = (await db
				.select()
				.from(job)
				.where(eq(job.idempotencyKey, key))
				.limit(1)) as (typeof job.$inferSelect)[]
			const row = rows[0]
			return row ? toRecord(row) : null
		},
		async claimNext(now) {
			const due = (await db
				.select()
				.from(job)
				.where(and(eq(job.status, 'pending'), lte(job.availableAt, now)))
				.orderBy(asc(job.createdAt))
				.limit(1)) as (typeof job.$inferSelect)[]
			const next = due[0]
			if (!next) return null
			const updatedAt = new Date()
			await db
				.update(job)
				.set({ status: 'running', updatedAt })
				.where(eq(job.id, next.id))
			return toRecord({ ...next, status: 'running', updatedAt })
		},
		async update(id, patch) {
			await db
				.update(job)
				.set(patch as Partial<typeof job.$inferInsert>)
				.where(eq(job.id, id))
		},
		async list(opts) {
			const filters = [
				opts?.type ? eq(job.type, opts.type) : undefined,
				opts?.scheduleKey ? eq(job.scheduleKey, opts.scheduleKey) : undefined,
				opts?.deadLetteredOnly ? isNotNull(job.deadLetteredAt) : undefined,
			].filter((f) => f !== undefined)
			const rows = (await db
				.select()
				.from(job)
				.where(filters.length ? and(...filters) : undefined)
				.orderBy(desc(job.createdAt))
				.limit(opts?.limit ?? 100)) as (typeof job.$inferSelect)[]
			return rows.map(toRecord)
		},
		async lastScheduledFor(scheduleKey) {
			const rows = (await db
				.select()
				.from(job)
				.where(eq(job.scheduleKey, scheduleKey))
				.orderBy(desc(job.scheduledFor))
				.limit(1)) as (typeof job.$inferSelect)[]
			return rows[0]?.scheduledFor ?? null
		},
	}
}
