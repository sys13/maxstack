/**
 * The related-records "view all" link on the generated app (#362).
 *
 * The bug this pins is not a broken link — it is a link that *works*, loads,
 * and shows the wrong rows. A related section's link filters the child list to
 * this record, and #342 confines `?filter.` to the columns a page renders. A
 * child list is the one list guaranteed not to render its own FK, so the naive
 * link would have had its filter dropped in silence and shown every row of the
 * child entity under a heading claiming this record's.
 *
 * So the load-bearing test here is not that a URL comes back. It is the
 * agreement test: the URL this builds, fed to the destination's own
 * `listControls`, must come back out with the filter intact. The link and the
 * page that honours it are two functions in two modules, and that is exactly
 * the pair that drifts.
 */

import type { SproutColumn } from '@maxstack/core'
import { describe, expect, it } from 'vitest'
import type { ProjectRoute } from './project-routes'
import { relatedListHref } from './related-link'
import { listControls } from './routes/project.page'

const column = (
	name: string,
	type: SproutColumn['type'],
	meta: SproutColumn['meta'] = {},
): SproutColumn => ({
	name,
	type,
	nullable: true,
	hasDefault: false,
	isPrimaryKey: name === 'id',
	meta,
})

const reference = (
	name: string,
	meta: SproutColumn['meta'] = {},
): SproutColumn => ({
	...column(name, 'uuid', meta),
	references: { table: 'book', column: 'id' },
})

/** A `review` child, with more plain columns than a list renders — so its FK
 * is not among the page's own picks, which is the case that matters. */
const introspection = {
	primaryKey: 'id',
	columns: [
		column('id', 'uuid'),
		column('body', 'string'),
		column('score', 'number'),
		column('mood', 'string'),
		column('locale', 'string'),
		column('source', 'string'),
		column('excerpt', 'string'),
		reference('bookId'),
		reference('draftOfId', { hidden: true }),
	],
}

const group = (fk = 'bookId') => ({ resource: 'review', fk, introspection })

const page = (over: Partial<ProjectRoute> = {}) =>
	({
		slug: 'reviews',
		resource: 'review',
		view: null,
		...over,
	}) as ProjectRoute

const calendar = {
	kind: 'calendar',
	dateField: 'postedOn',
	display: 'month',
	timezone: 'UTC',
	reschedule: false,
} as NonNullable<ProjectRoute['view']>

describe('relatedListHref (#362)', () => {
	it('links the child list, filtered to this record', () => {
		expect(relatedListHref([page()], group(), 'b-1')).toBe(
			'/reviews?filter.bookId=b-1',
		)
	})

	it('encodes an id that would otherwise change the query', () => {
		// An id is a value, not a fragment of URL syntax. A `&` in one would
		// otherwise start a second parameter — and the parameter it could start is
		// another `filter.`.
		expect(relatedListHref([page()], group(), 'a&filter.score=1')).toBe(
			'/reviews?filter.bookId=a%26filter.score%3D1',
		)
	})

	it('survives the page it points at', () => {
		// The agreement test, and the reason this file exists. The destination
		// narrows `?filter.` to the columns it renders; feed it exactly what the
		// link produced and the filter has to still be there. Without #362's
		// promotion this is the assertion that fails, and it fails as "the link
		// shows every review" rather than as a 404.
		const href = relatedListHref([page()], group(), 'b-1')
		expect(href).toBeDefined()
		const controls = listControls(
			new URL(`https://app.test${href}`),
			introspection,
			null,
			null,
		)
		expect(controls.filters.filter).toEqual({ bookId: 'b-1' })
		expect(controls.columns.map((c) => c.name)).toContain('bookId')
	})

	it('makes no link to a page that does not exist', () => {
		// `nav` is the accepted, flag-visible page set. A child entity with no
		// page of its own would be a link at a 404.
		expect(relatedListHref([], group(), 'b-1')).toBeUndefined()
		expect(
			relatedListHref([page({ resource: 'other' })], group(), 'b-1'),
		).toBeUndefined()
	})

	it('makes no link to an arranged view', () => {
		// A calendar's rows are a window on a date column; `listControls` honours
		// no filter on one, by design. A link there would show the whole view
		// while claiming to show this record's children — the exact lie the
		// missing link was preferable to.
		expect(
			relatedListHref([page({ view: calendar })], group(), 'b-1'),
		).toBeUndefined()
	})

	it('makes no link through a hidden relation', () => {
		// The destination will not render `draftOfId`, so it will not filter by it
		// either. The near half of the same rule: no link rather than a link whose
		// filter evaporates.
		expect(relatedListHref([page()], group('draftOfId'), 'b-1')).toBeUndefined()
	})

	it('makes no link for a record with no id', () => {
		expect(relatedListHref([page()], group(), '')).toBeUndefined()
	})
})
