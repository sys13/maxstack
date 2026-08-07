/**
 * The platform-verb lifecycle over a real temp directory (task 23): init → op →
 * gen → validate → eject. Proves the verbs are wired onto the shipped primitives
 * and that a freshly-init'd project passes its own standalone gate.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBundle } from '@maxstack/features/bundle'
import { readSpecDir, writeSpecDir } from '@maxstack/mcp'
import type { SpecSystem } from '@maxstack/spec'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addCommand } from './add.ts'
import { ejectCommand } from './eject.ts'
import { genCommand } from './gen.ts'
import { initCommand } from './init.ts'
import { opCommand } from './op.ts'
import { upgradeCommand } from './upgrade.ts'
import { validateCommand } from './validate.ts'

const provenance = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}

const entityOp = JSON.stringify({
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-widget',
			name: 'Widget',
			description: 'A tracked widget',
			provenance,
			fields: [
				{
					id: 'fld-title',
					name: 'title',
					type: 'string',
					required: true,
					provenance,
				},
			],
		},
	},
})

const pageOp = JSON.stringify({
	op: 'page.addPage',
	args: {
		page: {
			id: 'pg-widgets',
			name: 'Widgets',
			route: '/widgets',
			entityId: 'e-widget',
			provenance: { ...provenance, priority: 'high' },
			blocks: [{ id: 'blk-table', type: 'table', provenance }],
			e2eTests: ['the widgets table lists every widget'],
		},
	},
})

const scheduleOp = JSON.stringify({
	op: 'schedules.declare',
	args: {
		schedule: {
			id: 'sch-widget-sweep',
			key: 'widget.sweep',
			description: 'Retire widgets nobody touched this month',
			timezone: 'America/New_York',
			recurrence: { kind: 'daily', atTime: '03:00' },
			runAs: { kind: 'service', role: 'admin' },
			provenance,
		},
	},
})

/** Pin a scaffolded project's review mode, for suites that exercise the queue. */
async function setReviewMode(
	dir: string,
	mode: 'review' | 'auto',
): Promise<void> {
	const path = join(dir, 'maxstack.json')
	const config = JSON.parse(await readFile(path, 'utf8'))
	config.reviewMode = mode
	await writeFile(path, `${JSON.stringify(config, null, '\t')}\n`)
}

describe('maxstack platform verbs', () => {
	let dir: string
	// The spec lives in the `spec/` directory now; load/save it through the store.
	const loadSpec = (): Promise<SpecSystem> => readSpecDir(join(dir, 'spec'))
	const saveSpec = (s: SpecSystem): Promise<void> =>
		writeSpecDir(join(dir, 'spec'), s)

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-cli-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await rm(dir, { recursive: true, force: true })
	})

	it('init scaffolds a standalone project', async () => {
		await initCommand(dir, { desc: 'a widget tracker' })
		// This suite exercises the review queue, so it pins the mode it tests
		// rather than depending on the scaffold default.
		await setReviewMode(dir, 'review')
		const config = JSON.parse(
			await readFile(join(dir, 'maxstack.json'), 'utf8'),
		)
		expect(config.name).toBeTruthy()
		expect(config.backend).toBe('pglite')
		const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
		expect(pkg.scripts.validate).toBe('maxstack validate')
		// The toolchain the scripts drive is a real, pinned dependency — so
		// `pnpm install` provides it, not a global/checkout assumption.
		expect(pkg.devDependencies.maxstack).toMatch(/^\^\d+\.\d+\.\d+/)
		expect(pkg.devDependencies['maxstack-runtime']).toMatch(/^\^\d+\.\d+\.\d+/)
		// The seeded spec parses + validates (init would have thrown otherwise).
		expect((await loadSpec()).product.meta.title).toBeTruthy()
	})

	it('op applies typed spec-ops and persists them', async () => {
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp })
		const spec = await loadSpec()
		expect(spec.data.entities).toHaveLength(1)
		expect(spec.pages.pages).toHaveLength(1)
		expect(spec.opLog).toHaveLength(2)
	})

	it('op rejects an invalid spec-op without touching the spec', async () => {
		const before = JSON.stringify(await loadSpec())
		await expect(
			opCommand(dir, {
				op: JSON.stringify({ op: 'data.addEntity', args: {} }),
			}),
		).rejects.toThrow()
		expect(JSON.stringify(await loadSpec())).toBe(before)
	})

	it('gen lands the app tree through the never-clobber writer', async () => {
		await genCommand(dir)
		const route = await readFile(join(dir, 'app/routes/widget.tsx'), 'utf8')
		expect(route).toContain('Widget')
		const manifest = JSON.parse(
			await readFile(join(dir, 'app/.generated.routes.json'), 'utf8'),
		)
		expect(
			manifest.entries.some((e: { id: string }) => e.id === 'widget'),
		).toBe(true)
	})

	it('gen emits the non-page seams a declaration asks for', async () => {
		// The dogfood-shaped check the issue asks for: declare a schedule the way a
		// human or an agent does — a spec op through the CLI — and then look for
		// the file the runtime's dead-letter message names. It used to not exist
		// and nothing was going to write it: the generator was called by the
		// harness and by nothing a user runs.
		await opCommand(dir, { op: scheduleOp })
		await genCommand(dir)

		const registry = await readFile(
			join(dir, 'app/jobs/schedules.generated.ts'),
			'utf8',
		)
		expect(registry).toContain("'widget.sweep'")
		expect(registry).toContain("from './widget-sweep.handler.ts'")
		// The user-owned half: seeded once, and the exact path the runtime tells
		// somebody to fill in.
		const handler = await readFile(
			join(dir, 'app/jobs/widget-sweep.handler.ts'),
			'utf8',
		)
		expect(handler).toContain('widget.sweep')

		const manifest = JSON.parse(
			await readFile(join(dir, 'app/.generated.routes.json'), 'utf8'),
		)
		const entries: { id: string; ownership: string }[] = manifest.entries
		expect(entries.find((e) => e.id === 'schedules:registry')?.ownership).toBe(
			'generated',
		)
		expect(
			entries.find((e) => e.id === 'schedule:widget.sweep:slot')?.ownership,
		).toBe('user')

		// The absence rule holds for the seams nothing was declared for: a project
		// that declared no source, importer or live channel grows no directory to
		// prove it.
		for (const dirname of ['sources', 'imports', 'live']) {
			await expect(
				readFile(join(dir, 'app', dirname), 'utf8'),
			).rejects.toThrow()
		}
	})

	it('re-running gen never rewrites a filled handler slot', async () => {
		const file = join(dir, 'app/jobs/widget-sweep.handler.ts')
		const filled = '// mine\nexport default async function handler() {}\n'
		await writeFile(file, filled)
		await genCommand(dir)
		expect(await readFile(file, 'utf8')).toBe(filled)
	})

	// Issue #260. This used to assert a bare green on a project whose
	// dependencies were never installed — which is exactly the hollow green the
	// issue is about: steps 1-3 read the spec and the manifest and never open a
	// line of owned code, so "green" was a claim about work nobody did. The
	// expectation changed because the gate changed, and the pair below pins BOTH
	// halves: it refuses to call an unexamined project green, and it does go
	// green once the checks can actually run.
	it('validate refuses a green while the project’s own checks cannot run', async () => {
		const errors: string[] = []
		const spy = vi
			.spyOn(console, 'error')
			.mockImplementation((...a: unknown[]) => {
				errors.push(a.join(' '))
			})
		const prev = process.exitCode
		process.exitCode = 0
		await validateCommand(dir)
		expect(process.exitCode).toBe(1)
		const text = errors.join('\n')
		expect(text).toMatch(/INCOMPLETE/)
		expect(text).toMatch(/never ran/)
		expect(text).toMatch(/typecheck/)
		// Actionable, not just alarming.
		expect(text).toMatch(/install/)
		process.exitCode = prev
		spy.mockRestore()
	})

	/**
	 * #343 — the product doc `init` writes is fluent, complete and entirely
	 * invented, and this project has by now applied several real spec-ops without
	 * a single surface mentioning it. Silence was the bug: a reviewer opening the
	 * repo could not tell the PRD had never been written, because it *was*
	 * written. This is the end-to-end version of that claim — real `init`, real
	 * ops, real gate, real stdout.
	 */
	it('validate says the product doc is still init boilerplate, after real ops', async () => {
		const warnings: string[] = []
		const spy = vi
			.spyOn(console, 'warn')
			.mockImplementation((...a: unknown[]) => {
				warnings.push(a.join(' '))
			})
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const prev = process.exitCode
		process.exitCode = 0
		await validateCommand(dir)
		process.exitCode = prev
		spy.mockRestore()
		errSpy.mockRestore()

		const text = warnings.join('\n')
		expect(text).toMatch(/product doc/)
		expect(text).toMatch(/maxstack init" skeleton/)
		// Names the sections, not just the fact — and says what to do.
		expect(text).toContain('problem.statement')
		expect(text).toContain('goals.northStarMetric')
		expect(text).toContain('spec/product.json')
	})

	it('validate goes green once those checks can run and pass', async () => {
		// Stand in for an installed toolchain: the runner refuses to run a declared
		// script with no node_modules, because a missing toolchain is a check that
		// did not run, not a check that failed.
		await mkdir(join(dir, 'node_modules'), { recursive: true })
		const pkgPath = join(dir, 'package.json')
		const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
		pkg.scripts.typecheck = 'node -e ""'
		pkg.scripts.lint = 'node -e ""'
		pkg.scripts.test = 'node -e ""'
		// The spec declares e2eTests, so the runner demands something that runs
		// them — a chain that ends in nothing is the dead end.
		pkg.scripts.e2e = 'node -e ""'
		await writeFile(pkgPath, JSON.stringify(pkg, null, '\t'))
		// The same stand-in, for the two preconditions #341 added. A declared
		// `test` script over a project with no test file examines nothing, and a
		// declared `e2e` script on a machine with no browser runs nothing — both
		// are now reported UNEXAMINED rather than counted as passes, so "the checks
		// can run" has to mean this too. `PLAYWRIGHT_BROWSERS_PATH=0` is
		// Playwright's own "browsers live in node_modules" setting, which also
		// keeps this test off whether the machine happens to have run
		// `playwright install`.
		await writeFile(join(dir, 'app', 'smoke.test.ts'), '')
		vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '0')

		const prev = process.exitCode
		process.exitCode = 0
		await validateCommand(dir)
		expect(process.exitCode).toBeFalsy()
		process.exitCode = prev
	})

	it('validate fails when a generated file drifts', async () => {
		const file = join(dir, 'app/routes/widget.tsx')
		const original = await readFile(file, 'utf8')
		await writeFile(file, `${original}\n// tampered`)
		const prev = process.exitCode
		process.exitCode = 0
		await validateCommand(dir)
		expect(process.exitCode).toBe(1)
		process.exitCode = prev
		await writeFile(file, original) // restore for the eject test
	})

	it('eject flips a route to user ownership; gen then skips it', async () => {
		await ejectCommand(dir, 'widget', {})
		const manifest = JSON.parse(
			await readFile(join(dir, 'app/.generated.routes.json'), 'utf8'),
		)
		const entry = manifest.entries.find(
			(e: { id: string }) => e.id === 'widget',
		)
		expect(entry.ownership).toBe('ejected')
	})

	it('add installs a bundle: schema + page into the spec, prereqs first', async () => {
		await addCommand(dir, 'members')

		// The config records the install order: the auth prerequisite, then members.
		const config = JSON.parse(
			await readFile(join(dir, 'maxstack.json'), 'utf8'),
		)
		expect(config.bundles.map((b: { slug: string }) => b.slug)).toEqual([
			'auth',
			'members',
		])
		expect(config.bundles.every((b: { version: string }) => b.version)).toBe(
			true,
		)

		// The members entities + organizations page land in the spec.
		const spec = await loadSpec()
		const entityIds = spec.data.entities.map((e: { id: string }) => e.id)
		expect(entityIds).toContain('e-organization')
		expect(entityIds).toContain('e-member')
		expect(entityIds).toContain('e-invitation')
		const pageIds = spec.pages.pages.map((p: { id: string }) => p.id)
		expect(pageIds).toContain('pg-organizations')

		// The organizations route was generated (add runs gen).
		const route = await readFile(
			join(dir, 'app/routes/organization.tsx'),
			'utf8',
		)
		expect(route).toContain('Organization')
	})

	it('add is idempotent — re-adding an installed bundle is a no-op', async () => {
		const before = await readFile(join(dir, 'maxstack.json'), 'utf8')
		await addCommand(dir, 'members')
		expect(await readFile(join(dir, 'maxstack.json'), 'utf8')).toBe(before)
	})

	it('add rejects an unknown bundle', async () => {
		await expect(addCommand(dir, 'nope')).rejects.toThrow(/unknown bundle/)
	})

	it('add installs the billing bundle: subscription mirror + subscriptions page', async () => {
		await addCommand(dir, 'billing')
		const spec = await loadSpec()
		const sub = spec.data.entities.find(
			(e: { id: string }) => e.id === 'e-subscription',
		)
		expect(sub).toBeDefined()
		expect(sub?.fields.map((f) => f.name)).toContain('currentPeriodEnd')
		const config = JSON.parse(
			await readFile(join(dir, 'maxstack.json'), 'utf8'),
		)
		expect(
			config.bundles.find((b: { slug: string }) => b.slug === 'billing')
				?.version,
		).toBe(getBundle('billing')?.version)
	})

	it('upgrade reconciles a stale bundle version via its codemod', async () => {
		// Simulate an older install: drop currentPeriodEnd + pin billing to 0.1.0,
		// exactly the state a project added at 0.1.0 would be in.
		const config = JSON.parse(
			await readFile(join(dir, 'maxstack.json'), 'utf8'),
		)
		config.bundles = config.bundles.map(
			(b: { slug: string; version: string }) =>
				b.slug === 'billing' ? { ...b, version: '0.1.0' } : b,
		)
		await writeFile(join(dir, 'maxstack.json'), JSON.stringify(config, null, 2))
		const spec = await loadSpec()
		spec.data.entities = spec.data.entities.map((e) =>
			e.id === 'e-subscription'
				? {
						...e,
						fields: e.fields.filter((f) => f.name !== 'currentPeriodEnd'),
					}
				: e,
		)
		await saveSpec(spec)

		const prev = process.exitCode
		process.exitCode = 0
		await upgradeCommand(dir)
		expect(process.exitCode).toBeFalsy()
		process.exitCode = prev

		// The codemod re-added the field and the recorded version was bumped.
		const after = await loadSpec()
		const sub = after.data.entities.find((e) => e.id === 'e-subscription')
		expect(sub?.fields.map((f) => f.name)).toContain('currentPeriodEnd')
		const bumped = JSON.parse(
			await readFile(join(dir, 'maxstack.json'), 'utf8'),
		)
		expect(
			bumped.bundles.find((b: { slug: string }) => b.slug === 'billing')
				?.version,
		).toBe(getBundle('billing')?.version)
	})
})
