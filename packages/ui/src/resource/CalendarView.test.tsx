/**
 * `<CalendarView>` / `<TimelineView>` — the date-arranged views.
 *
 * Three properties carry the issue's gating criteria and are asserted here:
 * rows land on the day the *declared* timezone says they do; a move is always
 * reachable from the keyboard, not only by drag; and neither component ever
 * writes — it reports a target day and the caller performs the validated
 * update.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CalendarView } from './CalendarView.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'
import { TimelineView } from './TimelineView.tsx'

const resource: IntrospectedResource = {
	name: 'task',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'startDate', type: 'date', meta: {} },
		{ name: 'dueDate', type: 'date', meta: {} },
		{ name: 'blockedBy', type: 'string', meta: {} },
	],
}

const rows: Row[] = [
	{
		id: '1',
		title: 'Draft the brief',
		startDate: '2026-08-03',
		dueDate: '2026-08-05',
		blockedBy: null,
	},
	{
		id: '2',
		title: 'Review the brief',
		startDate: '2026-08-06',
		dueDate: '2026-08-07',
		blockedBy: '1',
	},
]

const entry = (title: string) => screen.getByTitle(title)

describe('CalendarView', () => {
	it('places a row on the day its declared timezone says, not the browser’s', () => {
		const late: Row[] = [
			{ id: '9', title: 'Late night', dueDate: '2026-08-05T02:30:00.000Z' },
		]
		const { rerender, container } = render(
			<CalendarView
				resource={resource}
				rows={late}
				dateField="dueDate"
				display="month"
				timezone="America/New_York"
				anchor="2026-08-05"
			/>,
		)
		expect(
			container.querySelector('[data-day="2026-08-04"] [data-entry="9"]'),
		).not.toBeNull()

		rerender(
			<CalendarView
				resource={resource}
				rows={late}
				dateField="dueDate"
				display="month"
				timezone="Europe/Berlin"
				anchor="2026-08-05"
			/>,
		)
		expect(
			container.querySelector('[data-day="2026-08-05"] [data-entry="9"]'),
		).not.toBeNull()
	})

	it('spans a multi-day entry across every day it occupies', () => {
		const { container } = render(
			<CalendarView
				resource={resource}
				rows={rows}
				dateField="startDate"
				endField="dueDate"
				display="month"
				timezone="UTC"
				anchor="2026-08-05"
			/>,
		)
		for (const day of ['2026-08-03', '2026-08-04', '2026-08-05'])
			expect(
				container.querySelector(`[data-day="${day}"] [data-entry="1"]`),
			).not.toBeNull()
		expect(
			container.querySelector('[data-day="2026-08-06"] [data-entry="1"]'),
		).toBeNull()
	})

	it('moves an entry by keyboard — a day sideways, a week vertically', () => {
		const onMove = vi.fn()
		render(
			<CalendarView
				resource={resource}
				rows={rows}
				dateField="startDate"
				display="month"
				timezone="UTC"
				anchor="2026-08-05"
				onMove={onMove}
			/>,
		)
		fireEvent.keyDown(entry('Draft the brief'), { key: 'ArrowRight' })
		expect(onMove).toHaveBeenLastCalledWith(rows[0], '2026-08-04')
		// A row of the month grid is a week, so down is +7 days.
		fireEvent.keyDown(entry('Draft the brief'), { key: 'ArrowDown' })
		expect(onMove).toHaveBeenLastCalledWith(rows[0], '2026-08-10')
		// The move affordance is stated in text, not left to be discovered.
		screen.getByText(/arrow keys/i)
	})

	it('moves by a day vertically in the week grid, where a row is a day', () => {
		const onMove = vi.fn()
		render(
			<CalendarView
				resource={resource}
				rows={rows}
				dateField="startDate"
				display="week"
				timezone="UTC"
				anchor="2026-08-05"
				onMove={onMove}
			/>,
		)
		fireEvent.keyDown(entry('Draft the brief'), { key: 'ArrowDown' })
		expect(onMove).toHaveBeenLastCalledWith(rows[0], '2026-08-04')
	})

	it('moves an entry by drop onto a day cell', () => {
		const onMove = vi.fn()
		const { container } = render(
			<CalendarView
				resource={resource}
				rows={rows}
				dateField="startDate"
				display="week"
				timezone="UTC"
				anchor="2026-08-05"
				onMove={onMove}
			/>,
		)
		const target = container.querySelector(
			'[data-day="2026-08-07"]',
		) as HTMLElement
		fireEvent.drop(target, {
			dataTransfer: { getData: () => '1', setData: () => {} },
		})
		expect(onMove).toHaveBeenCalledWith(rows[0], '2026-08-07')
	})

	it('is inert without onMove — no drag handles, no swallowed arrow keys', () => {
		const { container } = render(
			<CalendarView
				resource={resource}
				rows={rows}
				dateField="startDate"
				display="month"
				timezone="UTC"
				anchor="2026-08-05"
			/>,
		)
		expect(container.querySelector('[draggable="true"]')).toBeNull()
		expect(screen.queryByText(/arrow keys/i)).toBeNull()
		expect(
			fireEvent.keyDown(entry('Draft the brief'), { key: 'ArrowRight' }),
		).toBe(true)
	})

	it('draws a heatmap as labelled per-day counts, never as colour alone', () => {
		const completions: Row[] = [
			{ id: 'a', title: 'x', dueDate: '2026-08-05' },
			{ id: 'b', title: 'y', dueDate: '2026-08-05' },
			{ id: 'c', title: 'z', dueDate: '2026-08-06' },
		]
		const { container } = render(
			<CalendarView
				resource={resource}
				rows={completions}
				dateField="dueDate"
				display="heatmap"
				timezone="UTC"
				anchor="2026-08-05"
			/>,
		)
		expect(
			container
				.querySelector('[data-day="2026-08-05"]')
				?.getAttribute('data-count'),
		).toBe('2')
		expect(
			container
				.querySelector('[data-day="2026-08-06"]')
				?.getAttribute('data-count'),
		).toBe('1')
		// Every cell states its count in text, so the graph is readable without
		// discriminating shades.
		expect(screen.getByLabelText(/Aug 5: 2/)).toBeInTheDocument()
	})

	it('shows the empty state only when no row carries a date at all', () => {
		const { rerender } = render(
			<CalendarView
				resource={resource}
				rows={[{ id: '3', title: 'Undated' }]}
				dateField="startDate"
				display="month"
				timezone="UTC"
				anchor="2026-08-05"
				emptyState={<p>Nothing scheduled</p>}
			/>,
		)
		expect(screen.getByText('Nothing scheduled')).toBeInTheDocument()
		// A window with no entries is an empty *week*, not an empty page.
		rerender(
			<CalendarView
				resource={resource}
				rows={rows}
				dateField="startDate"
				display="month"
				timezone="UTC"
				anchor="2027-01-05"
				emptyState={<p>Nothing scheduled</p>}
			/>,
		)
		expect(screen.queryByText('Nothing scheduled')).toBeNull()
	})
})

describe('TimelineView', () => {
	it('draws one bar per row and an edge for each declared dependency', () => {
		const { container } = render(
			<TimelineView
				resource={resource}
				rows={rows}
				startField="startDate"
				endField="dueDate"
				dependsOnField="blockedBy"
				timezone="UTC"
			/>,
		)
		expect(container.querySelectorAll('[data-bar]')).toHaveLength(2)
		expect(container.querySelector('[data-edge="1->2"]')).not.toBeNull()
		// The relation is also stated in text, so the arrow is not the only way to
		// learn it.
		expect(screen.getByText(/follows Draft the brief/)).toBeInTheDocument()
	})

	it('draws no edge when the predecessor is not on screen', () => {
		const { container } = render(
			<TimelineView
				resource={resource}
				rows={[{ ...rows[1], blockedBy: 'missing' } as Row]}
				startField="startDate"
				endField="dueDate"
				dependsOnField="blockedBy"
				timezone="UTC"
			/>,
		)
		expect(container.querySelector('line')).toBeNull()
	})

	it('moves a bar by keyboard, reporting the new start day', () => {
		const onMove = vi.fn()
		const { container } = render(
			<TimelineView
				resource={resource}
				rows={rows}
				startField="startDate"
				endField="dueDate"
				timezone="UTC"
				onMove={onMove}
			/>,
		)
		const bar = container.querySelector('[data-bar="1"]') as HTMLElement
		fireEvent.keyDown(bar, { key: 'ArrowRight' })
		expect(onMove).toHaveBeenCalledWith(rows[0], '2026-08-04')
	})

	it('keeps a row with no end date as a single-day milestone', () => {
		const { container } = render(
			<TimelineView
				resource={resource}
				rows={[{ id: '4', title: 'Kickoff', startDate: '2026-08-03' }]}
				startField="startDate"
				endField="dueDate"
				timezone="UTC"
			/>,
		)
		expect(container.querySelectorAll('[data-bar]')).toHaveLength(1)
	})

	/**
	 * The declared axis. The timeline used to span whatever the
	 * capped row set contained, which meant two things: the chart rescaled every
	 * time a row moved, and there was no "earlier" for a viewer to go to, because
	 * there was no window to step.
	 */
	describe('a declared window', () => {
		const spanning: Row[] = [
			{
				id: '1',
				title: 'Long haul',
				startDate: '2026-07-01',
				dueDate: '2026-09-30',
				blockedBy: null,
			},
		]

		it('spans the window it was given rather than the data', () => {
			const { container } = render(
				<TimelineView
					resource={resource}
					rows={spanning}
					startField="startDate"
					endField="dueDate"
					timezone="UTC"
					window={{ from: '2026-08-01', to: '2026-08-31' }}
				/>,
			)
			expect(screen.getByText(/Aug 1.*Aug 31/)).toBeInTheDocument()
			// Clipped to the axis: an unclipped bar would be laid out at a negative
			// offset and a width past 100%, i.e. off screen, which reads as missing.
			const bar = container.querySelector('[data-bar="1"]') as HTMLElement
			expect(bar.style.left).toBe('0%')
			expect(Number.parseFloat(bar.style.width)).toBeLessThanOrEqual(100)
		})

		it('says a clipped bar continues, and still states its real dates', () => {
			render(
				<TimelineView
					resource={resource}
					rows={spanning}
					startField="startDate"
					endField="dueDate"
					timezone="UTC"
					window={{ from: '2026-08-01', to: '2026-08-31' }}
				/>,
			)
			// A screen reader told the edge of the window instead of the row's real
			// end would be told something untrue about the data.
			expect(
				screen.getByText(/Jul 1.*Sep 30.*continues outside this period/),
			).toBeInTheDocument()
		})

		it('still spans the data when no window is given', () => {
			render(
				<TimelineView
					resource={resource}
					rows={spanning}
					startField="startDate"
					endField="dueDate"
					timezone="UTC"
				/>,
			)
			// Padded by a day at each end, as it always was — the component stays
			// usable on its own with a fixed row set.
			expect(screen.getByText(/Jun 30.*Oct 1/)).toBeInTheDocument()
		})
	})
})
