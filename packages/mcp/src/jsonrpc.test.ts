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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
		surface: 'mcp',
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

/**
 * The two hosts, told apart on purpose (#353).
 *
 * `handleMcpRequest` serves both `maxstack mcp` (stdio, a child process of the
 * developer's own agent client) and `POST /mcp` (HTTP, in the generated app). It
 * is a pure function of (context, body) and can see nothing that distinguishes
 * them, so the *host* declares its own reach and the dispatcher believes it —
 * with the strict value as the default, so a host that says nothing is treated
 * as public.
 *
 * Both directions are pinned here because both are load-bearing. Redaction on
 * the network host is the fix; *no* redaction on the local one is the reason the
 * fix is a flag rather than a blanket, and a later "tidy-up" that deletes the
 * flag would break this test rather than quietly blinding every local agent.
 *
 * This file pins the *rule*. Which value each real host declares is pinned where
 * that host is built — `apps/maxstack/src/commands/mcp.test.ts` for stdio,
 * `apps/web/app/mcp.server.test.ts` for HTTP — because a rule and its two
 * applications can drift apart, and the drift is the whole bug.
 */
describe('how much an unrecognised failure says depends on the host', () => {
	/** A platform context whose spec store fails the way a filesystem does. */
	function explodingPlatform(): PlatformContext {
		const p = platform()
		return {
			...p,
			spec: {
				load: p.spec.load,
				save: () => {
					throw new Error('EACCES: permission denied, open /srv/spec/prd.ts')
				},
			},
		}
	}

	const applyOp = (ctx: McpRequestContext) =>
		handleMcpRequest(ctx, {
			jsonrpc: '2.0',
			id: 3,
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

	function toolText(body: Record<string, unknown>): string {
		const result = body.result as { content: { text: string }[] }
		return result.content.map((c) => c.text).join('\n')
	}

	beforeEach(() => {
		// The detail goes to stderr on both hosts; silencing keeps the run readable.
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("a 'local' transport keeps the detail — it is the developer, on their own machine", async () => {
		const { body } = await applyOp({
			platform: explodingPlatform(),
			exposure: 'local',
		})
		expect(toolText(body)).toContain('EACCES')
		expect(toolText(body)).toContain('/srv/spec/prd.ts')
		// Still keyed, so an id quoted from either host resolves to one log line.
		expect(toolText(body)).toMatch(/err_[a-z0-9]+/)
	})

	it('an undeclared transport withholds it — the caller is not the machine', async () => {
		// The shape `apps/web/app/routes/mcp.ts` builds: no `exposure`, because
		// `'network'` is what an unset field means.
		const { body } = await applyOp({
			platform: explodingPlatform(),
			user: sessionUser,
		})
		expect(toolText(body)).not.toContain('EACCES')
		expect(toolText(body)).not.toContain('/srv/spec/prd.ts')
		expect(toolText(body)).toMatch(/^Internal error \[err_[a-z0-9]+\]\./)
	})

	it('the detail reaches stderr either way, under the id the caller was handed', async () => {
		const stderr = vi.mocked(console.error)
		const { body } = await applyOp({ platform: explodingPlatform() })
		const errorId = /err_[a-z0-9]+/.exec(toolText(body))?.[0]
		const line = stderr.mock.calls
			.map((args) => String(args[0]))
			.find((l) => l.includes(String(errorId)))
		expect(String(line)).toContain('EACCES')
	})

	it('a refusal written for the caller survives on both hosts', async () => {
		// The other half of the boundary: `mcpFail` redacts by *class*, so a
		// message somebody composed for whoever called the tool is not collateral.
		// Without this, "unknown page" would read as "the server is broken".
		for (const ctx of [
			{ platform: platform(), exposure: 'local' as const },
			{ platform: platform(), user: sessionUser },
		]) {
			const { body } = await handleMcpRequest(ctx, {
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: {
					name: 'explain_feature',
					arguments: { pageId: 'no-such-page' },
				},
			})
			expect(toolText(body)).toContain('no-such-page')
			expect(toolText(body)).not.toContain('Internal error')
		}
	})
})
