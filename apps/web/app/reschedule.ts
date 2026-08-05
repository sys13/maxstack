/**
 * Moving an entry in a date-arranged view.
 *
 * This module answers one question — *what does a record look like after its
 * entry is dropped on a different day?* — and answers it as **plain values**,
 * not as a write. The values it returns are submitted to the record's ordinary
 * edit route, the same route, action and content type `<DynamicForm>` posts to,
 * so a drag goes through the identical server-side validation, permission check
 * and audit trail as editing that field in the form.
 *
 * That is the security property the issue gates on, and it is structural rather
 * than promised: there is no reschedule endpoint. If this file returned garbage,
 * the update would 422 exactly as a garbage form submission does.
 *
 * ## The timezone
 *
 * Two conversions happen here, in the declared zone and never the ambient one:
 *
 *  - **Reading** a stored value's day — `dayKeyOf`, shared with the view, so the
 *    day a drag *starts* from is the day the grid drew it on.
 *  - **Writing** the new instant — `zonedWallClockToInstant`, which is the
 *    DST-aware direction: a 09:00 standup moved onto the day the clocks go
 *    forward stays 09:00 local, not 08:00.
 *
 * A column storing a bare `YYYY-MM-DD` keeps storing one. Promoting a date to a
 * midnight timestamp because it was dragged would change the column's meaning as
 * a side effect of a mouse gesture.
 */

import { wallClockIn, zonedWallClockToInstant } from '@maxstack/spec'
import {
	addDays,
	type DayKey,
	dayKeyOf,
	daysBetween,
	isDayKey,
} from '@maxstack/ui'
import { pagePath } from './page-path'
import type { PageDateView } from './project-routes'

/** A record as the runtime hands it around — the same shape the list renders. */
type Row = Record<string, unknown>

/**
 * A stored value carrying no zone: a bare date, or the `YYYY-MM-DD HH:mm:ss` a
 * `timestamp` column reads back as. Its date part moves and everything after it
 * is preserved byte-for-byte — the value was a wall clock, and a drag changes
 * which day it reads, never which zone it is in. See `dayKeyOf`.
 */
const ZONELESS_RE =
	/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/

/**
 * `original` moved to `day`, preserving its time of day in `timezone`.
 *
 * A zone-less value keeps its shape and its time of day; only its date part
 * moves. A value that names an instant (it carries an offset or a `Z`) keeps its
 * wall-clock time in `timezone` and is re-anchored on the new day, which is what
 * makes a DST-crossing move keep the appointment at the hour it was booked.
 */
export function movedTo(
	original: unknown,
	day: DayKey,
	timezone: string,
): string {
	if (typeof original === 'string') {
		const zoneless = ZONELESS_RE.exec(original)
		// Re-emitted with a `T` — the canonical ISO separator, and what a form
		// posts. The space-separated read-back form (`2026-03-08 09:00:00`) also
		// validates now that #218 normalizes it, so this is a choice of shape
		// rather than a workaround; it was a workaround until then.
		if (zoneless) return zoneless[2] ? `${day}T${zoneless[2]}` : day
	}
	const at =
		original instanceof Date
			? original
			: typeof original === 'string' || typeof original === 'number'
				? new Date(original)
				: null
	if (!at || Number.isNaN(at.getTime())) return day
	const wall = wallClockIn(timezone, at)
	const [year, month, date] = day.split('-').map(Number)
	return zonedWallClockToInstant(timezone, {
		year: year ?? wall.year,
		month: month ?? wall.month,
		day: date ?? wall.day,
		hour: wall.hour,
		minute: wall.minute,
	}).toISOString()
}

/**
 * The field values that move `row`'s entry to `day`, or `null` when the move is
 * not allowed or not meaningful.
 *
 * `null` — rather than an empty object — for every refusal, so a caller cannot
 * accidentally submit a no-op update that still writes an audit entry:
 *
 *  - the view did not declare `reschedule`;
 *  - the target is not a real calendar day;
 *  - the row carries no date to move from.
 *
 * Only the view's own declared date columns are ever returned. A drag cannot
 * name a field, which is why it can never become a way to write one the view
 * does not arrange by.
 */
export function rescheduleValues(
	view: PageDateView,
	row: Row,
	day: string,
): Record<string, string> | null {
	if (!view.reschedule || !isDayKey(day)) return null
	const { timezone } = view

	if (view.kind === 'calendar') {
		const from = dayKeyOf(row[view.dateField], timezone)
		if (!from) return null
		const values: Record<string, string> = {
			[view.dateField]: movedTo(row[view.dateField], day, timezone),
		}
		// A multi-day entry keeps its length: the drag moved the entry, not its
		// end. Shifting only the start would silently stretch or invert it.
		if (view.endField) {
			const end = dayKeyOf(row[view.endField], timezone)
			if (end)
				values[view.endField] = movedTo(
					row[view.endField],
					addDays(end, daysBetween(from, day)),
					timezone,
				)
		}
		return values
	}

	const from = dayKeyOf(row[view.startField], timezone)
	if (!from) return null
	const values: Record<string, string> = {
		[view.startField]: movedTo(row[view.startField], day, timezone),
	}
	const end = dayKeyOf(row[view.endField], timezone)
	if (end)
		values[view.endField] = movedTo(
			row[view.endField],
			addDays(end, daysBetween(from, day)),
			timezone,
		)
	return values
}

/**
 * Where a reschedule is submitted: the record's own edit route.
 *
 * Exported (and used by both call sites) so "the same path as a form edit" is a
 * shared function rather than two string literals that agree today.
 */
export function rowEditRoute(slug: string, id: string): string {
	return pagePath(slug, encodeURIComponent(id))
}

/** The encoding the record edit action parses as a field-value update. */
export const ROW_EDIT_ENCTYPE = 'application/json'
