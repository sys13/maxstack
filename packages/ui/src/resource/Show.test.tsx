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
})
