import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReferenceManyCount } from './ReferenceManyCount.tsx'

describe('ReferenceManyCount', () => {
	it('pluralizes the noun by count', () => {
		const { rerender } = render(
			<ReferenceManyCount count={1} label="comment" />,
		)
		expect(screen.getByText('1 comment')).toBeInTheDocument()
		rerender(<ReferenceManyCount count={3} label="comment" />)
		expect(screen.getByText('3 comments')).toBeInTheDocument()
	})

	it('honors an irregular plural override', () => {
		render(<ReferenceManyCount count={2} label="person" pluralLabel="people" />)
		expect(screen.getByText('2 people')).toBeInTheDocument()
	})

	it('shows the bare number with no label', () => {
		render(<ReferenceManyCount count={7} />)
		expect(screen.getByText('7')).toBeInTheDocument()
	})

	it('links to the filtered child list when given a link component', () => {
		const Link = ({
			to,
			children,
		}: {
			to: string
			children: React.ReactNode
		}) => <a href={to}>{children}</a>
		render(
			<ReferenceManyCount
				count={5}
				label="comment"
				linkComponent={Link}
				to="/admin/comment?filter.articleId=a1"
			/>,
		)
		expect(screen.getByRole('link', { name: '5 comments' })).toHaveAttribute(
			'href',
			'/admin/comment?filter.articleId=a1',
		)
	})
})
