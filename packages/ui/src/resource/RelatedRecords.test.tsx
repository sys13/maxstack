import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
	type RelatedGroup,
	RelatedRecords,
	relatedColumns,
} from './RelatedRecords.tsx'
import type { IntrospectedResource } from './resource-types.ts'

const comment: IntrospectedResource = {
	name: 'comment',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid' },
		{ name: 'body', type: 'string' },
		{ name: 'rank', type: 'string', meta: { hidden: true } },
		{
			name: 'storyId',
			type: 'uuid',
			references: { table: 'story', column: 'id' },
		},
	],
}

const group = (over: Partial<RelatedGroup> = {}): RelatedGroup => ({
	resource: 'comment',
	label: 'Comment',
	fk: 'storyId',
	introspection: comment,
	rows: [],
	...over,
})

describe('RelatedRecords', () => {
	it('renders a section of the rows that reference this record', () => {
		render(
			<RelatedRecords
				groups={[
					group({
						rows: [
							{ id: 'c1', body: 'First!', storyId: 's1' },
							{ id: 'c2', body: 'Nice', storyId: 's1' },
						],
						count: 2,
					}),
				]}
				title="Related"
			/>,
		)
		expect(screen.getByRole('heading', { name: /Comment/ })).toBeInTheDocument()
		expect(screen.getByText('2 comments')).toBeInTheDocument()
		expect(screen.getByText('First!')).toBeInTheDocument()
		expect(screen.getByText('Nice')).toBeInTheDocument()
		// The back-reference is the same value on every row, and the hidden and
		// primary-key columns are never list material.
		expect(screen.queryByText('Story Id')).not.toBeInTheDocument()
		expect(screen.queryByText('Rank')).not.toBeInTheDocument()
	})

	it('renders the panel with an empty state when a relation has no rows', () => {
		render(<RelatedRecords groups={[group()]} title="Related" />)
		// The section still shows: a declared relation with nothing in it is a
		// fact, not a reason to hide the heading.
		expect(screen.getByText('0 comments')).toBeInTheDocument()
		expect(screen.getByText('No comment records yet.')).toBeInTheDocument()
	})

	it('renders nothing at all when no entity references this record', () => {
		const { container } = render(<RelatedRecords groups={[]} title="Related" />)
		expect(container).toBeEmptyDOMElement()
	})

	it('disambiguates two relations from the same entity by their FK', () => {
		const task: IntrospectedResource = {
			name: 'task',
			primaryKey: 'id',
			columns: [
				{ name: 'id', type: 'uuid' },
				{ name: 'title', type: 'string' },
				{
					name: 'assigneeId',
					type: 'uuid',
					references: { table: 'user', column: 'id' },
				},
				{
					name: 'reporterId',
					type: 'uuid',
					references: { table: 'user', column: 'id' },
				},
			],
		}
		render(
			<RelatedRecords
				groups={[
					group({
						resource: 'task',
						label: 'Task',
						fk: 'assigneeId',
						introspection: task,
					}),
					group({
						resource: 'task',
						label: 'Task',
						fk: 'reporterId',
						introspection: task,
					}),
				]}
			/>,
		)
		expect(screen.getByText(/Task · Assignee Id/)).toBeInTheDocument()
		expect(screen.getByText(/Task · Reporter Id/)).toBeInTheDocument()
	})

	it('links the count and the rows when the route supplies hrefs', () => {
		render(
			<RelatedRecords
				groups={[
					group({ rows: [{ id: 'c1', body: 'First!', storyId: 's1' }] }),
				]}
				listHref={(g) => `/admin/${g.resource}?filter.${g.fk}=s1`}
				rowHref={(g, row) => `/admin/${g.resource}/${String(row.id)}`}
				linkComponent={({ to, children, className }) => (
					<a href={to} className={className}>
						{children}
					</a>
				)}
			/>,
		)
		expect(screen.getByRole('link', { name: '1 comment' })).toHaveAttribute(
			'href',
			'/admin/comment?filter.storyId=s1',
		)
	})
})

describe('relatedColumns', () => {
	it('drops the pk, the back-reference and hidden columns, and caps the rest', () => {
		expect(relatedColumns(group(), 4).columns.map((c) => c.name)).toEqual([
			'body',
		])
		expect(relatedColumns(group(), 0).columns).toEqual([])
	})
})
