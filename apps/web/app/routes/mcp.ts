import { handleMcpRequest } from '~/mcp.server'
import { getContext } from '~/sprout.server'
import type { Route } from './+types/mcp'

/** The clean "wrong verb" answer, kept JSON-RPC-shaped so probing clients can
 * parse it. Shared by the loader (GET/HEAD land there) and the action's guard
 * (every other non-POST verb). */
function postOnly(): Response {
	return Response.json(
		{
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'POST only' },
		},
		{ status: 405, headers: { allow: 'POST' } },
	)
}

/** GET/HEAD dispatch to the loader, never the action — without one, React
 * Router throws its internal "no loader" error (a 400 + stack-trace dump)
 * before the action's guard can run. Health probes, browser
 * hits, and bare `curl`s get the clean 405 instead. */
export function loader() {
	return postOnly()
}

/** JSON-RPC 2.0 endpoint. `POST /mcp` with `{ jsonrpc, id, method, params }`. */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return postOnly()
	}

	let body: unknown
	try {
		body = await request.json()
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Invalid JSON'
		return Response.json(
			{
				jsonrpc: '2.0',
				id: null,
				error: { code: -32700, message: `Parse error: ${message}` },
			},
			{ status: 400 },
		)
	}

	const ctx = await getContext(request)
	const { status, body: rpc } = await handleMcpRequest(ctx, body as never)
	return Response.json(rpc, { status })
}
