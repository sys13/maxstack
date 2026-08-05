import { act, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { PreferenceProvider, useStore } from './prefs-context.tsx'
import { memoryBackend, PreferenceStore } from './store.ts'

function wrapper(store: PreferenceStore) {
	return ({ children }: { children: ReactNode }) => (
		<PreferenceProvider store={store}>{children}</PreferenceProvider>
	)
}

describe('useStore', () => {
	it('returns the fallback then reactively updates on set', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useStore('rows', 10), {
			wrapper: wrapper(store),
		})
		expect(result.current[0]).toBe(10)
		act(() => result.current[1](25))
		expect(result.current[0]).toBe(25)
	})

	it('accepts an updater function', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useStore('n', 1), {
			wrapper: wrapper(store),
		})
		act(() => result.current[1]((prev) => prev + 4))
		expect(result.current[0]).toBe(5)
	})

	it('shares state across two components on the same key', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })

		function Writer() {
			const [, set] = useStore('shared', 'a')
			return (
				<button type="button" onClick={() => set('b')}>
					write
				</button>
			)
		}
		function Reader() {
			const [value] = useStore('shared', 'a')
			return <span>value:{value}</span>
		}

		render(
			<PreferenceProvider store={store}>
				<Writer />
				<Reader />
			</PreferenceProvider>,
		)
		expect(screen.getByText('value:a')).toBeInTheDocument()
		act(() => screen.getByText('write').click())
		expect(screen.getByText('value:b')).toBeInTheDocument()
	})

	it('works without a provider (unshared fallback store)', () => {
		const { result } = renderHook(() => useStore('free', 0))
		expect(result.current[0]).toBe(0)
		act(() => result.current[1](7))
		expect(result.current[0]).toBe(7)
	})
})
