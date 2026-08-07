/**
 * What the stdio host declares about its own reach (#353).
 *
 * `handleMcpRequest` redacts an unrecognised failure down to a correlation id,
 * because on the surface that matters — `POST /mcp` in a generated app — the
 * message is the failed SQL statement and the caller is on the far end of a
 * network. This host is the other case, and it says so.
 *
 * The value is not incidental. `maxstack mcp` is spawned by the developer's own
 * agent client, over a pipe, against a directory named on its command line;
 * withholding `EACCES … /Users/me/app/spec/prd.ts` from the agent reading the
 * reply protects nobody and costs it the only fact it could have acted on. So
 * the two hosts differ **on purpose**, and this pins the purpose: a later change
 * that "unifies" them by dropping the declaration fails here rather than
 * silently making every local agent's debugging worse.
 *
 * `packages/mcp/src/jsonrpc.test.ts` pins the rule the flag drives; this pins
 * that this host opts into it, which is the half a shared test cannot see.
 */

import { handleMcpRequest } from '@maxstack/mcp'
import { describe, expect, it, vi } from 'vitest'
import { stdioMcpContext } from './mcp.ts'

/** A platform context whose spec store fails the way a filesystem does. */
function explodingPlatform() {
	return {
		spec: {
			load: () => {
				throw new Error('EACCES: permission denied, open /srv/spec/prd.ts')
			},
			save: async () => {},
		},
	} as unknown as Parameters<typeof stdioMcpContext>[0]
}

describe('the stdio host declares itself local', () => {
	it('states it on the context it dispatches with', () => {
		expect(stdioMcpContext(explodingPlatform()).exposure).toBe('local')
	})

	it('so a failure comes back with its detail, not just an id', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const { body } = await handleMcpRequest(
			stdioMcpContext(explodingPlatform()),
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'query_spec', arguments: { section: 'summary' } },
			},
		)
		const result = body.result as {
			isError?: boolean
			content: { text: string }[]
		}
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('EACCES')
		expect(result.content[0]?.text).toContain('/srv/spec/prd.ts')
		vi.restoreAllMocks()
	})
})
