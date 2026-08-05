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
	filtersFromSearchParams,
	filtersToSearchParams,
} from './filter-params.ts'
import { EMPTY_FILTERS } from './filterable.ts'

describe('filtersToSearchParams', () => {
	it('encodes search + filters, omitting blanks', () => {
		expect(
			filtersToSearchParams({
				search: 'ada',
				filter: { priority: 'high', authorId: '', done: 'true' },
			}),
		).toEqual({
			search: 'ada',
			'filter.priority': 'high',
			'filter.done': 'true',
		})
	})

	it('drops a blank search', () => {
		expect(filtersToSearchParams({ search: '  ', filter: {} })).toEqual({})
	})

	it('encodes range bounds as filter.<col>.gte/.lte, omitting blanks', () => {
		expect(
			filtersToSearchParams({
				filter: {},
				range: { cost: { gte: '5', lte: '20' }, due: { gte: '', lte: '2026' } },
			}),
		).toEqual({
			'filter.cost.gte': '5',
			'filter.cost.lte': '20',
			'filter.due.lte': '2026',
		})
	})
})

describe('filtersFromSearchParams', () => {
	it('decodes from a URLSearchParams, ignoring unrelated keys', () => {
		const params = new URLSearchParams('search=ada&filter.priority=high&page=2')
		expect(filtersFromSearchParams(params)).toEqual({
			search: 'ada',
			filter: { priority: 'high' },
		})
	})

	it('returns EMPTY_FILTERS when nothing matches', () => {
		expect(filtersFromSearchParams(new URLSearchParams('page=2'))).toBe(
			EMPTY_FILTERS,
		)
	})

	it('round-trips through the encoder', () => {
		const values = { search: 'x', filter: { priority: 'high', done: 'false' } }
		const encoded = new URLSearchParams(filtersToSearchParams(values))
		expect(filtersFromSearchParams(encoded)).toEqual(values)
	})

	it('decodes range bounds and round-trips them', () => {
		const values = {
			search: undefined,
			filter: { done: 'true' },
			range: { cost: { gte: '5', lte: '20' } },
		}
		const encoded = new URLSearchParams(filtersToSearchParams(values))
		expect(filtersFromSearchParams(encoded)).toEqual(values)
	})

	it('accepts a plain record too', () => {
		expect(filtersFromSearchParams({ 'filter.done': 'true' })).toEqual({
			search: undefined,
			filter: { done: 'true' },
		})
	})
})
