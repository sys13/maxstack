import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data/data-context.tsx'
import { useList } from '../data/hooks.ts'
import { createMemoryDataProvider } from '../data/memory-provider.ts'
import { QueryClient } from '../data/query-client.ts'
import {
	createPollingSubscription,
	type SubscriptionProvider,
	useSubscription,
} from './subscriptions.ts'

function wrap(dp = createMemoryDataProvider(), qc = new QueryClient()) {
	return ({ children }: { children: ReactNode }) => (
		<DataProvider dataProvider={dp} queryClient={qc}>
			{children}
		</DataProvider>
	)
}

describe('useSubscription', () => {
	it('invalidates the resource list on a pushed change → the list refetches', async () => {
		const dp = createMemoryDataProvider({
			data: { post: [{ id: '1', title: 'A' }] },
		})
		const qc = new QueryClient()
		let emit: ((e: { resource: string; type: 'updated' }) => void) | undefined
		const provider: SubscriptionProvider = {
			subscribe: (_resource, onChange) => {
				emit = onChange as typeof emit
				return () => {}
			},
		}

		const { result } = renderHook(
			() => {
				useSubscription(provider, 'post')
				return useList('post')
			},
			{ wrapper: wrap(dp, qc) },
		)
		await waitFor(() => expect(result.current.data?.length).toBe(1))

		// A record appears on the backend, then the transport pushes a change.
		await dp.create('post', { id: '2', title: 'B' })
		act(() => emit?.({ resource: 'post', type: 'updated' }))
		await waitFor(() => expect(result.current.data?.length).toBe(2))
	})
})

describe('createPollingSubscription', () => {
	it('emits an updated event when the polled list changes', async () => {
		const dp = createMemoryDataProvider({ data: { post: [{ id: '1' }] } })
		// Drive the timer manually so the test is deterministic.
		let tick: (() => void) | undefined
		const sub = createPollingSubscription(dp, {
			setInterval: (fn) => {
				tick = fn
				return 0 as unknown as ReturnType<typeof setInterval>
			},
			clearInterval: () => {},
		})
		const onChange = vi.fn()
		sub.subscribe('post', onChange)
		// First poll establishes the baseline (no event).
		await waitFor(() => expect(onChange).not.toHaveBeenCalled())

		await dp.create('post', { id: '2' })
		await act(async () => {
			tick?.()
		})
		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ resource: 'post', type: 'updated' }),
		)
	})
})
