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
})
