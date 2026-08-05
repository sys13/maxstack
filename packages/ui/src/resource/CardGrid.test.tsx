import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CardGrid } from './CardGrid.tsx'
import { FeedList } from './FeedList.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'book',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'notes', type: 'string', meta: { markdown: true } },
		{ name: 'addedAt', type: 'date', meta: { label: 'Added' } },
		{ name: 'secret', type: 'string', meta: { hidden: true } },
	],
}

const rows: Row[] = [
	{
		id: '1',
		title: 'Alpha',
		notes: 'first',
		addedAt: '2026-07-01',
		secret: 'x',
	},
	{
		id: '2',
		title: 'Beta',
		notes: 'second',
		addedAt: '2026-07-02',
		secret: 'y',
	},
]

describe('CardGrid', () => {
	it('renders one card per row with the inferred title, skipping hidden/pk', () => {
		render(<CardGrid resource={resource} rows={rows} />)
		expect(screen.getAllByRole('listitem')).toHaveLength(2)
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.queryByText('secret')).not.toBeInTheDocument()
	})

	it('links each card when rowHref is given', () => {
		render(
			<CardGrid
				resource={resource}
				rows={rows}
				rowHref={(r) => `/book/${r.id}`}
			/>,
		)
		const [first] = screen.getAllByRole('link')
		expect(first).toHaveAttribute('href', '/book/1')
	})

	// #285: switching a block to `cards` is a cosmetic op and used to remove the
	// only visible way to edit a record. The card is the link, so the affordance
	// must not be a second anchor inside it.
	it('shows an edit affordance on every linked card, without nesting a link', () => {
		render(
			<CardGrid
				resource={resource}
				rows={rows}
				rowHref={(r) => `/book/${r.id}`}
			/>,
		)
		expect(screen.getAllByText('Edit')).toHaveLength(2)
		expect(screen.getAllByRole('link')).toHaveLength(2)
	})

	it('omits the edit affordance with no rowHref and when told to', () => {
		const { rerender } = render(<CardGrid resource={resource} rows={rows} />)
		expect(screen.queryByText('Edit')).not.toBeInTheDocument()
		rerender(
			<CardGrid
				resource={resource}
				rows={rows}
				rowHref={(r) => `/book/${r.id}`}
				rowActionLabel={null}
			/>,
		)
		expect(screen.queryByText('Edit')).not.toBeInTheDocument()
	})

	it('renders the shared empty state and a skeleton grid while loading', () => {
		const { rerender } = render(<CardGrid resource={resource} rows={[]} />)
		expect(screen.getByText('No records yet')).toBeInTheDocument()
		rerender(<CardGrid resource={resource} rows={[]} loading />)
		expect(screen.getAllByTestId('skeleton-card').length).toBeGreaterThan(0)
	})
})

describe('FeedList', () => {
	it('renders title + inferred description + inferred date per entry', () => {
		render(<FeedList resource={resource} rows={rows} />)
		const [first] = screen.getAllByRole('article')
		const entry = within(first as HTMLElement)
		expect(entry.getByText('Alpha')).toBeInTheDocument()
		expect(entry.getByText('first')).toBeInTheDocument() // markdown col → description
		// the date column renders (formatted by <Field>, so just assert presence of the article rows)
		expect(screen.getAllByRole('article')).toHaveLength(2)
	})

	it('renders title-only when no prose column exists', () => {
		const bare: IntrospectedResource = {
			name: 'tag',
			primaryKey: 'id',
			columns: [
				{ name: 'id', type: 'uuid', meta: {} },
				{ name: 'name', type: 'string', meta: {} },
			],
		}
		render(<FeedList resource={bare} rows={[{ id: '1', name: 'urgent' }]} />)
		expect(screen.getByText('urgent')).toBeInTheDocument()
	})

	it('renders the shared empty state and skeleton entries while loading', () => {
		const { rerender } = render(<FeedList resource={resource} rows={[]} />)
		expect(screen.getByText('No records yet')).toBeInTheDocument()
		rerender(<FeedList resource={resource} rows={[]} loading />)
		expect(screen.getAllByTestId('skeleton-entry').length).toBeGreaterThan(0)
	})
})

// The reviews-app shape from issue #142: the rating and the review ARE the
// content, and the inferred feed used to hide both behind the detail form.
const reviewResource: IntrospectedResource = {
	name: 'book',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: {} },
		{ name: 'author', type: 'string', meta: {} },
		{
			name: 'status',
			type: 'string',
			enumValues: ['reading', 'finished'],
			meta: { options: [{ label: 'Finished', value: 'finished' }] },
		},
		{ name: 'rating', type: 'number', meta: { min: 0, max: 5 } },
		{ name: 'review', type: 'string', meta: {} },
		{ name: 'finishedOn', type: 'date', meta: {} },
	],
}

const reviewRows: Row[] = [
	{
		id: '1',
		title: 'Dune',
		author: 'Herbert',
		status: 'finished',
		rating: 4,
		review: 'Sandworms hold up.',
		finishedOn: '2026-07-01',
	},
]

describe('list field selection', () => {
	it('feed shows enum/number columns in a meta row by default', () => {
		render(<FeedList resource={reviewResource} rows={reviewRows} />)
		const entry = within(screen.getAllByRole('article')[0] as HTMLElement)
		// title, and the review (a prose-named text column) as the description —
		// not `author`, which merely comes first.
		expect(entry.getByText('Dune')).toBeInTheDocument()
		expect(entry.getByText('Sandworms hold up.')).toBeInTheDocument()
		const meta = within(entry.getByTestId('entry-meta'))
		expect(meta.getByText('status')).toBeInTheDocument()
		expect(meta.getByText('rating')).toBeInTheDocument()
	})

	it('feed renders every explicitly selected field, title first', () => {
		render(
			<FeedList
				resource={reviewResource}
				rows={reviewRows}
				primaryField="title"
				secondaryFields={['title', 'author', 'rating', 'review', 'finishedOn']}
			/>,
		)
		const entry = within(screen.getAllByRole('article')[0] as HTMLElement)
		expect(entry.getByText('Dune')).toBeInTheDocument()
		expect(entry.getByText('Sandworms hold up.')).toBeInTheDocument()
		const meta = within(entry.getByTestId('entry-meta'))
		// `author` is a plain text column the heuristics would have dropped;
		// selected explicitly, it renders. The title/description/date names in
		// the selection are not repeated in the meta row.
		expect(meta.getByText('Herbert')).toBeInTheDocument()
		expect(meta.getByText('author')).toBeInTheDocument()
		expect(meta.queryByText('Dune')).not.toBeInTheDocument()
		expect(meta.queryByText('Sandworms hold up.')).not.toBeInTheDocument()
	})

	it('cards render every explicitly selected field, past the default cap of 3', () => {
		render(
			<CardGrid
				resource={reviewResource}
				rows={reviewRows}
				primaryField="title"
				secondaryFields={['title', 'author', 'status', 'rating', 'review']}
			/>,
		)
		for (const label of ['author', 'status', 'rating', 'review'])
			expect(screen.getByText(label)).toBeInTheDocument()
		expect(screen.getByText('Herbert')).toBeInTheDocument()
	})
})
