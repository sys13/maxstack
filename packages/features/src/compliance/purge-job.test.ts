import type { PGlite } from '@electric-sql/pglite'
import { ResourceRegistry } from '@maxstack/core'
import { createDrizzleStore } from '@maxstack/core/demo'
import { bootPglite } from '@maxstack/core/testing'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryJobStore, JobQueue } from '../jobs/service.ts'
import {
	DEFAULT_RETENTION_MS,
	PURGE_JOB_TYPE,
	purgeSoftDeleted,
	schedulePurgeJob,
} from './purge-job.ts'

const note = pgTable('note', {
	id: uuid('id').primaryKey().defaultRandom(),
	authorId: text('authorId').notNull(),
	body: text('body').notNull(),
	deletedAt: timestamp('deletedAt'),
})

// Never soft-deletable — proves the purge skips resources that don't opt in.
const tag = pgTable('tag', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
})

const DDL = `
CREATE TABLE note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorId" text NOT NULL,
  body text NOT NULL,
  "deletedAt" timestamp
);
CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
`

let client: PGlite
let registry: ResourceRegistry
let store: ReturnType<typeof createDrizzleStore>

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	registry = new ResourceRegistry()
	registry.register(note, { softDelete: true })
	registry.register(tag, {})
	store = createDrizzleStore(drizzle({ client }), registry)
})

afterAll(async () => {
	await client.close()
})

describe('purgeSoftDeleted', () => {
	it('leaves a live row untouched', async () => {
		const live = await store.create('note', { authorId: 'u1', body: 'live' })
		const report = await purgeSoftDeleted({ registry, store })
		expect(report).toEqual([])
		expect(await store.get('note', live.id as string)).not.toBeNull()
	})

	it('leaves a recently soft-deleted row recoverable (within the window)', async () => {
		const recent = await store.create('note', {
			authorId: 'u1',
			body: 'recent',
		})
		await store.update('note', recent.id as string, { deletedAt: new Date() })

		const report = await purgeSoftDeleted({ registry, store })
		expect(report).toEqual([])
		expect(await store.get('note', recent.id as string)).not.toBeNull()
	})

	it('hard-deletes a soft-deleted row past the retention window', async () => {
		const stale = await store.create('note', { authorId: 'u1', body: 'stale' })
		const longAgo = new Date(Date.now() - DEFAULT_RETENTION_MS - 60_000)
		await store.update('note', stale.id as string, { deletedAt: longAgo })

		const report = await purgeSoftDeleted({ registry, store })
		expect(report).toEqual([{ resource: 'note', purged: 1 }])
		expect(await store.get('note', stale.id as string)).toBeNull()
	})

	it('honors a custom retentionMs', async () => {
		const row = await store.create('note', {
			authorId: 'u1',
			body: 'short window',
		})
		await store.update('note', row.id as string, {
			deletedAt: new Date(Date.now() - 5_000),
		})

		expect(
			await purgeSoftDeleted({ registry, store, retentionMs: 60_000 }),
		).toEqual([])
		const report = await purgeSoftDeleted({
			registry,
			store,
			retentionMs: 1_000,
		})
		expect(report).toEqual([{ resource: 'note', purged: 1 }])
	})

	it('never touches a resource without softDelete: true', async () => {
		await store.create('tag', { name: 'unrelated' })
		const report = await purgeSoftDeleted({ registry, store })
		expect(report.find((r) => r.resource === 'tag')).toBeUndefined()
	})
})

describe('schedulePurgeJob', () => {
	it('registers the purge handler on the queue and runs it on tick', async () => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		const stop = schedulePurgeJob(queue, {
			registry,
			store,
			intervalMs: 60_000,
		})

		const stale = await store.create('note', {
			authorId: 'u9',
			body: 'job-purged',
		})
		await store.update('note', stale.id as string, {
			deletedAt: new Date(Date.now() - DEFAULT_RETENTION_MS - 60_000),
		})

		await queue.enqueue({ type: PURGE_JOB_TYPE })
		await queue.tick()

		const [job] = await queue.list({ type: PURGE_JOB_TYPE })
		expect(job?.status).toBe('succeeded')
		expect(job?.result).toEqual([{ resource: 'note', purged: 1 }])
		expect(await store.get('note', stale.id as string)).toBeNull()

		stop()
	})
})
