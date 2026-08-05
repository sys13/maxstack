/**
 * Preflight — the checks that run before `init` and `dev`.
 *
 * The messages are the deliverable here, not a side effect of one, so they are
 * asserted as artifacts: every finding a user can see must name its cause *and*
 * a command that fixes it, and only a state-corrupting condition may block. A
 * message that drifts into naming a flag that no longer exists is a bug, exactly
 * as it is for the generated CLI reference.
 */

import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	collectPreflight,
	NODE_MIN_MAJOR,
	nodeVersionFinding,
	type PreflightFinding,
	preflightJson,
	PreflightError,
	renderPreflight,
	runPreflight,
} from './preflight.ts'

describe('nodeVersionFinding', () => {
	it('blocks below the engines floor and names the upgrade', () => {
		const finding = nodeVersionFinding('20.11.0')
		expect(finding.status).toBe('error')
		expect(finding.blocking).toBe(true)
		expect(finding.detail).toContain('20.11.0')
		expect(finding.detail).toContain(String(NODE_MIN_MAJOR))
		// The actual failure without this check is a SyntaxError inside a bundle
		// the user has never opened — so the fix has to be a command.
		expect(finding.fix).toMatch(/nvm install 22/)
	})

	it('passes at and above the floor', () => {
		for (const v of ['22.0.0', '24.3.1', '26.1.0']) {
			const finding = nodeVersionFinding(v)
			expect(finding.status).toBe('ok')
			expect(finding.blocking).toBeUndefined()
		}
	})
})

describe('collectPreflight init phase', () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-preflight-'))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('passes on an empty target and reports where it will land', async () => {
		const findings = await collectPreflight('init', dir)
		expect(findings.every((f) => f.status === 'ok')).toBe(true)
		expect(findings.some((f) => f.detail.includes(dir))).toBe(true)
	})

	it('blocks on a directory that is already a project, naming both ways out', async () => {
		await writeFile(join(dir, 'maxstack.json'), '{}')
		const findings = await collectPreflight('init', dir)
		const target = findings.find((f) => f.name === 'target')
		expect(target?.blocking).toBe(true)
		expect(target?.detail).toContain('Already a maxstack project')
		// Both of the things the user might have meant.
		expect(target?.fix).toMatch(/maxstack dev/)
		expect(target?.fix).toMatch(/maxstack init <other-dir>/)
	})

	it('reports only the Node finding when Node is below the floor', async () => {
		// Nothing after it can be trusted: the later checks run on the same
		// runtime, so their answers would be artifacts of the wrong Node.
		const findings = await collectPreflight('init', dir, {
			nodeVersion: '18.0.0',
		})
		expect(findings).toHaveLength(1)
		expect(findings[0]?.name).toBe('node')
	})
})

describe('every visible finding names a fix', () => {
	/** Every non-ok finding the module can produce, gathered from the shapes the
	 * checks return rather than from a hand-written list. */
	const notable = (findings: PreflightFinding[]) =>
		findings.filter((f) => f.status !== 'ok')

	it('holds for the init-phase failures', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maxstack-preflight-'))
		try {
			await writeFile(join(dir, 'maxstack.json'), '{}')
			const findings = notable([
				...(await collectPreflight('init', dir)),
				nodeVersionFinding('18.0.0'),
			])
			expect(findings.length).toBeGreaterThan(0)
			for (const f of findings) {
				expect(f.fix, `${f.name} has no fix`).toBeTruthy()
				// A finding that blocks is a refusal, and a refusal must be
				// state-corrupting or impossible-to-proceed — never a staleness note.
				if (f.blocking) expect(f.status).toBe('error')
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('reporting', () => {
	it('renders nothing at all when everything passes', () => {
		// Preflight runs before every `dev`; noise on the happy path is how a
		// useful check gets ignored.
		expect(
			renderPreflight([
				{ section: 'preflight', name: 'node', status: 'ok', detail: 'v24.0.0' },
			]),
		).toBe('')
	})

	it('renders each notable finding with its indented fix', () => {
		const findings: PreflightFinding[] = [
			{ section: 'preflight', name: 'node', status: 'ok', detail: 'v24.0.0' },
			{
				section: 'preflight',
				name: 'runtime',
				status: 'warn',
				detail: 'cli 1.0.0 · maxstack-runtime 0.9.0',
				fix: 'npx maxstack@0.9.0 dev',
			},
		]
		const out = renderPreflight(findings)
		expect(out).toContain('⚠ cli 1.0.0 · maxstack-runtime 0.9.0')
		expect(out).toContain('  npx maxstack@0.9.0 dev')
		// A passing check is not news.
		expect(out).not.toContain('v24.0.0')
	})

	it('leaves blocking findings to the thrown error, not the report', () => {
		// Both used to print, so every refusal appeared twice: once from the
		// stderr report and once from the bin entry's error handler.
		const blocking: PreflightFinding[] = [
			{
				section: 'preflight',
				name: 'port',
				status: 'error',
				blocking: true,
				detail: 'port 3000 is already in use.',
				fix: 'maxstack dev --port <n>',
			},
		]
		expect(renderPreflight(blocking)).toBe('')
		expect(renderPreflight(blocking, { includeBlocking: true })).toContain(
			'✖ port 3000 is already in use.',
		)
	})

	it('emits machine-readable findings with an ok flag', () => {
		const parsed = JSON.parse(
			preflightJson('dev', '/tmp/x', [
				{
					section: 'preflight',
					name: 'node',
					status: 'error',
					blocking: true,
					detail: 'too old',
					fix: 'upgrade',
				},
			]),
		)
		expect(parsed.preflight).toBe('dev')
		expect(parsed.ok).toBe(false)
		expect(parsed.findings[0].fix).toBe('upgrade')
	})

	it('runPreflight throws a PreflightError carrying the findings', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'maxstack-preflight-'))
		try {
			await writeFile(join(dir, 'maxstack.json'), '{}')
			await expect(runPreflight('init', dir)).rejects.toThrow(PreflightError)
			// The message a user sees is cause + fix, not a stack trace.
			await expect(runPreflight('init', dir)).rejects.toThrow(
				/Already a maxstack project[\s\S]*maxstack init <other-dir>/,
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('port check', () => {
	it('blocks when the port is held, and explains why drifting is worse', async () => {
		const server = createServer()
		const port = await new Promise<number>((res) => {
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				res(typeof addr === 'object' && addr ? addr.port : 0)
			})
		})
		const dir = await mkdtemp(join(tmpdir(), 'maxstack-preflight-'))
		try {
			const findings = await collectPreflight('dev', dir, {
				port: String(port),
				project: {
					root: dir,
					appPath: join(dir, 'app'),
					config: {
						name: 'x',
						backend: 'pglite',
						appDir: 'app',
						dataDir: '.maxstack',
					},
				} as never,
			})
			const portFinding = findings.find((f) => f.name === 'port')
			expect(portFinding?.blocking).toBe(true)
			expect(portFinding?.fix).toMatch(/--port <n>/)
		} finally {
			server.close()
			await rm(dir, { recursive: true, force: true })
		}
	})
})
