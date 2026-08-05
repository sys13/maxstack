import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { History, type HistoryEntry } from './History.tsx'

const entries: HistoryEntry[] = [
	{
		userId: 'u-ada',
		action: 'update',
		resourceId: 't1',
		metadata: { fields: ['title', 'priority'] },
		createdAt: '2026-07-10T12:00:00.000Z',
	},
	{
		userId: 'u-ada',
		action: 'create',
		resourceId: 't1',
		createdAt: '2026-07-10T09:00:00.000Z',
	},
]

function firstListItem(): HTMLElement {
	const item = screen.getAllByRole('listitem')[0]
	if (!item) throw new Error('expected at least one list item')
	return item
}

describe('History', () => {
	it('renders an empty state when there is no activity', () => {
		render(<History entries={[]} />)
		expect(screen.getByText('No activity yet.')).toBeInTheDocument()
	})

	it('renders one item per entry with a past-tense verb', () => {
		render(<History entries={entries} />)
		const items = screen.getAllByRole('listitem')
		expect(items).toHaveLength(2)
		expect(items[0]).toHaveTextContent('updated')
		expect(items[1]).toHaveTextContent('created')
	})

	it('surfaces the changed fields of an update', () => {
		render(<History entries={entries} />)
		expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(
			'title, priority',
		)
	})

	it('maps the actor id through formatActor', () => {
		render(
			<History
				entries={entries}
				formatActor={(id) => (id === 'u-ada' ? 'Ada Lovelace' : id)}
			/>,
		)
		expect(
			within(firstListItem()).getByText('Ada Lovelace'),
		).toBeInTheDocument()
	})

	it('renders a machine-readable <time> for each entry', () => {
		render(<History entries={entries} />)
		const time = firstListItem().querySelector('time')
		expect(time).toHaveAttribute('dateTime', '2026-07-10T12:00:00.000Z')
	})
})

/**
 * Issue #186. Recording the origin and never rendering it would make the
 * attribution unverifiable in the product — the whole point is that a change
 * made by a script looks different from one a colleague made.
 */
describe('History origin badge', () => {
	const at = '2026-07-27T10:00:00.000Z'

	it('labels a change made through an api key, and names the key on hover', () => {
		render(
			<History
				entries={[
					{
						userId: 'u-1',
						action: 'update',
						origin: 'api-key',
						apiKeyId: 'key-7',
						createdAt: at,
					},
				]}
			/>,
		)
		const badge = screen.getByText('via API key')
		expect(badge).toBeInTheDocument()
		expect(badge).toHaveAttribute('title', 'Key key-7')
	})

	it('labels an agent (MCP) change distinctly from an api key', () => {
		render(
			<History
				entries={[
					{ userId: 'u-1', action: 'create', origin: 'mcp', createdAt: at },
				]}
			/>,
		)
		expect(screen.getByText('via agent (MCP)')).toBeInTheDocument()
		expect(screen.queryByText('via API key')).not.toBeInTheDocument()
	})

	it('leaves a plain session unlabelled — the common case is not noise', () => {
		render(
			<History
				entries={[
					{ userId: 'u-1', action: 'create', origin: 'session', createdAt: at },
					// A pre-0.2.0 entry: no origin at all. Reads as unknown, never as
					// an assertion that a human did it.
					{ userId: 'u-2', action: 'create', createdAt: at },
				]}
			/>,
		)
		expect(screen.queryByText(/^via /)).not.toBeInTheDocument()
		expect(screen.queryByText('automated')).not.toBeInTheDocument()
	})
})
