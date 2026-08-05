import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PreferenceProvider } from '../prefs/prefs-context.tsx'
import { memoryBackend, PreferenceStore } from '../prefs/store.ts'
import type { FilterValues } from './filterable.ts'
import { SavedQueries } from './SavedQueries.tsx'
import { type AppliedQuery, useSavedQueries } from './saved-queries.ts'

function wrapper(store: PreferenceStore) {
	return ({ children }: { children: ReactNode }) => (
		<PreferenceProvider store={store}>{children}</PreferenceProvider>
	)
}

const highPriority: FilterValues = {
	search: 'urgent',
	filter: { priority: 'high' },
	range: { cost: { gte: '5' } },
}

describe('useSavedQueries', () => {
	it('saves, applies (round-tripping through the URL codec), and removes', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useSavedQueries('post'), {
			wrapper: wrapper(store),
		})

		act(() => {
			result.current.save('High priority', highPriority, {
				field: 'points',
				dir: 'desc',
			})
		})
		expect(result.current.queries).toHaveLength(1)
		// Persisted as flat URL-codec params — the shareable wire shape.
		expect(result.current.queries[0]?.params).toEqual({
			search: 'urgent',
			'filter.priority': 'high',
			'filter.cost.gte': '5',
		})

		const applied = result.current.apply('High priority')
		expect(applied?.values).toEqual(highPriority)
		expect(applied?.sort).toEqual({ field: 'points', dir: 'desc' })

		act(() => result.current.remove('High priority'))
		expect(result.current.queries).toEqual([])
		expect(result.current.apply('High priority')).toBeUndefined()
	})

	it('overwrites by name and persists across remounts on the same store', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const hook = renderHook(() => useSavedQueries('post'), {
			wrapper: wrapper(store),
		})
		act(() => {
			hook.result.current.save('Mine', { filter: { owner: 'a' } })
			hook.result.current.save('Mine', { filter: { owner: 'b' } })
		})
		expect(hook.result.current.queries).toHaveLength(1)
		hook.unmount()

		const again = renderHook(() => useSavedQueries('post'), {
			wrapper: wrapper(store),
		})
		expect(again.result.current.apply('Mine')?.values.filter).toEqual({
			owner: 'b',
		})
	})

	it('matching finds the preset equal to the current filters+sort', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useSavedQueries('post'), {
			wrapper: wrapper(store),
		})
		act(() => result.current.save('Q', highPriority))
		expect(result.current.matching(highPriority)?.name).toBe('Q')
		expect(
			result.current.matching(highPriority, { field: 'points', dir: 'asc' }),
		).toBeUndefined()
		expect(result.current.matching({ filter: {} })).toBeUndefined()
	})
})

describe('<SavedQueries>', () => {
	it('renders nothing with no presets and nothing savable', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { container } = render(
			<PreferenceProvider store={store}>
				<SavedQueries
					resource="post"
					value={{ filter: {} }}
					onApply={vi.fn()}
				/>
			</PreferenceProvider>,
		)
		expect(container).toBeEmptyDOMElement()
	})

	it('saves the current filters through the name form, then applies them', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const onApply = vi.fn()
		render(
			<PreferenceProvider store={store}>
				<SavedQueries
					resource="post"
					value={highPriority}
					sort={{ field: 'points', dir: 'desc' }}
					onApply={onApply}
				/>
			</PreferenceProvider>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Save query…' }))
		fireEvent.change(screen.getByLabelText('Query name'), {
			target: { value: 'High priority' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))

		// The new chip is the active preset, so the save affordance is gone.
		const chip = screen.getByRole('button', { name: 'High priority' })
		expect(chip).toHaveAttribute('aria-pressed', 'true')
		expect(screen.queryByRole('button', { name: 'Save query…' })).toBeNull()

		fireEvent.click(chip)
		const applied = onApply.mock.calls[0]?.[0] as AppliedQuery
		expect(applied.values).toEqual(highPriority)
		expect(applied.sort).toEqual({ field: 'points', dir: 'desc' })
	})

	it('deletes a preset via its × button', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		store.set('savedQueries.post', [
			{ name: 'Old', params: { 'filter.owner': 'a' } },
		])
		render(
			<PreferenceProvider store={store}>
				<SavedQueries
					resource="post"
					value={{ filter: {} }}
					onApply={vi.fn()}
				/>
			</PreferenceProvider>,
		)
		fireEvent.click(
			screen.getByRole('button', { name: 'Delete saved query Old' }),
		)
		expect(screen.queryByRole('button', { name: 'Old' })).toBeNull()
	})
})
