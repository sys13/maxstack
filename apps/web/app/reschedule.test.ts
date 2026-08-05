/**
 * Moving an entry in a date-arranged view.
 *
 * Two things are proven here, and they are the issue's two gating criteria:
 *
 * 1. **Timezone behaviour is declared and tested** — a move preserves the time
 *    of day in the *view's* zone, across a DST boundary, and a bare date column
 *    stays a bare date column.
 * 2. **The write-back does not bypass validation** — the values a drag produces
 *    are submitted to the record's own edit route and land through the same
 *    `updateHandler`/`opUpdate` a form save uses. The test drives that handler
 *    with a drag-shaped payload against the real backend, and shows a bad value
 *    rejected identically (422 + `fieldErrors`), not silently written.
 */

import {
	createSpecDb,
	ResourceRegistry,
	registerSpecEntities,
	updateHandler,
} from '@maxstack/core'
import { describe, expect, it } from 'vitest'
import type { PageCalendarView, PageTimelineView } from './project-routes'
import {
	movedTo,
	ROW_EDIT_ENCTYPE,
	rescheduleValues,
	rowEditRoute,
} from './reschedule'

const calendar = (extra: Partial<PageCalendarView> = {}): PageCalendarView => ({
	kind: 'calendar',
	dateField: 'dueAt',
	display: 'month',
	timezone: 'America/New_York',
	reschedule: true,
	...extra,
})

const timeline = (extra: Partial<PageTimelineView> = {}): PageTimelineView => ({
	kind: 'timeline',
	startField: 'startAt',
	endField: 'endAt',
	timezone: 'America/New_York',
	reschedule: true,
	...extra,
})

describe('movedTo', () => {
	it('keeps the wall-clock time in the declared zone across a DST boundary', () => {
		// 2026-03-08 is the US spring-forward Sunday. A value that names an instant
		// — it carries a `Z` — is re-anchored so a 09:00 standup is still at 09:00
		// local afterwards: 13:00Z (EDT), not the 14:00Z a 24-hour-multiple shift
		// would produce.
		expect(
			movedTo('2026-03-06T14:00:00.000Z', '2026-03-08', 'America/New_York'),
		).toBe('2026-03-08T13:00:00.000Z')
	})

	it('moves a zone-less stored value by its date part alone, keeping its shape', () => {
		// What a `timestamp` column actually reads back as. It is a wall clock, not
		// an instant: projecting it through a zone would move the appointment by
		// the offset, which is the same bug from the other side.
		// Re-emitted with a `T`: the space-separated form the column reads back as
		// is not what the column's own validation accepts.
		expect(
			movedTo('2026-03-06 09:00:00', '2026-03-08', 'America/New_York'),
		).toBe('2026-03-08T09:00:00')
		expect(movedTo('2026-08-01', '2026-08-04', 'America/New_York')).toBe(
			'2026-08-04',
		)
	})

	it('falls back to the day itself for an unparseable value', () => {
		expect(movedTo('not a date', '2026-08-04', 'UTC')).toBe('2026-08-04')
		expect(movedTo(null, '2026-08-04', 'UTC')).toBe('2026-08-04')
	})
})

describe('rescheduleValues', () => {
	it('writes only the view’s own declared date columns', () => {
		const row = { id: '1', title: 'Ship it', dueAt: '2026-08-01', other: 'x' }
		expect(rescheduleValues(calendar(), row, '2026-08-04')).toEqual({
			dueAt: '2026-08-04',
		})
	})

	it('preserves an entry’s length when it is moved', () => {
		const row = { id: '1', dueAt: '2026-08-01', endsAt: '2026-08-03' }
		expect(
			rescheduleValues(calendar({ endField: 'endsAt' }), row, '2026-08-05'),
		).toEqual({ dueAt: '2026-08-05', endsAt: '2026-08-07' })
	})

	it('shifts a timeline bar’s start and end together', () => {
		const row = { id: '1', startAt: '2026-08-01', endAt: '2026-08-06' }
		expect(rescheduleValues(timeline(), row, '2026-08-03')).toEqual({
			startAt: '2026-08-03',
			endAt: '2026-08-08',
		})
	})

	it('refuses a move the spec never allowed, an impossible day, or an undated row', () => {
		const row = { id: '1', dueAt: '2026-08-01' }
		expect(
			rescheduleValues(calendar({ reschedule: false }), row, '2026-08-04'),
		).toBeNull()
		expect(rescheduleValues(calendar(), row, '2026-02-30')).toBeNull()
		expect(rescheduleValues(calendar(), row, 'tomorrow')).toBeNull()
		expect(rescheduleValues(calendar(), { id: '2' }, '2026-08-04')).toBeNull()
	})

	it('submits to the record’s own edit route, in the form’s encoding', () => {
		// Not a cosmetic assertion: this route+encoding pair *is* the form's, so
		// there is no second write path for a view to leak through.
		expect(rowEditRoute('tasks', 'abc def')).toBe('/tasks/abc%20def')
		expect(ROW_EDIT_ENCTYPE).toBe('application/json')
	})
})

describe('the write-back runs the form’s validation, not its own', () => {
	/**
	 * A project-shaped resource: a spec entity with a writable date column,
	 * materialized through the same `registerSpecEntities` + `createSpecDb` the
	 * running app grounds a project with. The point of using the real bridge is
	 * that the validation a drag meets here is the validation a form meets there —
	 * not a stub that agrees with it today.
	 */
	async function scheduled() {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [
			{
				name: 'appointment',
				fields: [
					{ name: 'title', type: 'string', required: true },
					{ name: 'dueAt', type: 'date', required: false },
				],
			},
		])
		const { store } = await createSpecDb(registry, [
			{
				name: 'appointment',
				fields: [
					{ name: 'title', type: 'string', required: true },
					{ name: 'dueAt', type: 'date', required: false },
				],
			},
		])
		return { registry, store, user: null }
	}

	it('lands a drag-shaped payload through updateHandler, and 422s a bad one', async () => {
		const ctx = await scheduled()
		const row = await ctx.store.create('appointment', {
			title: 'Standup',
			dueAt: '2026-03-06T09:00:00.000Z',
		})
		const id = String(row.id)
		const view = calendar()

		// The value the store hands back is the zone-less wall clock the column
		// stores, so the move keeps 09:00 and changes only the day.
		const values = rescheduleValues(view, row, '2026-03-08')
		expect(values?.dueAt).toMatch(/^2026-03-08[T ]09:00/)

		const ok = await updateHandler(
			ctx,
			'appointment',
			id,
			values as Record<string, string>,
		)
		expect(ok.status).toBe(200)
		expect(String((ok.body as Record<string, unknown>).dueAt)).toContain(
			'2026-03-08',
		)

		// The same handler, the same column, a value the form would also reject —
		// so the view's write is not a softer path to the same column.
		const bad = await updateHandler(ctx, 'appointment', id, {
			dueAt: 'next tuesday',
		})
		expect(bad.status).toBe(422)
		expect(bad.body).toHaveProperty('fieldErrors')

		// The move touched the date column and nothing else — the row's other
		// fields are exactly as they were.
		expect((ok.body as Record<string, unknown>).title).toBe('Standup')
	})
})
