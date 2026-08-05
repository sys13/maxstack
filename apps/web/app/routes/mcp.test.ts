/**
 * Regression guard for issue #115: any non-POST hit on `/mcp` (health probe,
 * browser, bare `curl`) must get the clean JSON-RPC 405 — not React Router's
 * unhandled "no loader" 400 + stack-trace dump. GET/HEAD dispatch to the
 * loader, so the route must export one; other verbs reach the action's guard.
 */

import { describe, expect, it } from 'vitest'
import { action, loader } from './mcp'

const args = (request: Request): Parameters<typeof action>[0] =>
	({ request, params: {}, context: {} }) as Parameters<typeof action>[0]

describe('/mcp non-POST verbs', () => {
	it('exports a loader so a GET never hits the "no loader" internal error', async () => {
		const res = loader()
		expect(res.status).toBe(405)
		expect(res.headers.get('allow')).toBe('POST')
		expect(await res.json()).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'POST only' },
		})
	})

	it('keeps the action guard for other non-POST verbs (defense-in-depth)', async () => {
		const res = (await action(
			args(new Request('http://localhost/mcp', { method: 'DELETE' })),
		)) as Response
		expect(res.status).toBe(405)
		expect(await res.json()).toMatchObject({
			error: { code: -32600, message: 'POST only' },
		})
	})
})
