/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
/**
 * Day arithmetic for the date-arranged views.
 *
 * The interesting assertions are the timezone ones: the same stored instant is a
 * different *day* in two zones, and getting that wrong is the failure mode every
 * calendar feature ships at least once.
 */

import { describe, expect, it } from 'vitest'
import {
	addDays,
	dayKeyOf,
	daysBetween,
	daysInMonth,
	entryDays,
	heatmapGrid,
	isDayKey,
	monthGrid,
	weekday,
	weekGrid,
	weekStart,
} from './calendar-days.ts'

describe('dayKeyOf — the only instant → day conversion', () => {
	it('reads the same instant as a different day in two zones', () => {
		// 2026-08-05T02:30Z is still the 4th in New York and already the 5th in
		// Berlin. A view that ignores its declared zone puts this row on the wrong
		// day for one of them, silently.
		const at = '2026-08-05T02:30:00.000Z'
		expect(dayKeyOf(at, 'America/New_York')).toBe('2026-08-04')
		expect(dayKeyOf(at, 'Europe/Berlin')).toBe('2026-08-05')
		expect(dayKeyOf(at, 'UTC')).toBe('2026-08-05')
	})

	it('leaves a zone-less value alone rather than re-zoning it into another day', () => {
		// The classic off-by-one: parsing `2026-08-01` as UTC midnight and
		// formatting it in a western zone yields July 31st.
		expect(dayKeyOf('2026-08-01', 'America/Los_Angeles')).toBe('2026-08-01')
		// A `timestamp` column reads back like this. It is a wall clock, not an
		// instant, so its date part is the day — in every zone.
		expect(dayKeyOf('2026-08-01 23:30:00', 'America/Los_Angeles')).toBe(
			'2026-08-01',
		)
		expect(dayKeyOf('2026-08-01T23:30', 'Europe/Berlin')).toBe('2026-08-01')
	})

	it('accepts Date objects and returns null for absent or unparseable values', () => {
		expect(dayKeyOf(new Date('2026-08-05T12:00:00Z'), 'UTC')).toBe('2026-08-05')
		expect(dayKeyOf(null, 'UTC')).toBeNull()
		expect(dayKeyOf(undefined, 'UTC')).toBeNull()
		expect(dayKeyOf('not a date', 'UTC')).toBeNull()
		expect(dayKeyOf({}, 'UTC')).toBeNull()
	})
})

describe('day arithmetic', () => {
	it('adds and subtracts days across month, year and DST boundaries', () => {
		expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
		expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
		// A "spring forward" Sunday is still exactly one day after Saturday: the
		// keys carry days, not 24-hour blocks.
		expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
		expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2)
		expect(daysBetween('2026-03-01', '2026-02-27')).toBe(-2)
		expect(daysInMonth('2028-02-10')).toBe(29)
	})

	it('starts weeks on Monday, unconditionally', () => {
		expect(weekday('2026-08-02')).toBe(0) // a Sunday
		expect(weekStart('2026-08-02')).toBe('2026-07-27')
		expect(weekStart('2026-07-27')).toBe('2026-07-27')
		expect(weekGrid('2026-08-05')).toEqual([
			'2026-08-03',
			'2026-08-04',
			'2026-08-05',
			'2026-08-06',
			'2026-08-07',
			'2026-08-08',
			'2026-08-09',
		])
	})

	it('validates day keys, including impossible dates', () => {
		expect(isDayKey('2026-08-05')).toBe(true)
		expect(isDayKey('2026-02-30')).toBe(false)
		expect(isDayKey('2026-8-5')).toBe(false)
		expect(isDayKey(20260805)).toBe(false)
	})
})

describe('grids', () => {
	it('draws whole Monday→Sunday weeks around a month', () => {
		const grid = monthGrid('2026-08-12')
		expect(grid.length % 7).toBe(0)
		expect(grid[0]).toBe('2026-07-27') // the Monday before Aug 1
		expect(grid).toContain('2026-08-31')
		expect(weekday(grid[0] as string)).toBe(1)
	})

	it('draws a trailing 53-week window for a heatmap', () => {
		const grid = heatmapGrid('2026-08-12')
		expect(grid).toHaveLength(53 * 7)
		expect(grid.at(-1)).toBe(addDays(weekStart('2026-08-12'), 6))
	})
})

describe('entryDays', () => {
	it('spans start → end inclusive, and never disappears on bad data', () => {
		expect(entryDays('2026-08-04')).toEqual(['2026-08-04'])
		expect(entryDays('2026-08-04', '2026-08-06')).toEqual([
			'2026-08-04',
			'2026-08-05',
			'2026-08-06',
		])
		// End before start is stored data disagreeing with itself; the row is drawn
		// short rather than dropped from the calendar.
		expect(entryDays('2026-08-04', '2026-08-01')).toEqual(['2026-08-04'])
	})
})
