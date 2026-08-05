/**
 * The translation core (Plan v5 task 43) — pure, dependency-free, framework-
 * agnostic. `createI18n` builds a `translate(key, params)` over a message
 * catalog, with `{name}` interpolation, ICU-lite pluralization
 * (`"{count, plural, one {# item} other {# items}}"`), a fallback locale, and a
 * final fallback to the key itself (so a missing translation degrades to the
 * introspected label — the task-31 default — rather than blank). Locale-aware
 * date/number formatting wraps `Intl`. React binding + a `<LocaleSwitcher>` live
 * in `i18n-context.tsx`; this module holds the logic so it unit-tests plainly.
 */

export type Messages = Record<string, string>
export type Catalog = Record<string, Messages>

export interface I18nConfig {
	locale: string
	messages: Catalog
	/** Locale consulted when the active one lacks a key (default `en`). */
	fallbackLocale?: string
}

export type TranslateParams = Record<string, string | number>

export interface I18n {
	locale: string
	/** Translate a key with optional interpolation/pluralization params. Falls
	 * back to the fallback locale, then to `params.default`, then to the key. */
	translate(
		key: string,
		params?: TranslateParams & { default?: string },
	): string
	formatDate(
		value: Date | string | number,
		options?: Intl.DateTimeFormatOptions,
	): string
	formatNumber(value: number, options?: Intl.NumberFormatOptions): string
	/** Choose one of `{ one, other, ... }` by `count` under the locale's rules. */
	plural(count: number, forms: Record<string, string>): string
}

/** Resolve `{name}` placeholders from params. Unmatched placeholders are left
 * verbatim so a template mistake is visible rather than silently blanked. */
function interpolate(template: string, params: TranslateParams): string {
	return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		name in params ? String(params[name]) : whole,
	)
}

/** Match `{count, plural, one {…} other {…}}` blocks and resolve them against the
 * locale's plural category, with `#` substituted for the count. */
function applyPlurals(
	template: string,
	params: TranslateParams,
	locale: string,
): string {
	const marker = /\{\s*(\w+)\s*,\s*plural\s*,/g
	let out = ''
	let last = 0
	let m: RegExpExecArray | null = marker.exec(template)
	while (m !== null) {
		const name = m[1] as string
		// Scan from just after `plural,` to the brace that closes this block,
		// tracking depth so nested `{…}` in the forms don't end it early.
		let depth = 1
		let i = marker.lastIndex
		const bodyStart = i
		while (i < template.length && depth > 0) {
			const ch = template[i]
			if (ch === '{') depth++
			else if (ch === '}') {
				depth--
				if (depth === 0) break
			}
			i++
		}
		const body = template.slice(bodyStart, i)
		const count = Number(params[name] ?? 0)
		const forms = parsePluralForms(body)
		const category = new Intl.PluralRules(locale).select(count)
		const chosen = forms[`=${count}`] ?? forms[category] ?? forms.other ?? ''
		out += template.slice(last, m.index) + chosen.replace(/#/g, String(count))
		last = i + 1 // past the closing brace
		marker.lastIndex = last
		m = marker.exec(template)
	}
	return out + template.slice(last)
}

/** Parse `one {# item} other {# items}` into `{ one: '# item', other: '# items' }`. */
function parsePluralForms(body: string): Record<string, string> {
	const forms: Record<string, string> = {}
	const re = /(=\d+|\w+)\s*\{([^}]*)\}/g
	let m: RegExpExecArray | null = re.exec(body)
	while (m !== null) {
		if (m[1] !== undefined && m[2] !== undefined) forms[m[1]] = m[2]
		m = re.exec(body)
	}
	return forms
}

export function createI18n(config: I18nConfig): I18n {
	const { locale, messages, fallbackLocale = 'en' } = config

	function lookup(key: string): string | undefined {
		return messages[locale]?.[key] ?? messages[fallbackLocale]?.[key]
	}

	function translate(
		key: string,
		params: TranslateParams & { default?: string } = {},
	): string {
		const { default: def, ...rest } = params
		const template = lookup(key) ?? def ?? key
		const pluralized = applyPlurals(template, rest, locale)
		return interpolate(pluralized, rest)
	}

	return {
		locale,
		translate,
		formatDate(value, options) {
			const d = value instanceof Date ? value : new Date(value)
			if (Number.isNaN(d.getTime())) return String(value)
			return new Intl.DateTimeFormat(locale, options).format(d)
		},
		formatNumber(value, options) {
			return new Intl.NumberFormat(locale, options).format(value)
		},
		plural(count, forms) {
			const category = new Intl.PluralRules(locale).select(count)
			const chosen = forms[`=${count}`] ?? forms[category] ?? forms.other ?? ''
			return chosen.replace(/#/g, String(count))
		},
	}
}
