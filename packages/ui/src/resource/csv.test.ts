/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import {
	cellToText,
	csvColumnsFor,
	parseCsv,
	resourceToCsv,
	rowsToCsv,
} from './csv.ts'
import type { IntrospectedResource, Row } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'task',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'done', type: 'boolean', meta: { label: 'Done' } },
		{
			name: 'priority',
			type: 'enum',
			meta: {
				label: 'Priority',
				options: [{ label: 'High', value: 'high' }],
			},
		},
		{
			name: 'authorId',
			type: 'uuid',
			references: { table: 'author', column: 'id' },
			meta: { label: 'Author' },
		},
		{ name: 'secret', type: 'string', meta: { hidden: true } },
	],
}

const rows: Row[] = [
	{ id: '1', title: 'Alpha', done: true, priority: 'high', authorId: 'a1' },
	{
		id: '2',
		title: 'B, "quoted"',
		done: false,
		priority: 'high',
		authorId: 'a2',
	},
]

const references = { author: { a1: 'Ada', a2: 'Babbage' } }

describe('csvColumnsFor', () => {
	it('excludes hidden + PK columns by default', () => {
		expect(csvColumnsFor(resource).map((c) => c.name)).toEqual([
			'title',
			'done',
			'priority',
			'authorId',
		])
	})
	it('includes the PK when asked', () => {
		expect(csvColumnsFor(resource, { showPrimaryKey: true })[0]?.name).toBe(
			'id',
		)
	})
})

describe('cellToText', () => {
	const col = (name: string) => resource.columns.find((c) => c.name === name)
	it('resolves references, enum labels, booleans', () => {
		expect(cellToText('a1', col('authorId'), references)).toBe('Ada')
		expect(cellToText('high', col('priority'))).toBe('High')
		expect(cellToText(true, col('done'))).toBe('true')
	})
	it('renders dates as ISO and empty for null', () => {
		expect(
			cellToText('2020-01-02T03:04:05.000Z', { name: 'at', type: 'date' }),
		).toBe('2020-01-02T03:04:05.000Z')
		expect(cellToText(null, col('title'))).toBe('')
	})
})

describe('rowsToCsv', () => {
	it('emits a labelled header and RFC-4180-escaped cells', () => {
		const csv = resourceToCsv(resource, rows, { references })
		const lines = csv.split('\r\n')
		expect(lines[0]).toBe('Title,Done,Priority,Author')
		expect(lines[1]).toBe('Alpha,true,High,Ada')
		// commas + quotes get quoted/escaped
		expect(lines[2]).toBe('"B, ""quoted""",false,High,Babbage')
	})
})

describe('parseCsv', () => {
	it('round-trips a quoted/escaped export back to records', () => {
		const csv = rowsToCsv(rows, csvColumnsFor(resource), { references })
		const parsed = parseCsv(csv)
		expect(parsed).toHaveLength(2)
		expect(parsed[0]).toEqual({
			Title: 'Alpha',
			Done: 'true',
			Priority: 'High',
			Author: 'Ada',
		})
		expect(parsed[1]?.Title).toBe('B, "quoted"')
	})

	it('handles embedded newlines and trailing blank lines', () => {
		const csv = 'a,b\r\n"line1\nline2",2\r\n'
		expect(parseCsv(csv)).toEqual([{ a: 'line1\nline2', b: '2' }])
	})

	it('returns [] for empty input', () => {
		expect(parseCsv('')).toEqual([])
	})
})
