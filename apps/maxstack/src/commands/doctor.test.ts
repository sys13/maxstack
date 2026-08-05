/**
 * `maxstack doctor`. The command's value is that a user with no
 * checkout can tell runtime problems from spec problems, so the tests pin the
 * parts that carry that meaning: the version comparison staleness rests on, the
 * report/exit-code contract, a real stdio MCP handshake, and the fact that a
 * non-project directory still gets the toolchain answers instead of an error.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	aiProviderCheck,
	collectDoctorChecks,
	compareVersions,
	type DoctorCheck,
	depOverrideCheck,
	doctorSummary,
	probeMcpServer,
	RUNTIME_BOUNDARY_NOTE,
	renderDoctorReport,
	resolveAiProvider,
} from './doctor.ts'
import { scaffoldOverrides } from './init.ts'

const dirs: string[] = []
async function tmp(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'maxstack-doctor-'))
	dirs.push(dir)
	return dir
}
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true })
})

const check = (over: Partial<DoctorCheck> = {}): DoctorCheck => ({
	section: 'toolchain',
	name: 'cli',
	status: 'ok',
	detail: 'fine',
	...over,
})

describe('compareVersions', () => {
	it('orders numerically, not lexically', () => {
		// The bug this guards: '0.9.0' > '0.11.0' as strings, which would report
		// an up-to-date install as stale (and vice versa).
		expect(compareVersions('0.11.6', '0.9.0')).toBeGreaterThan(0)
		expect(compareVersions('0.11.6', '0.11.7')).toBeLessThan(0)
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
	})

	it('tolerates missing segments and prerelease tags', () => {
		expect(compareVersions('1.2', '1.2.0')).toBe(0)
		expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBe(0)
		expect(compareVersions('v1.3.0', '1.2.9')).toBeGreaterThan(0)
	})
})

describe('doctorSummary', () => {
	it('passes when nothing is warn or error', () => {
		const summary = doctorSummary([check(), check({ status: 'info' })])
		expect(summary.failed).toBe(false)
		expect(summary.line).toMatch(/no problems/)
	})

	it('warnings alone do not fail the exit code', () => {
		const summary = doctorSummary([check({ status: 'warn' })])
		expect(summary.failed).toBe(false)
		expect(summary.line).toContain('1 warning')
	})

	it('an error-level finding fails', () => {
		const summary = doctorSummary([
			check({ status: 'error' }),
			check({ status: 'warn' }),
		])
		expect(summary.failed).toBe(true)
		expect(summary.line).toContain('1 problem')
		expect(summary.line).toContain('1 warning')
	})
})

describe('renderDoctorReport', () => {
	it('groups by section and prints the fix under a finding', () => {
		const text = renderDoctorReport([
			check({ section: 'toolchain', name: 'cli' }),
			check({
				section: 'runtime',
				name: 'source maps',
				status: 'warn',
				detail: 'absent',
				fix: 'update the runtime',
			}),
		])
		expect(text).toContain('toolchain')
		expect(text).toContain('runtime')
		expect(text).toContain('✔ cli')
		expect(text).toContain('⚠ source maps')
		expect(text).toContain('update the runtime')
	})
})

describe('the runtime/spec boundary note', () => {
	it('tells the user runtime bugs are not their spec, and where they go', () => {
		expect(RUNTIME_BOUNDARY_NOTE).toMatch(/runtime bug/)
		expect(RUNTIME_BOUNDARY_NOTE).toContain('github.com/sys13/maxstack/issues')
		expect(RUNTIME_BOUNDARY_NOTE).toContain('maxstack runtime link')
	})
})

describe('collectDoctorChecks', () => {
	it('still reports the toolchain outside a project', async () => {
		const dir = await tmp()
		const checks = await collectDoctorChecks(dir, {
			offline: true,
			noMcpProbe: true,
		})
		expect(checks.some((c) => c.section === 'toolchain')).toBe(true)
		// Not a project — say so as information, never as a crash: someone
		// debugging "is my CLI even right?" is often in the wrong directory.
		expect(checks.find((c) => c.name === 'project')?.detail).toMatch(
			/not a maxstack project/,
		)
		// --offline must not touch the network.
		expect(checks.find((c) => c.name === 'npm latest')?.detail).toMatch(
			/skipped/,
		)
	})
})

describe('the AI provider check', () => {
	// #284: "AI is unavailable right now" was the only signal, and it names
	// nothing. Doctor is where a user already goes to ask what is configured.
	it('reports an unconfigured provider as actionable, not as a problem', () => {
		const check = resolveAiProvider('BETTER_AUTH_URL=http://localhost:3000\n')
		expect(check.status).toBe('info')
		expect(check.detail).toMatch(/not configured/)
		expect(check.fix).toContain('ANTHROPIC_API_KEY')
	})

	it('names whichever key is actually set, and treats blank as unset', () => {
		expect(resolveAiProvider('ANTHROPIC_API_KEY=sk-ant-x\n').status).toBe('ok')
		expect(resolveAiProvider('ANTHROPIC_API_KEY=sk-ant-x\n').detail).toMatch(
			/ANTHROPIC_API_KEY/,
		)
		expect(resolveAiProvider('OPENAI_API_KEY=sk-x\n').detail).toMatch(
			/OPENAI_API_KEY/,
		)
		// The scaffolded slot is blank — the whole point of the finding.
		expect(resolveAiProvider('ANTHROPIC_API_KEY=\n').detail).toMatch(
			/not configured/,
		)
	})

	it('recognises MOCK_AI, including its off values', () => {
		expect(resolveAiProvider('MOCK_AI=1\n').detail).toMatch(/MOCK_AI/)
		expect(resolveAiProvider('MOCK_AI=0\n').detail).toMatch(/not configured/)
		expect(resolveAiProvider('MOCK_AI=false\n').detail).toMatch(
			/not configured/,
		)
	})

	// The load-bearing property: the shell that runs doctor is not the server's
	// environment. `resolveAiProvider` takes text, so `process.env` is not
	// reachable from the rule at all — this pins that the file is what feeds it.
	it('reads the project .env from disk, not process.env', async () => {
		const dir = await tmp()
		process.env.ANTHROPIC_API_KEY = 'from-the-shell'
		try {
			expect((await aiProviderCheck({ root: dir })).detail).toMatch(
				/not configured/,
			)
			await writeFile(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-on-disk\n')
			expect((await aiProviderCheck({ root: dir })).status).toBe('ok')
		} finally {
			delete process.env.ANTHROPIC_API_KEY
		}
	})
})

describe('the dependency-pinning check', () => {
	// A project scaffolded before the fix carries a manifest with no override,
	// and the damage is invisible on the machine that installed it — it shows up
	// only where the project lands next. Doctor reads the manifest, never the
	// installed tree, precisely because a working node_modules is what hides it.
	async function projectWith(pkg: unknown): Promise<string> {
		const dir = await tmp()
		await writeFile(
			join(dir, 'package.json'),
			`${JSON.stringify(pkg, null, 2)}\n`,
		)
		return dir
	}

	it('warns, with a runnable fix, when the override is missing', async () => {
		const root = await projectWith({
			name: 'legacy',
			devDependencies: { 'maxstack-runtime': '^0.11.9' },
		})
		const check = await depOverrideCheck({ root })

		expect(check.status).toBe('warn')
		expect(check.detail).toMatch(/drizzle-orm/)
		expect(check.fix).toMatch(/"overrides"/)
		expect(check.fix).toMatch(/package-lock\.json/)
	})

	it('warns when the override names a different version than the runtime', async () => {
		const root = await projectWith({
			name: 'skewed',
			devDependencies: { 'maxstack-runtime': '^0.11.9' },
			overrides: { 'drizzle-orm': '0.45.2' },
		})
		expect((await depOverrideCheck({ root })).status).toBe('warn')
	})

	it('passes on what `maxstack init` writes today', async () => {
		const root = await projectWith({
			name: 'scaffolded',
			devDependencies: { 'maxstack-runtime': '^0.11.9' },
			overrides: await scaffoldOverrides(),
		})
		expect((await depOverrideCheck({ root })).status).toBe('ok')
	})

	it('stays quiet about a directory that is not a maxstack project', async () => {
		expect((await depOverrideCheck({ root: await tmp() })).status).toBe('info')
		const plain = await projectWith({ name: 'unrelated' })
		expect((await depOverrideCheck({ root: plain })).status).toBe('info')
	})
})

describe('probeMcpServer', () => {
	it('completes a real initialize → tools/list handshake', async () => {
		// A minimal stdio JSON-RPC server: the probe's contract is the wire, so
		// exercising it against a real child process (not a mock) is the point.
		const dir = await tmp()
		const script = join(dir, 'server.mjs')
		await writeFile(
			script,
			`import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'maxstack', version: '9.9.9' } } }) + '\\n')
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'a' }, { name: 'b' }] } }) + '\\n')
  }
}
`,
		)
		const result = await probeMcpServer(dir, process.execPath, [script])
		expect(result.ok).toBe(true)
		expect(result.server).toBe('maxstack 9.9.9')
		expect(result.tools).toBe(2)
	})

	it('reports a missing binary instead of throwing', async () => {
		const result = await probeMcpServer(
			await tmp(),
			'maxstack-definitely-not-installed',
			['mcp'],
		)
		expect(result.ok).toBe(false)
		expect(result.error).toMatch(/not on PATH/)
	})

	it('times out rather than hanging on a silent server', async () => {
		const dir = await tmp()
		const script = join(dir, 'silent.mjs')
		// Reads stdin forever, answers nothing — the wedged-server case.
		await writeFile(script, 'process.stdin.resume()\n')
		const result = await probeMcpServer(dir, process.execPath, [script], 300)
		expect(result.ok).toBe(false)
		expect(result.error).toMatch(/no response/)
	})
})
