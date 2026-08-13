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
	narrowFilters,
	sortFromSearchParams,
	sortToSearchParams,
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

/**
 * Issue #342: the generated app's list controls put search, facets and ordering
 * in the URL so a filtered list stays a link somebody can send — and the
 * *decode* side is where an end-user surface either holds or leaks.
 */
describe('sort params', () => {
	const allowed = ['title', 'due']

	it('round-trips a chosen sort', () => {
		const encoded = new URLSearchParams(
			sortToSearchParams({ field: 'due', dir: 'desc' }),
		)
		expect(encoded.toString()).toBe('sort=due&dir=desc')
		expect(sortFromSearchParams(encoded, allowed)).toEqual({
			field: 'due',
			dir: 'desc',
		})
	})

	it('drops out of the URL entirely when nothing is chosen', () => {
		// So a page with no `?sort=` falls back to its spec-declared `order`
		// rather than to an arbitrary column pinned in the link.
		expect(sortToSearchParams(undefined)).toEqual({})
		expect(
			sortFromSearchParams(new URLSearchParams(''), allowed),
		).toBeUndefined()
	})

	it('defaults an absent or junk direction to ascending', () => {
		expect(sortFromSearchParams({ sort: 'title' }, allowed)).toEqual({
			field: 'title',
			dir: 'asc',
		})
		expect(
			sortFromSearchParams({ sort: 'title', dir: 'sideways' }, allowed),
		).toEqual({ field: 'title', dir: 'asc' })
	})

	it('refuses to order by a column the page does not show', () => {
		// The attack, not a tidiness rule. `?sort=salary` over a list the viewer
		// may read leaks the hidden column one bit at a time: no value is ever
		// returned, but the permutation of the visible rows is a comparison
		// oracle, and a few dozen requests reconstruct the ordering exactly.
		expect(sortFromSearchParams({ sort: 'salary' }, allowed)).toBeUndefined()
	})
})

describe('narrowFilters', () => {
	const allowed = ['status', 'cost']

	it('keeps the filters over columns the page shows', () => {
		expect(
			narrowFilters(
				{
					search: 'ada',
					filter: { status: 'open' },
					range: { cost: { gte: '5' } },
				},
				allowed,
			),
		).toEqual({
			search: 'ada',
			filter: { status: 'open' },
			range: { cost: { gte: '5' } },
		})
	})

	it('drops equality and range constraints over columns it does not', () => {
		// `?filter.salary=90000` answers "is this row's salary 90000?" one guess
		// at a time; a range bound answers it in binary search. Both are dropped
		// rather than passed to the store, which would ignore a name that does
		// not exist and honour one that does but is hidden.
		expect(
			narrowFilters(
				{
					filter: { status: 'open', salary: '90000' },
					range: { cost: { gte: '5' }, salary: { gte: '80000' } },
				},
				allowed,
			),
		).toEqual({
			search: undefined,
			filter: { status: 'open' },
			range: { cost: { gte: '5' } },
		})
	})

	it('collapses to EMPTY_FILTERS when nothing survives', () => {
		expect(narrowFilters({ filter: { salary: '1' } }, allowed)).toBe(
			EMPTY_FILTERS,
		)
	})

	it('drops a spelling the column declared it does not offer', () => {
		// #414: `operators: ["eq"]` means the control is an exact match, so a
		// `.gte` typed into the URL is refused rather than quietly answered.
		expect(
			narrowFilters(
				{ filter: { cost: '5' }, range: { cost: { gte: '5' } } },
				allowed,
				{ cost: ['eq'] },
			),
		).toEqual({ search: undefined, filter: { cost: '5' } })
	})

	it('leaves a column that declared nothing exactly as it was', () => {
		// A narrowing may only refuse what somebody declared: every list has
		// honoured an equality filter on an ordered column since #342.
		expect(
			narrowFilters({ filter: { cost: '5' } }, allowed, { status: ['eq'] }),
		).toEqual({ search: undefined, filter: { cost: '5' } })
	})

	it('cannot re-admit a column the page does not render', () => {
		expect(
			narrowFilters({ filter: { salary: '1' } }, allowed, {
				salary: ['eq', 'range'],
			}),
		).toBe(EMPTY_FILTERS)
	})

	it('never narrows the free-text search, which names no column', () => {
		// Search scans a derived field set the caller cannot choose, so there is
		// nothing here to narrow — and dropping it would silently ignore the one
		// control every list has.
		expect(narrowFilters({ search: 'ada', filter: {} }, [])).toEqual({
			search: 'ada',
			filter: {},
		})
	})
})
