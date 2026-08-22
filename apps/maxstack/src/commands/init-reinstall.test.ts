/**
 * A scaffolded project must survive being installed from its **own lockfile**
 *.
 *
 * The shipped bug: `maxstack init` writes no lockfile, so one first appears
 * after the user's `npm install`. Install a second time *from that lockfile* —
 * a clone, a teammate's checkout, a CI checkout — and npm pruned `drizzle-orm`,
 * because the copy satisfying `better-auth`'s peer had been placed by npm's
 * peer auto-install and no dependency edge pointed at it. The app then died
 * before serving a page:
 *
 *   Cannot find package 'drizzle-orm' imported from
 *   node_modules/@better-auth/drizzle-adapter/dist/index.mjs
 *
 * A single install cannot observe this class of bug, which is why it shipped.
 * So the suite below installs **twice**, the second time into a directory that
 * has the lockfile and no `node_modules`, exactly as the reproduction does.
 *
 * These tests reach the npm registry deliberately. Nothing offline can observe
 * a resolver bug, and gating them behind an env var would mean a suite that
 * reports green having never run — which is the failure mode this whole issue
 * is about.
 */

import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { pathExists } from '../fsx.ts'
import { PINNED_DEP } from '../lib/cli-resolution.ts'
import { initCommand, scaffoldOverrides } from './init.ts'
import { startCommand } from './start.ts'

const run = promisify(execFile)
const NPM_TIMEOUT_MS = 240_000
/** Two npm installs against a possibly-cold cache, plus a pack. */
const CASE_TIMEOUT_MS = 600_000

const workspaceRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../..',
)

async function manifest(rel: string): Promise<{
	dependencies?: Record<string, string>
}> {
	return JSON.parse(await readFile(resolve(workspaceRoot, rel), 'utf8'))
}

const temps: string[] = []
afterAll(async () => {
	for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true })
})

async function temp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	temps.push(dir)
	return dir
}

describe('the scaffolded pin tracks the runtime', () => {
	it('pins the exact drizzle-orm the runtime depends on', async () => {
		// `scaffoldOverrides` reads the *CLI's* manifest, because that is the file
		// on disk when `init` runs (nothing is installed yet). What has to survive
		// an install, though, is the copy `maxstack-runtime` depends on, and its
		// published manifest is generated from apps/web. Bump one and not the
		// other and the scaffold would pin a version the runtime does not use —
		// silently, and only observable after a publish. So assert they agree.
		const web = await manifest('apps/web/package.json')
		const cli = await manifest('apps/maxstack/package.json')

		expect(web.dependencies?.[PINNED_DEP]).toBeTruthy()
		expect(cli.dependencies?.[PINNED_DEP]).toBe(web.dependencies?.[PINNED_DEP])
		expect((await scaffoldOverrides())[PINNED_DEP]).toBe(
			web.dependencies?.[PINNED_DEP],
		)
	})

	it('writes the override into the scaffolded manifest', async () => {
		const parent = await temp('maxstack-init-overrides-')
		const root = join(parent, 'pinned')
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})

		await initCommand(root, { desc: 'a widget tracker', git: false })
		vi.restoreAllMocks()

		const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
		expect(pkg.overrides?.[PINNED_DEP]).toBe(
			(await manifest('apps/web/package.json')).dependencies?.[PINNED_DEP],
		)
	})

	it('writes it from `start` too, not only from `init`', async () => {
		// The bug report names *both* entry points, and a user's very first
		// project usually comes from `start`, not `init`. `start` gets the pin
		// today only because it delegates to the same `scaffoldProject` — an
		// implementation detail, invisible from the outside and free to drift.
		// If it ever grows a manifest writer of its own, the override is exactly
		// the kind of one-line detail that would not be carried across, and the
		// resulting breakage appears one install later on someone else's
		// machine. So assert the observable thing: the manifest `start` leaves
		// on disk.
		const parent = await temp('maxstack-start-overrides-')
		const root = join(parent, 'started')
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.stubEnv('MOCK_AI', '1')

		await startCommand('a bug tracker for small teams', root, { dev: false })
		vi.unstubAllEnvs()
		vi.restoreAllMocks()

		const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
		expect(pkg.overrides?.[PINNED_DEP]).toBe(
			(await manifest('apps/web/package.json')).dependencies?.[PINNED_DEP],
		)
	})
})

describe('a lockfile-driven reinstall keeps the runtime whole', () => {
	/**
	 * A stand-in for `maxstack-runtime`, packed to a tarball.
	 *
	 * It cannot be the real thing: the version under test is unpublished, so
	 * installing `maxstack-runtime` would resolve to an older release and test
	 * yesterday's tree. What matters is the *shape*, and this reproduces it
	 * exactly — a dependency of the project (not the project itself) that pulls
	 * in both `better-auth`, whose adapter the runtime loads at boot, and the
	 * `drizzle-orm` we ship, whose range that adapter's peer declaration does not
	 * accept.
	 *
	 * A tarball rather than `file:./dir`: npm installs a directory dependency as
	 * a *link*, and root `overrides` do not reach a link's own tree, so the
	 * directory form would report the fix as not working when it does.
	 */
	async function packRuntimeStandIn(dir: string): Promise<string> {
		const web = await manifest('apps/web/package.json')
		const src = join(dir, 'runtime-src')
		await mkdir(src, { recursive: true })
		await writeFile(
			join(src, 'package.json'),
			`${JSON.stringify(
				{
					name: 'maxstack-runtime-standin',
					version: '0.0.0',
					dependencies: {
						'better-auth': web.dependencies?.['better-auth'],
						[PINNED_DEP]: web.dependencies?.[PINNED_DEP],
					},
				},
				null,
				2,
			)}\n`,
		)
		const { stdout } = await run(
			'npm',
			['pack', src, '--pack-destination', dir, '--silent'],
			{ cwd: dir, timeout: NPM_TIMEOUT_MS },
		)
		const tarball = stdout.trim().split('\n').at(-1)
		if (!tarball) throw new Error('npm pack produced no tarball name')
		return tarball
	}

	/** Install once, then again in a copy that has the lockfile but no tree. */
	async function installTwice(prefix: string, withOverrides: boolean) {
		const first = await temp(prefix)
		const tarball = await packRuntimeStandIn(first)
		const pkg = {
			name: 'reinstall-fixture',
			version: '0.0.0',
			private: true,
			dependencies: { 'maxstack-runtime-standin': `file:./${tarball}` },
			...(withOverrides ? { overrides: await scaffoldOverrides() } : {}),
		}
		await writeFile(
			join(first, 'package.json'),
			`${JSON.stringify(pkg, null, 2)}\n`,
		)
		const args = ['install', '--no-audit', '--no-fund']
		await run('npm', args, { cwd: first, timeout: NPM_TIMEOUT_MS })
		expect(await pathExists(join(first, 'package-lock.json'))).toBe(true)

		// The move that breaks it: the project travels with its lockfile and
		// without its node_modules, and is installed where it lands.
		const second = await temp(`${prefix}clone-`)
		for (const f of ['package.json', 'package-lock.json', tarball])
			await cp(join(first, f), join(second, f))
		await run('npm', args, { cwd: second, timeout: NPM_TIMEOUT_MS })
		return { first, second }
	}

	/** The version of the hoisted copy — the one the adapter resolves at boot. */
	async function hoisted(root: string): Promise<string | null> {
		try {
			const pkg = JSON.parse(
				await readFile(
					join(root, 'node_modules', PINNED_DEP, 'package.json'),
					'utf8',
				),
			) as { version: string }
			return pkg.version
		} catch {
			return null
		}
	}

	it(
		'leaves drizzle-orm resolvable after the second install',
		async () => {
			const { first, second } = await installTwice(
				'maxstack-reinstall-pinned-',
				true,
			)
			const pinned = (await scaffoldOverrides())[PINNED_DEP]

			// One copy, at the version the runtime actually depends on, reachable by a
			// real dependency edge — so nothing can prune it.
			expect(await hoisted(first)).toBe(pinned)
			expect(await hoisted(second)).toBe(pinned)
			expect(
				await pathExists(
					join(
						second,
						'node_modules/maxstack-runtime-standin/node_modules',
						PINNED_DEP,
					),
				),
			).toBe(false)
		},
		CASE_TIMEOUT_MS,
	)

	it(
		'records that upstream stopped pruning — the override is now belt, not braces',
		async () => {
			// The guard on the guard, and it has already done its job once.
			//
			// It used to assert `hoisted(second)` was `null`: that without the
			// override the reinstall still pruned, so the test above could not be
			// passing for some unrelated reason. It fired — upstream fixed the prune,
			// and the unpinned reinstall now keeps a resolvable copy.
			//
			// So the assertion is inverted rather than deleted, because the fact it
			// watches is still worth watching and is now interesting in **both**
			// directions:
			//
			//  - Staying truthy means the override is redundant. It is kept anyway —
			//    it costs a line in a scaffolded manifest and pins the copy the
			//    runtime ships, and a redundant pin is cheaper than rediscovering
			//    this failure mode in somebody's generated project.
			//  - Going back to `null` means the prune returned and the override
			//    became load-bearing again. That would fail here, which is the
			//    whole point of keeping the case.
			//
			// Deleting it would leave the test above passing with nothing saying
			// whether the override or the ecosystem is the reason.
			const { first, second } = await installTwice(
				'maxstack-reinstall-unpinned-',
				false,
			)
			expect(await hoisted(first)).toBeTruthy()
			expect(await hoisted(second)).toBeTruthy()
		},
		CASE_TIMEOUT_MS,
	)
})
