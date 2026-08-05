import { act, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { PreferenceProvider } from '../prefs/prefs-context.tsx'
import { memoryBackend, PreferenceStore } from '../prefs/store.ts'
import {
	I18nProvider,
	LocaleSwitcher,
	useFieldLabel,
	useI18n,
	useLocale,
	useTranslate,
} from './i18n-context.tsx'

const messages = {
	en: { greeting: 'Hello', 'field.title': 'Title' },
	fr: { greeting: 'Bonjour', 'field.title': 'Titre' },
}

function wrapper(store = new PreferenceStore({ backend: memoryBackend() })) {
	return ({ children }: { children: ReactNode }) => (
		<PreferenceProvider store={store}>
			<I18nProvider messages={messages}>{children}</I18nProvider>
		</PreferenceProvider>
	)
}

describe('I18nProvider + hooks', () => {
	it('translates in the active locale and switches reactively', () => {
		const { result } = renderHook(
			() => ({ t: useTranslate(), l: useLocale() }),
			{ wrapper: wrapper() },
		)
		expect(result.current.t('greeting')).toBe('Hello')
		act(() => result.current.l[1]('fr'))
		expect(result.current.t('greeting')).toBe('Bonjour')
	})

	it('persists the locale choice to the store', () => {
		const store = new PreferenceStore({ backend: memoryBackend() })
		const { result } = renderHook(() => useLocale(), {
			wrapper: wrapper(store),
		})
		act(() => result.current[1]('fr'))
		expect(store.get('ui.locale', 'en')).toBe('fr')
	})

	it('useFieldLabel translates a field then falls back to the introspected label', () => {
		const { result } = renderHook(() => useFieldLabel(), { wrapper: wrapper() })
		expect(result.current('title', 'Title')).toBe('Title')
		// Unknown field → the passed introspected label (zero-config default).
		expect(result.current('points', 'Points')).toBe('Points')
	})

	it('works provider-free (English identity fallback)', () => {
		const { result } = renderHook(() => useTranslate())
		expect(result.current('anything')).toBe('anything')
	})

	it('exposes available locales', () => {
		const { result } = renderHook(() => useI18n(), { wrapper: wrapper() })
		expect(result.current.availableLocales).toEqual(['en', 'fr'])
	})
})

describe('LocaleSwitcher', () => {
	it('renders options and switches locale on change', () => {
		render(<LocaleSwitcher labels={{ en: 'English', fr: 'Français' }} />, {
			wrapper: wrapper(),
		})
		const select = screen.getByRole('combobox', { name: 'Language' })
		expect(screen.getByRole('option', { name: 'Français' })).toBeInTheDocument()
		act(() => {
			;(select as HTMLSelectElement).value = 'fr'
			select.dispatchEvent(new Event('change', { bubbles: true }))
		})
		expect((select as HTMLSelectElement).value).toBe('fr')
	})
})
