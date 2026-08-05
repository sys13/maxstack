/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it, vi } from 'vitest'
import {
	createRestDataProvider,
	DataProviderError,
	fieldErrorsFrom,
} from './data-provider.ts'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	})
}

describe('createRestDataProvider — URL construction', () => {
	it('getList maps pagination/sort/search/filter to Sprout query params', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse([{ id: '1' }]),
		)
		const dp = createRestDataProvider({ fetch })
		await dp.getList('post', {
			pagination: { page: 2, perPage: 10 },
			sort: { field: 'title', order: 'desc' },
			search: 'ab',
			searchFields: ['title', 'body'],
			filter: { status: 'open', authorId: 'u1' },
		})
		const url = fetch.mock.calls[0]?.[0] as string
		expect(url).toContain('/api/post?')
		expect(url).toContain('limit=10')
		expect(url).toContain('offset=10') // (page 2 - 1) * 10
		expect(url).toContain('orderBy=title')
		expect(url).toContain('orderDir=desc')
		expect(url).toContain('search=ab')
		expect(url).toContain('searchField=title')
		expect(url).toContain('searchField=body')
		expect(url).toContain('filter.status=open')
		expect(url).toContain('filter.authorId=u1')
	})

	it('getList encodes range bounds as filter.<col>.gte/.lte, skipping blanks', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse([{ id: '1' }]),
		)
		const dp = createRestDataProvider({ fetch })
		await dp.getList('post', {
			range: { cost: { gte: 5, lte: 20 }, views: { gte: 100, lte: '' } },
		})
		const url = fetch.mock.calls[0]?.[0] as string
		expect(url).toContain('filter.cost.gte=5')
		expect(url).toContain('filter.cost.lte=20')
		expect(url).toContain('filter.views.gte=100')
		expect(url).not.toContain('filter.views.lte')
	})

	it('getList returns data + falls back total to page length', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse([{ id: '1' }, { id: '2' }]),
		)
		const dp = createRestDataProvider({ fetch })
		const res = await dp.getList('post')
		expect(res.data).toHaveLength(2)
		expect(res.total).toBe(2)
	})

	it('getList honors an X-Total-Count header when present', async () => {
		const fetch = vi.fn(async () =>
			jsonResponse([{ id: '1' }], { headers: { 'x-total-count': '57' } }),
		)
		const dp = createRestDataProvider({ fetch })
		const res = await dp.getList('post')
		expect(res.total).toBe(57)
	})

	it('getMany batches ids and short-circuits an empty list', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse([{ id: 'a' }]),
		)
		const dp = createRestDataProvider({ fetch })
		expect(await dp.getMany('post', [])).toEqual([])
		expect(fetch).not.toHaveBeenCalled()
		await dp.getMany('post', ['a', 'b'])
		expect(fetch.mock.calls[0]?.[0]).toContain('/api/post?ids=a%2Cb')
	})

	it('create/update/delete use the right method + path', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({ id: '1' }),
		)
		const dp = createRestDataProvider({ fetch })
		await dp.create('post', { title: 't' })
		expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST')
		await dp.update('post', '1', { title: 'u' })
		expect(fetch.mock.calls[1]?.[0]).toContain('/api/post/1')
		expect(fetch.mock.calls[1]?.[1]?.method).toBe('PATCH')
		const del = await dp.delete('post', '1')
		expect(fetch.mock.calls[2]?.[1]?.method).toBe('DELETE')
		expect(del).toEqual({ id: '1' })
	})

	it('respects a custom apiBase', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({ id: '1' }),
		)
		const dp = createRestDataProvider({ fetch, apiBase: '/data/v1' })
		await dp.getOne('post', '1')
		expect(fetch.mock.calls[0]?.[0]).toContain('/data/v1/post/1')
	})
})

describe('createRestDataProvider — errors', () => {
	it('throws DataProviderError carrying status + body on non-2xx', async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({ fieldErrors: { title: 'required' } }, { status: 422 }),
		)
		const dp = createRestDataProvider({ fetch })
		const err = await dp.create('post', {}).catch((e) => e)
		expect(err).toBeInstanceOf(DataProviderError)
		expect(err.status).toBe(422)
		expect(err.body).toEqual({ fieldErrors: { title: 'required' } })
	})

	it('surfaces a 403 error message', async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({ error: 'forbidden' }, { status: 403 }),
		)
		const dp = createRestDataProvider({ fetch })
		await expect(dp.getOne('post', '1')).rejects.toThrow('forbidden')
	})
})

describe('fieldErrorsFrom', () => {
	it('extracts fieldErrors from a 422 DataProviderError', () => {
		const error = new DataProviderError(422, {
			fieldErrors: { email: ['Already taken'] },
		})
		expect(fieldErrorsFrom(error)).toEqual({ email: ['Already taken'] })
	})

	it('returns undefined for non-422 / non-DataProviderError failures', () => {
		expect(
			fieldErrorsFrom(new DataProviderError(403, { error: 'nope' })),
		).toBeUndefined()
		expect(
			fieldErrorsFrom(new DataProviderError(422, { error: 'no fields' })),
		).toBeUndefined()
		expect(fieldErrorsFrom(new Error('network'))).toBeUndefined()
	})
})
