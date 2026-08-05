/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	THEME_PALETTES,
	THEME_TOKEN_NAMES,
	type ThemePreset,
} from './presets.ts'
import { hexLuminance, themeToCss } from './theme-css.ts'

describe('THEME_PALETTES', () => {
	it('covers every preset with all tokens in both modes', () => {
		for (const preset of Object.keys(THEME_PALETTES) as ThemePreset[]) {
			const palette = THEME_PALETTES[preset]
			expect(palette, preset).toBeDefined()
			for (const mode of ['light', 'dark'] as const)
				expect(Object.keys(palette[mode]).sort(), `${preset}.${mode}`).toEqual(
					[...THEME_TOKEN_NAMES].sort(),
				)
		}
	})

	it('zinc is byte-identical to the app.css defaults (theme.set zinc = no-op)', () => {
		// The pre-theme palette hardcoded in the runtime stylesheet is the source
		// of truth for zinc; if app.css changes, this table must change with it.
		const appCss = readFileSync(
			join(import.meta.dirname, '../../../../apps/web/app/app.css'),
			'utf8',
		)
		for (const [token, value] of Object.entries(THEME_PALETTES.zinc.light))
			expect(appCss, `light --${token}`).toContain(`--${token}: ${value};`)
		for (const [token, value] of Object.entries(THEME_PALETTES.zinc.dark))
			expect(appCss, `dark --${token}`).toContain(`--${token}: ${value};`)
	})
})

describe('themeToCss', () => {
	it('emits light tokens on the scope and dark tokens under BOTH mechanisms', () => {
		const css = themeToCss({ preset: 'ocean' })
		expect(css).toContain('.mx-theme {')
		expect(css).toContain(
			`--background: ${THEME_PALETTES.ocean.light.background};`,
		)
		// media-query dark (how app.css themes today) …
		expect(css).toContain('@media (prefers-color-scheme: dark)')
		// … AND class-toggle dark (how prefs/theme.tsx switches)
		expect(css).toContain('.dark .mx-theme, .mx-theme.dark {')
		expect(css).toContain(
			`--background: ${THEME_PALETTES.ocean.dark.background};`,
		)
	})

	it('accent overrides primary + ring with a luminance-picked foreground', () => {
		const dark = themeToCss({ preset: 'zinc', accent: '#1d4ed8' })
		expect(dark).toContain('--primary: #1d4ed8;')
		expect(dark).toContain('--ring: #1d4ed8;')
		expect(dark).toContain('--primary-foreground: oklch(0.985 0 0);') // white on dark blue
		const light = themeToCss({ preset: 'zinc', accent: '#fde047' })
		expect(light).toContain('--primary-foreground: oklch(0.145 0 0);') // near-black on yellow
	})

	it('radius/typeScale/font/density blocks appear only when set', () => {
		const bare = themeToCss({ preset: 'zinc' })
		expect(bare).not.toContain('--radius-md')
		expect(bare).not.toContain('--text-sm')
		expect(bare).not.toContain('font-family')
		expect(bare).not.toContain('data-density')

		const full = themeToCss({
			preset: 'sunset',
			radius: 'lg',
			typeScale: 'relaxed',
			font: 'humanist',
			density: 'compact',
		})
		expect(full).toContain('--radius-md: 0.625rem;')
		expect(full).toContain('--text-sm: 0.9375rem;')
		expect(full).toContain('--text-sm--line-height: 1.375rem;')
		expect(full).toContain('--font-sans: Seravek')
		expect(full).toContain('font-family: var(--font-sans);')
		expect(full).toContain('.mx-theme[data-density="compact"]')
	})

	it('md radius and default typeScale emit nothing (Tailwind defaults stand)', () => {
		const css = themeToCss({
			preset: 'zinc',
			radius: 'md',
			typeScale: 'default',
		})
		expect(css).not.toContain('--radius-')
		expect(css).not.toContain('--text-')
	})
})

describe('hexLuminance', () => {
	it('orders black < mid blue < yellow < white', () => {
		const l = (h: string) => hexLuminance(h)
		expect(l('#000000')).toBe(0)
		expect(l('#ffffff')).toBeCloseTo(1, 5)
		expect(l('#1d4ed8')).toBeLessThan(0.4)
		expect(l('#fde047')).toBeGreaterThan(0.4)
		// #rgb shorthand expands
		expect(l('#fff')).toBeCloseTo(1, 5)
	})
})
