import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { IntrospectedResource, Row } from './resource-types.ts'
import { detectParentField, TreeList } from './TreeList.tsx'

const resource: IntrospectedResource = {
	name: 'category',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'name', type: 'string', meta: {} },
		{
			name: 'parent_id',
			type: 'uuid',
			nullable: true,
			references: { table: 'category', column: 'id' },
		},
	],
}

const rows: Row[] = [
	{ id: '1', name: 'Root', parent_id: null },
	{ id: '2', name: 'Child', parent_id: '1' },
	{ id: '3', name: 'Grandchild', parent_id: '2' },
]

describe('TreeList', () => {
	it('detects the self-referencing parent column', () => {
		expect(detectParentField(resource)).toBe('parent_id')
	})

	it('renders the whole tree expanded by default', () => {
		render(<TreeList resource={resource} rows={rows} />)
		expect(screen.getByText('Root')).toBeInTheDocument()
		expect(screen.getByText('Child')).toBeInTheDocument()
		expect(screen.getByText('Grandchild')).toBeInTheDocument()
	})

	it('collapses and expands a subtree', () => {
		render(<TreeList resource={resource} rows={rows} />)
		// Root and Child both have children → two collapse controls.
		const [rootCollapse] = screen.getAllByRole('button', { name: 'Collapse' })
		fireEvent.click(rootCollapse as HTMLElement) // collapse Root
		expect(screen.queryByText('Child')).not.toBeInTheDocument()
		expect(screen.queryByText('Grandchild')).not.toBeInTheDocument()
		const expand = screen.getByRole('button', { name: 'Expand' })
		fireEvent.click(expand)
		expect(screen.getByText('Child')).toBeInTheDocument()
	})

	it('indents rows by depth', () => {
		const { container } = render(<TreeList resource={resource} rows={rows} />)
		const depths = [...container.querySelectorAll('tr[data-depth]')].map((r) =>
			r.getAttribute('data-depth'),
		)
		expect(depths).toEqual(['0', '1', '2'])
	})
})
