/**
 * `.mcp.json` self-heal (`maxstack dev`) — `ensureMcpJson` writes the
 * file when it's missing, upgrades the superseded HTTP registration, and leaves
 * a hand-tuned one untouched, so older projects gain MCP auto-discovery without
 * clobbering a config that isn't ours.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliInvocation } from './invocation.ts'
import {
	ensureMcpJson,
	mcpJson,
	mcpJsonContent,
	readMcpRegistration,
	writeMcpJson,
} from './mcp-config.ts'

describe('mcp-config', () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-mcp-'))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('mcpJsonContent registers a stdio server for a direct install', async () => {
		const parsed = JSON.parse(await mcpJsonContent())
		// Stdio, not HTTP: the client spawns this itself, so the tools are present
		// in every session instead of only while `maxstack dev` happens to be up
		//. An `http`/`url` shape here reintroduces the cold start.
		expect(parsed.mcpServers.maxstack.command).toBe('maxstack')
		expect(parsed.mcpServers.maxstack.args).toEqual(['mcp'])
		expect(parsed.mcpServers.maxstack).not.toHaveProperty('url')
	})

	it('mcpJson registers a version-pinned npx command under npx', () => {
		// The bug this closes: `npx maxstack init` scaffolded a config naming a
		// bare `maxstack`, which under npx is on nobody's PATH — so the server
		// never started and the session silently had no tools.
		const parsed = JSON.parse(mcpJson(cliInvocation('npx', '1.2.3')))
		expect(parsed.mcpServers.maxstack.command).toBe('npx')
		expect(parsed.mcpServers.maxstack.args).toEqual([
			'-y',
			'maxstack@1.2.3',
			'mcp',
		])
	})

	it('readMcpRegistration reports the command a project registers', async () => {
		await writeMcpJson(dir)
		expect(await readMcpRegistration(dir)).toEqual({
			command: 'maxstack',
			args: ['mcp'],
		})
		// Preflight relies on `null` (not a throw) for "nothing usable here".
		await writeFile(join(dir, '.mcp.json'), '{"mcpServers":{}}')
		expect(await readMcpRegistration(dir)).toBeNull()
		await writeFile(join(dir, '.mcp.json'), 'not json')
		expect(await readMcpRegistration(dir)).toBeNull()
	})

	it('ensureMcpJson creates the file when missing, then is a no-op', async () => {
		expect(await ensureMcpJson(dir)).toBe(true)
		expect(JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'))).toHaveProperty(
			'mcpServers.maxstack',
		)
		// Second call is a no-op on the file it just wrote.
		expect(await ensureMcpJson(dir)).toBe(false)
	})

	it('ensureMcpJson upgrades the superseded http registration in place', async () => {
		// What every project scaffolded before the stdio switch carries. It only
		// answers while `dev` runs, so leaving it in place would strand those
		// projects on the cold-start bug forever.
		await writeFile(
			join(dir, '.mcp.json'),
			JSON.stringify({
				mcpServers: {
					maxstack: {
						type: 'http',
						url: '${MAXSTACK_MCP_URL:-http://127.0.0.1:3000/mcp}',
					},
				},
			}),
		)
		expect(await ensureMcpJson(dir)).toBe(true)
		const parsed = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'))
		expect(parsed.mcpServers.maxstack.command).toBe('maxstack')
	})

	it('ensureMcpJson leaves a config that is not ours alone', async () => {
		// Hand-tuned, or registering other servers alongside ours — not ours to
		// rewrite, even though a maxstack http entry is present.
		const custom = JSON.stringify({
			mcpServers: {
				maxstack: { type: 'http', url: 'http://elsewhere:9000/mcp' },
				other: { command: 'something' },
			},
		})
		await writeFile(join(dir, '.mcp.json'), custom)
		expect(await ensureMcpJson(dir)).toBe(false)
		expect(await readFile(join(dir, '.mcp.json'), 'utf8')).toBe(custom)

		// Unparseable is likewise left untouched rather than clobbered.
		await writeFile(join(dir, '.mcp.json'), 'not json')
		expect(await ensureMcpJson(dir)).toBe(false)
		expect(await readFile(join(dir, '.mcp.json'), 'utf8')).toBe('not json')
	})

	it('writeMcpJson overwrites unconditionally', async () => {
		await writeFile(join(dir, '.mcp.json'), 'stale')
		await writeMcpJson(dir)
		expect(await readFile(join(dir, '.mcp.json'), 'utf8')).not.toBe('stale')
	})
})
