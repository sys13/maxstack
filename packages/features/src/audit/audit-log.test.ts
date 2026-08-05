import { describe, expect, it, vi } from 'vitest'
import {
	createDrizzleAuditSink,
	createMemoryAuditSink,
	queryAuditEntries,
	type StoredAuditEntry,
} from './audit-log.ts'

describe('audit sink', () => {
	it('memory sink collects entries', async () => {
		const sink = createMemoryAuditSink()
		await sink({ userId: 'u1', action: 'test', resource: 'thing' })
		expect(sink.entries).toHaveLength(1)
		expect(sink.entries[0]?.action).toBe('test')
	})

	it('drizzle sink serializes metadata and stamps createdAt', async () => {
		const values = vi.fn().mockResolvedValue(undefined)
		const db = { insert: vi.fn().mockReturnValue({ values }) }
		const table = { name: 'audit_log' }
		const sink = createDrizzleAuditSink(db, table)

		await sink({
			userId: 'u1',
			action: 'update_member_role',
			resource: 'member',
			resourceId: 'm1',
			metadata: { organizationId: 'o1', newRole: 'admin' },
		})

		expect(db.insert).toHaveBeenCalledWith(table)
		const row = values.mock.calls[0]?.[0] as Record<string, unknown>
		expect(row.userId).toBe('u1')
		expect(row.resourceId).toBe('m1')
		expect(row.metadata).toBe('{"organizationId":"o1","newRole":"admin"}')
		expect(row.createdAt).toBeInstanceOf(Date)
	})

	it('persists orgId and sourceKey when the table has the columns', async () => {
		const values = vi.fn().mockResolvedValue(undefined)
		const db = { insert: vi.fn().mockReturnValue({ values }) }
		// A 0.3.0 `audit_log`: the two attribution columns exist, so the two facts
		// the sink already received survive the process that recorded them.
		const table = { orgId: {}, sourceKey: {} }
		const sink = createDrizzleAuditSink(db, table)

		await sink({
			userId: 'service:importer',
			action: 'create',
			resource: 'book',
			resourceId: 'b1',
			origin: 'system',
			orgId: 'org-acme',
			sourceKey: 'books.sync',
		})

		const row = values.mock.calls[0]?.[0] as Record<string, unknown>
		expect(row.orgId).toBe('org-acme')
		expect(row.sourceKey).toBe('books.sync')
	})

	it('omits the 0.3.0 columns entirely for a table that does not have them', async () => {
		const values = vi.fn().mockResolvedValue(undefined)
		const db = { insert: vi.fn().mockReturnValue({ values }) }
		const sink = createDrizzleAuditSink(db, { name: 'audit_log' })

		await sink({
			userId: 'u1',
			action: 'create',
			resource: 'book',
			orgId: 'org-acme',
			sourceKey: 'books.sync',
		})

		// Not `null` — *absent*. Naming a column a pre-0.3.0 table does not have
		// would turn every audited mutation in that deployment into a failed insert.
		const row = values.mock.calls[0]?.[0] as Record<string, unknown>
		expect('orgId' in row).toBe(false)
		expect('sourceKey' in row).toBe(false)
	})

	it('nulls the 0.3.0 columns for a write that carried neither fact', async () => {
		const values = vi.fn().mockResolvedValue(undefined)
		const db = { insert: vi.fn().mockReturnValue({ values }) }
		const sink = createDrizzleAuditSink(db, { orgId: {}, sourceKey: {} })

		await sink({ userId: 'u1', action: 'create', resource: 'book' })

		// A person's write outside any org, not recorded by a source: the columns
		// exist, so the row says so explicitly rather than leaving them unset.
		const row = values.mock.calls[0]?.[0] as Record<string, unknown>
		expect(row.orgId).toBeNull()
		expect(row.sourceKey).toBeNull()
	})

	it('drizzle sink nulls out omitted optional fields', async () => {
		const values = vi.fn().mockResolvedValue(undefined)
		const db = { insert: vi.fn().mockReturnValue({ values }) }
		const sink = createDrizzleAuditSink(db, {})

		await sink({ userId: 'u1', action: 'a', resource: 'r' })
		const row = values.mock.calls[0]?.[0] as Record<string, unknown>
		expect(row.resourceId).toBeNull()
		expect(row.metadata).toBeNull()
		expect(row.ipAddress).toBeNull()
	})
})

describe('audit read API', () => {
	const entry = (
		resource: string,
		resourceId: string,
		action: string,
	): StoredAuditEntry => ({
		userId: 'u1',
		action,
		resource,
		resourceId,
		createdAt: '2026-07-10T00:00:00.000Z',
	})

	it('queryAuditEntries filters by resource + resourceId, most-recent first', () => {
		const entries = [
			entry('task', 't1', 'create'),
			entry('task', 't2', 'create'),
			entry('task', 't1', 'update'),
		]
		const feed = queryAuditEntries(entries, {
			resource: 'task',
			resourceId: 't1',
		})
		// t1's two entries, newest (the update) first.
		expect(feed.map((e) => e.action)).toEqual(['update', 'create'])
	})

	it('an empty query returns the whole feed reversed', () => {
		const entries = [
			entry('task', 't1', 'create'),
			entry('author', 'a1', 'create'),
		]
		expect(queryAuditEntries(entries).map((e) => e.resource)).toEqual([
			'author',
			'task',
		])
	})

	it('applies limit after ordering', () => {
		const entries = [
			entry('task', 't1', 'create'),
			entry('task', 't1', 'update'),
			entry('task', 't1', 'delete'),
		]
		expect(
			queryAuditEntries(entries, { limit: 2 }).map((e) => e.action),
		).toEqual(['delete', 'update'])
	})

	it('the memory sink stamps createdAt and reads back through query', async () => {
		const sink = createMemoryAuditSink()
		await sink({
			userId: 'u1',
			action: 'create',
			resource: 'task',
			resourceId: 't1',
		})
		expect(typeof sink.entries[0]?.createdAt).toBe('string')
		const feed = await sink.query({ resource: 'task', resourceId: 't1' })
		expect(feed).toHaveLength(1)
		expect(feed[0]?.action).toBe('create')
		expect(await sink.query({ resource: 'task', resourceId: 'nope' })).toEqual(
			[],
		)
	})
})
