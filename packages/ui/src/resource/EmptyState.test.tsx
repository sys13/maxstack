/**
 * `resourceNoun` — the one place that decides what to call one row. Everything
 * user-facing that names the thing being created goes through it, so its
 * fallback order is pinned here rather than at each screen.
 */

import { describe, expect, it } from 'vitest'
import { addTheFirst, resourceNoun } from './EmptyState.tsx'

describe('resourceNoun', () => {
	it("prefers the resource's declared label", () => {
		expect(resourceNoun({ name: 'reading-item', label: 'Reading item' })).toBe(
			'Reading item',
		)
	})

	it('humanizes the identifier when there is no label', () => {
		expect(resourceNoun({ name: 'reading-item' })).toBe('reading item')
		expect(resourceNoun({ name: 'reading_item' })).toBe('reading item')
	})

	it('falls back to a generic noun for a nameless resource', () => {
		expect(resourceNoun({ name: '' })).toBe('record')
		expect(resourceNoun(null)).toBe('record')
		expect(resourceNoun(undefined)).toBe('record')
	})

	it('ignores a blank label rather than saying "Add the first  "', () => {
		expect(resourceNoun({ name: 'book', label: '   ' })).toBe('book')
	})

	it('spells the empty-state sentence from that noun', () => {
		expect(addTheFirst({ name: 'book', label: 'Book' })).toBe(
			'Add the first Book to get started.',
		)
	})
})
