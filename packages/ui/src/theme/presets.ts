/**
 * The preset → palette tables behind the spec's theme vocabulary.
 *
 * The spec (`@maxstack/spec`) owns the *names* — its `ThemePreset`,
 * `ThemeFont`, … unions — and this module owns the *values*: full light+dark
 * shadcn-token palettes, system font stacks, and the radius/type scales. The
 * unions below are deliberate structural **duplicates** of the spec's, not
 * imports: `@maxstack/ui` publishes standalone and may import no workspace
 * package (boundaries policy) — the same discipline as
 * `isSlotBlock` in spec-ops. Drift is still a compile error, just at the seam
 * where the layers meet: apps/web passes the spec's `ThemeSpec` into
 * `themeToCss`, so a preset/option added spec-side without a value here makes
 * that call not typecheck.
 *
 * `zinc` is byte-identical to the hardcoded palette in `apps/web/app/app.css`
 * (the pre-theme default), so `theme.set {preset:"zinc"}` with no overrides is
 * a visual no-op — asserted by a test against that file.
 */

/** Keep in sync with `@maxstack/spec`'s `ThemePreset` (see module docblock). */
export type ThemePreset =
	| 'zinc'
	| 'ocean'
	| 'forest'
	| 'sunset'
	| 'mono'
	| 'rose'
	| 'amber'
/** Keep in sync with `@maxstack/spec`'s `ThemeRadius`. */
export type ThemeRadius = 'sm' | 'md' | 'lg' | 'full'
/** Keep in sync with `@maxstack/spec`'s `ThemeDensity`. */
export type ThemeDensity = 'comfortable' | 'compact'
/** Keep in sync with `@maxstack/spec`'s `ThemeFont`. */
export type ThemeFont = 'sans' | 'serif' | 'mono' | 'rounded' | 'humanist'
/** Keep in sync with `@maxstack/spec`'s `ThemeTypeScale`. */
export type ThemeTypeScale = 'compact' | 'default' | 'relaxed'

/**
 * The theme shape `themeToCss` consumes — structurally identical to the
 * spec's `ThemeSpec`, so the spec's type is assignable wherever this is
 * expected (that assignment is the drift check).
 */
export interface ThemeSpecLike {
	preset: ThemePreset
	accent?: string
	radius?: ThemeRadius
	density?: ThemeDensity
	font?: ThemeFont
	typeScale?: ThemeTypeScale
}

/** The shadcn token names every widget consumes (`bg-primary`, `border-input`,
 * …) — exactly the `--<name>` variables app.css declares. */
export const THEME_TOKEN_NAMES = [
	'background',
	'foreground',
	'card',
	'card-foreground',
	'popover',
	'popover-foreground',
	'primary',
	'primary-foreground',
	'secondary',
	'secondary-foreground',
	'muted',
	'muted-foreground',
	'accent',
	'accent-foreground',
	'destructive',
	'success',
	'warning',
	'border',
	'input',
	'ring',
] as const

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number]
export type ThemeTokens = Record<ThemeTokenName, string>

export interface ThemePalette {
	light: ThemeTokens
	dark: ThemeTokens
}

/**
 * The three status colours are fixed across every preset, not derived from the
 * preset's hue like `primary` is. "This failed" and "this worked" are claims
 * about the world, not about the brand — a forest-preset app whose success
 * colour drifted toward its green primary would make the two indistinguishable
 * at a glance, and an amber-preset warning would vanish into the chrome. Each
 * carries a single token (no paired `-foreground`), matching `destructive`:
 * callers tint with `bg-success/10` and write text in the colour itself.
 *
 * Lightness mirrors `destructive` in each mode so the three read as one family.
 * Amber sits low in lightness for the light palette — a bright amber has no
 * contrast on white, so accessible warning text is necessarily olive-leaning.
 */
const DESTRUCTIVE_LIGHT = 'oklch(0.577 0.245 27.325)'
const DESTRUCTIVE_DARK = 'oklch(0.704 0.191 22.216)'
const SUCCESS_LIGHT = 'oklch(0.55 0.15 150)'
const SUCCESS_DARK = 'oklch(0.72 0.15 150)'
const WARNING_LIGHT = 'oklch(0.58 0.14 75)'
const WARNING_DARK = 'oklch(0.8 0.14 80)'

/**
 * Build a palette from a neutral tint + a brand primary. The lightness
 * structure mirrors the zinc palette (the shadcn layout every widget was
 * designed against); `hue`/`tint` shift the neutrals, `primary*` carries the
 * brand color. Colored presets keep the tint subtle (≤0.03) so text contrast
 * stays where zinc's was.
 */
function palette(opts: {
	hue: number
	/** Chroma of the neutral surfaces (zinc ≈ 0.005; 0 = pure grayscale). */
	tint: number
	primaryLight: string
	primaryLightForeground: string
	primaryDark: string
	primaryDarkForeground: string
}): ThemePalette {
	const {
		hue,
		tint,
		primaryLight,
		primaryLightForeground,
		primaryDark,
		primaryDarkForeground,
	} = opts
	const t = (l: number, factor: number) =>
		`oklch(${l} ${+(tint * factor).toFixed(4)} ${hue})`
	return {
		light: {
			background: t(0.99, 0.4),
			foreground: t(0.141, 1),
			card: 'oklch(1 0 0)',
			'card-foreground': t(0.141, 1),
			popover: 'oklch(1 0 0)',
			'popover-foreground': t(0.141, 1),
			primary: primaryLight,
			'primary-foreground': primaryLightForeground,
			secondary: t(0.967, 0.4),
			'secondary-foreground': t(0.21, 1.2),
			muted: t(0.967, 0.4),
			'muted-foreground': t(0.552, 3),
			accent: t(0.955, 0.8),
			'accent-foreground': t(0.21, 1.2),
			destructive: DESTRUCTIVE_LIGHT,
			success: SUCCESS_LIGHT,
			warning: WARNING_LIGHT,
			border: t(0.92, 0.8),
			input: t(0.92, 0.8),
			ring: primaryLight,
		},
		dark: {
			background: t(0.141, 1),
			foreground: 'oklch(0.985 0 0)',
			card: t(0.21, 1.2),
			'card-foreground': 'oklch(0.985 0 0)',
			popover: t(0.21, 1.2),
			'popover-foreground': 'oklch(0.985 0 0)',
			primary: primaryDark,
			'primary-foreground': primaryDarkForeground,
			secondary: t(0.274, 1.2),
			'secondary-foreground': 'oklch(0.985 0 0)',
			muted: t(0.274, 1.2),
			'muted-foreground': t(0.705, 3),
			accent: t(0.3, 1.6),
			'accent-foreground': 'oklch(0.985 0 0)',
			destructive: DESTRUCTIVE_DARK,
			success: SUCCESS_DARK,
			warning: WARNING_DARK,
			border: 'oklch(1 0 0 / 10%)',
			input: 'oklch(1 0 0 / 15%)',
			ring: primaryDark,
		},
	}
}

/** The exact palette hardcoded in apps/web/app/app.css — the pre-theme
 * default. Kept verbatim (not built by {@link palette}) so `preset: "zinc"`
 * emits CSS identical to what un-themed apps already render. */
const ZINC: ThemePalette = {
	light: {
		background: 'oklch(1 0 0)',
		foreground: 'oklch(0.141 0.005 285.823)',
		card: 'oklch(1 0 0)',
		'card-foreground': 'oklch(0.141 0.005 285.823)',
		popover: 'oklch(1 0 0)',
		'popover-foreground': 'oklch(0.141 0.005 285.823)',
		primary: 'oklch(0.21 0.006 285.885)',
		'primary-foreground': 'oklch(0.985 0 0)',
		secondary: 'oklch(0.967 0.001 286.375)',
		'secondary-foreground': 'oklch(0.21 0.006 285.885)',
		muted: 'oklch(0.967 0.001 286.375)',
		'muted-foreground': 'oklch(0.552 0.016 285.938)',
		accent: 'oklch(0.967 0.001 286.375)',
		'accent-foreground': 'oklch(0.21 0.006 285.885)',
		destructive: DESTRUCTIVE_LIGHT,
		success: SUCCESS_LIGHT,
		warning: WARNING_LIGHT,
		border: 'oklch(0.92 0.004 286.32)',
		input: 'oklch(0.92 0.004 286.32)',
		ring: 'oklch(0.705 0.015 286.067)',
	},
	dark: {
		background: 'oklch(0.141 0.005 285.823)',
		foreground: 'oklch(0.985 0 0)',
		card: 'oklch(0.21 0.006 285.885)',
		'card-foreground': 'oklch(0.985 0 0)',
		popover: 'oklch(0.21 0.006 285.885)',
		'popover-foreground': 'oklch(0.985 0 0)',
		primary: 'oklch(0.92 0.004 286.32)',
		'primary-foreground': 'oklch(0.21 0.006 285.885)',
		secondary: 'oklch(0.274 0.006 286.033)',
		'secondary-foreground': 'oklch(0.985 0 0)',
		muted: 'oklch(0.274 0.006 286.033)',
		'muted-foreground': 'oklch(0.705 0.015 286.067)',
		accent: 'oklch(0.274 0.006 286.033)',
		'accent-foreground': 'oklch(0.985 0 0)',
		destructive: DESTRUCTIVE_DARK,
		success: SUCCESS_DARK,
		warning: WARNING_DARK,
		border: 'oklch(1 0 0 / 10%)',
		input: 'oklch(1 0 0 / 15%)',
		ring: 'oklch(0.552 0.016 285.938)',
	},
}

/** Preset → full light+dark palette. `Record<ThemePreset, …>` keeps this table
 * exhaustively in sync with the spec's preset names at compile time. */
export const THEME_PALETTES: Record<ThemePreset, ThemePalette> = {
	zinc: ZINC,
	ocean: palette({
		hue: 235,
		tint: 0.012,
		primaryLight: 'oklch(0.55 0.17 245)',
		primaryLightForeground: 'oklch(0.985 0 0)',
		primaryDark: 'oklch(0.72 0.14 240)',
		primaryDarkForeground: 'oklch(0.16 0.03 245)',
	}),
	forest: palette({
		hue: 150,
		tint: 0.01,
		primaryLight: 'oklch(0.5 0.13 152)',
		primaryLightForeground: 'oklch(0.985 0 0)',
		primaryDark: 'oklch(0.75 0.15 152)',
		primaryDarkForeground: 'oklch(0.16 0.04 152)',
	}),
	sunset: palette({
		hue: 45,
		tint: 0.014,
		primaryLight: 'oklch(0.6 0.16 42)',
		primaryLightForeground: 'oklch(0.99 0.01 45)',
		primaryDark: 'oklch(0.74 0.15 50)',
		primaryDarkForeground: 'oklch(0.18 0.05 45)',
	}),
	mono: palette({
		hue: 0,
		tint: 0,
		primaryLight: 'oklch(0.145 0 0)',
		primaryLightForeground: 'oklch(0.985 0 0)',
		primaryDark: 'oklch(0.922 0 0)',
		primaryDarkForeground: 'oklch(0.205 0 0)',
	}),
	rose: palette({
		hue: 12,
		tint: 0.008,
		primaryLight: 'oklch(0.58 0.2 15)',
		primaryLightForeground: 'oklch(0.99 0.01 12)',
		primaryDark: 'oklch(0.72 0.17 13)',
		primaryDarkForeground: 'oklch(0.18 0.05 12)',
	}),
	amber: palette({
		hue: 75,
		tint: 0.012,
		primaryLight: 'oklch(0.66 0.14 70)',
		primaryLightForeground: 'oklch(0.2 0.06 75)',
		primaryDark: 'oklch(0.8 0.15 80)',
		primaryDarkForeground: 'oklch(0.2 0.06 75)',
	}),
}

/** Curated *system* font stacks — no webfont files to ship;
 * `sans` is the stack app.css already applies to `body`. */
export const FONT_STACKS: Record<ThemeFont, string> = {
	sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
	serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
	mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
	rounded:
		'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, ui-sans-serif, system-ui, sans-serif',
	humanist:
		'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, ui-sans-serif, sans-serif',
}

/**
 * Radius scale → Tailwind v4 `--radius-*` overrides. Utilities compile to
 * `var(--radius-md)` etc., so overriding the variables on the theme wrapper
 * re-rounds every widget underneath. `md` is the Tailwind default (nothing to
 * emit); `full` makes controls pills while keeping cards merely generous.
 */
export const RADIUS_SCALES: Record<
	ThemeRadius,
	Record<string, string> | undefined
> = {
	sm: {
		'--radius-sm': '0.125rem',
		'--radius-md': '0.25rem',
		'--radius-lg': '0.375rem',
		'--radius-xl': '0.5rem',
	},
	md: undefined,
	lg: {
		'--radius-sm': '0.375rem',
		'--radius-md': '0.625rem',
		'--radius-lg': '0.875rem',
		'--radius-xl': '1.125rem',
	},
	full: {
		'--radius-sm': '9999px',
		'--radius-md': '9999px',
		'--radius-lg': '1rem',
		'--radius-xl': '1.25rem',
	},
}

/**
 * Type scale → Tailwind v4 `--text-*` (+ paired `--line-height`) overrides on
 * the wrapper. Root font-size is never touched, so platform chrome outside the
 * wrapper is unaffected. `default` keeps the Tailwind values (nothing to emit).
 */
export const TYPE_SCALES: Record<
	ThemeTypeScale,
	Record<string, string> | undefined
> = {
	compact: {
		'--text-xs': '0.6875rem',
		'--text-xs--line-height': '0.9375rem',
		'--text-sm': '0.8125rem',
		'--text-sm--line-height': '1.1875rem',
		'--text-base': '0.9375rem',
		'--text-base--line-height': '1.375rem',
		'--text-lg': '1.0625rem',
		'--text-lg--line-height': '1.625rem',
		'--text-xl': '1.1875rem',
		'--text-xl--line-height': '1.625rem',
		'--text-2xl': '1.375rem',
		'--text-2xl--line-height': '1.875rem',
	},
	default: undefined,
	relaxed: {
		'--text-xs': '0.8125rem',
		'--text-xs--line-height': '1.125rem',
		'--text-sm': '0.9375rem',
		'--text-sm--line-height': '1.375rem',
		'--text-base': '1.0625rem',
		'--text-base--line-height': '1.625rem',
		'--text-lg': '1.1875rem',
		'--text-lg--line-height': '1.8125rem',
		'--text-xl': '1.3125rem',
		'--text-xl--line-height': '1.8125rem',
		'--text-2xl': '1.5625rem',
		'--text-2xl--line-height': '2.0625rem',
	},
}
