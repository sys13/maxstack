/**
 * JSON-RPC 2.0 dispatch over the maxstack MCP surface. A pure function of
 * (context, request body) — every transport is a thin adapter over it:
 *   - **HTTP** — `apps/web/app/routes/mcp.ts` parses the body, maps `status`.
 *   - **stdio** — `maxstack mcp` (the CLI) reads newline-delimited JSON on
 *     stdin and writes responses to stdout.
 *
 * The surface is two layers merged into one tool list:
 *   - **Sprout CRUD** (@maxstack/core) — RBAC-gated per-resource tools; discovery
 *     (`tools/list`) is row-less, execution (`tools/call`) re-authorizes with the
 *     fetched row. Needs a live registry + store, so it is **optional**: the
 *     stdio transport serves a project on disk with no database open.
 *   - **Platform tools** (@maxstack/mcp) — spec ops, generators, checks, docs
 *     (§3-L3), present when the context carries a {@link PlatformContext}. These
 *     are pure spec-file operations and need no server.
 * A tool name routes to the platform executor iff it's a platform tool, else to
 * Sprout. This file only speaks the wire protocol.
 */

import {
	executeMCPTool,
	generateMCPTools,
	type McpExposure,
	type McpToolResult,
	mcpFail,
	type OpContext,
	type SproutUser,
} from '@maxstack/core'
import { argErrors } from './args.ts'
import type { PlatformContext } from './context.ts'
import { PlatformToolError } from './errors.ts'
import { executePlatformTool, isPlatformTool, platformTools } from './tools.ts'

export const MCP_PROTOCOL_VERSION = '2024-11-05'

/**
 * What {@link handleMcpRequest} needs — **both halves optional**, because the
 * two hosts carry different ones. The web server has a registry + store + user
 * (Sprout CRUD) *and* a platform context; the CLI's stdio server has only the
 * platform context, since spec ops never touch the database.
 *
 * Deliberately wider than {@link McpContext}: a host that genuinely has the
 * Sprout half should keep the strong type for its own internals and merely pass
 * it in here.
 */
export type McpRequestContext = Partial<OpContext> & {
	platform?: PlatformContext
	/**
	 * How reachable this transport is — see {@link McpExposure} for what the two
	 * values mean and why the default is the strict one.
	 *
	 * It is a field on the *context* rather than something inferred here because
	 * the dispatcher genuinely cannot tell: `handleMcpRequest` is a pure function
	 * of (context, body), which is exactly what lets one implementation serve both
	 * hosts, and neither the body nor the halves of the context that are wired say
	 * anything about who is on the other end. Only the host knows, so only the
	 * host may say — and a host that says nothing is treated as public (#353).
	 *
	 * Today: `maxstack mcp` (stdio, a child process of the developer's own agent
	 * client) declares `'local'`; `POST /mcp` in the web app leaves it unset and
	 * therefore gets `'network'`.
	 */
	exposure?: McpExposure
}

/**
 * A host with the full Sprout data layer wired (the web server). Assignable to
 * {@link McpRequestContext}.
 */
export type McpContext = OpContext & { platform?: PlatformContext }

/**
 * May this identity reach the platform (spec-authoring) tools?
 *
 * Everyone may, **except an api-key identity**. The platform tools rewrite the
 * project's own specification — `apply_spec_change` adds entities and fields —
 * and an api key is scoped in the vocabulary of *data*: resource plus CRUD
 * action. There is no way to spell "and it may also restructure the app", which
 * means there is no way for someone issuing a key to consent to it. A key
 * described in its own UI as "read `order`, nothing else" being able to add a
 * column to `order` is not a scope anyone chose.
 *
 * Found by driving a read-only key at the real `/mcp` endpoint: the scope check
 * lives in the permission layer, and `executePlatformTool` is the one path that
 * never reaches it, because a spec op has no resource to authorize against.
 *
 * The blunt refusal is deliberate rather than a scope entry like
 * `{"spec": ["update"]}`: spec authoring is not one permission, it is the whole
 * op vocabulary, and modelling it as a fifth CRUD verb would be a claim of
 * granularity that does not exist. Agents that author specs drive MCP through
 * `maxstack dev` locally, not through an integration credential.
 */
function mayUsePlatformTools(user: SproutUser | null | undefined): boolean {
	return !user?.apiKeyScope
}

export interface JsonRpcRequest {
	jsonrpc?: unknown
	id?: unknown
	method?: unknown
	params?: unknown
}

export interface JsonRpcResponse {
	/** HTTP status for the HTTP transport; `202` means "notification, no reply"
	 * — the stdio transport writes nothing for it. */
	status: number
	body: Record<string, unknown>
}

function result(id: unknown, value: unknown): JsonRpcResponse {
	return {
		status: 200,
		body: { jsonrpc: '2.0', id: id ?? null, result: value },
	}
}

function error(
	id: unknown,
	code: number,
	message: string,
	status: number,
): JsonRpcResponse {
	return {
		status,
		body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
	}
}

export async function handleMcpRequest(
	ctx: McpRequestContext,
	body: JsonRpcRequest,
): Promise<JsonRpcResponse> {
	if (body.jsonrpc !== '2.0') {
		return error(body.id, -32600, 'Invalid Request: jsonrpc must be "2.0"', 400)
	}

	// Notifications (`notifications/*`, e.g. the `notifications/initialized` every
	// client sends right after `initialize`) are id-less fire-and-forget messages:
	// accept them as no-ops with HTTP 202 and no JSON-RPC response body. Routing
	// them into the dispatch below would 404 and abort the client handshake.
	if (
		typeof body.method === 'string' &&
		body.method.startsWith('notifications/')
	) {
		return { status: 202, body: {} }
	}

	switch (body.method) {
		case 'initialize':
			return result(body.id, {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: 'maxstack-sprout', version: '0.0.0' },
			})

		case 'ping':
			return result(body.id, {})

		case 'tools/list': {
			// Sprout CRUD only when a registry is wired; the stdio host has none.
			const tools = ctx.registry
				? await generateMCPTools(ctx.registry, ctx.user ?? null)
				: []
			if (ctx.platform && mayUsePlatformTools(ctx.user)) {
				tools.push(...platformTools(ctx.platform))
			}
			return result(body.id, { tools })
		}

		case 'tools/call': {
			const params = (body.params ?? {}) as {
				name?: unknown
				arguments?: unknown
			}
			if (typeof params.name !== 'string') {
				return error(body.id, -32602, 'Invalid params: name is required', 400)
			}
			const args = (params.arguments ?? {}) as Record<string, unknown>
			// Unset means public. See `McpRequestContext.exposure`.
			const exposure: McpExposure = ctx.exposure ?? 'network'
			let toolResult: McpToolResult
			try {
				if (ctx.platform && isPlatformTool(params.name)) {
					if (!mayUsePlatformTools(ctx.user)) {
						// Named, not a generic denial: the caller is holding a credential
						// that cannot express this, and should go get a session rather
						// than retry.
						throw new PlatformToolError(
							`Permission denied: "${params.name}" authors the project spec, ` +
								'which an API key cannot be scoped for. Use a signed-in ' +
								'session (or `maxstack dev` locally) for spec changes.',
						)
					}
					toolResult = await executePlatformTool(
						ctx.platform,
						params.name,
						args,
						exposure,
					)
				} else if (ctx.registry && ctx.store) {
					// The same refuse-rather-than-default boundary the platform half
					// runs, over the schemas Sprout already publishes. One
					// rule, both halves — an agent should not have to learn that a
					// missing argument means different things depending on which tool
					// list the name came from.
					const schema = (
						await generateMCPTools(ctx.registry, ctx.user ?? null)
					).find((t) => t.name === params.name)?.inputSchema
					const bad = schema ? argErrors(schema, args) : []
					if (bad.length > 0)
						throw new PlatformToolError(`${params.name}: ${bad.join(' ')}`)
					toolResult = await executeMCPTool(
						{
							...ctx,
							registry: ctx.registry,
							store: ctx.store,
							user: ctx.user ?? null,
						},
						params.name,
						args,
						exposure,
					)
				} else {
					// No Sprout half wired (the stdio host): a non-platform name can't
					// be served here. Say why, rather than throwing a null-deref — the
					// per-resource CRUD tools only exist while `maxstack dev` runs.
					throw new PlatformToolError(
						`Unknown tool "${params.name}". This server exposes the platform ` +
							`tools only; per-resource CRUD tools require a running ` +
							`\`maxstack dev\`.`,
					)
				}
			} catch (e) {
				// A throwing tool is a tool-level failure the client can act on —
				// never let it escape to the route and become a raw HTTP 500.
				//
				// The three throws above are ours and are addressed to the caller, so
				// they carry `PlatformToolError` and come back verbatim. Anything
				// *else* arriving here escaped an executor's own boundary — a registry
				// that threw while listing schemas, a store built per request — and is
				// the unknown class `mcpFail` exists for: over a network transport it
				// becomes a correlation id, never a driver string (#353). Tool-level
				// `isError` either way, because a JSON-RPC-level error makes clients
				// report the whole endpoint as broken rather than this one call.
				toolResult =
					e instanceof PlatformToolError
						? { content: [{ type: 'text', text: e.message }], isError: true }
						: mcpFail(
								e,
								{ resource: params.name, operation: 'tools/call' },
								exposure,
							)
			}
			// A tool-level error is a successful JSON-RPC call carrying isError.
			return result(body.id, toolResult)
		}

		default:
			// Unknown method is a JSON-RPC-level error, not a missing HTTP endpoint:
			// it must ride on HTTP 200 with the error in the body. Returning 404 here
			// makes clients report the whole `/mcp` endpoint as not found.
			return error(
				body.id,
				-32601,
				`Method not found: ${String(body.method)}`,
				200,
			)
	}
}
