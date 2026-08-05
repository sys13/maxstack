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
	activeFilterCount,
	deriveFacets,
	searchableFields,
} from './filterable.ts'
import type { IntrospectedResource } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'task',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'body', type: 'text', meta: {} },
		{ name: 'done', type: 'boolean', meta: { label: 'Done' } },
		{
			name: 'priority',
			type: 'enum',
			enumValues: ['low', 'high'],
			meta: {
				label: 'Priority',
				options: [
					{ label: 'Low', value: 'low' },
					{ label: 'High', value: 'high' },
				],
			},
		},
		{
			name: 'authorId',
			type: 'uuid',
			references: { table: 'author', column: 'id' },
			meta: { label: 'Author' },
		},
		{ name: 'estimate', type: 'number', meta: { label: 'Estimate' } },
		{ name: 'dueDate', type: 'date', meta: { label: 'Due Date' } },
		{ name: 'internal', type: 'string', meta: { filterable: false } },
	],
}

describe('searchableFields', () => {
	it('picks the text columns, skipping PK/reference/enum/opted-out', () => {
		expect(searchableFields(resource)).toEqual(['title', 'body'])
	})
})

describe('deriveFacets', () => {
	it('derives enum, reference, boolean, and numeric/date range facets (skipping PK + opted-out)', () => {
		const facets = deriveFacets(resource)
		expect(facets.map((f) => [f.name, f.kind])).toEqual([
			['done', 'boolean'],
			['priority', 'enum'],
			['authorId', 'reference'],
			['estimate', 'range'],
			['dueDate', 'range'],
		])
	})

	it('gives a numeric/date column a range facet with no options', () => {
		const estimate = deriveFacets(resource).find((f) => f.name === 'estimate')
		expect(estimate?.kind).toBe('range')
		expect(estimate?.options).toEqual([])
		expect(estimate?.column.type).toBe('number')
	})

	it('uses metadata options for enum facets', () => {
		const priority = deriveFacets(resource).find((f) => f.name === 'priority')
		expect(priority?.options).toEqual([
			{ label: 'Low', value: 'low' },
			{ label: 'High', value: 'high' },
		])
	})

	it('injects reference options, empty when not supplied', () => {
		expect(
			deriveFacets(resource).find((f) => f.name === 'authorId')?.options,
		).toEqual([])
		const opts = [{ label: 'Ada', value: 'a1' }]
		expect(
			deriveFacets(resource, { authorId: opts }).find(
				(f) => f.name === 'authorId',
			)?.options,
		).toEqual(opts)
	})

	it('falls back to bare enumValues when there are no labelled options', () => {
		const r: IntrospectedResource = {
			name: 'x',
			primaryKey: 'id',
			columns: [
				{ name: 'stage', type: 'enum', enumValues: ['a', 'b'], meta: {} },
			],
		}
		expect(deriveFacets(r)[0]?.options).toEqual([
			{ label: 'a', value: 'a' },
			{ label: 'b', value: 'b' },
		])
	})

	it('honors filterable:true as a free-text facet for a plain column', () => {
		const r: IntrospectedResource = {
			name: 'x',
			primaryKey: 'id',
			columns: [{ name: 'code', type: 'string', meta: { filterable: true } }],
		}
		const facet = deriveFacets(r)[0]
		expect(facet?.kind).toBe('text')
		expect(facet?.options).toEqual([])
	})
})

describe('activeFilterCount', () => {
	it('counts search + non-empty facet selections', () => {
		expect(activeFilterCount({ filter: {} })).toBe(0)
		expect(activeFilterCount({ search: '  ', filter: {} })).toBe(0)
		expect(
			activeFilterCount({
				search: 'x',
				filter: { priority: 'high', done: '' },
			}),
		).toBe(2)
	})

	it('counts each present range bound', () => {
		expect(
			activeFilterCount({ filter: {}, range: { estimate: { gte: '5' } } }),
		).toBe(1)
		expect(
			activeFilterCount({
				filter: { done: 'true' },
				range: { estimate: { gte: '5', lte: '20' }, dueDate: { lte: '' } },
			}),
		).toBe(3)
	})
})
