/**
 * Store backend selection — the seam that makes Postgres a first-class store
 * alongside pglite (task 22). Both are Postgres wire-compatible, so the
 * `SproutStore` on top (`createDrizzleStore`) and the additive DDL are
 * *identical* across backends; only the driver differs, and it is chosen here.
 *
 *   - `pglite`   — embedded Postgres (in-memory for tests, on-disk for dev /
 *                  project mode). The default: zero infra, durable enough for a
 *                  single-process app.
 *   - `postgres` — a real Postgres server via postgres.js, selected by a project
 *                  config (`DATABASE_URL` / `sprout.config`). Same schema, same
 *                  store, same auth — just a connection string.
 *
 * A backend exposes the drizzle handle the store binds to, an `exec` for
 * multi-statement DDL (pglite takes it whole; postgres.js runs the statements
 * split), and `dispose` for connection teardown. `client` is the raw pglite
 * handle when present — the auth layer and the on-disk re-sync path use it.
 */

import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'

export type StoreBackendConfig =
	| { kind: 'pglite'; dir?: string }
	| { kind: 'postgres'; url: string }

// drizzle's driver types differ per backend; the store only needs the shared
// query surface, so an untyped handle is the honest contract here.
export type AnyDrizzle = any

export interface StoreBackend {
	kind: StoreBackendConfig['kind']
	db: AnyDrizzle
	/** The raw pglite handle (pglite only) — auth + on-disk re-sync use it. */
	client?: PGlite
	/** Run multi-statement DDL (idempotent, additive) against the backend. */
	exec(sql: string): Promise<void>
	/**
	 * Run one parameterized SELECT and return its rows.
	 *
	 * The `SproutStore` covers every CRUD shape the platform needs, but a rollup is
	 * an *aggregate over rows that are never fetched* — a grouped, joined
	 * `GROUP BY` the store's query builder has no vocabulary for. Rather than grow
	 * `ListOptions` into a reporting DSL, derived values compile to SQL
	 * (`sprout/derived.ts`) and run here.
	 *
	 * Parameterized on purpose: `exec` takes DDL the platform itself generates,
	 * whereas this carries row values (filter comparands, owner-id arrays), so the
	 * values travel as bound parameters and never through string interpolation.
	 */
	query(
		text: string,
		params?: readonly unknown[],
	): Promise<Record<string, unknown>[]>
	/**
	 * Hold a `LISTEN` on `channel` and call `onNotify` for each payload, until the
	 * returned function is called.
	 *
	 * **Present only on backends where a second instance can exist.** pglite is
	 * embedded and single-writer puts an `O_EXCL` lock on the data
	 * dir precisely so a second process cannot open it — so there is no other
	 * session to hear from and no honest implementation to write. Absent rather
	 * than a no-op: a no-op `listen` returns a working-looking unsubscribe and
	 * delivers nothing, which is the exact failure shape (`works in every
	 * single-instance test`) this issue exists to remove. `createPostgresCoordinator`
	 * refuses a backend without it.
	 *
	 * It takes its own connection rather than one from the pool. A listening
	 * connection is occupied for as long as it listens, so borrowing a pooled one
	 * would remove it from the pool for the lifetime of the process.
	 */
	listen?(
		channel: string,
		onNotify: (payload: string) => void,
		/** Called on the first subscribe and on every re-subscribe after a dropped
		 * connection — the caller's cue that it may have missed announcements in
		 * the gap, because nothing replays a `NOTIFY`. */
		onResubscribe?: () => void,
	): Promise<() => Promise<void>>
	dispose(): Promise<void>
}

/** Whether a process with this pid is currently alive. `kill(pid, 0)` sends no
 * signal, it only checks deliverability: success or `EPERM` (alive but owned by
 * another user) mean alive; anything else (`ESRCH`) means gone. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** The lockfile guarding an on-disk pglite data dir. */
export function pgliteLockFile(dir: string): string {
	return `${dir}/.lock`
}

/**
 * Acquire the single-writer lock on an on-disk pglite data dir.
 *
 * pglite is single-writer but enforces nothing across processes: two servers
 * opening the same dir don't error, they silently diverge — rows written by one
 * are invisible to the other, and the WAL state corrupts. This lock is the
 * chokepoint every dir-open goes through (`dev`, `demo`, `build`, tests), so a
 * second process fails *here*, loudly, instead of downstream as missing rows.
 *
 * Mechanics: an `O_EXCL` (`wx`) write of `<dir>/.lock` holding `{pid,
 * startedAt}`. On `EEXIST` the holder's pid is liveness-checked — a dead holder
 * (crash, SIGKILL; `dispose` never ran) is reclaimed and the acquire retried,
 * so a stale lock never wedges the dir. Returns the release function that
 * `dispose` calls.
 */
async function acquirePgliteLock(dir: string): Promise<() => Promise<void>> {
	const { readFile, rm, writeFile } = await import('node:fs/promises')
	const lockFile = pgliteLockFile(dir)
	const release = async () => {
		try {
			await rm(lockFile)
		} catch {
			// Already gone (a reclaim after our false death, say) — released either way.
		}
	}
	// Two attempts: the first `wx` write, and one more after reclaiming a stale
	// lock. Losing the reclaim race to another process is a genuine live holder.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await writeFile(
				lockFile,
				`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
				{ flag: 'wx' },
			)
			return release
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
		}
		let holder: { pid?: unknown; startedAt?: unknown } = {}
		try {
			holder = JSON.parse(await readFile(lockFile, 'utf8'))
		} catch {
			// Unreadable/garbled lock — treat as stale and reclaim below.
		}
		if (typeof holder.pid === 'number' && pidAlive(holder.pid)) {
			throw new Error(
				`the pglite data dir ${dir} is already open in another process ` +
					`(pid ${holder.pid}${typeof holder.startedAt === 'string' ? `, started ${holder.startedAt}` : ''}).\n` +
					`pglite is single-writer: a second writer on the same dir silently corrupts it —\n` +
					`rows land in one process and are invisible in the other. Stop that process\n` +
					`first (or, if it is truly gone and this pid was recycled, delete ${lockFile}).`,
			)
		}
		await release() // stale (dead pid / unreadable) — reclaim and retry
	}
	throw new Error(
		`could not lock the pglite data dir ${dir}: another process keeps (re)acquiring ${lockFile}.`,
	)
}

/**
 * Split a DDL block into statements, respecting dollar-quoted bodies.
 *
 * A naive `sql.split(';')` shreds a `DO $$ … $$` block into invalid fragments —
 * `EXECUTE '…'`, `END IF`, `END $$` — and this path is the **only** one that
 * needs splitting at all: pglite's `client.exec` runs a multi-statement string
 * natively, so every test in the workspace took the path that worked. On real
 * Postgres, a spec with any declared `reference` therefore failed at boot on the
 * guarded reconciliation `specSchemaDdl` emits for it.
 *
 * Only `$$` is handled, because it is the only dollar-quote the emitter produces.
 * A tagged one (`$body$`) would need the tag matched; there is none to match.
 */
export function splitStatements(sql: string): string[] {
	const out: string[] = []
	let current = ''
	let inDollarQuote = false
	for (let i = 0; i < sql.length; i++) {
		if (sql.startsWith('$$', i)) {
			inDollarQuote = !inDollarQuote
			current += '$$'
			i++
			continue
		}
		const char = sql[i] as string
		if (char === ';' && !inDollarQuote) {
			if (current.trim()) out.push(current.trim())
			current = ''
			continue
		}
		current += char
	}
	if (current.trim()) out.push(current.trim())
	return out
}

/** Wrap an already-open pglite client as a backend (demo mode reuses the client
 * `createDemoDb` opened, so auth and the store share one database). */
export function pgliteBackend(client: PGlite): StoreBackend {
	return {
		kind: 'pglite',
		db: drizzlePglite({ client }),
		client,
		exec: (ddl) => client.exec(ddl).then(() => undefined),
		query: async (text, params) =>
			(await client.query(text, params as unknown[] | undefined))
				.rows as Record<string, unknown>[],
		dispose: () => client.close(),
	}
}

/** Open a store backend from its config. */
export async function createBackend(
	config: StoreBackendConfig,
): Promise<StoreBackend> {
	if (config.kind === 'postgres') {
		// Lazy import so pglite-only consumers never load the postgres.js driver.
		const { default: postgres } = await import('postgres')
		const sql = postgres(config.url, { max: 4 })
		const db = drizzlePostgres({ client: sql })
		return {
			kind: 'postgres',
			db,
			async exec(ddl) {
				for (const stmt of splitStatements(ddl)) await sql.unsafe(stmt)
			},
			async query(text, params) {
				return (await sql.unsafe(text, params as never)) as unknown as Record<
					string,
					unknown
				>[]
			},
			async listen(channel, onNotify, onResubscribe) {
				// postgres.js reserves a dedicated connection for a listener and
				// re-issues the `LISTEN` after a reconnect, which is the property that
				// matters here: a connection that dropped and came back subscribed to
				// nothing would be an instance that has silently stopped hearing about
				// other instances' changes — the failure this whole path exists to
				// remove, reintroduced one layer down. `onResubscribe` fires on the
				// first subscribe and on every re-subscribe after that, so a caller can
				// say out loud that it may have missed the gap (nothing replays a
				// `NOTIFY`).
				const meta = await sql.listen(channel, onNotify, onResubscribe)
				return async () => {
					await meta.unlisten()
				}
			},
			async dispose() {
				await sql.end({ timeout: 5 })
			},
		}
	}
	if (config.dir) {
		// pglite does not create missing parent dirs, so ensure the on-disk data
		// dir exists first. It used to appear as a side effect of the spec store
		// seeding `<dataDir>/spec`, but a CLI project keeps its spec at the
		// project root — the backend now owns its own directory.
		const { mkdir } = await import('node:fs/promises')
		await mkdir(config.dir, { recursive: true })
		// Single-writer enforcement: hold `<dir>/.lock` for as long
		// as this backend is open, released in dispose. Acquire *before* opening —
		// a second process must fail before it can touch the dir at all.
		const releaseLock = await acquirePgliteLock(config.dir)
		try {
			const backend = pgliteBackend(new PGlite(config.dir))
			const closeClient = backend.dispose
			backend.dispose = async () => {
				await closeClient()
				await releaseLock()
			}
			return backend
		} catch (err) {
			await releaseLock()
			throw err
		}
	}
	return pgliteBackend(new PGlite())
}

/** Resolve a backend config from the environment / project config. `DATABASE_URL`
 * (postgres:// or postgresql://) selects Postgres; otherwise pglite at `dir`. */
export function resolveBackendConfig(opts: {
	dir?: string
	databaseUrl?: string | null
}): StoreBackendConfig {
	const url = opts.databaseUrl?.trim()
	if (url && /^postgres(ql)?:\/\//.test(url)) return { kind: 'postgres', url }
	return { kind: 'pglite', dir: opts.dir }
}
