/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { toDateInputValue } from './DynamicForm.tsx'

// Regression: a stored ISO *datetime* prefilled into an `<input type="date">`
// was rejected by the browser, rendering the field blank — so submitting an
// otherwise-unchanged record wiped the date. The prefill must be coerced to the
// `yyyy-MM-dd` a date input accepts.
describe('toDateInputValue', () => {
	it('truncates an ISO datetime to its date', () => {
		expect(toDateInputValue('2026-07-14T00:00:00.000Z')).toBe('2026-07-14')
		expect(toDateInputValue('2026-07-14T23:59:59+02:00')).toBe('2026-07-14')
	})

	it('passes an already-legal yyyy-MM-dd through unchanged', () => {
		expect(toDateInputValue('2026-07-14')).toBe('2026-07-14')
	})

	it('accepts a space-separated datetime', () => {
		expect(toDateInputValue('2026-07-14 09:30')).toBe('2026-07-14')
	})

	it('normalizes a Date instance', () => {
		expect(toDateInputValue(new Date('2026-07-14T12:00:00Z'))).toBe(
			'2026-07-14',
		)
	})

	it('yields empty string for empty/nullish/unparseable input', () => {
		expect(toDateInputValue('')).toBe('')
		expect(toDateInputValue(null)).toBe('')
		expect(toDateInputValue(undefined)).toBe('')
		expect(toDateInputValue('not a date')).toBe('')
	})
})
