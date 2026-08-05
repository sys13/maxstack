import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataProvider } from './data-context.tsx'
import type { DataProvider as DataProviderContract } from './data-provider.ts'
import {
	useCreate,
	useDelete,
	useInfiniteList,
	useList,
	useOne,
	useUpdate,
} from './hooks.ts'
import { NotificationProvider, Notifications } from './notifications.tsx'
import { QueryClient } from './query-client.ts'

type Post = { id: string; title: string }

function makeProvider(
	overrides: Partial<DataProviderContract> = {},
): DataProviderContract {
	const base: DataProviderContract = {
		getList: vi.fn(async () => ({ data: [], total: 0 })),
		getOne: vi.fn(async () => ({ id: '1', title: 'a' })),
		getMany: vi.fn(async () => []),
		create: vi.fn(async (_r, d) => ({ id: 'new', ...d })),
		update: vi.fn(async (_r, id, d) => ({ id, ...d })),
		delete: vi.fn(async (_r, id) => ({ id })),
	}
	return { ...base, ...overrides }
}

function wrapper(dp: DataProviderContract, qc: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<NotificationProvider>
			<DataProvider dataProvider={dp} queryClient={qc}>
				{children}
				<Notifications />
			</DataProvider>
		</NotificationProvider>
	)
}

describe('useList / useOne', () => {
	it('loads, exposes total, and lands data', async () => {
		const dp = makeProvider({
			getList: vi.fn(async () => ({
				data: [{ id: '1', title: 'a' }] as Post[],
				total: 42,
			})),
		})
		const qc = new QueryClient()
		const { result } = renderHook(() => useList<Post>('post'), {
			wrapper: wrapper(dp, qc),
		})
		expect(result.current.isLoading).toBe(true)
		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.data).toEqual([{ id: '1', title: 'a' }])
		expect(result.current.total).toBe(42)
	})

	it('useOne is disabled for a nullish id', async () => {
		const dp = makeProvider()
		const qc = new QueryClient()
		renderHook(() => useOne<Post>('post', undefined), {
			wrapper: wrapper(dp, qc),
		})
		await Promise.resolve()
		expect(dp.getOne).not.toHaveBeenCalled()
	})
})

describe('useCreate', () => {
	it('creates and invalidates the list so it refetches', async () => {
		const getList = vi.fn(async () => ({ data: [] as Post[], total: 0 }))
		const dp = makeProvider({ getList })
		const qc = new QueryClient()
		const { result } = renderHook(
			() => ({ list: useList<Post>('post'), create: useCreate<Post>('post') }),
			{ wrapper: wrapper(dp, qc) },
		)
		await waitFor(() => expect(result.current.list.isLoading).toBe(false))
		expect(getList).toHaveBeenCalledTimes(1)
		await act(async () => {
			await result.current.create[0]({ title: 'fresh' })
		})
		expect(dp.create).toHaveBeenCalledWith('post', { title: 'fresh' })
		await waitFor(() => expect(getList).toHaveBeenCalledTimes(2))
	})
})

describe('mutation notifications (task 35)', () => {
	it('toasts a default success message on create', async () => {
		const dp = makeProvider()
		const qc = new QueryClient()
		const { result } = renderHook(() => useCreate<Post>('post'), {
			wrapper: wrapper(dp, qc),
		})
		await act(async () => {
			await result.current[0]({ title: 'x' })
		})
		expect(await screen.findByText('Created.')).toBeInTheDocument()
	})

	it('toasts the error message when a mutation throws', async () => {
		const dp = makeProvider({
			update: vi.fn(async () => {
				throw new Error('nope')
			}),
		})
		const qc = new QueryClient()
		const { result } = renderHook(() => useUpdate<Post>('post'), {
			wrapper: wrapper(dp, qc),
		})
		await act(async () => {
			await result.current[0]('1', { title: 'x' }).catch(() => {})
		})
		expect(await screen.findByText('nope')).toBeInTheDocument()
	})

	it('stays silent when notify is false', async () => {
		const dp = makeProvider()
		const qc = new QueryClient()
		const { result } = renderHook(() => useCreate<Post>('post'), {
			wrapper: wrapper(dp, qc),
		})
		await act(async () => {
			await result.current[0]({ title: 'x' }, { notify: false })
		})
		expect(screen.queryByText('Created.')).toBeNull()
	})
})

describe('useUpdate — optimistic', () => {
	it('patches the cached list immediately, before the server responds', async () => {
		let resolveUpdate: (v: Post) => void = () => {}
		const dp = makeProvider({
			getList: vi.fn(async () => ({
				data: [{ id: '1', title: 'old' }] as Post[],
				total: 1,
			})),
			update: vi.fn(
				() =>
					new Promise<Post>((res) => {
						resolveUpdate = res
					}),
			),
		})
		const qc = new QueryClient()
		const { result } = renderHook(
			() => ({ list: useList<Post>('post'), update: useUpdate<Post>('post') }),
			{ wrapper: wrapper(dp, qc) },
		)
		await waitFor(() =>
			expect(result.current.list.data).toEqual([{ id: '1', title: 'old' }]),
		)
		let pending: Promise<unknown>
		act(() => {
			pending = result.current.update[0]('1', { title: 'new' })
		})
		// Optimistic: list shows the new title while the request is still pending.
		await waitFor(() =>
			expect(result.current.list.data?.[0]?.title).toBe('new'),
		)
		await act(async () => {
			resolveUpdate({ id: '1', title: 'new' })
			await pending
		})
	})

	it('rolls back on error (refetch restores server truth)', async () => {
		const getList = vi
			.fn()
			.mockResolvedValueOnce({ data: [{ id: '1', title: 'old' }], total: 1 })
			.mockResolvedValue({ data: [{ id: '1', title: 'old' }], total: 1 })
		const dp = makeProvider({
			getList,
			update: vi.fn(async () => {
				throw new Error('nope')
			}),
		})
		const qc = new QueryClient()
		const { result } = renderHook(
			() => ({ list: useList<Post>('post'), update: useUpdate<Post>('post') }),
			{ wrapper: wrapper(dp, qc) },
		)
		await waitFor(() =>
			expect(result.current.list.data?.[0]?.title).toBe('old'),
		)
		await act(async () => {
			await result.current.update[0]('1', { title: 'new' }).catch(() => {})
		})
		await waitFor(() =>
			expect(result.current.list.data?.[0]?.title).toBe('old'),
		)
		expect(result.current.update[1].error?.message).toBe('nope')
	})
})

describe('useDelete', () => {
	it('pessimistic: deletes then invalidates', async () => {
		const getList = vi
			.fn()
			.mockResolvedValueOnce({ data: [{ id: '1', title: 'a' }], total: 1 })
			.mockResolvedValue({ data: [], total: 0 })
		const dp = makeProvider({ getList })
		const qc = new QueryClient()
		const { result } = renderHook(
			() => ({ list: useList<Post>('post'), del: useDelete('post') }),
			{ wrapper: wrapper(dp, qc) },
		)
		await waitFor(() => expect(result.current.list.data).toHaveLength(1))
		await act(async () => {
			await result.current.del[0]('1')
		})
		expect(dp.delete).toHaveBeenCalledWith('post', '1')
		await waitFor(() => expect(result.current.list.data).toHaveLength(0))
	})
})

describe('useDelete — undoable', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('removes the row instantly, then commits after the delay', async () => {
		const dp = makeProvider({
			getList: vi.fn(async () => ({
				data: [{ id: '1', title: 'a' }] as Post[],
				total: 1,
			})),
		})
		const qc = new QueryClient()
		const { result } = renderHook(
			() => ({ list: useList<Post>('post'), del: useDelete('post') }),
			{ wrapper: wrapper(dp, qc) },
		)
		await vi.waitFor(() => expect(result.current.list.data).toHaveLength(1))
		act(() => {
			void result.current.del[0]('1', { mode: 'undoable', undoDelay: 5000 })
		})
		// Optimistically gone from the UI right away, but the server wasn't called.
		expect(result.current.list.data).toHaveLength(0)
		expect(dp.delete).not.toHaveBeenCalled()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000)
		})
		expect(dp.delete).toHaveBeenCalledWith('post', '1')
	})

	it('undo cancels the commit and restores the row', async () => {
		const dp = makeProvider({
			getList: vi.fn(async () => ({
				data: [{ id: '1', title: 'a' }] as Post[],
				total: 1,
			})),
		})
		const qc = new QueryClient()
		function Harness() {
			const list = useList<Post>('post')
			const [del] = useDelete('post')
			return (
				<div>
					<span data-testid="count">{list.data?.length ?? 0}</span>
					<button
						type="button"
						onClick={() => void del('1', { mode: 'undoable' })}
					>
						delete
					</button>
				</div>
			)
		}
		render(<Harness />, { wrapper: wrapper(dp, qc) })
		await vi.waitFor(() =>
			expect(screen.getByTestId('count').textContent).toBe('1'),
		)
		act(() => {
			fireEvent.click(screen.getByRole('button', { name: 'delete' }))
		})
		expect(screen.getByTestId('count').textContent).toBe('0')
		// The undo toast appeared; click it before the delay elapses.
		act(() => {
			fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
		})
		await vi.waitFor(() =>
			expect(screen.getByTestId('count').textContent).toBe('1'),
		)
		// Advancing past the window must NOT commit — undo cancelled it.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(6000)
		})
		expect(dp.delete).not.toHaveBeenCalled()
	})
})

describe('useInfiniteList (task 40 infinite scroll)', () => {
	/** 5 posts served 2 per page. */
	function pagedProvider() {
		const all: Post[] = Array.from({ length: 5 }, (_, i) => ({
			id: String(i + 1),
			title: `t${i + 1}`,
		}))
		return makeProvider({
			getList: vi.fn(async (_r, params) => {
				const { page = 1, perPage = 2 } = params?.pagination ?? {}
				const start = (page - 1) * perPage
				return { data: all.slice(start, start + perPage), total: 5 }
			}),
			// Persist updates so the post-invalidate refetch agrees with the patch.
			update: vi.fn(async (_r, id, d) => {
				const i = all.findIndex((p) => p.id === id)
				const existing = all[i]
				if (!existing) throw new Error(`post not found: ${id}`)
				const next = { ...existing, ...(d as Partial<Post>) }
				all[i] = next
				return next
			}),
		})
	}

	it('accumulates pages via loadMore and flips hasMore off at the end', async () => {
		const dp = pagedProvider()
		const qc = new QueryClient()
		const { result } = renderHook(
			() => useInfiniteList<Post>('post', {}, { perPage: 2 }),
			{ wrapper: wrapper(dp, qc) },
		)
		expect(result.current.isLoading).toBe(true)
		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.data.map((p) => p.id)).toEqual(['1', '2'])
		expect(result.current.hasMore).toBe(true)

		act(() => result.current.loadMore())
		await waitFor(() => expect(result.current.data).toHaveLength(4))
		expect(result.current.isFetchingMore).toBe(false)
		expect(dp.getList).toHaveBeenLastCalledWith(
			'post',
			expect.objectContaining({ pagination: { page: 2, perPage: 2 } }),
		)

		act(() => result.current.loadMore())
		await waitFor(() => expect(result.current.data).toHaveLength(5))
		expect(result.current.total).toBe(5)
		expect(result.current.hasMore).toBe(false)
	})

	it('resets to one page when the params change', async () => {
		const dp = pagedProvider()
		const qc = new QueryClient()
		const { result, rerender } = renderHook(
			({ search }: { search?: string }) =>
				useInfiniteList<Post>('post', { search }, { perPage: 2 }),
			{ wrapper: wrapper(dp, qc), initialProps: {} },
		)
		await waitFor(() => expect(result.current.isLoading).toBe(false))
		act(() => result.current.loadMore())
		await waitFor(() => expect(result.current.data).toHaveLength(4))

		rerender({ search: 'x' })
		await waitFor(() =>
			expect(result.current.data.map((p) => p.id)).toEqual(['1', '2']),
		)
		expect(dp.getList).toHaveBeenLastCalledWith(
			'post',
			expect.objectContaining({
				search: 'x',
				pagination: { page: 1, perPage: 2 },
			}),
		)
	})

	it('receives useUpdate optimistic patches and refetches on invalidate', async () => {
		const dp = pagedProvider()
		const qc = new QueryClient()
		const { result } = renderHook(
			() => ({
				list: useInfiniteList<Post>('post', {}, { perPage: 2 }),
				update: useUpdate<Post>('post'),
			}),
			{ wrapper: wrapper(dp, qc) },
		)
		await waitFor(() => expect(result.current.list.isLoading).toBe(false))
		act(() => result.current.list.loadMore())
		await waitFor(() => expect(result.current.list.data).toHaveLength(4))

		await act(async () => {
			await result.current.update[0]('3', { title: 'patched' })
		})
		await waitFor(() =>
			expect(result.current.list.data.find((p) => p.id === '3')?.title).toBe(
				'patched',
			),
		)
	})
})

// ===========================================================================
// One convention, two forms
// ===========================================================================

describe('mutation hooks read both ways', () => {
	it('destructures by name, the way useList taught', async () => {
		// The reported failure: the session pattern-matched off `useList`, wrote
		// `const { create } = useCreate(…)`, got undefined, and discovered the
		// mismatch through a broken render instead of a type error.
		const dp = makeProvider()
		const qc = new QueryClient()
		const { result } = renderHook(() => useCreate<Post>('post'), {
			wrapper: wrapper(dp, qc),
		})
		expect(typeof result.current.create).toBe('function')
		expect(result.current.isLoading).toBe(false)
		expect(result.current.error).toBeUndefined()
		await act(async () => {
			await result.current.create({ title: 'fresh' })
		})
		expect(dp.create).toHaveBeenCalled()
	})

	it('still destructures as a tuple, so existing code is untouched', async () => {
		const dp = makeProvider()
		const qc = new QueryClient()
		const { result } = renderHook(() => useUpdate<Post>('post'), {
			wrapper: wrapper(dp, qc),
		})
		const [update, state] = result.current
		expect(typeof update).toBe('function')
		expect(state.isLoading).toBe(false)
	})

	it('names the delete function too, not just create/update', () => {
		const dp = makeProvider()
		const qc = new QueryClient()
		const { result } = renderHook(() => useDelete('post'), {
			wrapper: wrapper(dp, qc),
		})
		expect(typeof result.current.remove).toBe('function')
		expect(typeof result.current[0]).toBe('function')
	})
})
