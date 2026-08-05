import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
	useAggregate,
	useCount,
	useCustomQuery,
	useMutation,
	useSupportsAggregates,
} from './custom.ts'
import { DataProvider } from './data-context.tsx'
import { createMemoryDataProvider } from './memory-provider.ts'
import { QueryClient } from './query-client.ts'

function wrap(
	dp = createMemoryDataProvider({ data: mkData() }),
	qc = new QueryClient(),
) {
	return ({ children }: { children: ReactNode }) => (
		<DataProvider dataProvider={dp} queryClient={qc}>
			{children}
		</DataProvider>
	)
}

function mkData() {
	return {
		post: [
			{ id: '1', title: 'Alpha', points: 10, published: true },
			{ id: '2', title: 'Beta', points: 30, published: false },
		],
	}
}

describe('useCustomQuery', () => {
	it('runs a fetcher and caches by key', async () => {
		const fetcher = vi.fn(async () => ({ ok: true }))
		const { result } = renderHook(() => useCustomQuery(['rpc', 'x'], fetcher), {
			wrapper: wrap(),
		})
		await waitFor(() => expect(result.current.data).toEqual({ ok: true }))
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
})

describe('useMutation', () => {
	it('runs an action, exposes pending/result, and invalidates keys', async () => {
		const qc = new QueryClient()
		const action = vi.fn(async (n: number) => n * 2)
		const invalidate = vi.spyOn(qc, 'invalidate')
		const { result } = renderHook(
			() => useMutation(action, { invalidateKeys: [['list', 'post', {}]] }),
			{ wrapper: wrap(createMemoryDataProvider(), qc) },
		)
		let out: number | undefined
		await act(async () => {
			out = await result.current.mutate(21)
		})
		expect(out).toBe(42)
		expect(result.current.data).toBe(42)
		expect(invalidate).toHaveBeenCalled()
	})

	it('captures an error and rethrows', async () => {
		const action = vi.fn(async () => {
			throw new Error('boom')
		})
		const { result } = renderHook(() => useMutation(action), {
			wrapper: wrap(),
		})
		await act(async () => {
			await expect(result.current.mutate()).rejects.toThrow('boom')
		})
		expect(result.current.error?.message).toBe('boom')
	})
})

describe('useCount / useAggregate', () => {
	it('reports the count of matching records', async () => {
		const { result } = renderHook(
			() => useCount('post', { filter: { published: true } }),
			{ wrapper: wrap() },
		)
		await waitFor(() => expect(result.current.data).toBe(1))
	})

	it('computes a sum aggregate', async () => {
		const { result } = renderHook(() => useAggregate('post', 'sum', 'points'), {
			wrapper: wrap(),
		})
		await waitFor(() => expect(result.current.data).toBe(40))
	})

	it('detects aggregate support', () => {
		const { result } = renderHook(() => useSupportsAggregates(), {
			wrapper: wrap(),
		})
		expect(result.current).toBe(true)
	})

	it('errors when the provider lacks aggregate support', async () => {
		const restLike = {
			getList: async () => ({ data: [], total: 0 }),
			getOne: async () => ({}),
			getMany: async () => [],
			create: async (_r: string, d: Record<string, unknown>) => d,
			update: async (_r: string, _i: string, d: Record<string, unknown>) => d,
			delete: async (_r: string, id: string) => ({ id }),
		}
		const { result } = renderHook(() => useCount('post'), {
			wrapper: wrap(restLike as never),
		})
		await waitFor(() => expect(result.current.error).toBeDefined())
	})
})
