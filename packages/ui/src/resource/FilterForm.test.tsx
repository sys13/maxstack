import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FilterForm } from './FilterForm.tsx'
import { EMPTY_FILTERS, type FilterValues } from './filterable.ts'
import type { IntrospectedResource } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'task',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{
			name: 'priority',
			type: 'enum',
			meta: {
				label: 'Priority',
				options: [
					{ label: 'Low', value: 'low' },
					{ label: 'High', value: 'high' },
				],
			},
		},
		{
			name: 'authorId',
			type: 'uuid',
			references: { table: 'author', column: 'id' },
			meta: { label: 'Author' },
		},
		{ name: 'estimate', type: 'number', meta: { label: 'Estimate' } },
	],
}

const authorOptions = [
	{ label: 'Ada', value: 'a1' },
	{ label: 'Babbage', value: 'a2' },
]

describe('FilterForm', () => {
	it('renders a search box and one dropdown per facet', () => {
		render(
			<FilterForm
				resource={resource}
				value={EMPTY_FILTERS}
				onChange={() => {}}
				referenceOptions={{ authorId: authorOptions }}
			/>,
		)
		expect(screen.getByRole('searchbox')).toBeInTheDocument()
		expect(screen.getByLabelText('Priority')).toBeInTheDocument()
		const author = screen.getByLabelText('Author') as HTMLSelectElement
		expect(within(author).queryByText('Ada')).toBeTruthy()
	})

	it('emits filter changes when a facet is selected', () => {
		const onChange = vi.fn()
		render(
			<FilterForm
				resource={resource}
				value={EMPTY_FILTERS}
				onChange={onChange}
			/>,
		)
		fireEvent.change(screen.getByLabelText('Priority'), {
			target: { value: 'high' },
		})
		expect(onChange).toHaveBeenCalledWith({ filter: { priority: 'high' } })
	})

	it('clearing a facet removes its key', () => {
		const onChange = vi.fn()
		const value: FilterValues = { filter: { priority: 'high' } }
		render(<FilterForm resource={resource} value={value} onChange={onChange} />)
		fireEvent.change(screen.getByLabelText('Priority'), {
			target: { value: '' },
		})
		expect(onChange).toHaveBeenCalledWith({ filter: {} })
	})

	it('emits search text', () => {
		const onChange = vi.fn()
		render(
			<FilterForm
				resource={resource}
				value={EMPTY_FILTERS}
				onChange={onChange}
			/>,
		)
		fireEvent.change(screen.getByRole('searchbox'), {
			target: { value: 'ada' },
		})
		expect(onChange).toHaveBeenCalledWith({ search: 'ada', filter: {} })
	})

	it('shows a Clear button only when filters are active, and it resets', () => {
		const onChange = vi.fn()
		const { rerender } = render(
			<FilterForm
				resource={resource}
				value={EMPTY_FILTERS}
				onChange={onChange}
			/>,
		)
		expect(screen.queryByText(/Clear/)).toBeNull()
		rerender(
			<FilterForm
				resource={resource}
				value={{ filter: { priority: 'high' } }}
				onChange={onChange}
			/>,
		)
		fireEvent.click(screen.getByText(/Clear/))
		expect(onChange).toHaveBeenCalledWith({ filter: {} })
	})

	it('renders a min/max pair for a numeric range facet and emits a bound', () => {
		const onChange = vi.fn()
		render(
			<FilterForm
				resource={resource}
				value={EMPTY_FILTERS}
				onChange={onChange}
			/>,
		)
		const min = screen.getByLabelText('Estimate minimum') as HTMLInputElement
		const max = screen.getByLabelText('Estimate maximum') as HTMLInputElement
		expect(min.type).toBe('number')
		expect(max.type).toBe('number')
		fireEvent.change(min, { target: { value: '5' } })
		expect(onChange).toHaveBeenCalledWith({
			filter: {},
			range: { estimate: { gte: '5' } },
		})
	})

	it('clearing one range bound keeps the other, and the last drops the column', () => {
		const onChange = vi.fn()
		const value: FilterValues = {
			filter: {},
			range: { estimate: { gte: '5', lte: '20' } },
		}
		const { rerender } = render(
			<FilterForm resource={resource} value={value} onChange={onChange} />,
		)
		fireEvent.change(screen.getByLabelText('Estimate minimum'), {
			target: { value: '' },
		})
		expect(onChange).toHaveBeenCalledWith({
			filter: {},
			range: { estimate: { lte: '20' } },
		})
		onChange.mockClear()
		rerender(
			<FilterForm
				resource={resource}
				value={{ filter: {}, range: { estimate: { lte: '20' } } }}
				onChange={onChange}
			/>,
		)
		fireEvent.change(screen.getByLabelText('Estimate maximum'), {
			target: { value: '' },
		})
		expect(onChange).toHaveBeenCalledWith({ filter: {}, range: {} })
	})

	it('disables a reference facet with no options supplied', () => {
		render(
			<FilterForm
				resource={resource}
				value={EMPTY_FILTERS}
				onChange={() => {}}
			/>,
		)
		expect(screen.getByLabelText('Author')).toBeDisabled()
	})
})
