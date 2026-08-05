/**
 * A reference reconciliation refuses to rewrite a big table at boot.
 *
 * `ALTER COLUMN … TYPE` takes an ACCESS EXCLUSIVE lock and rewrites the whole
 * table, and the schema sync runs at **application boot** rather than from an
 * operator-invoked migration. A one-line spec change whose DDL diff looks like two
 * extra statements could therefore block a deployed app's startup for the length
 * of a full rewrite, with every reader and writer of that table blocked too.
 *
 * These run against a real pglite database, because the whole behaviour lives in
 * a `DO $$ … $$` block: asserting on the emitted SQL string would test that the
 * text was written, not that Postgres does what it says.
 */

import type { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import { specSchemaDdl } from './from-spec.ts'

const ORIGINAL = process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT
afterEach(() => {
	if (ORIGINAL === undefined)
		delete process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT
	else process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT = ORIGINAL
})

/** `note.owner` as a plain string column, holding `rows` castable uuids. */
async function seeded(rows: number): Promise<PGlite> {
	const db = await bootPglite()
	await db.exec(
		'CREATE TABLE "note" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "owner" text);',
	)
	for (let i = 0; i < rows; i++)
		await db.query(
			'INSERT INTO "note" ("owner") VALUES (gen_random_uuid()::text)',
		)
	return db
}

/** The declared SQL type of `note.owner`, as Postgres reports it. */
async function ownerColumnType(db: PGlite): Promise<string | undefined> {
	const { rows } = await db.query<{ data_type: string }>(
		"SELECT data_type FROM information_schema.columns WHERE table_name = 'note' AND column_name = 'owner'",
	)
	return rows[0]?.data_type
}

/** The DDL for `note.owner` once it is declared a reference. */
const referenceDdl = () =>
	specSchemaDdl([
		{
			name: 'note',
			fields: [
				{ name: 'id', type: 'string', required: true },
				{
					name: 'owner',
					type: 'string',
					required: false,
					reference: { table: 'author', column: 'id' },
				},
			],
		},
	])

describe('under the limit', () => {
	it('reconciles the column, so small projects are unaffected', async () => {
		process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT = '100'
		const db = await seeded(3)
		await db.exec(referenceDdl())
		const columnType = await ownerColumnType(db)
		expect(columnType).toBe('uuid')
		await db.close()
	})
})

describe('over the limit', () => {
	it('refuses, and names the statement to run', async () => {
		process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT = '2'
		const db = await seeded(5)
		await expect(db.exec(referenceDdl())).rejects.toThrow(/refused to rewrite/)
		// The refusal is only useful if it hands over the exact statement.
		await expect(db.exec(referenceDdl())).rejects.toThrow(
			/ALTER TABLE "note" ALTER COLUMN "owner" TYPE uuid/,
		)
		await db.close()
	})

	it('leaves the column alone — a blocked deploy, not a half-done one', async () => {
		process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT = '2'
		const db = await seeded(5)
		await db.exec(referenceDdl()).catch(() => {})
		const columnType = await ownerColumnType(db)
		expect(columnType).toBe('text')
		await db.close()
	})

	it('a limit of 0 refuses every automatic rewrite', async () => {
		// The setting for anyone who wants the migration to be a deliberate act.
		process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT = '0'
		const db = await seeded(1)
		await expect(db.exec(referenceDdl())).rejects.toThrow(/refused to rewrite/)
		await db.close()
	})
})

describe('once the column is already right', () => {
	it('costs nothing and never counts rows', async () => {
		// The guard is what makes re-running the DDL on every boot free. A version
		// that counted first would put a full scan in the boot path of every app.
		process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT = '0'
		const db = await bootPglite()
		await db.exec(
			'CREATE TABLE "note" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "owner" uuid);',
		)
		await expect(db.exec(referenceDdl())).resolves.toBeDefined()
		await db.close()
	})
})
