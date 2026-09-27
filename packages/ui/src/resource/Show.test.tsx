import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { IntrospectedResource } from './resource-types.ts'
import { Show } from './Show.tsx'

const resource: IntrospectedResource = {
	name: 'post',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'published', type: 'boolean', meta: { readOnly: true } },
		{ name: 'secret', type: 'string', meta: { hidden: true } },
	],
}

const record = { id: 'abc', title: 'Hello', published: true, secret: 'nope' }

describe('Show', () => {
	it('renders labels and values, including read-only and the primary key', () => {
		render(<Show resource={resource} record={record} />)
		expect(screen.getByText('Title')).toBeInTheDocument()
		expect(screen.getByText('Hello')).toBeInTheDocument()
		// read-only boolean still shown
		expect(screen.getByLabelText('yes')).toBeInTheDocument()
		// primary key shown by default
		expect(screen.getByText('abc')).toBeInTheDocument()
	})

	it('skips hidden columns and can hide the primary key', () => {
		render(<Show resource={resource} record={record} hidePrimaryKey />)
		expect(screen.queryByText('nope')).not.toBeInTheDocument()
		expect(screen.queryByText('abc')).not.toBeInTheDocument()
	})

	it('humanizes a raw column name with no meta.label', () => {
		render(<Show resource={resource} record={record} />)
		// `id` has meta: {} (no label) and shows by default — must not render as
		// the raw lowercase name.
		expect(screen.getByText('Id')).toBeInTheDocument()
	})

	it('supports a field override', () => {
		render(
			<Show
				resource={resource}
				record={record}
				fields={{ title: ({ value }) => <b data-testid="ov">{`~${value}`}</b> }}
			/>,
		)
		expect(screen.getByTestId('ov')).toHaveTextContent('~Hello')
	})

	it('says who last wrote a cell with a merge policy, and that a hand edit is kept (#460)', () => {
		const stamped: IntrospectedResource = {
			name: 'book',
			primaryKey: 'id',
			columns: [
				{ name: 'id', type: 'uuid', meta: {} },
				{ name: 'title', type: 'string', meta: {} },
				{
					name: 'coverUrl',
					type: 'string',
					meta: { label: 'Cover', merge: { humanEditWins: true } },
				},
				{
					name: 'isbn',
					type: 'string',
					meta: { merge: { humanEditWins: true } },
				},
				{
					name: '_maxstack_provenance',
					type: 'json',
					meta: { hidden: true, readOnly: true, cellProvenance: true },
				},
			],
		}
		render(
			<Show
				resource={stamped}
				record={{
					id: 'b1',
					title: 'Dune',
					coverUrl: 'https://covers.example/dune.jpg',
					isbn: '978',
					_maxstack_provenance: {
						coverUrl: {
							by: 'u-host',
							origin: 'session',
							at: '2026-09-01T10:00:00.000Z',
						},
						isbn: {
							by: 'service:sync',
							origin: 'system',
							source: 'openlibrary',
							at: '2026-09-02T10:00:00.000Z',
						},
					},
				}}
			/>,
		)
		expect(screen.getByText('edited by hand · kept from sync')).toHaveAttribute(
			'title',
			'u-host · 2026-09-01T10:00:00.000Z',
		)
		expect(screen.getByText('synced from openlibrary')).toBeInTheDocument()
		// The stamps column itself is hidden, never rendered as a field.
		expect(screen.queryByText('Cell provenance')).not.toBeInTheDocument()
		// A column with no policy carries no line at all.
		expect(document.querySelectorAll('[data-cell-writer]')).toHaveLength(2)
	})

	it('lists the values a cell with a declared history has held, newest first (#307)', () => {
		const deal: IntrospectedResource = {
			name: 'deal',
			primaryKey: 'id',
			columns: [
				{ name: 'id', type: 'uuid', meta: {} },
				{ name: 'stage', type: 'string', meta: { history: { keep: 5 } } },
				{ name: 'owner', type: 'string', meta: { history: { keep: 5 } } },
				{ name: 'notes', type: 'string', meta: {} },
				{
					name: '_maxstack_history',
					type: 'json',
					meta: {
						label: 'Cell history',
						hidden: true,
						readOnly: true,
						cellHistory: true,
					},
				},
			],
		}
		render(
			<Show
				resource={deal}
				record={{
					id: 'd1',
					stage: 'proposal',
					owner: 'Sam',
					notes: 'n',
					_maxstack_history: {
						stage: [
							{
								value: 'lead',
								by: 'u-rep',
								origin: 'session',
								at: '2026-09-01T10:00:00.000Z',
							},
							{
								value: 'proposal',
								by: 'service:sync',
								origin: 'system',
								source: 'hubspot',
								at: '2026-09-02T10:00:00.000Z',
							},
						],
					},
				}}
			/>,
		)
		const history = document.querySelector('[data-cell-history="stage"]')
		expect(history).not.toBeNull()
		expect(history).toHaveTextContent('History · 2 values')
		const items = history?.querySelectorAll('li') ?? []
		expect([...items].map((li) => li.textContent)).toEqual([
			expect.stringMatching(/^proposal.*synced from hubspot/),
			expect.stringMatching(/^lead.*edited by hand/),
		])
		// Who, exactly, is one hover away rather than on the page.
		expect(screen.getByText(/edited by hand/)).toHaveAttribute('title', 'u-rep')
		// A declared field with nothing kept yet shows no empty history, a field
		// with no declaration shows none at all, and the column itself is hidden.
		expect(document.querySelectorAll('[data-cell-history]')).toHaveLength(1)
		expect(screen.queryByText('Cell history')).not.toBeInTheDocument()
	})
})
