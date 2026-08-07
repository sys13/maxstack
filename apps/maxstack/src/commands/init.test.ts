import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readSpecDir } from '@maxstack/mcp'
import { suggested } from '@maxstack/spec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadProject } from '../lib/project.ts'
import { projectCheckRunner } from '../lib/project-checks.ts'
import { BIOME_VERSION, initCommand, scaffoldPackageJson } from './init.ts'

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

/**
 * #331 — `init`'s report opened with a twelve-row inventory of every file the
 * scaffold wrote, then an MCP paragraph, and only then the two commands the user
 * is supposed to type. The inventory is reference material: it answers a
 * question nobody has in the second after running `init`, and it pushed the
 * actionable part off the first screenful.
 *
 * What is pinned here is the standard, not the wording: the next step is near
 * the top, the inventory is gone from stdout, and — the part that would
 * otherwise rot silently — the `cd` target actually names the directory the
 * project was written to, from the directory the user is standing in.
 */
describe('what init prints leads with what to type next (#331)', () => {
	const originalCwd = process.cwd()
	const dirs: string[] = []

	afterEach(async () => {
		process.chdir(originalCwd)
		vi.restoreAllMocks()
		for (const d of dirs.splice(0))
			await rm(d, { recursive: true, force: true })
	})

	/** Run `init` from inside a fresh temp cwd, capturing every printed line. */
	async function report(arg: string | undefined, name?: string) {
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-report-'))
		dirs.push(parent)
		// Resolve the symlinked macOS tmpdir, so a `resolve()` comparison below is
		// comparing paths and not two spellings of the same one.
		const cwd = await realpath(parent)
		process.chdir(cwd)
		const lines: string[] = []
		const capture = (...a: unknown[]) => {
			lines.push(a.join(' '))
		}
		vi.spyOn(console, 'log').mockImplementation(capture)
		vi.spyOn(console, 'warn').mockImplementation(capture)

		await initCommand(
			arg,
			{ desc: 'a reading log', git: false },
			name ? { projectName: async () => name } : {},
		)
		return { cwd, lines, text: lines.join('\n') }
	}

	it('puts the next command inside the first handful of lines', async () => {
		const { text } = await report('reader')
		const printed = text.split('\n').flatMap((l) => l.split('\n'))
		const nonEmpty = printed.filter((l) => l.trim())
		// The receipt is two lines (name + where it went); the git warning is one
		// more. The command must be reachable without scrolling past a wall.
		const cd = nonEmpty.findIndex((l) => l.includes('cd reader'))
		expect(cd).toBeGreaterThanOrEqual(0)
		expect(cd).toBeLessThanOrEqual(3)
	})

	it('no longer inventories the scaffold on stdout', async () => {
		const { text } = await report('reader')
		// The old tree, row by row. Any of these back on stdout is the regression.
		for (const row of [
			'maxstack.json',
			'tsconfig.json',
			'package.json',
			'biome.jsonc',
			'.mcp.json',
			'.claude/settings.json',
			'.env.example',
			'mcp__maxstack__*',
		])
			expect(text).not.toContain(row)
		expect(text).not.toMatch(/[├└]/)
		// Eight lines of report, blank ones included — not the twenty-four it was.
		// Twelve here because these fixtures pass `--no-git`, which adds the
		// no-undo warning the real default path does not print.
		expect(text.split('\n').length).toBeLessThanOrEqual(12)
	})

	it('prints a cd target that resolves to the project it just wrote', async () => {
		// The failure this exists to catch: `init` derives the scaffold directory
		// from the *answered name* when no argument is given, so the printed `cd`
		// and the actual root are computed from different things and can drift.
		for (const [arg, name] of [
			['reader', undefined],
			[undefined, 'Reading Log'],
		] as [string | undefined, string | undefined][]) {
			const { cwd, text } = await report(arg, name)
			const target = text.match(/cd (\S+)/)?.[1]
			expect(target, 'no cd hint printed').toBeTruthy()
			// `cd <target>` from where the user is standing has to land on a real
			// maxstack project — the one that was just created.
			const landed = resolve(cwd, target ?? '')
			expect(
				JSON.parse(await readFile(join(landed, 'maxstack.json'), 'utf8')).name,
			).toBe(name ?? 'reader')
		}
	})

	it('says where the detail went, and the detail is there', async () => {
		const { cwd, text } = await report('reader')
		expect(text).toContain('README.md')
		// Whatever left stdout has to be findable later, or it was deleted rather
		// than moved. The README's Layout section is where it went.
		const readme = await readFile(join(cwd, 'reader', 'README.md'), 'utf8')
		const layout = readme.slice(readme.indexOf('## Layout'))
		for (const row of [
			'maxstack.json',
			'tsconfig.json',
			'package.json',
			'biome.jsonc',
			'.mcp.json',
			'.claude/settings.json',
			'.env.example',
			'CLAUDE.md',
		])
			expect(layout, `README's Layout never mentions ${row}`).toContain(row)
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

/**
 * #341: the scaffold declared `typecheck` and nothing else, so `maxstack
 * validate` on a fresh project reported three of its four checks UNEXAMINED
 * because the scaffold it had just written declared no such script. The sharpest
 * of the three was `e2e` — `maxstack gen` transcribes every page's `e2eTests`
 * into a Playwright spec, and nothing on the path from `init` to `validate`
 * could open the file it wrote.
 *
 * The invariant this pins is the one the issue asks for: **for every check
 * `validate` knows how to run, the scaffold declares a script — there is no
 * third state.** "The framework knows about this check and the project it just
 * generated cannot run it" is the state that must not exist.
 *
 * A declared script is only half of it, so the rest pins the other half: the
 * binary each one names is a declared devDependency, and the config file each
 * one needs is written by the same scaffold. `scaffold-typecheck.test.ts` is the
 * matching proof for `typecheck`; the end-to-end proof for the other three is a
 * real `pnpm install` against published packages, which is not something a unit
 * test can do — so what is pinned here is every input to that run.
 */
describe('the scaffold declares every gate validate knows how to run (#341)', () => {
	const dirs: string[] = []

	afterEach(async () => {
		vi.restoreAllMocks()
		for (const d of dirs.splice(0))
			await rm(d, { recursive: true, force: true })
	})

	/** A scaffolded project whose spec declares an e2e test — the condition under
	 * which `e2e` becomes an expected check — and whose dependencies look
	 * installed, so "not installed" cannot mask "not declared". */
	async function scaffoldWithE2e(): Promise<string> {
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-scripts-'))
		dirs.push(parent)
		const root = join(parent, 'scripted')
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await initCommand(root, { desc: 'a widget tracker', git: false })

		const project = await loadProject(root)
		const spec = await project.spec.load()
		spec.pages.pages.push({
			id: 'pg-widgets' as (typeof spec.pages.pages)[number]['id'],
			name: 'Widgets',
			route: '/widgets',
			blocks: [],
			provenance: spec.pages.pages[0]?.provenance ?? suggested(),
			e2eTests: ['I can add a widget and see it in the list.'],
		})
		await project.spec.save(spec)
		await mkdir(join(root, 'node_modules'), { recursive: true })
		return root
	}

	it('leaves no check reporting "declares no <x> script"', async () => {
		const root = await scaffoldWithE2e()
		const runner = await projectCheckRunner(await loadProject(root))
		const unavailable = (await runner.unavailable?.()) ?? []

		// The exact failure #341 reported. Any check still in this state is a gate
		// the framework asked for and the scaffold cannot satisfy.
		expect(
			unavailable
				.filter((u) => /declares no "\w+" script/.test(u.reason))
				.map((u) => u.name),
		).toEqual([])
		// And `e2e` is genuinely on the board once a page declares tests, rather
		// than having quietly stopped being expected.
		expect([
			...runner.list().map((c) => c.name),
			...unavailable.map((u) => u.name),
		]).toContain('e2e')
	})

	it('declares the binary behind every script it declares', async () => {
		const pkg = JSON.parse(await scaffoldPackageJson('probe')) as {
			scripts: Record<string, string>
			devDependencies: Record<string, string>
		}
		// A script is only runnable if `install` puts its binary in `.bin`. Without
		// this the scaffold trades "no script" for "a script that exits 127", which
		// is the strictly worse trade the issue warns about.
		const provider: Record<string, string> = {
			biome: '@biomejs/biome',
			playwright: '@playwright/test',
			tsc: 'typescript',
			vitest: 'vitest',
		}
		for (const [name, command] of Object.entries(pkg.scripts)) {
			const bin = command.split(' ')[0] ?? ''
			// `maxstack …` is the CLI itself, already declared; the rest name a tool.
			const dep = bin === 'maxstack' ? 'maxstack' : provider[bin]
			expect(
				dep,
				`script "${name}" runs "${bin}", which no entry in this test knows how to install`,
			).toBeTruthy()
			expect(
				Object.keys(pkg.devDependencies),
				`script "${name}" runs "${bin}" but nothing declares it`,
			).toContain(dep)
		}
	})

	it('pins biome exactly, so lint does not nag about its own $schema', async () => {
		// Biome compares the `$schema` in the config against its own version and
		// prints a mismatch notice on every run. A caret range floats to the next
		// patch and every `pnpm lint` in every scaffolded project starts
		// complaining about a file its owner never wrote.
		const pkg = JSON.parse(await scaffoldPackageJson('probe')) as {
			devDependencies: Record<string, string>
		}
		expect(pkg.devDependencies['@biomejs/biome']).toBe(BIOME_VERSION)
		expect(pkg.devDependencies['@biomejs/biome']).not.toMatch(/^[\^~]/)
	})

	it('writes the config each of those scripts cannot run without', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'maxstack-init-configs-'))
		dirs.push(parent)
		const root = join(parent, 'configured')
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await initCommand(root, { desc: 'a widget tracker', git: false })

		const biome = await readFile(join(root, 'biome.jsonc'), 'utf8')
		const vitest = await readFile(join(root, 'vitest.config.ts'), 'utf8')
		const playwright = await readFile(
			join(root, 'playwright.config.ts'),
			'utf8',
		)

		expect(biome).toContain(`schemas/${BIOME_VERSION}/schema.json`)
		// The formatter is off on purpose: it fails on `app/routes.ts` and
		// `app/generated/types.ts`, which are ts-morph output stamped DO NOT EDIT.
		// A gate a user can only satisfy by ejecting is a gate they learn to ignore.
		expect(biome).toMatch(/"formatter":\s*\{\s*"enabled":\s*false\s*\}/)

		// `.test.ts` is vitest's, `.spec.ts` is Playwright's. Vitest's default
		// sweep collects both, which would drag the generated Playwright specs into
		// a runner with no browser to give them.
		const include = vitest.match(/include: \[([^\]]*)\]/)?.[1] ?? ''
		expect(include).toContain("'app/**/*.test.ts'")
		expect(include).not.toContain('.spec.')

		// `page.goto('/widgets')` in a generated spec is a relative URL against a
		// server nobody started. Both halves have to be here or `e2e` is a script
		// that exists and cannot pass.
		expect(playwright).toContain('baseURL')
		expect(playwright).toContain('webServer')
		expect(playwright).toContain("testDir: './app/e2e'")

		// And the configs are themselves typechecked — a typo in the file that
		// decides what `pnpm test` collects is a gate that silently covers nothing.
		const tsconfig = JSON.parse(
			await readFile(join(root, 'tsconfig.json'), 'utf8'),
		) as { include: string[] }
		expect(tsconfig.include).toContain('*.config.ts')

		// A failed `pnpm e2e` drops traces and screenshots; they are not the user's
		// to commit.
		const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
		expect(gitignore).toContain('test-results')
		expect(gitignore).toContain('playwright-report')
	})
})
