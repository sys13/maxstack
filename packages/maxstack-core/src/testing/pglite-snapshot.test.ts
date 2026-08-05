import { describe, expect, it } from 'vitest'
import { bootPglite, emptyClusterSnapshot } from './pglite-snapshot.ts'

describe('bootPglite', () => {
	it('hands back a working, empty database', async () => {
		const db = await bootPglite()
		try {
			// Empty means empty: a restored cluster that quietly carried a schema
			// would be the exact failure this design exists to rule out.
			const { rows } = await db.query<{ n: number }>(
				`select count(*)::int as n from pg_tables where schemaname = 'public'`,
			)
			expect(rows[0]?.n).toBe(0)

			await db.exec(`CREATE TABLE t (id serial primary key, a text)`)
			await db.exec(`INSERT INTO t (a) VALUES ('x')`)
			const read = await db.query<{ a: string }>(`select a from t`)
			expect(read.rows.map((r) => r.a)).toEqual(['x'])
		} finally {
			await db.close()
		}
	})

	it('gives each caller an independent database from the one snapshot', async () => {
		const [a, b] = await Promise.all([bootPglite(), bootPglite()])
		try {
			await a.exec(`CREATE TABLE only_in_a (id int)`)
			const seen = await b.query<{ n: number }>(
				`select count(*)::int as n from pg_tables where tablename = 'only_in_a'`,
			)
			expect(seen.rows[0]?.n).toBe(0)
		} finally {
			await Promise.all([a.close(), b.close()])
		}
	})

	it('memoizes the snapshot rather than rebuilding it per call', async () => {
		expect(await emptyClusterSnapshot()).toBe(await emptyClusterSnapshot())
	})
})
