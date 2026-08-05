import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReferenceManyToManyField } from './ReferenceManyToManyField.tsx'

describe('ReferenceManyToManyField', () => {
	it('renders the far-side records as chips under a heading', () => {
		render(
			<ReferenceManyToManyField
				label="Tags"
				records={[
					{ id: 't1', name: 'Ecosystem' },
					{ id: 't2', name: 'DX' },
				]}
			/>,
		)
		expect(screen.getByRole('heading', { name: 'Tags' })).toBeInTheDocument()
		expect(screen.getByText('Ecosystem')).toBeInTheDocument()
		expect(screen.getByText('DX')).toBeInTheDocument()
	})

	it('links each chip when given a link component', () => {
		const Link = ({
			to,
			children,
		}: {
			to: string
			children: React.ReactNode
		}) => <a href={to}>{children}</a>
		render(
			<ReferenceManyToManyField
				records={[{ id: 't1', name: 'Ecosystem' }]}
				table="tag"
				linkComponent={Link}
				hrefFor={({ table, id }) => `/admin/${table}/${id}`}
			/>,
		)
		expect(screen.getByRole('link', { name: 'Ecosystem' })).toHaveAttribute(
			'href',
			'/admin/tag/t1',
		)
	})

	it('shows an empty state when there are no related records', () => {
		render(<ReferenceManyToManyField records={[]} empty="No tags." />)
		expect(screen.getByText('No tags.')).toBeInTheDocument()
	})

	it('honors a custom display field', () => {
		render(
			<ReferenceManyToManyField
				records={[{ id: 'u1', email: 'ada@x.dev' }]}
				displayField="email"
			/>,
		)
		expect(screen.getByText('ada@x.dev')).toBeInTheDocument()
	})
})
