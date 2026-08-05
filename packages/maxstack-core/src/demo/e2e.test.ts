import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	createHandler,
	deleteHandler,
	getHandler,
	getManyHandler,
	listHandler,
	updateHandler,
} from '../sprout/api.ts'
import { executeMCPTool } from '../sprout/mcp.ts'
import type { OpAuditEntry, OpContext } from '../sprout/operations.ts'
import { ResourceRegistry } from '../sprout/registry.ts'
import { author, task } from './schema.ts'
import { createDemoDb, type DemoDb } from './store.ts'

const admin = { id: 'admin', role: 'admin' }
const member = { id: 'member', role: 'member' }

let demo: DemoDb
let registry: ResourceRegistry
let ctx: OpContext

beforeAll(async () => {
	registry = new ResourceRegistry()
	registry.register(author, { access: { read: 'public' } })
	registry.register(task, {
		access: { read: 'public', delete: 'admin' },
	})
	demo = await createDemoDb(registry)
	ctx = { registry, store: demo.store, user: admin }
})

afterAll(async () => {
	await demo.client.close()
})

describe('REST API end-to-end (pglite)', () => {
	let authorId: string
	let taskId: string

	it('creates an author', async () => {
		const res = await createHandler(ctx, 'author', { name: 'Ada' })
		expect(res.status).toBe(201)
		authorId = (res.body as { id: string }).id
		expect(authorId).toBeTruthy()
	})

	it('rejects an invalid task (422 with fieldErrors)', async () => {
		const res = await createHandler(ctx, 'task', { title: '' })
		expect(res.status).toBe(422)
		expect(res.body).toHaveProperty('fieldErrors')
	})

	it('creates a task with defaults applied', async () => {
		const res = await createHandler(ctx, 'task', {
			title: 'Ship Phase 0',
			authorId,
		})
		expect(res.status).toBe(201)
		const body = res.body as { id: string; done: boolean; priority: string }
		taskId = body.id
		expect(body.done).toBe(false)
		expect(body.priority).toBe('medium')
	})

	it('lists and gets', async () => {
		const list = await listHandler(ctx, 'task')
		expect(list.status).toBe(200)
		expect((list.body as unknown[]).length).toBe(1)

		const one = await getHandler(ctx, 'task', taskId)
		expect(one.status).toBe(200)
		expect((one.body as { title: string }).title).toBe('Ship Phase 0')
	})

	it('updates', async () => {
		const res = await updateHandler(ctx, 'task', taskId, {
			done: true,
			priority: 'high',
		})
		expect(res.status).toBe(200)
		expect((res.body as { done: boolean }).done).toBe(true)
	})

	it('404s on a missing row', async () => {
		const res = await getHandler(
			ctx,
			'task',
			'00000000-0000-0000-0000-000000000000',
		)
		expect(res.status).toBe(404)
	})

	it('enforces access: member cannot delete (403)', async () => {
		const memberCtx: OpContext = { ...ctx, user: member }
		const res = await deleteHandler(memberCtx, 'task', taskId)
		expect(res.status).toBe(403)
	})

	it('admin can delete (200)', async () => {
		const res = await deleteHandler(ctx, 'task', taskId)
		expect(res.status).toBe(200)
		expect((res.body as { success: boolean }).success).toBe(true)
	})
})

describe('MCP tools end-to-end (pglite)', () => {
	it('creates, lists, and reads a task through MCP tool calls', async () => {
		const authorRes = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'create_record',
			{ resource: 'author', data: { name: 'Grace' } },
		)
		expect(authorRes.isError).toBeUndefined()
		const authorId = JSON.parse(authorRes.content[0]?.text ?? '{}').id as string

		const created = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'create_record',
			{ resource: 'task', data: { title: 'Via MCP', authorId } },
		)
		expect(created.isError).toBeUndefined()

		const listed = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'list_records',
			{ resource: 'task' },
		)
		const rows = JSON.parse(listed.content[0]?.text ?? '[]') as unknown[]
		expect(rows.length).toBe(1)
	})

	/**
	 * Issue #320 moved the resource from the tool's name into its arguments, and
	 * the old names stayed executable on purpose: a live session, a saved
	 * transcript or a script holding `create_task` should not break on the day the
	 * tool list stopped naming it. Same ops, same gate — only discovery changed.
	 */
	it('still executes the pre-#320 per-resource names', async () => {
		const created = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'create_task',
			{ title: 'Legacy name' },
		)
		expect(created.isError).toBeUndefined()
		const id = JSON.parse(created.content[0]?.text ?? '{}').id as string
		const got = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'get_task',
			{ id },
		)
		expect(JSON.parse(got.content[0]?.text ?? '{}').title).toBe('Legacy name')
	})

	it('describes one resource on demand, with its create schema', async () => {
		const res = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'describe_resources',
			{ resource: 'task' },
		)
		expect(res.isError).toBeUndefined()
		const described = JSON.parse(res.content[0]?.text ?? '{}') as {
			name: string
			actions: string[]
			createSchema: { properties: Record<string, unknown>; required: string[] }
		}
		expect(described.name).toBe('task')
		expect(described.actions).toContain('read')
		expect(Object.keys(described.createSchema.properties)).toContain('title')
		expect(described.createSchema.required).toContain('title')
	})

	it('indexes every resource the caller may touch, and no more', async () => {
		const res = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'describe_resources',
			{},
		)
		const index = JSON.parse(res.content[0]?.text ?? '{}') as {
			resources: { name: string }[]
			total: number
		}
		expect(index.resources.map((r) => r.name)).toContain('task')
		expect(index.total).toBe(index.resources.length)
	})

	it('returns a validation error result for bad input', async () => {
		const res = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'create_record',
			{ resource: 'task', data: { title: '' } },
		)
		expect(res.isError).toBe(true)
	})

	it('returns a permission error for a gated tool', async () => {
		const list = await executeMCPTool(
			{ registry, store: demo.store, user: admin },
			'list_records',
			{ resource: 'task' },
		)
		const id = (
			JSON.parse(list.content[0]?.text ?? '[]') as { id: string }[]
		)[0]?.id as string
		const res = await executeMCPTool(
			{ registry, store: demo.store, user: member },
			'delete_record',
			{ resource: 'task', id },
		)
		expect(res.isError).toBe(true)
	})
})

describe('derived values ride out of every read op', () => {
	/** A stand-in for the host's real resolver (computed fields in JS, rollups in
	 * SQL — `sprout/derived.ts` covers that half). What matters here is that the
	 * op layer calls it, so REST and MCP cannot disagree about whether a row
	 * carries its derived accessors. */
	function derivedCtx(): { ctx: OpContext; calls: string[] } {
		const calls: string[] = []
		return {
			calls,
			ctx: {
				registry,
				store: demo.store,
				user: admin,
				derived: async (resource, rows) => {
					calls.push(resource)
					return rows.map((row) => ({ ...row, taskCount: 7 }))
				},
			},
		}
	}

	let authorId: string

	beforeAll(async () => {
		const created = await createHandler(ctx, 'author', { name: 'Barbara' })
		authorId = (created.body as { id: string }).id
	})

	it('attaches them on list, get, and get-many', async () => {
		const { ctx: dctx, calls } = derivedCtx()

		const list = await listHandler(dctx, 'author')
		expect((list.body as { taskCount?: number }[])[0]?.taskCount).toBe(7)

		const one = await getHandler(dctx, 'author', authorId)
		expect((one.body as { taskCount?: number }).taskCount).toBe(7)

		const many = await getManyHandler(dctx, 'author', [authorId])
		expect((many.body as { taskCount?: number }[])[0]?.taskCount).toBe(7)

		expect(calls).toEqual(['author', 'author', 'author'])
	})

	it('attaches them to MCP tool output too — one read path, one shape', async () => {
		const { ctx: dctx } = derivedCtx()

		const listed = await executeMCPTool(dctx, 'list_records', {
			resource: 'author',
		})
		const rows = JSON.parse(listed.content[0]?.text ?? '[]') as {
			taskCount?: number
		}[]
		expect(rows[0]?.taskCount).toBe(7)

		const got = await executeMCPTool(dctx, 'get_record', {
			resource: 'author',
			id: authorId,
		})
		expect(
			(JSON.parse(got.content[0]?.text ?? '{}') as { taskCount?: number })
				.taskCount,
		).toBe(7)
	})

	it('never resolves for a row the caller cannot read', async () => {
		const { ctx: dctx, calls } = derivedCtx()
		const missing = await getHandler(
			dctx,
			'author',
			'00000000-0000-0000-0000-000000000000',
		)
		expect(missing.status).toBe(404)
		// A rollup is a query the caller has no standing to run; a 404 must not
		// spend one on their behalf.
		expect(calls).toEqual([])
	})

	it('leaves rows untouched when the host wires no resolver', async () => {
		const list = await listHandler(ctx, 'author')
		expect(
			(list.body as { taskCount?: number }[])[0]?.taskCount,
		).toBeUndefined()
	})
})

describe('audit sink — mutations are recorded (task 35)', () => {
	it('emits create/update/delete entries through the context sink', async () => {
		const events: OpAuditEntry[] = []
		const auditCtx: OpContext = {
			registry,
			store: demo.store,
			user: admin,
			audit: (e) => {
				events.push(e)
			},
		}

		const created = await createHandler(auditCtx, 'author', { name: 'Grace' })
		const id = (created.body as { id: string }).id
		await updateHandler(auditCtx, 'author', id, { name: 'Grace Hopper' })
		await deleteHandler(auditCtx, 'author', id)

		expect(events.map((e) => e.action)).toEqual(['create', 'update', 'delete'])
		expect(events.every((e) => e.resource === 'author')).toBe(true)
		expect(events.every((e) => e.resourceId === id)).toBe(true)
		expect(events.every((e) => e.userId === 'admin')).toBe(true)
		// An update records the fields it changed — the diff a history feed shows.
		expect(events[1]?.metadata).toEqual({ fields: ['name'] })
	})

	it('does not emit when a mutation is denied, and never fails on a throwing sink', async () => {
		const events: OpAuditEntry[] = []
		const created = await createHandler(
			{ registry, store: demo.store, user: admin },
			'task',
			{ title: 'gated' },
		)
		const id = (created.body as { id: string }).id

		// member can't delete task (delete: 'admin') → 403, no audit entry.
		const denied = await deleteHandler(
			{
				registry,
				store: demo.store,
				user: member,
				audit: (e) => {
					events.push(e)
				},
			},
			'task',
			id,
		)
		expect(denied.status).toBe(403)
		expect(events).toHaveLength(0)

		// A throwing sink is swallowed — the delete still succeeds (200).
		const ok = await deleteHandler(
			{
				registry,
				store: demo.store,
				user: admin,
				audit: () => {
					throw new Error('sink is down')
				},
			},
			'task',
			id,
		)
		expect(ok.status).toBe(200)
	})
})
