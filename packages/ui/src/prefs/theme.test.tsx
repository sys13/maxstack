import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PreferenceProvider } from './prefs-context.tsx'
import { memoryBackend, PreferenceStore } from './store.ts'
import { applyTheme, useDensity, useTheme } from './theme.tsx'

function wrapper(store: PreferenceStore) {
	return ({ children }: { children: ReactNode }) => (
		<PreferenceProvider store={store}>{children}</PreferenceProvider>
	)
}

function stubMatchMedia(dark: boolean) {
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({
			matches: dark,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	)
}

describe('useTheme', () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	it('defaults to system and resolves against the OS preference', () => {
		stubMatchMedia(true)
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useTheme(), { wrapper: wrapper(store) })
		expect(result.current.theme).toBe('system')
		expect(result.current.resolved).toBe('dark')
	})

	it('persists an explicit choice and reflects it onto the DOM', () => {
		stubMatchMedia(false)
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useTheme(), { wrapper: wrapper(store) })
		act(() => result.current.setTheme('dark'))
		expect(result.current.resolved).toBe('dark')
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
		expect(document.documentElement.classList.contains('dark')).toBe(true)
	})

	it('toggle flips between light and dark from the resolved value', () => {
		stubMatchMedia(false) // system → light
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useTheme(), { wrapper: wrapper(store) })
		act(() => result.current.toggle())
		expect(result.current.resolved).toBe('dark')
		act(() => result.current.toggle())
		expect(result.current.resolved).toBe('light')
	})
})

describe('useDensity', () => {
	it('defaults to comfortable and toggles to compact, persisting', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useDensity(), {
			wrapper: wrapper(store),
		})
		expect(result.current.density).toBe('comfortable')
		act(() => result.current.toggle())
		expect(result.current.density).toBe('compact')
		expect(store.get('ui.density', 'comfortable')).toBe('compact')
	})
})

describe('applyTheme', () => {
	it('sets data-theme and toggles the dark class on a target element', () => {
		const el = document.createElement('div')
		applyTheme('dark', el)
		expect(el.getAttribute('data-theme')).toBe('dark')
		expect(el.classList.contains('dark')).toBe(true)
		applyTheme('light', el)
		expect(el.classList.contains('dark')).toBe(false)
	})
})
