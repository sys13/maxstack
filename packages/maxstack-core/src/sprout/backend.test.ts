/**
 * The store contract over each backend. pglite always runs; Postgres runs only
 * when `MAXSTACK_TEST_POSTGRES_URL` points at a throwaway database (CI / the
 * nightly can set it; local + hermetic runs skip it cleanly, matching the keyed
 * eval convention). Both drive the *same* `createSpecStore` + DDL, so a green
 * pglite run is the standing proof and the Postgres run confirms parity.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createBackend,
	pgliteLockFile,
	pidAlive,
	resolveBackendConfig,
	type StoreBackendConfig,
} from './backend.ts'
import {
	createSpecStore,
	registerSpecEntities,
	type SpecEntityShape,
} from './from-spec.ts'
import { ResourceRegistry } from './registry.ts'

const entities: SpecEntityShape[] = [
	{
		name: 'widget',
		fields: [
			{ name: 'title', type: 'string', required: true },
			{ name: 'qty', type: 'number', required: false },
			{ name: 'active', type: 'boolean', required: false },
		],
	},
]

async function runStoreContract(config: StoreBackendConfig): Promise<void> {
	const backend = await createBackend(config)
	try {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, entities)
		const store = await createSpecStore(backend, registry, entities)

		const created = await store.create('widget', {
			title: 'Sprocket',
			qty: 3,
			active: true,
		})
		expect(created.id).toBeTruthy()
		expect(created.title).toBe('Sprocket')

		const fetched = await store.get('widget', created.id as string)
		expect(fetched?.title).toBe('Sprocket')

		const updated = await store.update('widget', created.id as string, {
			qty: 5,
		})
		expect(updated?.qty).toBe(5)

		const listed = await store.list('widget')
		expect(listed).toHaveLength(1)

		expect(await store.delete('widget', created.id as string)).toBe(true)
		expect(await store.list('widget')).toHaveLength(0)

		// Re-running the DDL is idempotent (additive) — safe on every boot.
		await expect(
			createSpecStore(backend, registry, entities),
		).resolves.toBeDefined()
	} finally {
		await backend.dispose()
	}
}

describe('store backend', () => {
	it('resolves DATABASE_URL to the right backend kind', () => {
		expect(resolveBackendConfig({ databaseUrl: 'postgres://x' }).kind).toBe(
			'postgres',
		)
		expect(resolveBackendConfig({ databaseUrl: 'postgresql://x' }).kind).toBe(
			'postgres',
		)
		expect(resolveBackendConfig({ databaseUrl: null }).kind).toBe('pglite')
		expect(resolveBackendConfig({ dir: '/tmp/x' }).kind).toBe('pglite')
	})

	it('runs the store contract on pglite', async () => {
		await runStoreContract({ kind: 'pglite' })
	})

	const pgUrl = process.env.MAXSTACK_TEST_POSTGRES_URL?.trim()
	it.skipIf(!pgUrl)('runs the store contract on Postgres', async () => {
		await runStoreContract({ kind: 'postgres', url: pgUrl as string })
	})
})

/**
 * Issue #123: pglite is single-writer, but nothing used to enforce that across
 * processes — two `maxstack dev` servers opening the same `.maxstack/db`
 * silently diverged. `createBackend` now holds `<dir>/.lock` for the lifetime
 * of an on-disk backend: a live holder makes a second open throw; a dead
 * holder (crash — dispose never ran) is reclaimed.
 */
describe('pglite data-dir lock', () => {
	let dir: string
	afterEach(() => rm(dir, { recursive: true, force: true }))
	const freshDir = async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-pglite-lock-'))
		return join(dir, 'db')
	}

	it('writes the lock on open and removes it on dispose', async () => {
		const dbDir = await freshDir()
		const backend = await createBackend({ kind: 'pglite', dir: dbDir })
		const lock = JSON.parse(await readFile(pgliteLockFile(dbDir), 'utf8')) as {
			pid: number
			startedAt: string
		}
		expect(lock.pid).toBe(process.pid)
		expect(lock.startedAt).toBeTruthy()
		await backend.dispose()
		await expect(readFile(pgliteLockFile(dbDir), 'utf8')).rejects.toThrow()
	})

	it('refuses a second open while the holder is alive', async () => {
		const dbDir = await freshDir()
		const backend = await createBackend({ kind: 'pglite', dir: dbDir })
		try {
			// The holder pid is this very process — alive by definition.
			await expect(
				createBackend({ kind: 'pglite', dir: dbDir }),
			).rejects.toThrow(/single-writer/)
		} finally {
			await backend.dispose()
		}
	})

	it('reclaims a stale lock left by a dead process', async () => {
		const dbDir = await freshDir()
		const { mkdir } = await import('node:fs/promises')
		await mkdir(dbDir, { recursive: true })
		// A pid that cannot be alive (beyond any real pid range) — the crash case,
		// where dispose never ran and the lockfile survived the process.
		await writeFile(
			pgliteLockFile(dbDir),
			`${JSON.stringify({ pid: 2 ** 30, startedAt: 'then' })}\n`,
		)
		const backend = await createBackend({ kind: 'pglite', dir: dbDir })
		const lock = JSON.parse(await readFile(pgliteLockFile(dbDir), 'utf8')) as {
			pid: number
		}
		expect(lock.pid).toBe(process.pid) // reclaimed, now ours
		await backend.dispose()
	})

	it('reclaims an unreadable (garbled) lock', async () => {
		const dbDir = await freshDir()
		const { mkdir } = await import('node:fs/promises')
		await mkdir(dbDir, { recursive: true })
		await writeFile(pgliteLockFile(dbDir), 'not json')
		const backend = await createBackend({ kind: 'pglite', dir: dbDir })
		await backend.dispose()
	})
})

describe('pidAlive', () => {
	it('is true for this process and false for an impossible pid', () => {
		expect(pidAlive(process.pid)).toBe(true)
		expect(pidAlive(2 ** 30)).toBe(false)
	})
})
