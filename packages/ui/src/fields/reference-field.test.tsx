import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { IntrospectedColumn } from './field-semantics.ts'
import { Field, ReferenceField } from './fields.tsx'
import { ReferenceProvider } from './reference-context.tsx'

const authorId: IntrospectedColumn = {
	name: 'authorId',
	type: 'uuid',
	references: { table: 'author', column: 'id', displayField: 'name' },
}

describe('ReferenceField', () => {
	it('resolves the FK to the referenced display value from context', () => {
		render(
			<ReferenceProvider value={{ author: { a1: 'Ada Lovelace' } }}>
				<ReferenceField value="a1" column={authorId} />
			</ReferenceProvider>,
		)
		expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
	})

	it('falls back to the raw id when unresolved', () => {
		render(
			<ReferenceProvider value={{ author: {} }}>
				<ReferenceField value="ghost" column={authorId} />
			</ReferenceProvider>,
		)
		expect(screen.getByText('ghost')).toBeInTheDocument()
	})

	it('renders a dash for an empty value', () => {
		render(<ReferenceField value={null} column={authorId} />)
		expect(screen.getByText('—')).toBeInTheDocument()
	})

	it('is dispatched by <Field> for a reference column', () => {
		render(
			<ReferenceProvider value={{ author: { a1: 'Grace Hopper' } }}>
				<Field value="a1" column={authorId} />
			</ReferenceProvider>,
		)
		expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
	})

	it('links to the referenced record when given a link component', () => {
		const Link = ({
			to,
			children,
		}: {
			to: string
			children: React.ReactNode
		}) => <a href={to}>{children}</a>
		render(
			<ReferenceProvider value={{ author: { a1: 'Ada' } }}>
				<ReferenceField
					value="a1"
					column={authorId}
					linkComponent={Link}
					hrefFor={({ table, id }) => `/admin/${table}/${id}`}
				/>
			</ReferenceProvider>,
		)
		const link = screen.getByRole('link', { name: 'Ada' })
		expect(link).toHaveAttribute('href', '/admin/author/a1')
	})
})
