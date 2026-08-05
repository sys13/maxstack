import { describe, expect, it } from 'vitest'
import { introspectTable } from '../sprout/introspection.ts'
import { generateValidationSchema } from '../sprout/validation.ts'
import { FIXTURE_TABLES } from './fixture.ts'

describe('fidelity fixture (scaled-down 90-table gate)', () => {
	it('introspects every table without error and resolves FK counts', () => {
		for (const { table, expectedFks } of FIXTURE_TABLES) {
			const resource = introspectTable(table)
			expect(resource.name).toBeTruthy()
			expect(resource.columns.length).toBeGreaterThan(0)
			const fkCount = resource.columns.filter((c) => c.references).length
			expect(fkCount, `FK count for ${resource.name}`).toBe(expectedFks)
			expect(resource.relations.length).toBe(expectedFks)
		}
	})

	it('generates a Zod schema for every table', () => {
		for (const { table } of FIXTURE_TABLES) {
			const resource = introspectTable(table)
			const schema = generateValidationSchema(resource, 'create')
			// PK is always excluded from create input.
			expect(Object.keys(schema.shape)).not.toContain('id')
		}
	})

	it('every FK target resolves to a known fixture table', () => {
		const names = new Set(
			FIXTURE_TABLES.map(({ table }) => introspectTable(table).name),
		)
		for (const { table } of FIXTURE_TABLES) {
			for (const rel of introspectTable(table).relations) {
				expect(names.has(rel.references.table)).toBe(true)
			}
		}
	})
})
