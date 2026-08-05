import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FormReferenceArrayInput } from './form-fields.tsx'

const options = [
	{ label: 'Ecosystem', value: 't1' },
	{ label: 'DX', value: 't2' },
	{ label: 'Internals', value: 't3' },
]

/** The hidden ids the form would submit for field `tags`. */
function submittedIds(container: HTMLElement): string[] {
	return [
		...container.querySelectorAll('input[type="hidden"][name="tags"]'),
	].map((el) => (el as HTMLInputElement).value)
}

describe('FormReferenceArrayInput', () => {
	it('renders default selections as chips and submits them as repeated inputs', () => {
		const { container } = render(
			<FormReferenceArrayInput
				name="tags"
				options={options}
				defaultValue={['t1', 't2']}
			/>,
		)
		expect(screen.getByText('Ecosystem')).toBeInTheDocument()
		expect(screen.getByText('DX')).toBeInTheDocument()
		expect(submittedIds(container)).toEqual(['t1', 't2'])
	})

	it('adds a reference from the dropdown', () => {
		const { container } = render(
			<FormReferenceArrayInput name="tags" options={options} />,
		)
		fireEvent.focus(screen.getByRole('combobox'))
		fireEvent.click(screen.getByRole('option', { name: 'Internals' }))
		expect(submittedIds(container)).toEqual(['t3'])
	})

	it('removes a selected reference', () => {
		const { container } = render(
			<FormReferenceArrayInput
				name="tags"
				options={options}
				defaultValue={['t1', 't2']}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Remove Ecosystem' }))
		expect(submittedIds(container)).toEqual(['t2'])
	})

	it('does not offer an already-selected option', () => {
		render(
			<FormReferenceArrayInput
				name="tags"
				options={options}
				defaultValue={['t1']}
			/>,
		)
		fireEvent.focus(screen.getByRole('combobox'))
		const listbox = screen.getByRole('listbox')
		expect(
			within(listbox).queryByRole('option', { name: 'Ecosystem' }),
		).not.toBeInTheDocument()
		expect(
			within(listbox).getByRole('option', { name: 'DX' }),
		).toBeInTheDocument()
	})

	it('filters options by the typed query', () => {
		render(<FormReferenceArrayInput name="tags" options={options} />)
		const box = screen.getByRole('combobox')
		fireEvent.focus(box)
		fireEvent.change(box, { target: { value: 'inter' } })
		const listbox = screen.getByRole('listbox')
		expect(
			within(listbox).getByRole('option', { name: 'Internals' }),
		).toBeInTheDocument()
		expect(
			within(listbox).queryByRole('option', { name: 'DX' }),
		).not.toBeInTheDocument()
	})
})
