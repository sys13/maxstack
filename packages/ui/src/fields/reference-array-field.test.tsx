import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { detectFieldKind, type IntrospectedColumn } from './field-semantics.ts'
import { Field, parseReferenceIds, ReferenceArrayField } from './fields.tsx'
import { ReferenceProvider } from './reference-context.tsx'

const tags: IntrospectedColumn = {
	name: 'tags',
	type: 'json',
	meta: {
		arrayReference: { table: 'tag', column: 'id', displayField: 'name' },
	},
}

const resolution = { tag: { t1: 'Ecosystem', t2: 'DX' } }

describe('parseReferenceIds', () => {
	it('accepts arrays and JSON strings and drops blanks', () => {
		expect(parseReferenceIds(['t1', 't2'])).toEqual(['t1', 't2'])
		expect(parseReferenceIds('["t1","t2"]')).toEqual(['t1', 't2'])
		expect(parseReferenceIds(['t1', null, ''])).toEqual(['t1'])
		expect(parseReferenceIds(null)).toEqual([])
		expect(parseReferenceIds('nope')).toEqual([])
	})
})

describe('detectFieldKind', () => {
	it('classifies an array-reference column as reference-array over its json type', () => {
		expect(detectFieldKind(tags)).toBe('reference-array')
	})
})

describe('ReferenceArrayField', () => {
	it('renders one resolved chip per id from context', () => {
		render(
			<ReferenceProvider value={resolution}>
				<ReferenceArrayField value={['t1', 't2']} column={tags} />
			</ReferenceProvider>,
		)
		expect(screen.getByText('Ecosystem')).toBeInTheDocument()
		expect(screen.getByText('DX')).toBeInTheDocument()
	})

	it('falls back to the raw id for an unresolved reference', () => {
		render(
			<ReferenceProvider value={{ tag: { t1: 'Ecosystem' } }}>
				<ReferenceArrayField value={['t1', 'ghost']} column={tags} />
			</ReferenceProvider>,
		)
		expect(screen.getByText('Ecosystem')).toBeInTheDocument()
		expect(screen.getByText('ghost')).toBeInTheDocument()
	})

	it('renders a dash for an empty array', () => {
		render(<ReferenceArrayField value={[]} column={tags} />)
		expect(screen.getByText('—')).toBeInTheDocument()
	})

	it('is dispatched by <Field> for an array-reference column', () => {
		render(
			<ReferenceProvider value={resolution}>
				<Field value={'["t2"]'} column={tags} />
			</ReferenceProvider>,
		)
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
			<ReferenceProvider value={resolution}>
				<ReferenceArrayField
					value={['t1']}
					column={tags}
					linkComponent={Link}
					hrefFor={({ table, id }) => `/admin/${table}/${id}`}
				/>
			</ReferenceProvider>,
		)
		expect(screen.getByRole('link', { name: 'Ecosystem' })).toHaveAttribute(
			'href',
			'/admin/tag/t1',
		)
	})
})
