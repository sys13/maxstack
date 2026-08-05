/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { createI18n } from './i18n.ts'

const messages = {
	en: {
		greeting: 'Hello, {name}!',
		items: '{count, plural, one {# item} other {# items}}',
		'field.title': 'Title',
	},
	fr: {
		greeting: 'Bonjour, {name} !',
		items: '{count, plural, one {# article} other {# articles}}',
	},
}

describe('createI18n.translate', () => {
	it('interpolates named params', () => {
		const i18n = createI18n({ locale: 'en', messages })
		expect(i18n.translate('greeting', { name: 'Ada' })).toBe('Hello, Ada!')
	})

	it('falls back to the fallback locale, then the key', () => {
		const i18n = createI18n({ locale: 'fr', messages, fallbackLocale: 'en' })
		// 'field.title' exists only in en.
		expect(i18n.translate('field.title')).toBe('Title')
		// Missing everywhere → the key (or an explicit default).
		expect(i18n.translate('missing.key')).toBe('missing.key')
		expect(i18n.translate('missing.key', { default: 'Def' })).toBe('Def')
	})

	it('pluralizes with # substitution per locale', () => {
		const en = createI18n({ locale: 'en', messages })
		expect(en.translate('items', { count: 1 })).toBe('1 item')
		expect(en.translate('items', { count: 5 })).toBe('5 items')
		const fr = createI18n({ locale: 'fr', messages })
		expect(fr.translate('items', { count: 2 })).toBe('2 articles')
	})
})

describe('createI18n formatters', () => {
	it('formats numbers per locale', () => {
		const en = createI18n({ locale: 'en-US', messages })
		const de = createI18n({ locale: 'de-DE', messages })
		expect(en.formatNumber(1234.5)).toBe('1,234.5')
		expect(de.formatNumber(1234.5)).toBe('1.234,5')
	})

	it('formats dates per locale', () => {
		const en = createI18n({ locale: 'en-US', messages })
		const out = en.formatDate('2026-03-04T00:00:00Z', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			timeZone: 'UTC',
		})
		expect(out).toBe('03/04/2026')
	})

	it('leaves an invalid date as its input', () => {
		const en = createI18n({ locale: 'en', messages })
		expect(en.formatDate('not-a-date')).toBe('not-a-date')
	})

	it('plural() picks the right form', () => {
		const en = createI18n({ locale: 'en', messages })
		expect(en.plural(1, { one: '# thing', other: '# things' })).toBe('1 thing')
		expect(en.plural(3, { one: '# thing', other: '# things' })).toBe('3 things')
	})
})
