/**
 * The `<resource>__row` block slot across all three list variants.
 *
 * The property under test is what makes a bespoke row cost 3 instead of 5: the
 * row's *contents* become the user's, and everything the platform derived
 * around them — ordering, links into CRUD, the empty state, the selection
 * column, the sample-data marking — keeps working. A row slot that quietly
 * dropped the row link would be an eject wearing a slot's clothes.
 */

import { render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { CardGrid } from '../resource/CardGrid.tsx'
import { FeedList } from '../resource/FeedList.tsx'
import { ResourceList } from '../resource/ResourceList.tsx'
import type { IntrospectedResource, Row } from '../resource/resource-types.ts'
import type { RowSlotProps } from './block-slots.ts'

const resource: IntrospectedResource = {
	name: 'exercise',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'name', type: 'string', meta: { label: 'Exercise' } },
		{ name: 'formCue', type: 'string', meta: { label: 'Form cue' } },
	],
}

const rows: Row[] = [
	{ id: '1', name: 'Squat', formCue: 'knees out' },
	{ id: '2', name: 'Deadlift', formCue: 'brace' },
]

const rowHref = (row: Row) => `/exercises/${String(row.id)}`

/** A bespoke row of the shape the gymlog ask needs: field metadata read from
 * `columns`, not re-derived, and local state for the animation. */
function DemoRow({ row, columns, href, isDemo }: RowSlotProps) {
	const [playing, setPlaying] = useState(false)
	const cue = columns.find((c) => c.name === 'formCue')
	return (
		<div data-testid="bespoke-row">
			<span>{String(row.name)}</span>
			<span>
				{cue?.meta?.label}: {String(row.formCue)}
			</span>
			<span data-testid="href">{href}</span>
			{isDemo ? <span data-testid="demo">sample</span> : null}
			<button type="button" onClick={() => setPlaying(true)}>
				{playing ? 'playing' : 'play'}
			</button>
		</div>
	)
}

describe.each([
	['CardGrid', CardGrid],
	['FeedList', FeedList],
	['ResourceList', ResourceList],
] as const)('%s row slot', (_name, List) => {
	it('renders the bespoke row in place of the generated one', () => {
		render(
			<List
				resource={resource}
				rows={rows}
				rowHref={rowHref}
				renderRow={DemoRow}
			/>,
		)
		expect(screen.getAllByTestId('bespoke-row')).toHaveLength(2)
		// The generated presentation is gone, not merely covered.
		expect(screen.queryByText('knees out')).not.toBeInTheDocument()
		expect(screen.getByText('Form cue: knees out')).toBeInTheDocument()
	})

	it('keeps the row link the platform derived', () => {
		render(
			<List
				resource={resource}
				rows={rows}
				rowHref={rowHref}
				renderRow={DemoRow}
			/>,
		)
		expect(screen.getAllByTestId('href')[0]).toHaveTextContent('/exercises/1')
	})

	it('keeps the empty state', () => {
		render(
			<List
				resource={resource}
				rows={[]}
				rowHref={rowHref}
				renderRow={DemoRow}
				emptyState={<p>nothing yet</p>}
			/>,
		)
		expect(screen.getByText('nothing yet')).toBeInTheDocument()
		expect(screen.queryByTestId('bespoke-row')).not.toBeInTheDocument()
	})

	it('still marks sample rows', () => {
		render(
			<List
				resource={resource}
				rows={rows}
				rowHref={rowHref}
				renderRow={DemoRow}
				demoIds={['2']}
			/>,
		)
		expect(screen.getAllByTestId('demo')).toHaveLength(1)
	})
})

describe('ResourceList row slot', () => {
	/** The row region spans every column, so the headers would be labelling
	 * cells that no longer exist. */
	it('suppresses the column headers a bespoke row no longer fills', () => {
		const { container } = render(
			<ResourceList
				resource={resource}
				rows={rows}
				rowHref={rowHref}
				renderRow={DemoRow}
			/>,
		)
		expect(container.querySelector('thead')).toHaveAttribute('hidden')
	})

	it('keeps the selection column beside the bespoke row', () => {
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				renderRow={DemoRow}
				selectable
				bulkActions={() => <button type="button">Delete</button>}
			/>,
		)
		const first = screen.getAllByTestId('bespoke-row')[0]
		expect(first).toBeInTheDocument()
		expect(
			within(first?.closest('tr') as HTMLElement).queryByLabelText(
				'Select row 1',
			),
		).toBeInTheDocument()
	})
})
