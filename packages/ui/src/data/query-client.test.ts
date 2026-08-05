/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, serializeKey } from './query-client.ts'

describe('serializeKey', () => {
	it('hashes object params order-independently', () => {
		expect(serializeKey(['list', 'post', { a: 1, b: 2 }])).toBe(
			serializeKey(['list', 'post', { b: 2, a: 1 }]),
		)
	})
	it('distinguishes different keys', () => {
		expect(serializeKey(['one', 'post', '1'])).not.toBe(
			serializeKey(['one', 'post', '2']),
		)
	})
})

describe('QueryClient.fetch', () => {
	it('moves idle → loading → success and stores data', async () => {
		const qc = new QueryClient()
		const key = ['one', 'post', '1']
		qc.subscribe(key, () => {})
		expect(qc.getState(key).status).toBe('idle')
		const p = qc.fetch(key, async () => ({ id: '1' }))
		expect(qc.getState(key).status).toBe('loading')
		expect(qc.getState(key).isFetching).toBe(true)
		await p
		expect(qc.getState(key).status).toBe('success')
		expect(qc.getState(key).isFetching).toBe(false)
		expect(qc.getQueryData(key)).toEqual({ id: '1' })
	})

	it('de-dupes concurrent fetches for the same key', async () => {
		const qc = new QueryClient()
		const key = ['list', 'post', {}]
		const fetcher = vi.fn(async () => [1])
		const [a, b] = [qc.fetch(key, fetcher), qc.fetch(key, fetcher)]
		expect(a).toBe(b)
		await a
		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it('force refetches even with data present, keeping data during refetch', async () => {
		const qc = new QueryClient()
		const key = ['list', 'post', {}]
		qc.subscribe(key, () => {})
		await qc.fetch(key, async () => [1])
		const p = qc.fetch(key, async () => [1, 2], { force: true })
		// data stays on screen; status is not knocked back to loading.
		expect(qc.getState(key).status).toBe('success')
		expect(qc.getState(key).isFetching).toBe(true)
		await p
		expect(qc.getQueryData(key)).toEqual([1, 2])
	})

	it('records an error and does not clobber it silently', async () => {
		const qc = new QueryClient()
		const key = ['one', 'post', 'x']
		qc.subscribe(key, () => {})
		await expect(
			qc.fetch(key, async () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		expect(qc.getState(key).status).toBe('error')
		expect(qc.getState(key).error?.message).toBe('boom')
	})
})

describe('QueryClient cache writes', () => {
	it('setQueryData updates only observed keys and notifies', async () => {
		const qc = new QueryClient()
		const key = ['one', 'post', '1']
		const listener = vi.fn()
		qc.subscribe(key, listener)
		await qc.fetch(key, async () => ({ id: '1', title: 'a' }))
		listener.mockClear()
		qc.setQueryData(key, (old: { id: string; title: string } | undefined) => ({
			...(old as { id: string; title: string }),
			title: 'b',
		}))
		expect(qc.getQueryData(key)).toEqual({ id: '1', title: 'b' })
		expect(listener).toHaveBeenCalled()
	})

	it('setQueryData is a no-op for an unobserved key', () => {
		const qc = new QueryClient()
		qc.setQueryData(['one', 'post', 'ghost'], () => ({ id: 'ghost' }))
		expect(qc.getQueryData(['one', 'post', 'ghost'])).toBeUndefined()
	})

	it('setQueriesData patches every matching entry', async () => {
		const qc = new QueryClient()
		const k1 = ['list', 'post', { page: 1 }]
		const k2 = ['list', 'post', { page: 2 }]
		qc.subscribe(k1, () => {})
		qc.subscribe(k2, () => {})
		await qc.fetch(k1, async () => [{ id: '1' }])
		await qc.fetch(k2, async () => [{ id: '2' }])
		qc.setQueriesData<{ id: string }[]>(
			(key) => key[0] === 'list' && key[1] === 'post',
			(old) => (old ?? []).map((r) => ({ ...r, seen: true })),
		)
		expect(qc.getQueryData(k1)).toEqual([{ id: '1', seen: true }])
		expect(qc.getQueryData(k2)).toEqual([{ id: '2', seen: true }])
	})
})

describe('QueryClient.invalidate', () => {
	it('refetches observed matching queries', async () => {
		const qc = new QueryClient()
		const key = ['list', 'post', {}]
		qc.subscribe(key, () => {})
		let n = 0
		const fetcher = vi.fn(async () => {
			n += 1
			return [n]
		})
		await qc.fetch(key, fetcher)
		expect(qc.getQueryData(key)).toEqual([1])
		qc.invalidate((k) => k[1] === 'post')
		await Promise.resolve()
		await Promise.resolve()
		expect(fetcher).toHaveBeenCalledTimes(2)
		expect(qc.getQueryData(key)).toEqual([2])
	})

	it('drops unobserved matching queries so a remount refetches', async () => {
		const qc = new QueryClient()
		const key = ['list', 'post', {}]
		const unsub = qc.subscribe(key, () => {})
		await qc.fetch(key, async () => [1])
		unsub() // now unobserved
		qc.invalidate((k) => k[1] === 'post')
		expect(qc.getState(key).status).toBe('idle')
	})
})
