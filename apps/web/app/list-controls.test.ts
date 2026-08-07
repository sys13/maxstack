/**
 * What a generated list page's controls resolve to for one request (#342).
 *
 * The complaint in #342 is that the generated app got none of the list
 * capabilities the admin got: the loader applied only the spec-declared
 * `order`, and the search endpoint the runtime already exposed had no caller.
 * The fix is a wiring one — but the wiring reads user input off the query
 * string of a page an end user is looking at, and that makes it a security
 * seam as well as a feature.
 *
 * So these pin the *decision*, not the rendering, exactly as `view-window.test`
 * pins the query a calendar asks for: which columns a request may search,
 * filter and order by. A control that quietly honours a column the page does
 * not render looks identical on screen to one that does not.
 */

import type { SproutColumn } from '@maxstack/core'
import { EMPTY_FILTERS } from '@maxstack/ui'
import { describe, expect, it } from 'vitest'
import type { ProjectRoute } from './project-routes'
import { listControls, tableColumns } from './routes/project.page'

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

/** A `book` entity with one column the page is not allowed to expose. */
const introspection = {
	primaryKey: 'id',
	columns: [
		column('id', 'uuid'),
		column('title', 'string'),
		column('status', 'enum', {}),
		column('rating', 'number'),
		// Hidden, so it is not rendered, not searched, not faceted and not
		// orderable — the whole point of the rule below.
		column('acquisitionCost', 'number', { hidden: true }),
	],
}

const at = (query: string) => new URL(`https://app.test/books${query}`)

const reference = (
	name: string,
	table: string,
	meta: SproutColumn['meta'] = {},
): SproutColumn => ({
	...column(name, 'uuid', meta),
	references: { table, column: 'id' },
})

/**
 * A `review` entity, as a child list: enough plain columns to fill the
 * six-column cap, so none of its three FKs is picked by default — which is the
 * shape a related-records "view all" link actually lands on (#362).
 */
const child = {
	primaryKey: 'id',
	columns: [
		column('id', 'uuid'),
		column('body', 'string'),
		column('score', 'number'),
		column('mood', 'string'),
		column('locale', 'string'),
		column('source', 'string'),
		column('excerpt', 'string'),
		reference('bookId', 'book'),
		reference('draftOfId', 'book', { hidden: true }),
		reference('moderatorId', 'user', { filterable: false }),
	],
}

const calendar: NonNullable<ProjectRoute['view']> = {
	kind: 'calendar',
	dateField: 'startsOn',
	display: 'month',
	timezone: 'UTC',
	reschedule: false,
}

describe('listControls (#342)', () => {
	it('reads search, facets and ordering off the URL', () => {
		// The regression itself: before #342 every one of these was ignored and
		// the loader passed only `page.order` to the list handler.
		const controls = listControls(
			at('?search=dune&filter.status=reading&sort=rating&dir=desc'),
			introspection,
			null,
			null,
		)
		expect(controls.filters).toEqual({
			search: 'dune',
			filter: { status: 'reading' },
		})
		expect(controls.sort).toEqual({ field: 'rating', dir: 'desc' })
	})

	it('scans the page columns it makes sense to search', () => {
		// Derived, not declared: the search box and the query agree because they
		// read the same introspection.
		expect(
			listControls(at(''), introspection, null, null).searchFields,
		).toEqual(['title'])
	})

	it('refuses to order by a column the page does not render', () => {
		// `ORDER BY acquisitionCost` over a list the viewer may read leaks the
		// hidden column one bit at a time: no value comes back, but the
		// permutation of the visible rows is a comparison oracle. Core refuses
		// exactly this for a portal identity; this is the same rule for every
		// identity, arriving through the query string instead.
		expect(
			listControls(
				at('?sort=acquisitionCost&dir=asc'),
				introspection,
				null,
				null,
			).sort,
		).toBeUndefined()
	})

	it('refuses to filter by one either', () => {
		// The blunter version of the same oracle — `?filter.acquisitionCost=42`
		// answers "is this row's cost 42?" one guess at a time, and the range
		// bounds answer it in binary search.
		const controls = listControls(
			at(
				'?filter.acquisitionCost=42&filter.acquisitionCost.gte=10&filter.status=reading',
			),
			introspection,
			null,
			null,
		)
		expect(controls.filters.filter).toEqual({ status: 'reading' })
		expect(controls.filters.range).toBeUndefined()
	})

	it('leaves a date- or board-arranged view alone', () => {
		// A calendar's rows are a window on a date column chosen by
		// `viewListOptions`. Layering a search over that would silently change
		// which days the grid is even asking about, so the page renders no bar
		// and the loader honours nothing.
		const controls = listControls(
			at('?search=dune&sort=title'),
			introspection,
			null,
			calendar,
		)
		expect(controls.filters).toBe(EMPTY_FILTERS)
		expect(controls.sort).toBeUndefined()
	})
})

/**
 * The one widening of #342's rule, and the proof it is not a hole (#362).
 *
 * A related-records "view all" is `?filter.<fk>=<parent id>` landing on the
 * child's list, and a child list is precisely the list that does not render its
 * own FK. Permitting the filter anyway would be the oracle #342 refuses; so the
 * page renders the column instead, and the filter is then honoured for the
 * ordinary reason. The tests below are the two halves of that: the filter *is*
 * honoured, and the column *is* on screen when it is.
 */
describe('listControls: a filtered relation joins the page (#362)', () => {
	it('renders the FK it is filtered by, and honours the filter', () => {
		const controls = listControls(at('?filter.bookId=b-1'), child, null, null)
		expect(controls.filters.filter).toEqual({ bookId: 'b-1' })
		// The half that makes it safe. Honouring the filter while the column
		// stayed off the page is the failure mode; a reader of the filtered list
		// sees `bookId` on every row, so the filter tells them nothing the page
		// was not already willing to show.
		expect(controls.columns.map((c) => c.name)).toContain('bookId')
		// Appended rather than promoted over the page's own picks.
		expect(controls.columns.map((c) => c.name)).toEqual([
			'body',
			'score',
			'mood',
			'locale',
			'source',
			'excerpt',
			'bookId',
		])
	})

	it('leaves the page alone when nothing filters it', () => {
		// The widening is per-request: the ordinary list is still the six columns
		// it always was, and the FK is not now a permanent seventh.
		const controls = listControls(at(''), child, null, null)
		expect(controls.columns.map((c) => c.name)).not.toContain('bookId')
		expect(controls.columns).toHaveLength(6)
	})

	it('honours it under a declared `fields` subset too', () => {
		// A declared subset is the other way an FK falls off a child list, and the
		// same answer applies — the filter target is appended, after the fields
		// the author asked for and in the order they asked for them.
		const controls = listControls(
			at('?filter.bookId=b-1'),
			child,
			['score', 'body'],
			null,
		)
		expect(controls.filters.filter).toEqual({ bookId: 'b-1' })
		expect(controls.columns.map((c) => c.name)).toEqual([
			'score',
			'body',
			'bookId',
		])
	})

	it('refuses a hidden relation — the hand-crafted URL', () => {
		// The attack the promotion must not become: `?filter.draftOfId=<guess>`
		// asks "is this review a draft of book X?" about a column the spec said to
		// hide. `hidden` is the declaration that means "never render this", so
		// promoting it would both leak the column and make `hidden` meaningless —
		// the filter is dropped and the page is unchanged, exactly as before #362.
		const controls = listControls(
			at('?filter.draftOfId=b-1'),
			child,
			null,
			null,
		)
		expect(controls.filters.filter).toEqual({})
		expect(controls.columns.map((c) => c.name)).not.toContain('draftOfId')
	})

	it('refuses a relation the schema opted out of filtering', () => {
		// `filterable === false` is the narrower opt-out and it binds here too.
		const controls = listControls(
			at('?filter.moderatorId=u-1'),
			child,
			null,
			null,
		)
		expect(controls.filters.filter).toEqual({})
		expect(controls.columns.map((c) => c.name)).not.toContain('moderatorId')
	})

	it('refuses a non-relation column past the cap', () => {
		// The widening is to *relations*, not to "whatever the URL names". A plain
		// column the page did not pick stays unfilterable and unrendered, so the
		// only thing a caller can reach through this door is the relation graph the
		// spec declares.
		const controls = listControls(
			at('?filter.excerpt=secret'),
			child,
			['body'],
			null,
		)
		expect(controls.filters.filter).toEqual({})
		expect(controls.columns.map((c) => c.name)).toEqual(['body'])
	})

	it('does not reshape a view page', () => {
		// A calendar honours no filter at all, so a filtered URL must not add a
		// column either — the grid would gain a column that constrains nothing.
		const controls = listControls(
			at('?filter.bookId=b-1'),
			child,
			null,
			calendar,
		)
		expect(controls.filters).toBe(EMPTY_FILTERS)
		expect(controls.columns.map((c) => c.name)).not.toContain('bookId')
	})

	it('promotes nothing on its own', () => {
		// `tableColumns` with no filter targets is the pre-#362 function, byte for
		// byte — every other caller keeps the columns it had.
		expect(tableColumns(child).map((c) => c.name)).toEqual(
			tableColumns(child, null, []).map((c) => c.name),
		)
	})
})
