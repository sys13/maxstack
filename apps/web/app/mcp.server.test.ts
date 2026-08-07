import type { OpContext, SproutUser } from '@maxstack/core'
import {
	createInMemorySpecStore,
	defaultCheckRunner,
	defaultGeneratorRunner,
	type PlatformContext,
} from '@maxstack/mcp'
import { newSpecSystem, type OpId } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { beforeAll, describe, expect, it } from 'vitest'
import { handleMcpRequest, type McpContext } from './mcp.server'
import { getSprout } from './sprout.server'

const admin: SproutUser = { id: 'admin', role: 'admin' }
const member: SproutUser = { id: 'member', role: 'member' }

async function ctxFor(user: SproutUser | null): Promise<OpContext> {
	const { registry, store } = await getSprout()
	return { registry, store, user }
}

let adminCtx: OpContext
let memberCtx: OpContext

beforeAll(async () => {
	adminCtx = await ctxFor(admin)
	memberCtx = await ctxFor(member)
})

describe('MCP JSON-RPC dispatch', () => {
	it('rejects a non-2.0 envelope', async () => {
		const res = await handleMcpRequest(adminCtx, {
			jsonrpc: '1.0',
			id: 1,
			method: 'initialize',
		})
		expect(res.status).toBe(400)
		expect((res.body.error as { code: number }).code).toBe(-32600)
	})

	it('initializes', async () => {
		const res = await handleMcpRequest(adminCtx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
		})
		expect(res.status).toBe(200)
		expect(res.body.result).toMatchObject({
			serverInfo: { name: 'maxstack-sprout' },
		})
	})

	it('reports an unknown method as a -32601 JSON-RPC error on HTTP 200', async () => {
		const res = await handleMcpRequest(adminCtx, {
			jsonrpc: '2.0',
			id: 2,
			method: 'nope',
		})
		// JSON-RPC "method not found" rides on HTTP 200; 404 would make clients
		// read the whole /mcp endpoint as missing and abort the connection.
		expect(res.status).toBe(200)
		expect((res.body.error as { code: number }).code).toBe(-32601)
	})

	it('accepts notifications/initialized as a no-op (202)', async () => {
		const res = await handleMcpRequest(adminCtx, {
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		})
		expect(res.status).toBe(202)
		expect(res.body.error).toBeUndefined()
	})

	it('answers ping with an empty result', async () => {
		const res = await handleMcpRequest(adminCtx, {
			jsonrpc: '2.0',
			id: 99,
			method: 'ping',
		})
		expect(res.status).toBe(200)
		expect(res.body.result).toEqual({})
	})

	/**
	 * Issue #320 made the tool list a fixed vocabulary, so the role gate no longer
	 * shows up as a missing tool *name* — it shows up in `describe_resources`,
	 * which is still computed row-lessly with the same `canPerformAction`. Member
	 * may delete a `tag` (no rule) and not a `task` (admin-only), which is exactly
	 * the fact the old `delete_task`-shaped assertion was carrying.
	 */
	it('gates discovery by role: admin may delete a task, member may not', async () => {
		const describe = async (ctx: OpContext) => {
			const res = await handleMcpRequest(ctx, {
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'describe_resources', arguments: { resource: 'task' } },
			})
			return JSON.parse(
				(res.body.result as { content: { text: string }[] }).content[0]?.text ??
					'{}',
			) as { actions: string[] }
		}
		expect((await describe(adminCtx)).actions).toContain('delete')
		expect((await describe(memberCtx)).actions).not.toContain('delete')
		expect((await describe(memberCtx)).actions).toContain('read')
	})

	it('lists a bounded vocabulary rather than one tool per resource', async () => {
		const res = await handleMcpRequest(adminCtx, {
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/list',
		})
		const names = (res.body.result as { tools: { name: string }[] }).tools.map(
			(t) => t.name,
		)
		expect(names).toContain('describe_resources')
		expect(names).toContain('list_records')
		expect(names.some((n) => n.endsWith('_task'))).toBe(false)
	})

	it('executes a create then list through tools/call', async () => {
		const created = await handleMcpRequest(adminCtx, {
			jsonrpc: '2.0',
			id: 5,
			method: 'tools/call',
			params: {
				name: 'create_record',
				arguments: { resource: 'author', data: { name: 'Grace Hopper' } },
			},
		})
		const createResult = created.body.result as {
			isError?: boolean
			content: { text: string }[]
		}
		expect(createResult.isError).toBeUndefined()

		const listed = await handleMcpRequest(adminCtx, {
			jsonrpc: '2.0',
			id: 6,
			method: 'tools/call',
			params: { name: 'list_records', arguments: { resource: 'author' } },
		})
		const rows = JSON.parse(
			(listed.body.result as { content: { text: string }[] }).content[0]
				?.text ?? '[]',
		) as unknown[]
		expect(rows.length).toBeGreaterThanOrEqual(1)
	})

	it('surfaces a permission error as a tool-level isError result', async () => {
		const list = await handleMcpRequest(memberCtx, {
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'list_records', arguments: { resource: 'task' } },
		})
		const id = (
			JSON.parse(
				(list.body.result as { content: { text: string }[] }).content[0]
					?.text ?? '[]',
			) as { id: string }[]
		)[0]?.id
		const res = await handleMcpRequest(memberCtx, {
			jsonrpc: '2.0',
			id: 8,
			method: 'tools/call',
			params: {
				name: 'delete_record',
				arguments: { resource: 'task', id },
			},
		})
		// JSON-RPC call succeeds; the tool result carries the failure.
		expect(res.status).toBe(200)
		expect((res.body.result as { isError?: boolean }).isError).toBe(true)
	})
})

describe('platform tools merged into the same surface', () => {
	function platformCtx(): PlatformContext {
		let n = 0
		return {
			spec: createInMemorySpecStore(newSpecSystem(tasklyPRD)),
			generators: defaultGeneratorRunner(),
			checks: defaultCheckRunner(),
			origin: 'ai',
			surface: 'mcp',
			now: () => '2026-07-09',
			nextOpId: () => `op-${++n}` as OpId,
		}
	}

	async function withPlatform(): Promise<McpContext> {
		const { registry, store } = await getSprout()
		return { registry, store, user: admin, platform: platformCtx() }
	}

	it('lists Sprout CRUD and platform tools together', async () => {
		const res = await handleMcpRequest(await withPlatform(), {
			jsonrpc: '2.0',
			id: 10,
			method: 'tools/list',
		})
		const names = (res.body.result as { tools: { name: string }[] }).tools.map(
			(t) => t.name,
		)
		expect(names).toContain('list_records') // Sprout
		expect(names).toContain('query_spec') // platform
	})

	it('omits platform tools when no platform context is present', async () => {
		const res = await handleMcpRequest(adminCtx, {
			jsonrpc: '2.0',
			id: 11,
			method: 'tools/list',
		})
		const names = (res.body.result as { tools: { name: string }[] }).tools.map(
			(t) => t.name,
		)
		expect(names).not.toContain('query_spec')
	})

	it('routes a platform tool call to the platform executor', async () => {
		const res = await handleMcpRequest(await withPlatform(), {
			jsonrpc: '2.0',
			id: 12,
			method: 'tools/call',
			params: { name: 'query_spec', arguments: { section: 'summary' } },
		})
		const data = JSON.parse(
			(res.body.result as { content: { text: string }[] }).content[0]?.text ??
				'{}',
		) as { title: string }
		expect(data.title).toContain('Taskly')
	})

	it('a save-time throw becomes a tool-level isError, never an HTTP 500', async () => {
		// The original bug path: a valid op whose persistence rejects. Before the
		// fix this rejection escaped handleMcpRequest and surfaced as a raw 500.
		const ctx = await withPlatform()
		if (ctx.platform) {
			const inner = ctx.platform.spec
			ctx.platform.spec = {
				load: inner.load,
				save: async () => {
					throw new Error('spec store exploded')
				},
			}
		}
		const res = await handleMcpRequest(ctx, {
			jsonrpc: '2.0',
			id: 13,
			method: 'tools/call',
			params: {
				name: 'apply_spec_change',
				arguments: {
					op: 'pricing.addTier',
					args: {
						tier: { id: 'tr-x', name: 'X', priceMonthly: 1, features: [] },
					},
				},
			},
		})
		expect(res.status).toBe(200)
		const result = res.body.result as {
			isError?: boolean
			content: { text: string }[]
		}
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('spec store exploded')
	})
})
