import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReferenceManyField } from './ReferenceManyField.tsx'
import type { IntrospectedResource } from './resource-types.ts'

const comment: IntrospectedResource = {
	name: 'comment',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid' },
		{ name: 'body', type: 'string' },
		{
			name: 'storyId',
			type: 'uuid',
			references: { table: 'story', column: 'id' },
		},
	],
}

describe('ReferenceManyField', () => {
	it('renders the label and the children as an inline list, hiding the back-reference', () => {
		render(
			<ReferenceManyField
				label="Comments"
				reference="storyId"
				resource={comment}
				rows={[
					{ id: 'c1', body: 'First!', storyId: 's1' },
					{ id: 'c2', body: 'Nice', storyId: 's1' },
				]}
			/>,
		)
		expect(
			screen.getByRole('heading', { name: 'Comments' }),
		).toBeInTheDocument()
		expect(screen.getByText('First!')).toBeInTheDocument()
		// The back-reference column is hidden by default (same value every row).
		expect(screen.queryByText('Story Id')).not.toBeInTheDocument()
		expect(screen.queryByText('storyId')).not.toBeInTheDocument()
	})

	it('shows the empty state when a record has no children', () => {
		render(
			<ReferenceManyField
				label="Comments"
				reference="storyId"
				resource={comment}
				rows={[]}
				empty="No comments yet."
			/>,
		)
		expect(screen.getByText('No comments yet.')).toBeInTheDocument()
	})
})
