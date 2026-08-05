import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data/data-context.tsx'
import { createMemoryDataProvider } from '../data/memory-provider.ts'
import { QueryClient } from '../data/query-client.ts'
import { createResourceRegistry } from '../registry/resource-registry.ts'
import { useGlobalSearch } from './global-search.ts'
import { SearchPalette } from './SearchPalette.tsx'

function provider() {
	return createMemoryDataProvider({
		data: {
			post: [
				{ id: 'p1', title: 'Alpha guide', body: 'x' },
				{ id: 'p2', title: 'Beta notes', body: 'y' },
			],
			user: [{ id: 'u1', name: 'Alpha person' }],
		},
	})
}

const registry = createResourceRegistry([{ name: 'post' }, { name: 'user' }])
const searchables = [
	{ name: 'post', searchFields: ['title'], titleField: 'title' },
	{ name: 'user', searchFields: ['name'], titleField: 'name' },
]

function wrap(dp = provider()) {
	return ({ children }: { children: ReactNode }) => (
		<DataProvider dataProvider={dp} queryClient={new QueryClient()}>
			{children}
		</DataProvider>
	)
}

describe('useGlobalSearch', () => {
	it('groups hits by resource across the registry', async () => {
		const { result } = renderHook(
			() => useGlobalSearch({ registry, searchables, debounce: 0 }),
			{ wrapper: wrap() },
		)
		act(() => result.current.setQuery('Alpha'))
		await waitFor(() => expect(result.current.groups.length).toBe(2))
		const byName = Object.fromEntries(
			result.current.groups.map((g) => [
				g.resource,
				g.hits.map((h) => h.title),
			]),
		)
		expect(byName.post).toEqual(['Alpha guide'])
		expect(byName.user).toEqual(['Alpha person'])
		expect(result.current.flat[0]?.href).toBe('/post/p1')
	})

	it('returns no groups below the minimum length', async () => {
		const { result } = renderHook(
			() =>
				useGlobalSearch({ registry, searchables, debounce: 0, minLength: 2 }),
			{ wrapper: wrap() },
		)
		act(() => result.current.setQuery('A'))
		await waitFor(() => expect(result.current.isSearching).toBe(false))
		expect(result.current.groups).toEqual([])
	})

	it('skips a resource the session cannot read', async () => {
		const { result } = renderHook(
			() =>
				useGlobalSearch({
					registry,
					searchables,
					debounce: 0,
					capabilities: {
						user: { read: false, create: false, update: false, delete: false },
					},
				}),
			{ wrapper: wrap() },
		)
		act(() => result.current.setQuery('Alpha'))
		await waitFor(() => expect(result.current.groups.length).toBe(1))
		expect(result.current.groups[0]?.resource).toBe('post')
	})
})

describe('SearchPalette', () => {
	it('renders grouped results and opens a hit on click', async () => {
		const onNavigate = vi.fn()
		const onClose = vi.fn()
		render(
			<SearchPalette
				open
				onClose={onClose}
				onNavigate={onNavigate}
				registry={registry}
				searchables={searchables}
				debounce={0}
			/>,
			{ wrapper: wrap() },
		)
		const input = screen.getByRole('searchbox', { name: 'Search' })
		fireEvent.change(input, { target: { value: 'Alpha' } })
		await waitFor(() =>
			expect(screen.getByText('Alpha guide')).toBeInTheDocument(),
		)
		act(() => screen.getByText('Alpha person').click())
		expect(onNavigate).toHaveBeenCalledWith(
			expect.objectContaining({ resource: 'user', id: 'u1' }),
		)
		expect(onClose).toHaveBeenCalled()
	})

	it('renders nothing when closed', () => {
		const { container } = render(
			<SearchPalette
				open={false}
				onClose={() => {}}
				registry={registry}
				searchables={searchables}
			/>,
			{ wrapper: wrap() },
		)
		expect(container).toBeEmptyDOMElement()
	})
})
