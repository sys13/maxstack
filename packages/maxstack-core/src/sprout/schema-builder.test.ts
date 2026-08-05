import { pgTable, text } from 'drizzle-orm/pg-core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { getColumnMeta, withMeta } from './schema-builder.ts'

describe('withMeta', () => {
	it('returns the same column reference', () => {
		const col = text('name')
		expect(withMeta(col, { label: 'Name' })).toBe(col)
	})

	it('reads back meta off a builder', () => {
		const col = withMeta(text('name'), { label: 'Name', maxLength: 5 })
		expect(getColumnMeta(col)).toEqual({ label: 'Name', maxLength: 5 })
	})

	it('meta survives pgTable() via the config copy (dual-write invariant)', () => {
		// The whole reason for writing both __meta and config.__meta: only the
		// config copy survives once pgTable() builds the final column.
		const t = pgTable('t', {
			title: withMeta(text('title'), { label: 'Title' }).notNull(),
		})
		expect(getColumnMeta(t.title)).toEqual({ label: 'Title' })
	})

	it('preserves the column type so $inferSelect stays precise', () => {
		const t = pgTable('t', {
			id: text('id').primaryKey(),
			title: withMeta(text('title'), { label: 'Title' }).notNull(),
			note: withMeta(text('note'), {}),
		})
		type Row = typeof t.$inferSelect
		expectTypeOf<Row>().toEqualTypeOf<{
			id: string
			title: string
			note: string | null
		}>()
	})
})
