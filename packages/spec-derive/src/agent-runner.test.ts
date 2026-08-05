/**
 * The agent loop, driven hermetically.
 *
 * Every arm's number comes out of this loop, so the properties under test are
 * the ones that would silently bias a comparison rather than break it: that
 * tokens are billed on the turns that went wrong as well as the ones that went
 * right, that the turn cap is reported rather than dressed up as a failed
 * change, and that a workspace cannot reach outside itself into another arm's
 * tree or into the specs it is being judged by.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	type AgentMessage,
	type AgentRequest,
	agentRunner,
	nodeWorkspace,
	runTool,
	TOOL_RESULT_LIMIT,
	type Workspace,
} from './agent-runner.ts'

function fakeWorkspace(over: Partial<Workspace> = {}): Workspace {
	const files = new Map<string, string>([
		['app/routes/card.tsx', 'export default 1'],
	])
	return {
		read: async (p) => files.get(p) ?? '',
		write: async (p, c) => void files.set(p, c),
		list: async () => [...files.keys()],
		exec: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
		...over,
	}
}

/** A transport that replays a script of messages, recording what it was sent. */
function scriptedTransport(script: AgentMessage[]) {
	const seen: AgentRequest[] = []
	let i = 0
	return {
		seen,
		transport: async (req: AgentRequest) => {
			seen.push(structuredClone(req))
			const next = script[i++]
			if (!next) throw new Error('script exhausted')
			return next
		},
	}
}

const text = (
	t: string,
	usage = { input_tokens: 10, output_tokens: 5 },
): AgentMessage => ({
	stop_reason: 'end_turn',
	content: [{ type: 'text', text: t }],
	usage,
})

const toolCall = (name: string, input: unknown): AgentMessage => ({
	stop_reason: 'tool_use',
	content: [{ type: 'tool_use', id: 'tu_1', name, input }],
	usage: { input_tokens: 100, output_tokens: 20 },
})

function session(script: AgentMessage[], workspace = fakeWorkspace()) {
	const { transport, seen } = scriptedTransport(script)
	return {
		seen,
		session: agentRunner({ transport }).start({
			system: 'sys',
			workspace,
			model: 'test-model',
			maxTurns: 5,
			maxTokens: 100,
			thinkingTokens: 10,
		}),
	}
}

describe('the tool loop', () => {
	it('runs tools until the model stops asking for them', async () => {
		const written: [string, string][] = []
		const { session: s } = session(
			[toolCall('write_file', { path: 'a.ts', content: 'x' }), text('done')],
			fakeWorkspace({ write: async (p, c) => void written.push([p, c]) }),
		)
		const attempt = await s.send('do the thing')
		expect(attempt.stopReason).toBe('completed')
		expect(attempt.turns).toBe(2)
		expect(written).toEqual([['a.ts', 'x']])
		expect(attempt.finalText).toBe('done')
	})

	it('bills every turn, provider-reported and never estimated', async () => {
		const { session: s } = session([
			toolCall('list_files', { path: '.' }),
			text('done'),
		])
		const attempt = await s.send('go')
		expect(attempt.usage.requests).toBe(2)
		expect(attempt.usage.inputTokens).toBe(110)
		expect(attempt.usage.outputTokens).toBe(25)
		expect(attempt.usage.totalTokens).toBe(135)
		expect(attempt.usage.estimated).toBe(false)
	})

	it('counts cache reads and writes as input tokens', async () => {
		const { session: s } = session([
			{
				stop_reason: 'end_turn',
				content: [{ type: 'text', text: 'ok' }],
				usage: {
					input_tokens: 10,
					cache_read_input_tokens: 90,
					cache_creation_input_tokens: 100,
					output_tokens: 1,
				},
			},
		])
		expect((await s.send('go')).usage.inputTokens).toBe(200)
	})

	it('accumulates across sends, because the session is the cell', async () => {
		const { session: s } = session([text('one'), text('two')])
		await s.send('first change')
		await s.send('second change')
		expect(s.usage().requests).toBe(2)
		expect(s.usage().totalTokens).toBe(30)
	})

	it('carries history forward so the agent is maintaining one app', async () => {
		const { session: s, seen } = session([text('one'), text('two')])
		await s.send('first change')
		await s.send('second change')
		expect(seen[1]?.messages.length).toBeGreaterThan(
			seen[0]?.messages.length ?? 0,
		)
		expect(JSON.stringify(seen[1]?.messages)).toContain('first change')
	})
})

describe('the ways an attempt can end', () => {
	it('reports the turn cap rather than dressing it up as a failed change', async () => {
		const { transport } = scriptedTransport(
			Array.from({ length: 10 }, () => toolCall('list_files', { path: '.' })),
		)
		const s = agentRunner({ transport }).start({
			system: 'sys',
			workspace: fakeWorkspace(),
			model: 'm',
			maxTurns: 3,
			maxTokens: 10,
			thinkingTokens: 1,
		})
		const attempt = await s.send('go')
		expect(attempt.stopReason).toBe('turn-cap')
		expect(attempt.turns).toBe(3)
		// Billed in full: the cap is a cost control, and the cost was incurred.
		expect(attempt.usage.totalTokens).toBe(360)
	})

	it('bills a refusal, because a refusal costs tokens', async () => {
		const { session: s } = session([
			{
				stop_reason: 'refusal',
				content: [],
				usage: { input_tokens: 7, output_tokens: 0 },
			},
		])
		const attempt = await s.send('go')
		expect(attempt.stopReason).toBe('refusal')
		expect(attempt.usage.inputTokens).toBe(7)
	})

	it('surfaces a transport failure as `error`, not as a failed change', async () => {
		const s = agentRunner({
			transport: async () => {
				throw new Error('503 overloaded')
			},
		}).start({
			system: 'sys',
			workspace: fakeWorkspace(),
			model: 'm',
			maxTurns: 3,
			maxTokens: 10,
			thinkingTokens: 1,
		})
		const attempt = await s.send('go')
		expect(attempt.stopReason).toBe('error')
		expect(attempt.error).toContain('503')
	})
})

describe('tool dispatch', () => {
	it('returns a non-zero exit as information, not as a tool error', async () => {
		// Flagging it would train the model away from running its own gate.
		const out = await runTool(
			fakeWorkspace({
				exec: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
			}),
			'run_command',
			{ command: 'pnpm validate' },
		)
		expect(out.isError).toBe(false)
		expect(out.content).toContain('exit 1')
		expect(out.content).toContain('boom')
	})

	it('turns a thrown tool into a result the model can recover from', async () => {
		const out = await runTool(
			fakeWorkspace({
				read: async () => {
					throw new Error('ENOENT')
				},
			}),
			'read_file',
			{ path: 'nope.ts' },
		)
		expect(out.isError).toBe(true)
		expect(out.content).toContain('ENOENT')
	})

	it('truncates a huge result from the tail, keeping the error', async () => {
		const out = await runTool(
			fakeWorkspace({ read: async () => `${'x'.repeat(50_000)}THE ERROR` }),
			'read_file',
			{ path: 'big.log' },
		)
		expect(out.content.length).toBeLessThan(TOOL_RESULT_LIMIT + 200)
		expect(out.content).toContain('THE ERROR')
		expect(out.content).toContain('truncated')
	})

	it('names an unknown tool rather than failing silently', async () => {
		const out = await runTool(fakeWorkspace(), 'apply_spec_op', {})
		expect(out.isError).toBe(true)
		expect(out.content).toContain('apply_spec_op')
	})
})

describe('the node workspace stays inside its own arm', () => {
	it('reads and writes relative to the root', async () => {
		const root = await mkdtemp(join(tmpdir(), 'h2h-'))
		const ws = nodeWorkspace(root)
		await ws.write('app/routes/card.tsx', 'export default 1')
		expect(await ws.read('app/routes/card.tsx')).toBe('export default 1')
		expect(await ws.list('app')).toContain('routes/')
	})

	it('refuses a path that escapes the root', async () => {
		// An arm that could write outside its directory could reach the other arm's
		// tree or the acceptance specs it is judged by.
		const root = await mkdtemp(join(tmpdir(), 'h2h-'))
		const ws = nodeWorkspace(root)
		await expect(ws.read('../../etc/passwd')).rejects.toThrow(/escapes/)
		await expect(ws.write('../escaped.txt', 'x')).rejects.toThrow(/escapes/)
	})

	it('runs commands in the root and reports the exit code', async () => {
		const root = await mkdtemp(join(tmpdir(), 'h2h-'))
		await writeFile(join(root, 'marker'), 'here')
		const ws = nodeWorkspace(root)
		expect((await ws.exec('ls')).stdout).toContain('marker')
		expect((await ws.exec('exit 3')).code).toBe(3)
		expect(await readFile(join(root, 'marker'), 'utf8')).toBe('here')
	})
})
