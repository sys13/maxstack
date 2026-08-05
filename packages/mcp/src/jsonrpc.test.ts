/**
 * JSON-RPC dispatch — specifically, who is allowed to reach the *platform*
 * (spec-authoring) tools.
 *
 * The Sprout half of the surface is scope-gated in the permission layer, which
 * `executePlatformTool` never reaches: a spec op has no resource to authorize
 * against. So an api key scoped to `order: read` could rewrite the project's
 * schema through `apply_spec_change` — not an escalation past its *holder*
 * (a session with any role can do the same), but far outside the scope its
 * holder agreed to when they issued it. Found by driving a read-only key at a
 * running `/mcp`, not by reading the code.
 */

import type { SproutUser } from '@maxstack/core'
import { newSpecSystem, type OpId } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { defaultCheckRunner } from './checks.ts'
import type { PlatformContext } from './context.ts'
import { defaultGeneratorRunner } from './generators.ts'
import { handleMcpRequest, type McpRequestContext } from './jsonrpc.ts'
import { createInMemorySpecStore } from './spec-store.ts'

function platform(): PlatformContext {
	let n = 0
	return {
		spec: createInMemorySpecStore(newSpecSystem(tasklyPRD)),
		generators: defaultGeneratorRunner(),
		checks: defaultCheckRunner(),
		origin: 'ai',
		now: () => '2026-07-09',
		nextOpId: () => `op-${++n}` as OpId,
	}
}

const apiKeyUser: SproutUser = {
	id: 'u-1',
	role: 'admin',
	apiKeyId: 'key-1',
	origin: 'api-key',
	apiKeyScope: { order: ['read'] },
}

const sessionUser: SproutUser = { id: 'u-1', role: 'member' }

const list = (ctx: McpRequestContext) =>
	handleMcpRequest(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' })

const call = (ctx: McpRequestContext, name: string) =>
	handleMcpRequest(ctx, {
		jsonrpc: '2.0',
		id: 2,
		method: 'tools/call',
		params: { name, arguments: {} },
	})

function toolNames(body: Record<string, unknown>): string[] {
	const result = body.result as { tools: { name: string }[] }
	return result.tools.map((t) => t.name)
}

describe('platform tools and api-key identities', () => {
	it('are offered to a session, including a plain member', async () => {
		const { body } = await list({ platform: platform(), user: sessionUser })
		expect(toolNames(body)).toContain('apply_spec_change')
	})

	it('are offered when there is no identity at all (the stdio host)', async () => {
		const { body } = await list({ platform: platform() })
		expect(toolNames(body)).toContain('apply_spec_change')
	})

	it('are not listed for an api-key identity', async () => {
		const { body } = await list({ platform: platform(), user: apiKeyUser })
		expect(toolNames(body)).toEqual([])
	})

	it('are refused by name when an api-key identity calls one anyway', async () => {
		// Absence from tools/list is discovery, not enforcement — a client that
		// already knows the name must still be refused.
		const { body } = await call(
			{ platform: platform(), user: apiKeyUser },
			'apply_spec_change',
		)
		const result = body.result as {
			isError?: boolean
			content: { text: string }[]
		}
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('cannot be scoped')
	})

	it('the same call from a session is not refused for that reason', async () => {
		const { body } = await call(
			{ platform: platform(), user: sessionUser },
			'apply_spec_change',
		)
		const result = body.result as {
			isError?: boolean
			content: { text: string }[]
		}
		// It fails on its (empty) arguments, which is a different failure — the
		// point is that the identity was not the reason.
		expect(result.content[0]?.text).not.toContain('cannot be scoped')
	})
})
