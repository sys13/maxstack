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

/** The resource as the page shows it — what the loader derives the rules from. */
const shown = {
	primaryKey: introspection.primaryKey,
	columns: tableColumns(introspection),
}

const at = (query: string) => new URL(`https://app.test/books${query}`)

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
			shown,
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
		expect(listControls(at(''), shown, null).searchFields).toEqual(['title'])
	})

	it('refuses to order by a column the page does not render', () => {
		// `ORDER BY acquisitionCost` over a list the viewer may read leaks the
		// hidden column one bit at a time: no value comes back, but the
		// permutation of the visible rows is a comparison oracle. Core refuses
		// exactly this for a portal identity; this is the same rule for every
		// identity, arriving through the query string instead.
		expect(
			listControls(at('?sort=acquisitionCost&dir=asc'), shown, null).sort,
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
			shown,
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
			shown,
			calendar,
		)
		expect(controls.filters).toBe(EMPTY_FILTERS)
		expect(controls.sort).toBeUndefined()
	})
})
