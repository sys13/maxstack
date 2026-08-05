import type { PGlite } from '@electric-sql/pglite'
import { bootPglite } from '@maxstack/core/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach } from 'vitest'

/**
 * One pglite instance per test *file*, reset between tests by truncation.
 *
 * Nine suites in this package booted a fresh `new PGlite()` in `beforeEach` and
 * re-ran their DDL, which is 146 of the ~175 pglite boots a full `pnpm test`
 * performs. Measured on a warm module: a boot is ~490ms and a truncate of the
 * same schema is ~1ms, so those nine files were spending well over a minute of
 * CPU per run rebuilding a schema that never changes. On the 2-core CI runner —
 * where `turbo run test --concurrency=50%` resolves to 1 and the test phase is
 * fully serial — that cost is paid end to end.
 *
 * A boot and a truncate are equivalent here only because none of this package's
 * DDL constants seed rows: they are pure `CREATE TABLE`/`CREATE INDEX`, so an
 * empty freshly-created schema and a freshly-truncated one are the same
 * database. That is a real precondition, not an aesthetic one — a DDL that
 * grows an `INSERT` would silently lose its seed from the second test onward,
 * so seed from a fixture helper in `beforeEach`, never from the DDL.
 *
 * The truncate list is discovered from `pg_tables` after the DDL runs rather
 * than written out here. A hand-maintained list is the failure mode this whole
 * helper would otherwise introduce: add a table, forget the list, and rows leak
 * between tests as an order-dependent flake that reproduces nowhere.
 *
 * The one remaining per-file boot goes through `bootPglite`, which restores an
 * empty cluster from a snapshot rather than running `initdb`. That
 * is orthogonal to the truncation here: this helper decides how often a
 * database is created, `bootPglite` decides what creating one costs.
 *
 * Two suites additionally open a second "legacy" client inside a single test
 * (`preferences/service.test.ts`, `api-keys/portal-token.test.ts`). Those boots
 * stay exactly as they are: they assert behaviour against a schema at an older
 * shape, so the boot *is* the subject of the test. Only the per-test boot in
 * their `beforeEach` moves onto this fixture.
 */
export interface PgliteFixture {
	/** The shared client. Only defined once `beforeAll` has run. */
	readonly client: PGlite
	/** A drizzle handle over {@link client}, constructed once alongside it. */
	readonly db: ReturnType<typeof drizzle>
}

/**
 * Register the per-file pglite fixture. Call at module scope, or inside the
 * `describe` that needs a database — hooks bind to whichever suite is open, so
 * a file with one database-backed block does not pay for it in the others.
 *
 * Must be called *above* any `beforeEach` that reads `fixture.db`: vitest runs
 * same-level `beforeEach` hooks in registration order, and the truncate has to
 * land before the test's own seeding does.
 */
export function usePglite(...ddl: string[]): PgliteFixture {
	const fixture = {} as { client: PGlite; db: ReturnType<typeof drizzle> }
	let truncate = ''

	beforeAll(async () => {
		fixture.client = await bootPglite()
		for (const stmt of ddl) await fixture.client.exec(stmt)
		fixture.db = drizzle({ client: fixture.client })
		const { rows } = await fixture.client.query<{ ident: string }>(
			`select quote_ident(tablename) as ident
			   from pg_tables
			  where schemaname = 'public'`,
		)
		// `restart identity` so a suite asserting on a generated id sees the same
		// sequence a fresh boot gave it; `cascade` because the tables reference
		// each other and truncating them one at a time would not be possible.
		truncate = rows.length
			? `truncate ${rows.map((r) => r.ident).join(', ')} restart identity cascade`
			: ''
	})

	beforeEach(async () => {
		if (truncate) await fixture.client.exec(truncate)
	})

	afterAll(async () => {
		await fixture.client?.close()
	})

	return fixture
}
