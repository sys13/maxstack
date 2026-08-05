/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { createMemoryDataProvider } from './memory-provider.ts'

function seeded() {
	return createMemoryDataProvider({
		data: {
			post: [
				{ id: '1', title: 'Alpha', points: 10, published: true },
				{ id: '2', title: 'Beta', points: 30, published: false },
				{ id: '3', title: 'Gamma', points: 20, published: true },
			],
		},
	})
}

describe('createMemoryDataProvider — DataProvider contract', () => {
	it('lists all rows with a total', async () => {
		const { data, total } = await seeded().getList('post')
		expect(total).toBe(3)
		expect(data.map((r) => r.id)).toEqual(['1', '2', '3'])
	})

	it('filters, sorts, and paginates', async () => {
		const dp = seeded()
		const filtered = await dp.getList('post', { filter: { published: true } })
		expect(filtered.data.map((r) => r.id)).toEqual(['1', '3'])

		const sorted = await dp.getList('post', {
			sort: { field: 'points', order: 'desc' },
		})
		expect(sorted.data.map((r) => r.points)).toEqual([30, 20, 10])

		const paged = await dp.getList('post', {
			pagination: { page: 2, perPage: 1 },
			sort: { field: 'points', order: 'asc' },
		})
		expect(paged.total).toBe(3)
		expect(paged.data.map((r) => r.id)).toEqual(['3'])
	})

	it('honors a numeric range and search', async () => {
		const dp = seeded()
		const range = await dp.getList('post', { range: { points: { gte: 20 } } })
		expect(range.data.map((r) => r.id)).toEqual(['2', '3'])
		const search = await dp.getList('post', {
			search: 'amm',
			searchFields: ['title'],
		})
		expect(search.data.map((r) => r.id)).toEqual(['3'])
	})

	it('getOne / getMany', async () => {
		const dp = seeded()
		expect((await dp.getOne('post', '2')).title).toBe('Beta')
		await expect(dp.getOne('post', '99')).rejects.toThrow()
		const many = await dp.getMany('post', ['1', '3'])
		expect(many.map((r) => r.id)).toEqual(['1', '3'])
	})

	it('creates (generating an id), updates, and deletes', async () => {
		const dp = seeded()
		const created = await dp.create('post', { title: 'Delta', points: 5 })
		expect(created.id).toBeDefined()
		expect((await dp.getList('post')).total).toBe(4)

		const updated = await dp.update('post', '1', { title: 'Alpha!' })
		expect(updated.title).toBe('Alpha!')
		expect(updated.id).toBe('1')

		await dp.delete('post', '2')
		expect((await dp.getList('post')).total).toBe(3)
		await expect(dp.getOne('post', '2')).rejects.toThrow()
	})

	it('does not mutate the caller-supplied seed by reference', async () => {
		const seed = { post: [{ id: '1', title: 'A' }] }
		const dp = createMemoryDataProvider({ data: seed })
		await dp.update('post', '1', { title: 'B' })
		expect(seed.post[0]?.title).toBe('A')
	})
})

describe('createMemoryDataProvider — AggregateProvider', () => {
	it('counts matching rows', async () => {
		const dp = seeded()
		expect(await dp.count('post')).toBe(3)
		expect(await dp.count('post', { filter: { published: true } })).toBe(2)
	})

	it('sums / averages / min / max over a column', async () => {
		const dp = seeded()
		expect(await dp.aggregate('post', 'sum', 'points')).toBe(60)
		expect(await dp.aggregate('post', 'avg', 'points')).toBe(20)
		expect(await dp.aggregate('post', 'min', 'points')).toBe(10)
		expect(await dp.aggregate('post', 'max', 'points')).toBe(30)
	})

	it('aggregates over a filtered set', async () => {
		const dp = seeded()
		expect(
			await dp.aggregate('post', 'sum', 'points', {
				filter: { published: true },
			}),
		).toBe(30)
	})
})
