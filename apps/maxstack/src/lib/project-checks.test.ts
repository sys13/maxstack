/**
 * The project check registry — what runs, and what is reported as
 * never having run.
 *
 * The second half is the one under test here. A check that is silently absent is
 * indistinguishable from a check that passed, and `run_checks` answering
 * `ok: true` over code nothing examined is the failure mode the whole registry
 * exists to close.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from './project.ts'
import { e2eBlocker, projectCheckRunner } from './project-checks.ts'

const dirs: string[] = []

async function projectAt(
	pkg: unknown,
	opts: { installed?: boolean; manifest?: { entries: unknown[] } } = {},
) {
	const root = await mkdtemp(join(tmpdir(), 'maxstack-checks-'))
	dirs.push(root)
	if (pkg !== null)
		await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, '\t'))
	if (opts.installed) await mkdir(join(root, 'node_modules'), { recursive: true })
	const appPath = join(root, 'app')
	if (opts.manifest) {
		await mkdir(appPath, { recursive: true })
		await writeFile(
			join(appPath, '.generated.routes.json'),
			JSON.stringify({ version: 1, ...opts.manifest }),
		)
	}
	return { root, appPath } as Project
}

afterEach(async () => {
	vi.unstubAllEnvs()
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('projectCheckRunner', () => {
	it('names every expected check the project does not declare', async () => {
		const runner = await projectCheckRunner(await projectAt({ scripts: {} }))
		const unavailable = (await runner.unavailable?.()) ?? []
		expect(unavailable.map((u) => u.name).sort()).toEqual([
			'lint',
			'test',
			'typecheck',
		])
	})

	it('says WHY each one matters, not just that it is missing', async () => {
		const runner = await projectCheckRunner(await projectAt({ scripts: {} }))
		const typecheck = ((await runner.unavailable?.()) ?? []).find(
			(u) => u.name === 'typecheck',
		)
		expect(typecheck?.reason).toMatch(/no "typecheck" script/)
		expect(typecheck?.reason).toMatch(/nothing type-checks the code you own/)
		expect(typecheck?.remedy).toMatch(/tsc --noEmit/)
	})

	it('registers a declared script as a real check once deps are installed', async () => {
		const runner = await projectCheckRunner(
			await projectAt(
				{ scripts: { typecheck: 'tsc --noEmit' } },
				{ installed: true },
			),
		)
		expect(runner.list().map((c) => c.name)).toContain('typecheck')
		expect((await runner.unavailable?.()) ?? []).toEqual([
			expect.objectContaining({ name: 'lint' }),
			expect.objectContaining({ name: 'test' }),
		])
	})

	it('treats a declared-but-uninstalled script as unexamined, not as failing', async () => {
		// The distinction is load-bearing in the other direction too: reporting
		// `npm run typecheck` exiting 127 as a FAILING typecheck would be just as
		// misleading as omitting it, because it says nothing about the code.
		const runner = await projectCheckRunner(
			await projectAt({ scripts: { typecheck: 'tsc --noEmit' } }),
		)
		expect(runner.list().map((c) => c.name)).not.toContain('typecheck')
		const typecheck = ((await runner.unavailable?.()) ?? []).find(
			(u) => u.name === 'typecheck',
		)
		expect(typecheck?.reason).toMatch(/dependencies are not installed/)
		expect(typecheck?.remedy).toMatch(/install/)
	})

	it('reports all three as unavailable when there is no package.json at all', async () => {
		const runner = await projectCheckRunner(await projectAt(null))
		expect(((await runner.unavailable?.()) ?? []).length).toBe(3)
	})

	it('names a real command in every remedy, never the script name twice', async () => {
		// `"lint": "lint"` is not a runnable command. An agent that follows that
		// remedy literally ships a package.json that fails differently, and the
		// next run reports a check that ERRORS instead of one that is missing.
		const runner = await projectCheckRunner(await projectAt({ scripts: {} }))
		const byName = new Map(
			((await runner.unavailable?.()) ?? []).map((u) => [u.name, u]),
		)
		expect(byName.get('lint')?.remedy).toContain('"lint": "biome check ."')
		expect(byName.get('test')?.remedy).toContain('"test": "vitest run"')
		expect(byName.get('typecheck')?.remedy).toContain(
			'"typecheck": "tsc --noEmit"',
		)
		for (const u of byName.values())
			expect(u.remedy).not.toMatch(/"(\w+)": "\1"/)
	})

	it('does not withhold the green from a project that owns no code yet', async () => {
		// The scaffold failing its own gate on creation. `maxstack init` writes a
		// manifest with no owned entries, so there is no code for typecheck / lint
		// / test to examine — and a gate that is red no matter what the person did
		// is a gate agents learn to read past.
		const runner = await projectCheckRunner(
			await projectAt(
				{ scripts: { typecheck: 'tsc --noEmit' } },
				{ manifest: { entries: [] } },
			),
		)
		const unavailable = (await runner.unavailable?.()) ?? []
		expect(unavailable.map((u) => u.name).sort()).toEqual([
			'lint',
			'test',
			'typecheck',
		])
		// Named — never omitted. Only the blocking flag differs.
		expect(unavailable.every((u) => u.blocking === false)).toBe(true)
	})

	it('counts a seam handler as owned code, not just a route slot', async () => {
		// A schedule/source/import/live handler stub gets a `user` entry of its
		// own, with no `slotFile` — the shape `doctor`'s owned-module count misses.
		const runner = await projectCheckRunner(
			await projectAt(
				{ scripts: {} },
				{
					manifest: {
						entries: [
							{
								id: 'sch-widget-sweep:handler',
								routePath: '',
								file: 'app/jobs/widget-sweep.handler.ts',
								ownership: 'user',
							},
						],
					},
				},
			),
		)
		const unavailable = (await runner.unavailable?.()) ?? []
		expect(unavailable.some((u) => u.blocking === false)).toBe(false)
	})

	it('demands them again the moment a slot is filled', async () => {
		const runner = await projectCheckRunner(
			await projectAt(
				{ scripts: { typecheck: 'tsc --noEmit' } },
				{
					manifest: {
						entries: [
							{
								file: 'app/routes/decks.tsx',
								ownership: 'generated',
								slotFile: 'app/slots/decks.tsx',
							},
						],
					},
				},
			),
		)
		const unavailable = (await runner.unavailable?.()) ?? []
		expect(unavailable.length).toBeGreaterThan(0)
		expect(unavailable.some((u) => u.blocking === false)).toBe(false)
	})

	it('always keeps spec-validate, which needs nothing from the project', async () => {
		const runner = await projectCheckRunner(await projectAt(null))
		expect(runner.list().map((c) => c.name)).toEqual(['spec-validate'])
	})
})

describe('the e2e check', () => {
	it('is not demanded of a project that declares no e2e tests', async () => {
		const project = await projectAt({ scripts: {} })
		const runner = await projectCheckRunner({
			...project,
			spec: { load: async () => ({ pages: { pages: [] } }) },
		} as unknown as Project)
		expect(((await runner.unavailable?.()) ?? []).map((u) => u.name)).not.toContain(
			'e2e',
		)
	})

	it('is demanded, with the command to add, once a page declares them', async () => {
		// The dead end this closes: an agent is told to declare e2eTests and
		// scaffold the specs, then finds nothing that runs them, and goes back to
		// driving a browser by hand.
		const project = await projectAt({ scripts: {} })
		const runner = await projectCheckRunner({
			...project,
			spec: {
				load: async () => ({
					pages: { pages: [{ e2eTests: ['a user can archive a deck'] }] },
				}),
			},
		} as unknown as Project)
		const e2e = ((await runner.unavailable?.()) ?? []).find(
			(u) => u.name === 'e2e',
		)
		expect(e2e?.reason).toMatch(
			/nothing runs the end-to-end tests the pages declare/,
		)
		expect(e2e?.remedy).toMatch(/playwright test/)
	})

	it('runs it as a real check once the project declares the script', async () => {
		// `0` is Playwright's own "browsers live in node_modules" setting, which
		// this module treats as installed. Pinned here so the result does not
		// depend on whether the machine running the suite happens to have run
		// `playwright install` — see the browsers test below.
		vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '0')
		const project = await projectAt(
			{ scripts: { e2e: 'playwright test' } },
			{ installed: true },
		)
		const runner = await projectCheckRunner({
			...project,
			spec: {
				load: async () => ({
					pages: { pages: [{ e2eTests: ['a user can archive a deck'] }] },
				}),
			},
		} as unknown as Project)
		expect(runner.list().map((c) => c.name)).toContain('e2e')
	})

	it('withholds the green even from a project that owns no code (#377)', async () => {
		// The dogfood project: a global CLI, no `node_modules`, four declared
		// e2eTests, the specs on disk and the app serving — and `run_checks`
		// answering `pass` with `e2e` listed as "did not apply here". `blocking`
		// is `ownsCode` for typecheck/lint/test because THEIR subject is the owned
		// code. `e2e`'s subject is the running application, which every generated
		// project has, and its applicability was already settled by the spec.
		const project = await projectAt(
			{ scripts: { e2e: 'playwright test' } },
			{ manifest: { entries: [] } },
		)
		const runner = await projectCheckRunner({
			...project,
			spec: {
				load: async () => ({
					pages: { pages: [{ e2eTests: ['a user can archive a deck'] }] },
				}),
			},
		} as unknown as Project)
		const unavailable = (await runner.unavailable?.()) ?? []
		// The other three still soften — this fix is narrow on purpose.
		expect(
			unavailable.filter((u) => u.blocking === false).map((u) => u.name).sort(),
		).toEqual(['lint', 'test', 'typecheck'])
		expect(
			unavailable.find((u) => u.name === 'e2e')?.blocking,
		).toBe(true)
	})

	it('reads as one sentence when the deps are the thing missing', async () => {
		// The `why` clause completes "…, so ${why}" for all three prefixes. Written
		// for one of them, it produces `"e2e" is declared but this project's
		// dependencies are not installed, so the pages declare e2eTests and nothing
		// runs them` — which parses as nothing.
		const project = await projectAt({ scripts: { e2e: 'playwright test' } })
		const runner = await projectCheckRunner({
			...project,
			spec: {
				load: async () => ({
					pages: { pages: [{ e2eTests: ['a user can archive a deck'] }] },
				}),
			},
		} as unknown as Project)
		expect(
			((await runner.unavailable?.()) ?? []).find((u) => u.name === 'e2e')
				?.reason,
		).toBe(
			`"e2e" is declared but this project's dependencies are not installed, so nothing runs the end-to-end tests the pages declare`,
		)
	})
})

describe('e2eBlocker', () => {
	it('answers with the gate\'s own reason and remedy', async () => {
		const project = await projectAt({ scripts: { e2e: 'playwright test' } })
		const blocker = await e2eBlocker(project)
		expect(blocker?.reason).toMatch(/dependencies are not installed/)
		expect(blocker?.remedy).toMatch(/npm install/)
	})

	it('answers null when the suite can actually run', async () => {
		vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '0')
		const project = await projectAt(
			{ scripts: { e2e: 'playwright test' } },
			{ installed: true },
		)
		expect(await e2eBlocker(project)).toBeNull()
	})
})

/**
 * #341 — a declared script is not the same thing as a check that examined
 * something.
 *
 * The scaffold now declares `lint`, `test` and `e2e`, which closes the "package
 * .json declares no X script" report the issue opened on. It opens two new ways
 * for the same hollow green to come back, and both are refused here: a `test`
 * script over a project with no test files, and an `e2e` script on a machine
 * where Playwright has no browser to drive. Neither says anything about the
 * code, so neither may borrow the colour of a check that did.
 */
describe('a declared script that would examine nothing (#341)', () => {
	it('reports "test" as unexamined when there are no test files', async () => {
		// `vitest run --passWithNoTests` — what the scaffold declares — exits 0
		// over an empty suite. Correct for a runner, and a false green for a gate.
		const project = await projectAt(
			{ scripts: { test: 'vitest run --passWithNoTests' } },
			{ installed: true },
		)
		const runner = await projectCheckRunner(project)
		expect(runner.list().map((c) => c.name)).not.toContain('test')
		const test = ((await runner.unavailable?.()) ?? []).find(
			(u) => u.name === 'test',
		)
		expect(test?.reason).toMatch(/no test files/)
		expect(test?.remedy).toMatch(/app\/\*\*\/\*\.test\.ts/)
	})

	it('runs "test" the moment one test file exists', async () => {
		const project = await projectAt(
			{ scripts: { test: 'vitest run --passWithNoTests' } },
			{ installed: true },
		)
		await mkdir(join(project.appPath, 'routes'), { recursive: true })
		await writeFile(join(project.appPath, 'routes/deck.test.ts'), '')
		const runner = await projectCheckRunner(project)
		expect(runner.list().map((c) => c.name)).toContain('test')
	})

	it('does not count a Playwright spec as a unit test', async () => {
		// `.spec.ts` under `app/e2e/` is the `e2e` check's, and the scaffolded
		// `vitest.config.ts` deliberately does not collect it. Counting it here
		// would report `test` as running over files vitest never opens.
		const project = await projectAt(
			{ scripts: { test: 'vitest run --passWithNoTests' } },
			{ installed: true },
		)
		await mkdir(join(project.appPath, 'e2e'), { recursive: true })
		await writeFile(join(project.appPath, 'e2e/deck.spec.ts'), '')
		const runner = await projectCheckRunner(project)
		expect(runner.list().map((c) => c.name)).not.toContain('test')
	})

	it('reports "e2e" as unexamined — not failed — when browsers are missing', async () => {
		// `playwright test` without browsers fails legibly, but it fails RED, and
		// red says "your code is broken". Nothing about the code is broken: a
		// one-time download that `npm install` deliberately does not perform has
		// not happened.
		const empty = await mkdtemp(join(tmpdir(), 'maxstack-no-browsers-'))
		dirs.push(empty)
		vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', empty)
		const project = await projectAt(
			{ scripts: { e2e: 'playwright test' } },
			{ installed: true },
		)
		const runner = await projectCheckRunner({
			...project,
			spec: {
				load: async () => ({
					pages: { pages: [{ e2eTests: ['a user can archive a deck'] }] },
				}),
			},
		} as unknown as Project)
		expect(runner.list().map((c) => c.name)).not.toContain('e2e')
		const e2e = ((await runner.unavailable?.()) ?? []).find(
			(u) => u.name === 'e2e',
		)
		expect(e2e?.reason).toMatch(/no browsers on this machine/)
		expect(e2e?.remedy).toMatch(/playwright install/)
	})

	it('still says "no script" first, when there is no script', async () => {
		// Order matters: a project that never declared `test` must hear that,
		// not "you have no test files" — the second is true and following it
		// would not make the check run.
		const runner = await projectCheckRunner(
			await projectAt({ scripts: {} }, { installed: true }),
		)
		const test = ((await runner.unavailable?.()) ?? []).find(
			(u) => u.name === 'test',
		)
		expect(test?.reason).toMatch(/declares no "test" script/)
	})
})
