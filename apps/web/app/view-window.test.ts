/**
 * What a date-arranged view asks the store for.
 *
 * Before this, only a single-day calendar was windowed. A multi-day calendar
 * entry and every timeline bar read a capped 500 rows ordered by the start
 * column, and the view said so on screen when it hit the cap — because an entry
 * that *starts* before the window and *ends* inside it falls out of a range test
 * on its start column alone, and `ListOptions.range` ANDs its per-column bounds,
 * which silently drops every row whose end is NULL.
 *
 * These pin the query rather than the rendering, because the query is where both
 * failures were: a window that is subtly wrong shows a plausible chart with rows
 * missing from it, and nothing about the page says so.
 */

import { addDays, monthGrid, monthStart } from '@maxstack/ui'
import { describe, expect, it } from 'vitest'
import type { PageRowView } from './project-routes'
import {
	TIMELINE_WINDOW_DAYS,
	timelineWindow,
	viewLimit,
	viewListOptions,
} from './routes/project.page'

// The row-shaped views only. An aggregate has no window, no cap and no anchor
// — it is deliberately not assignable to any of these three functions.
type View = PageRowView

const ANCHOR = '2026-06-15'

const calendar = (endField?: string): View => ({
	kind: 'calendar',
	dateField: 'startsOn',
	display: 'month',
	timezone: 'UTC',
	reschedule: false,
	...(endField ? { endField } : {}),
})

const timeline = (): View => ({
	kind: 'timeline',
	startField: 'startsOn',
	endField: 'endsOn',
	timezone: 'UTC',
	reschedule: false,
})

describe('a single-day calendar', () => {
	it('still asks for exactly the days the grid draws, as a plain range', () => {
		const opts = viewListOptions(calendar(), ANCHOR)
		const days = monthGrid(ANCHOR)
		expect(opts.range?.startsOn?.gte).toBe(days[0])
		// The upper bound is the start of the day AFTER the last one drawn, so a
		// 23:30 entry on the final day is inside the window.
		expect(opts.range?.startsOn?.lte).toBe(addDays(days.at(-1) as string, 1))
		// A point per row: there is no end column to test, so the two-column
		// predicate would have nothing to say.
		expect(opts.overlaps).toBeUndefined()
	})
})

describe('a calendar with a declared end column', () => {
	it('is windowed now, with the overlap predicate rather than a cap', () => {
		const opts = viewListOptions(calendar('endsOn'), ANCHOR)
		const days = monthGrid(ANCHOR)
		expect(opts.overlaps).toEqual({
			startColumn: 'startsOn',
			endColumn: 'endsOn',
			from: days[0],
			to: addDays(days.at(-1) as string, 1),
		})
		// Not a range: an AND of two range bounds is what silently dropped every
		// milestone row, which is the reason this read a cap for so long.
		expect(opts.range).toBeUndefined()
	})
})

describe('a timeline', () => {
	it('asks for its own axis, so the query and the drawing cannot disagree', () => {
		const opts = viewListOptions(timeline(), ANCHOR)
		const axis = timelineWindow(ANCHOR)
		expect(opts.overlaps).toEqual({
			startColumn: 'startsOn',
			endColumn: 'endsOn',
			from: axis.from,
			to: addDays(axis.to, 1),
		})
	})

	it('has an axis a viewer can move, anchored on a month boundary', () => {
		// A timeline has no natural period, so the axis is chosen rather than
		// declared — and it has to be *stable*, or paging forward and back would
		// not return to where it started.
		expect(timelineWindow(ANCHOR).from).toBe(monthStart(ANCHOR))
		expect(timelineWindow(ANCHOR).to).toBe(
			addDays(monthStart(ANCHOR), TIMELINE_WINDOW_DAYS - 1),
		)
		// Paging by exactly one axis width and back is the identity.
		const later = addDays(monthStart(ANCHOR), TIMELINE_WINDOW_DAYS)
		expect(addDays(later, -TIMELINE_WINDOW_DAYS)).toBe(monthStart(ANCHOR))
	})
})

describe('the row cap', () => {
	it('still exists, because a window bounds how far a view reads, not how many rows are in it', () => {
		// A thousand overlapping bars in one quarter is still a thousand rows, and
		// a truncated chart looks exactly like a complete one — so the cap and its
		// notice both stay.
		expect(viewLimit(timeline())).toBe(1000)
		expect(viewListOptions(timeline(), ANCHOR).limit).toBe(1000)
		expect(viewListOptions(calendar('endsOn'), ANCHOR).limit).toBe(1000)
	})
})
