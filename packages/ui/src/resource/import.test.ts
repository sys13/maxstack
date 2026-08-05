/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv.ts'
import {
	coerceValue,
	importableColumns,
	suggestColumnMapping,
	validateImportRows,
} from './import.ts'
import type { IntrospectedResource } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'post',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{
			name: 'title',
			type: 'string',
			nullable: false,
			meta: { label: 'Title' },
		},
		{ name: 'points', type: 'number', nullable: true, meta: {} },
		{ name: 'published', type: 'boolean', nullable: true, meta: {} },
		{
			name: 'status',
			type: 'enum',
			enumValues: ['draft', 'live'],
			nullable: true,
			meta: {},
		},
		{ name: 'internal', type: 'string', meta: { hidden: true } },
	],
}

describe('importableColumns', () => {
	it('excludes the pk and hidden columns', () => {
		expect(importableColumns(resource).map((c) => c.name)).toEqual([
			'title',
			'points',
			'published',
			'status',
		])
	})
})

describe('suggestColumnMapping', () => {
	it('matches by column name and by label, case/space-insensitively', () => {
		const mapping = suggestColumnMapping(resource, [
			'Title',
			'points',
			'Unknown',
		])
		expect(mapping).toEqual({ Title: 'title', points: 'points', Unknown: null })
	})
})

describe('coerceValue', () => {
	const col = (name: string) =>
		resource.columns.find(
			(c) => c.name === name,
		) as IntrospectedResource['columns'][number]

	it('coerces numbers, booleans, and enums', () => {
		expect(coerceValue('42', col('points'))).toEqual({ value: 42 })
		expect(coerceValue('yes', col('published'))).toEqual({ value: true })
		expect(coerceValue('draft', col('status'))).toEqual({ value: 'draft' })
	})

	it('rejects malformed values', () => {
		expect(coerceValue('abc', col('points'))).toHaveProperty('error')
		expect(coerceValue('maybe', col('published'))).toHaveProperty('error')
		expect(coerceValue('archived', col('status'))).toHaveProperty('error')
	})

	it('treats an empty cell as null', () => {
		expect(coerceValue('  ', col('title'))).toEqual({ value: null })
	})
})

describe('validateImportRows', () => {
	it('produces create-ready records and a per-row report', () => {
		const csv = 'Title,points,published\nHello,10,true\nWorld,20,false'
		const records = parseCsv(csv)
		const mapping = suggestColumnMapping(
			resource,
			Object.keys(records[0] ?? {}),
		)
		const result = validateImportRows(resource, records, mapping)
		expect(result.validCount).toBe(2)
		expect(result.errorCount).toBe(0)
		expect(result.valid[0]).toEqual({
			title: 'Hello',
			points: 10,
			published: true,
		})
	})

	it('flags a required-field-missing row and a bad-type row', () => {
		const csv = 'Title,points\n,10\nOk,abc'
		const records = parseCsv(csv)
		const mapping = suggestColumnMapping(resource, ['Title', 'points'])
		const result = validateImportRows(resource, records, mapping)
		expect(result.validCount).toBe(0)
		expect(result.report[0]?.errors[0]?.field).toBe('title')
		expect(result.report[1]?.errors[0]?.field).toBe('points')
	})
})
