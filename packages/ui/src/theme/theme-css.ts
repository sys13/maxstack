/**
 * `themeToCss` — a validated {@link ThemeSpec} → the scoped CSS override block
 * the runtime server-renders into `<ProjectFrame>`.
 *
 * The emitted CSS redeclares, on a `.mx-theme` wrapper, exactly the custom
 * properties app.css sets on `:root` (the shadcn tokens) plus the Tailwind v4
 * `--radius-*`/`--text-*`/`--font-sans` theme variables that utilities compile
 * to `var(…)` references of. Custom properties resolve at the *element*, so
 * the wrapper's values win over `:root` for everything inside it — the
 * generated app is themed while `/admin` and `/workbench` (outside the
 * wrapper) keep platform chrome.
 *
 * Dark tokens are emitted under BOTH `prefers-color-scheme: dark` (how app.css
 * themes today) and a `.dark`-class scope (how `prefs/theme.tsx` toggles), so
 * the theme stays correct whichever mechanism is active. The pre-existing gap
 * — an explicit "light" preference under a dark OS still renders dark, because
 * app.css is media-query-only — is unchanged by this module.
 *
 * Injection surface: every value interpolated here comes from a validated
 * `ThemeSpec` — enums checked against the spec's runtime arrays, `accent`
 * against `ACCENT_RE` — plus this package's own literal tables. No free text
 * reaches the emitted CSS.
 */

import {
	FONT_STACKS,
	RADIUS_SCALES,
	THEME_PALETTES,
	type ThemeSpecLike,
	type ThemeTokens,
	TYPE_SCALES,
} from './presets.ts'

/**
 * Relative luminance (WCAG) of a `#rgb`/`#rrggbb` color — used to pick a
 * readable foreground for an accent override. Exported for tests.
 */
export function hexLuminance(hex: string): number {
	const raw = hex.slice(1)
	const full =
		raw.length === 3
			? raw
					.split('')
					.map((c) => c + c)
					.join('')
			: raw
	const channel = (i: number) => {
		const v = Number.parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

/** White for dark accents, near-black for light ones (the 0.4 cut favors
 * white text — correct for the mid-saturation brand colors accents tend to be). */
function accentForeground(accent: string): string {
	return hexLuminance(accent) > 0.4 ? 'oklch(0.145 0 0)' : 'oklch(0.985 0 0)'
}

/** Apply an accent override to a palette side: the accent becomes the brand
 * (`primary` + `ring`), with a luminance-picked readable foreground. */
function withAccent(tokens: ThemeTokens, accent: string | undefined) {
	if (!accent) return tokens
	return {
		...tokens,
		primary: accent,
		'primary-foreground': accentForeground(accent),
		ring: accent,
	}
}

function declarations(vars: Record<string, string>, indent = '\t'): string {
	return Object.entries(vars)
		.map(([name, value]) =>
			name.startsWith('--')
				? `${indent}${name}: ${value};`
				: `${indent}--${name}: ${value};`,
		)
		.join('\n')
}

/**
 * Render a theme as a self-contained CSS block scoped to `scope`. Always emits
 * the palette (zinc = the exact app.css values, a visual no-op); radius/type
 * scale/font/density blocks are emitted only when the theme sets them.
 */
export function themeToCss(theme: ThemeSpecLike, scope = '.mx-theme'): string {
	const palette = THEME_PALETTES[theme.preset]
	const light = withAccent(palette.light, theme.accent)
	const dark = withAccent(palette.dark, theme.accent)

	const extra: Record<string, string> = {
		...(theme.radius ? RADIUS_SCALES[theme.radius] : undefined),
		...(theme.typeScale ? TYPE_SCALES[theme.typeScale] : undefined),
	}
	if (theme.font) extra['--font-sans'] = FONT_STACKS[theme.font]

	const blocks = [
		`${scope} {\n${declarations({ ...light, ...extra })}\n${theme.font ? '\tfont-family: var(--font-sans);\n' : ''}}`,
		`@media (prefers-color-scheme: dark) {\n\t${scope} {\n${declarations(dark, '\t\t')}\n\t}\n}`,
		`.dark ${scope}, ${scope}.dark {\n${declarations(dark)}\n}`,
	]
	if (theme.density === 'compact')
		blocks.push(
			`${scope}[data-density="compact"] :is(td, th) {\n\tpadding-block: 0.375rem;\n}`,
		)
	return blocks.join('\n')
}
