/**
 * Theming + density on top of the preference store (Plan v5 task 42). `useTheme`
 * resolves a `light | dark | system` choice against the OS `prefers-color-scheme`
 * and persists it; `useDensity` toggles `comfortable | compact` list/table
 * spacing. Both are one-control toggles that survive a reload because they live
 * in the `PreferenceStore`. A tiny `applyTheme` writes the resolved theme onto a
 * DOM element (`data-theme` + `.dark` class, the two conventions Tailwind and
 * Base UI read) so styling is a pure CSS concern.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useStore } from './prefs-context.tsx'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

const THEME_KEY = 'ui.theme'
const DENSITY_KEY = 'ui.density'

/** Read the OS preference (`prefers-color-scheme`). Falls back to `light` where
 * `matchMedia` is unavailable (SSR, jsdom without the shim). */
function systemTheme(): ResolvedTheme {
	const mm = (
		globalThis as { matchMedia?: (q: string) => { matches: boolean } }
	).matchMedia
	if (typeof mm === 'function') {
		try {
			return mm('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
		} catch {
			// fall through
		}
	}
	return 'light'
}

/** Subscribe a component to OS-theme changes so a `system` choice tracks the OS
 * live. Returns the current resolved OS theme. */
function useSystemTheme(): ResolvedTheme {
	const subscribe = useCallback((cb: () => void) => {
		const mm = (
			globalThis as {
				matchMedia?: (q: string) => {
					matches: boolean
					addEventListener?: (t: string, l: () => void) => void
					removeEventListener?: (t: string, l: () => void) => void
				}
			}
		).matchMedia
		if (typeof mm !== 'function') return () => {}
		try {
			const mql = mm('(prefers-color-scheme: dark)')
			mql.addEventListener?.('change', cb)
			return () => mql.removeEventListener?.('change', cb)
		} catch {
			return () => {}
		}
	}, [])
	return useSyncExternalStore(subscribe, systemTheme, () => 'light')
}

/** Apply a resolved theme to a DOM element — sets `data-theme` and toggles the
 * `.dark` class (Tailwind's `darkMode: 'class'` convention). Defaults to
 * `document.documentElement`. Safe to call on the server (no-ops without a DOM). */
interface ThemeTarget {
	setAttribute(name: string, value: string): void
	classList: { toggle(cls: string, on: boolean): void }
}

export function applyTheme(theme: ResolvedTheme, el?: ThemeTarget): void {
	const doc = (globalThis as { document?: { documentElement?: ThemeTarget } })
		.document
	const target = el ?? doc?.documentElement
	if (!target) return
	target.setAttribute('data-theme', theme)
	target.classList.toggle('dark', theme === 'dark')
}

export interface UseThemeResult {
	/** The stored choice (may be `system`). */
	theme: ThemeChoice
	/** The choice resolved against the OS when `system`. */
	resolved: ResolvedTheme
	setTheme: (t: ThemeChoice) => void
	/** Convenience: flip between explicit light and dark (resolving `system` first). */
	toggle: () => void
}

export function useTheme(): UseThemeResult {
	const [theme, setTheme] = useStore<ThemeChoice>(THEME_KEY, 'system')
	const system = useSystemTheme()
	const resolved: ResolvedTheme = theme === 'system' ? system : theme

	// Reflect the resolved theme onto the DOM whenever it changes.
	useEffect(() => {
		applyTheme(resolved)
	}, [resolved])

	const toggle = useCallback(() => {
		setTheme(resolved === 'dark' ? 'light' : 'dark')
	}, [resolved, setTheme])

	return { theme, resolved, setTheme, toggle }
}

export interface UseDensityResult {
	density: Density
	setDensity: (d: Density) => void
	toggle: () => void
}

export function useDensity(): UseDensityResult {
	const [density, setDensity] = useStore<Density>(DENSITY_KEY, 'comfortable')
	const toggle = useCallback(() => {
		setDensity(density === 'compact' ? 'comfortable' : 'compact')
	}, [density, setDensity])
	return { density, setDensity, toggle }
}
