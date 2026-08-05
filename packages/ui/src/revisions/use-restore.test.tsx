import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data/data-context.tsx'
import type { DataProvider as DataProviderContract } from '../data/data-provider.ts'
import { QueryClient } from '../data/query-client.ts'
import { useRestore } from './use-restore.ts'

function makeProvider(overrides: Partial<DataProviderContract> = {}) {
	return {
		getList: vi.fn(async () => ({ data: [], total: 0 })),
		getOne: vi.fn(async () => ({ id: '1' })),
		getMany: vi.fn(async () => []),
		create: vi.fn(async (_r, d) => ({ id: 'new', ...d })),
		update: vi.fn(async (_r, id, d) => ({ id, ...d })),
		delete: vi.fn(async (_r, id) => ({ id })),
		...overrides,
	} as DataProviderContract
}

function wrap(dp: DataProviderContract) {
	return ({ children }: { children: ReactNode }) => (
		<DataProvider dataProvider={dp} queryClient={new QueryClient()}>
			{children}
		</DataProvider>
	)
}

describe('useRestore', () => {
	it('updates with the snapshot minus server-owned fields', async () => {
		const dp = makeProvider()
		const { result } = renderHook(() => useRestore('post'), {
			wrapper: wrap(dp),
		})
		await act(async () => {
			await result.current[0]({
				id: 'r1',
				createdAt: '2026-01-01',
				snapshot: {
					id: '1',
					title: 'Old title',
					createdAt: '2026-01-01',
					updatedAt: '2026-01-02',
				},
			})
		})
		await waitFor(() => expect(dp.update).toHaveBeenCalled())
		expect(dp.update).toHaveBeenCalledWith('post', '1', { title: 'Old title' })
	})
})
