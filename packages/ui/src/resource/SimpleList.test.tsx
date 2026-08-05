import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { IntrospectedResource, Row } from './resource-types.ts'
import { SimpleList } from './SimpleList.tsx'

const resource: IntrospectedResource = {
	name: 'post',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'points', type: 'number', meta: {} },
		{ name: 'secret', type: 'string', meta: { hidden: true } },
	],
}

const rows: Row[] = [
	{ id: '1', title: 'Alpha', points: 10, secret: 's1' },
	{ id: '2', title: 'Beta', points: 30, secret: 's2' },
]

describe('SimpleList', () => {
	it('renders one card per row with the inferred title', () => {
		render(<SimpleList resource={resource} rows={rows} />)
		expect(screen.getAllByRole('listitem')).toHaveLength(2)
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()
	})

	it('shows secondary fields as labeled lines and skips hidden/pk', () => {
		render(<SimpleList resource={resource} rows={rows} />)
		const [firstCard] = screen.getAllByRole('listitem')
		const card = within(firstCard as HTMLElement)
		expect(card.getByText('points')).toBeInTheDocument()
		expect(card.getByText('10')).toBeInTheDocument()
		expect(screen.queryByText('secret')).not.toBeInTheDocument()
	})

	it('links each card when rowHref is given', () => {
		render(
			<SimpleList
				resource={resource}
				rows={rows}
				rowHref={(r) => `/post/${r.id}`}
			/>,
		)
		const [firstLink] = screen.getAllByRole('link')
		expect(firstLink).toHaveAttribute('href', '/post/1')
	})

	it('renders an empty state', () => {
		render(<SimpleList resource={resource} rows={[]} />)
		expect(screen.getByText('No records yet.')).toBeInTheDocument()
	})
})
