import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpecDir } from '@maxstack/mcp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadProject } from '../lib/project.ts'
import { projectCheckRunner } from '../lib/project-checks.ts'
import { initCommand } from './init.ts'

describe('maxstack init naming', () => {
	const originalCwd = process.cwd()

	afterEach(async () => {
		process.chdir(originalCwd)
		vi.restoreAllMocks()
	})

	it('prompts for a project name and scaffolds into a kebab-case subdir', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-name-'))
		process.chdir(parent)
		vi.spyOn(console, 'log').mockImplementation(() => {})

		await initCommand(
			undefined,
			{ desc: 'a widget tracker' },
			{ projectName: async () => 'Widget Tracker' },
		)

		const root = join(parent, 'widget-tracker')
		const config = JSON.parse(
			await readFile(join(root, 'maxstack.json'), 'utf8'),
		)
		const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
		const spec = await readSpecDir(join(root, 'spec'))

		expect(config.name).toBe('Widget Tracker')
		expect(pkg.name).toBe('widget-tracker')
		expect(spec.product.meta.title).toBe('Widget Tracker')

		await rm(parent, { recursive: true, force: true })
	})

	it('slugifies an explicit directory basename for the scaffolded package name', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-dir-'))
		const root = join(parent, 'Widget Tracker')
		vi.spyOn(console, 'log').mockImplementation(() => {})

		await initCommand(root, { desc: 'a widget tracker' })

		const config = JSON.parse(
			await readFile(join(root, 'maxstack.json'), 'utf8'),
		)
		const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

		expect(config.name).toBe('Widget Tracker')
		expect(pkg.name).toBe('widget-tracker')

		await rm(parent, { recursive: true, force: true })
	})
})

describe('maxstack init scaffolds its own precondition', () => {
	const originalCwd = process.cwd()
	const dirs: string[] = []

	afterEach(async () => {
		process.chdir(originalCwd)
		vi.restoreAllMocks()
		for (const d of dirs.splice(0))
			await rm(d, { recursive: true, force: true })
	})

	it('leaves the project under version control, with the scaffold committed', async () => {
		// Never-clobber promises the platform will not overwrite code you own.
		// The thing that makes a mistake survivable is `git diff` / `git checkout
		// --`, and `init` used to write a .gitignore for a repo that never existed.
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-git-'))
		dirs.push(parent)
		const root = join(parent, 'tracked')
		vi.spyOn(console, 'log').mockImplementation(() => {})

		await initCommand(root, { desc: 'a widget tracker' })

		const git = (...args: string[]) =>
			execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
		expect(git('rev-parse', '--is-inside-work-tree')).toBe('true')
		expect(git('log', '--oneline')).toContain('Initial scaffold')
		// The whole scaffold is in that commit — a baseline with files left out
		// is a baseline you cannot revert to.
		expect(git('status', '--porcelain')).toBe('')
	})

	it('warns loudly when asked to skip it, naming the missing undo', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-nogit-'))
		dirs.push(parent)
		const root = join(parent, 'untracked')
		vi.spyOn(console, 'log').mockImplementation(() => {})
		const warnings: string[] = []
		vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
			warnings.push(a.join(' '))
		})

		await initCommand(root, { desc: 'a widget tracker', git: false })

		expect(warnings.join('\n')).toMatch(/no version control here/)
		expect(warnings.join('\n')).toMatch(/no undo/)
	})
})

describe('a fresh scaffold passes its own gate', () => {
	const dirs: string[] = []

	afterEach(async () => {
		vi.restoreAllMocks()
		for (const d of dirs.splice(0))
			await rm(d, { recursive: true, force: true })
	})

	/** What `run_checks` reports on the project `maxstack init` just wrote. */
	async function gateOn(root: string) {
		const runner = await projectCheckRunner(await loadProject(root))
		const unavailable = (await runner.unavailable?.()) ?? []
		return {
			unavailable,
			blocking: unavailable.filter((u) => u.blocking !== false),
		}
	}

	it('reports nothing blocking on a project with no owned code', async () => {
		// The bug: `maxstack init` scaffolded a project and the very first
		// `run_checks` came back `{ok: false, status: "incomplete"}` — three checks
		// "never ran", over zero lines of owned code, on op zero, through no action
		// of the person who ran the command.
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-gate-'))
		dirs.push(parent)
		const root = join(parent, 'gated')
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})

		await initCommand(root, { desc: 'a widget tracker', git: false })

		const { unavailable, blocking } = await gateOn(root)
		expect(blocking).toEqual([])
		// Still named, with the reason and a remedy — this is a flag, not an
		// omission, and the report has to keep saying what did not run.
		expect(unavailable.map((u) => u.name).sort()).toEqual([
			'lint',
			'test',
			'typecheck',
		])
	})

	it('offers only remedies that are runnable commands', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-remedy-'))
		dirs.push(parent)
		const root = join(parent, 'remedied')
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})

		await initCommand(root, { desc: 'a widget tracker', git: false })

		for (const u of (await gateOn(root)).unavailable) {
			expect(u.remedy).toBeTruthy()
			// `"lint": "lint"` — the script name repeated is not a binary.
			expect(u.remedy).not.toMatch(/"(\w+)": "\1"/)
		}
	})
})
