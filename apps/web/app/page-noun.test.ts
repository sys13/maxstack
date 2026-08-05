/**
 * `pageNoun` — the word the generated app uses for one row.
 *
 * The regression this pins is the first screen of every generated app: a page
 * named "Shelf" over a `book` entity told the user to "Add the first Shelf".
 */

import { describe, expect, it } from 'vitest'
import { pageNoun } from './page-noun'

describe('pageNoun', () => {
	it("names the entity, not the page — a Shelf page over books adds a 'Book'", () => {
		expect(pageNoun({ resource: 'book', resourceLabel: 'Book' })).toBe('Book')
	})

	it('gives two pages over one entity the same noun', () => {
		const shelf = pageNoun({ resource: 'book', resourceLabel: 'Book' })
		const readingList = pageNoun({ resource: 'book', resourceLabel: 'Book' })
		expect(shelf).toBe(readingList)
	})

	it('humanizes the resource id when the entity declares no name', () => {
		expect(pageNoun({ resource: 'reading-item', resourceLabel: null })).toBe(
			'reading item',
		)
	})

	it('falls back to the generic noun for a page backed by no entity', () => {
		expect(pageNoun({ resource: null, resourceLabel: null })).toBe('record')
	})
})
