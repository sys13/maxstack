/**
 * Regression guard for issue #94: `maxstack dev` on a prebuilt-runtime project
 * served every `/assets/*` as 404 because the react-router server was spawned
 * with no `cwd`, so its *relative* `assetsBuildDirectory` resolved against the
 * user's project dir instead of the runtime package dir. The spawn options must
 * pin `cwd` to the runtime package dir (which contains `build/`).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { devServerFinding } from '../lib/preflight.ts'
import type { Runtime } from '../lib/runtime.ts'
import {
	ownedGapNotice,
	packageServeSpawnOptions,
	readDevServerPort,
	readDevServerRecord,
	removeDevServerFile,
	resolveDemoTarget,
	seedSummary,
	selectPackageDevPath,
	writeDevServerFile,
} from './dev.ts'

const runtime: Extract<Runtime, { mode: 'package' }> = {
	mode: 'package',
	version: '0.0.0-test',
	pkgDir: '/tmp/maxstack-runtime',
	root: '/tmp/maxstack-runtime/workspace',
	serverIndex: '/tmp/maxstack-runtime/build/server/index.js',
	seedScript: '/tmp/maxstack-runtime/seed-demo.mjs',
}

describe('packageServeSpawnOptions', () => {
	it('pins cwd to the runtime package dir so /assets/* resolves', () => {
		const opts = packageServeSpawnOptions(runtime, '/data', '5199', 'pglite')
		// Without this cwd, express.static(build/client) resolves against the
		// user's project dir and every hashed asset 404s.
		expect(opts.cwd).toBe('/tmp/maxstack-runtime')
		expect(opts.env.PORT).toBe('5199')
		expect(opts.env.MAXSTACK_DATA_DIR).toBe('/data')
		expect(opts.env.NODE_ENV).toBe('production')
	})

	it('inherits stdio so the server logs stream to the terminal', () => {
		expect(
			packageServeSpawnOptions(runtime, '/data', '3000', 'pglite').stdio,
		).toBe('inherit')
	})

	// The vite dev paths pin `host: '127.0.0.1'` (apps/web/vite.config.ts), and
	// `dev` chooses between them and this one on the user's behalf, from whether
	// a slot happens to be filled. Left unset, `@react-router/serve` binds every
	// interface and the app is reached as `localhost` — a different *origin*
	// from `127.0.0.1`, and therefore a different `localStorage`. Crossing
	// between dev paths then wipes every client-persisted preference: the
	// cookie-banner dismissal, saved queries, column prefs.
	it('pins the same loopback host the vite dev paths bind', () => {
		expect(
			packageServeSpawnOptions(runtime, '/data', '3000', 'pglite').env.HOST,
		).toBe('127.0.0.1')
	})
})

describe('seedSummary', () => {
	const json = (body: unknown) => Response.json(body) as unknown as Response

	it('names the resources that committed', async () => {
		const line = await seedSummary(
			json({ seeded: true, resources: ['book', 'author'] }),
			'3000',
		)
		expect(line).toBe(
			'✓ demo data loaded via the running dev server (port 3000) (book, author)',
		)
	})

	it('reports the idempotent no-op instead of a false success', async () => {
		const line = await seedSummary(
			json({ seeded: false, resources: [] }),
			'3000',
		)
		expect(line).toContain('nothing to seed')
		expect(line).toContain('already have data')
	})

	it('falls back to a generic line for an older runtime that redirects', async () => {
		// Opaque redirect: status 0, no JSON body — the rows still committed, so
		// this reports success without the per-resource detail.
		const redirectish = new Response(null, { status: 302 })
		const line = await seedSummary(redirectish, '4000')
		expect(line).toBe(
			'✓ demo data loaded via the running dev server (port 4000)',
		)
	})
})

/**
 * Issue #116: `demo` must target the dev server the user actually started —
 * `--port`, then `PORT`, then the port `maxstack dev` recorded in the data
 * dir — never a blind default to 3000 while a server runs elsewhere.
 */
describe('demo port resolution', () => {
	let dataDir: string
	afterEach(() => rm(dataDir, { recursive: true, force: true }))
	const freshDataDir = async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'maxstack-demo-'))
		return dataDir
	}

	it('prefers an explicit --port over everything', async () => {
		const dir = await freshDataDir()
		await writeDevServerFile(dir, '3111')
		expect(await resolveDemoTarget(dir, { port: '4000' }, '5000')).toEqual({
			port: '4000',
			source: 'flag',
		})
	})

	it('prefers PORT env over the recorded server', async () => {
		const dir = await freshDataDir()
		await writeDevServerFile(dir, '3111')
		expect(await resolveDemoTarget(dir, {}, '5000')).toEqual({
			port: '5000',
			source: 'env',
		})
	})

	it('targets the port `maxstack dev` recorded, not the default', async () => {
		// The issue's exact failure: dev on 3111, demo silently seeding 3000.
		const dir = await freshDataDir()
		await writeDevServerFile(dir, '3111')
		expect(await resolveDemoTarget(dir, {}, undefined)).toEqual({
			port: '3111',
			source: 'recorded',
		})
	})

	it('falls back to 3000 when nothing is recorded', async () => {
		const dir = await freshDataDir()
		expect(await resolveDemoTarget(dir, {}, undefined)).toEqual({
			port: '3000',
			source: 'default',
		})
	})

	it('ignores an unreadable or malformed record', async () => {
		const dir = await freshDataDir()
		await writeDevServerFile(dir, '')
		expect(await resolveDemoTarget(dir, {}, undefined)).toEqual({
			port: '3000',
			source: 'default',
		})
	})
})

describe('dev-server record lifecycle', () => {
	let dataDir: string
	afterEach(() => rm(dataDir, { recursive: true, force: true }))

	it('round-trips the port and removes cleanly', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'maxstack-devrec-'))
		await writeDevServerFile(dataDir, '3111', 42)
		expect(await readDevServerPort(dataDir)).toBe('3111')
		expect(
			JSON.parse(await readFile(join(dataDir, 'dev-server.json'), 'utf8')),
		).toEqual({ port: '3111', pid: 42 })
		await removeDevServerFile(dataDir)
		expect(await readDevServerPort(dataDir)).toBeNull()
	})

	it('pid-guarded removal leaves a newer server’s record alone', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'maxstack-devrec-'))
		await writeDevServerFile(dataDir, '3111', 42)
		// An exiting older dev (pid 41) must not delete the newer record (pid 42).
		await removeDevServerFile(dataDir, 41)
		expect(await readDevServerPort(dataDir)).toBe('3111')
		await removeDevServerFile(dataDir, 42)
		expect(await readDevServerPort(dataDir)).toBeNull()
	})

	it('removal of a missing record is a no-op, not an error', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'maxstack-devrec-'))
		await expect(removeDevServerFile(dataDir)).resolves.toBeUndefined()
	})

	it('readDevServerRecord surfaces the pid alongside the port', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'maxstack-devrec-'))
		await writeDevServerFile(dataDir, '3111', 42)
		expect(await readDevServerRecord(dataDir)).toEqual({
			port: '3111',
			pid: 42,
		})
	})
})

/**
 * Issue #123: on the pglite backend, a second `maxstack dev` for the same
 * project must REFUSE to start — both would open the same single-writer
 * on-disk store and silently corrupt it. The pre-#123 behavior was a scrolled-
 * past warning that even claimed the stores were separate. Liveness is judged
 * by the recorded pid (the other dev may not have bound its port yet), with a
 * port probe only for pid-less older records. Postgres backends share one
 * server-side database and stay allowed.
 */
describe('devServerFinding', () => {
	let dataDir: string
	afterEach(() => rm(dataDir, { recursive: true, force: true }))
	const withRecord = async (port: string, pid?: number) => {
		dataDir = await mkdtemp(join(tmpdir(), 'maxstack-guard-'))
		if (pid === undefined) {
			// A pid-less (older-format) record.
			const { writeFile } = await import('node:fs/promises')
			await writeFile(
				join(dataDir, 'dev-server.json'),
				`${JSON.stringify({ port })}\n`,
			)
		} else {
			await writeDevServerFile(dataDir, port, pid)
		}
		return dataDir
	}

	it('blocks on pglite when the recorded pid is alive', async () => {
		const dir = await withRecord('3000', 4242)
		const finding = await devServerFinding(dir, 'pglite', { alive: () => true })
		expect(finding.blocking).toBe(true)
		expect(finding.detail).toMatch(/already running/)
		expect(finding.fix).toMatch(/single-writer/)
	})

	it('blocks by pid even if the other server has not bound its port yet', async () => {
		const dir = await withRecord('3000', 4242)
		const finding = await devServerFinding(dir, 'pglite', {
			alive: () => true,
			// The port probe never runs — pid wins — but make its answer wrong
			// on purpose to prove the pid is what's consulted.
			portBusy: async () => false,
		})
		expect(finding.blocking).toBe(true)
		expect(finding.detail).toMatch(/pid 4242/)
	})

	it('passes when the recorded pid is dead (stale record after a crash)', async () => {
		const dir = await withRecord('3000', 4242)
		const finding = await devServerFinding(dir, 'pglite', {
			alive: () => false,
			portBusy: async () => true, // even a busy port doesn't matter: pid wins
		})
		expect(finding.status).toBe('ok')
		expect(finding.blocking).toBeUndefined()
	})

	it('falls back to the port probe for a pid-less older record', async () => {
		const dir = await withRecord('3000')
		expect(
			(await devServerFinding(dir, 'pglite', { portBusy: async () => true }))
				.blocking,
		).toBe(true)
		expect(
			(await devServerFinding(dir, 'pglite', { portBusy: async () => false }))
				.status,
		).toBe('ok')
	})

	it('allows a concurrent server on the postgres backend, with the caveat', async () => {
		const dir = await withRecord('3000', 4242)
		const finding = await devServerFinding(dir, 'postgres', {
			alive: () => true,
		})
		expect(finding.blocking).toBeUndefined()
		// Still worth saying: `demo` seeds through the most recent server.
		expect(finding.fix).toMatch(/maxstack demo/)
	})

	it('passes when there is no record at all', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'maxstack-guard-'))
		const finding = await devServerFinding(dataDir, 'pglite', {
			alive: () => true,
		})
		expect(finding.status).toBe('ok')
	})
})

describe('selectPackageDevPath', () => {
	it('auto-selects the vendored path when owned modules exist and pnpm is on PATH', () => {
		// The dogfood failure mode: dev defaulted to a server the ejected route
		// demonstrably wasn't in, and the agent's workaround (a second server)
		// caused the #123 two-writer collision.
		expect(selectPackageDevPath(false, 2, true)).toEqual({
			path: 'vendored',
			reason: 'auto-owned',
		})
	})

	it('keeps the prebuilt server for a project with no owned modules', () => {
		expect(selectPackageDevPath(false, 0, true)).toEqual({
			path: 'package',
			reason: 'no-owned',
		})
	})

	it('falls back to the prebuilt server (not a hard failure) when pnpm is missing', () => {
		expect(selectPackageDevPath(false, 2, false)).toEqual({
			path: 'package',
			reason: 'no-pnpm',
		})
	})

	it('honors an explicit --owned even when pnpm was not probed as available', () => {
		// The user asked for exactly this path — the install step's own ENOENT
		// message beats a silent downgrade to the prebuilt server.
		expect(selectPackageDevPath(true, 0, false)).toEqual({
			path: 'vendored',
			reason: 'flag',
		})
	})
})

describe('ownedGapNotice', () => {
	it('tells a pnpm-less user exactly how to unblock owned code', () => {
		const notice = ownedGapNotice('no-pnpm', 3)
		expect(notice).toContain('3 owned module(s)')
		expect(notice).toContain('pnpm is missing')
		expect(notice).toContain('npm install -g pnpm')
	})

	it('points a no-owned project at the auto-selecting restart, not a flag', () => {
		const notice = ownedGapNotice('no-owned', 0)
		expect(notice).toContain('restart `maxstack dev`')
		expect(notice).toContain('auto-selects')
	})
})
