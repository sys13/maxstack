/**
 * `<TimelineView>` — containment of its own horizontal overflow.
 *
 * This file exists for issue #340, which was reported against `<BoardView>`:
 * a scroll container that is not positioned does not clip absolutely positioned
 * descendants, so anything of theirs that lands past the viewport widens the
 * **document** instead of scrolling inside the view. The board reproduced it
 * through the `sr-only` spans in its column headers.
 *
 * The timeline has the same shape — `overflow-x-auto` around content that holds
 * `sr-only` labels and absolutely positioned bars — and did not reproduce it
 * only because its bars are positioned in percentages of the axis, so the axis
 * never exceeds its box today. That is a property of the current drawing code,
 * not of the container, which is exactly the kind of accident that stops being
 * true later. The container is positioned here for the same reason, and this
 * pins it.
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { IntrospectedResource, Row } from './resource-types.ts'
import { TimelineView } from './TimelineView.tsx'

const resource: IntrospectedResource = {
	name: 'task',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'startsOn', type: 'date', meta: {} },
		{ name: 'endsOn', type: 'date', meta: {} },
	],
}

const rows: Row[] = [
	{
		id: '1',
		title: 'Draft the plan',
		startsOn: '2026-03-02',
		endsOn: '2026-03-06',
	},
	{ id: '2', title: 'Ship it', startsOn: '2026-03-09', endsOn: '2026-03-13' },
]

describe('TimelineView', () => {
	it('scrolls inside a positioned container, so the page cannot', () => {
		const { container } = render(
			<TimelineView
				resource={resource}
				rows={rows}
				startField="startsOn"
				endField="endsOn"
				timezone="UTC"
				window={{ from: '2026-03-01', to: '2026-03-31' }}
			/>,
		)
		const scroller = container.querySelector('section') as HTMLElement
		expect(scroller.className).toContain('overflow-x-auto')
		// jsdom has no layout, so the honest assertion is the structural one: the
		// scroller is the containing block for the absolutely positioned
		// descendants it holds, rather than leaking them to the initial one.
		expect(scroller.className).toContain('relative')
		expect(scroller.querySelectorAll('.sr-only').length).toBeGreaterThan(0)
	})
})
