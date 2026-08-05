/**
 * `splitStatements` respects dollar-quoted bodies (found while landing #215).
 *
 * This is the Postgres backend's only path to running a DDL block — pglite's
 * `client.exec` takes a multi-statement string natively, so it never splits, and
 * every test in the workspace uses pglite. That is why a splitter that cut on
 * every `;` survived: it shredded `DO $$ … $$` into `EXECUTE '…'`, `END IF`,
 * `END $$`, and nothing ever ran it.
 *
 * The consequence was not cosmetic: `specSchemaDdl` emits exactly such a block
 * for every column carrying a declared `reference`, so on real Postgres a
 * spec with any reference failed at boot.
 */

import { describe, expect, it } from 'vitest'
import { splitStatements } from './backend.ts'

describe('splitStatements', () => {
	it('keeps a DO block whole', () => {
		const sql = [
			'CREATE TABLE "a" ("id" uuid);',
			'DO $$',
			'BEGIN',
			"  RAISE NOTICE 'hi';",
			'  EXECUTE \'ALTER TABLE "a" ADD COLUMN "b" text\';',
			'END $$;',
			'CREATE TABLE "c" ("id" uuid);',
		].join('\n')
		const parts = splitStatements(sql)
		expect(parts).toHaveLength(3)
		expect(parts[1]).toContain('DO $$')
		expect(parts[1]).toContain('END $$')
		// The internal semicolons stayed inside.
		expect(parts[1]).toContain('RAISE NOTICE')
		expect(parts[1]).toContain('EXECUTE')
	})

	it('still splits ordinary statements', () => {
		expect(splitStatements('SELECT 1; SELECT 2;')).toEqual([
			'SELECT 1',
			'SELECT 2',
		])
	})

	it('drops empty fragments rather than emitting blanks', () => {
		expect(splitStatements(';;\nSELECT 1;\n\n;')).toEqual(['SELECT 1'])
	})

	it('does not lose a trailing statement with no semicolon', () => {
		expect(splitStatements('SELECT 1;\nSELECT 2')).toEqual([
			'SELECT 1',
			'SELECT 2',
		])
	})
})
