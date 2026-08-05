import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DynamicForm, type FormSection } from './DynamicForm.tsx'
import { byLabel } from './test-support/label-query.ts'

const personSchema = z.object({
	firstName: z.string().min(1),
	lastName: z.string().min(1),
	street: z.string().optional(),
	city: z.string().optional(),
})

const sections: FormSection[] = [
	{ title: 'Identity', fields: ['firstName', 'lastName'] },
	{ title: 'Address', fields: ['street', 'city'] },
]

describe('DynamicForm — sections', () => {
	it('renders panels with a legend per section', () => {
		render(
			<DynamicForm
				schema={personSchema}
				sections={sections}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByText('Identity')).toBeInTheDocument()
		expect(screen.getByText('Address')).toBeInTheDocument()
		expect(screen.getByLabelText(byLabel('firstName'))).toBeInTheDocument()
		expect(screen.getByLabelText(byLabel('city'))).toBeInTheDocument()
	})

	it('tabs show only the active section and switch on click', () => {
		render(
			<DynamicForm
				schema={personSchema}
				sections={sections}
				sectionVariant="tabs"
				onSubmit={vi.fn()}
			/>,
		)
		// First tab active → identity fields shown, address hidden.
		expect(screen.getByLabelText(byLabel('firstName'))).toBeInTheDocument()
		expect(screen.queryByLabelText(byLabel('city'))).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole('tab', { name: 'Address' }))
		expect(screen.getByLabelText(byLabel('city'))).toBeInTheDocument()
		expect(
			screen.queryByLabelText(byLabel('firstName')),
		).not.toBeInTheDocument()
	})

	it('accordion renders a disclosure per section', () => {
		const { container } = render(
			<DynamicForm
				schema={personSchema}
				sections={sections}
				sectionVariant="accordion"
				onSubmit={vi.fn()}
			/>,
		)
		expect(container.querySelectorAll('details')).toHaveLength(2)
	})

	it('appends fields named by no section so nothing is dropped', () => {
		render(
			<DynamicForm
				schema={personSchema}
				sections={[{ title: 'Identity', fields: ['firstName', 'lastName'] }]}
				onSubmit={vi.fn()}
			/>,
		)
		// street/city belong to no section → folded into the last one, still rendered.
		expect(screen.getByLabelText(byLabel('street'))).toBeInTheDocument()
	})
})

describe('DynamicForm — wizard', () => {
	it('shows a progress affordance and one step at a time', () => {
		render(
			<DynamicForm
				schema={personSchema}
				sections={sections}
				wizard
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
		expect(screen.getByLabelText(byLabel('firstName'))).toBeVisible()
		// Later steps stay mounted (values persist) but hidden until reached.
		expect(screen.getByLabelText(byLabel('city'))).not.toBeVisible()
	})

	it('blocks Next while the current step is invalid', () => {
		render(
			<DynamicForm
				schema={personSchema}
				sections={sections}
				wizard
				onSubmit={vi.fn()}
			/>,
		)
		// firstName/lastName are required and empty → Next should not advance.
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
		expect(screen.getByLabelText(byLabel('city'))).not.toBeVisible()
	})

	it('advances when the step is valid and returns on Back', () => {
		render(
			<DynamicForm
				schema={personSchema}
				sections={sections}
				wizard
				onSubmit={vi.fn()}
			/>,
		)
		fireEvent.input(screen.getByLabelText(byLabel('firstName')), {
			target: { value: 'Ada' },
		})
		fireEvent.input(screen.getByLabelText(byLabel('lastName')), {
			target: { value: 'Lovelace' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getByText('Step 2 of 2')).toBeInTheDocument()
		expect(screen.getByLabelText(byLabel('city'))).toBeVisible()
		fireEvent.click(screen.getByRole('button', { name: 'Back' }))
		expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
	})

	it('submits from the final step', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={personSchema}
				sections={sections}
				wizard
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.input(screen.getByLabelText(byLabel('firstName')), {
			target: { value: 'Ada' },
		})
		fireEvent.input(screen.getByLabelText(byLabel('lastName')), {
			target: { value: 'Lovelace' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ firstName: 'Ada', lastName: 'Lovelace' }),
		)
	})
})

describe('DynamicForm — conditional fields', () => {
	const schema = z.object({
		status: z.string(),
		reason: z.string().optional(),
	})

	it('hides a field until its predicate is met', () => {
		render(
			<DynamicForm
				schema={schema}
				conditions={[
					{ field: 'reason', visible: (v) => v.status === 'rejected' },
				]}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.queryByLabelText(byLabel('reason'))).not.toBeInTheDocument()
		fireEvent.input(screen.getByLabelText(byLabel('status')), {
			target: { value: 'rejected' },
		})
		expect(screen.getByLabelText(byLabel('reason'))).toBeInTheDocument()
	})

	it('enforces conditional-required at submit', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={schema}
				conditions={[
					{ field: 'reason', visible: (v) => v.status === 'rejected' },
					{ field: 'reason', required: (v) => v.status === 'rejected' },
				]}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.input(screen.getByLabelText(byLabel('status')), {
			target: { value: 'rejected' },
		})
		// reason shown but empty → submit blocked.
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.input(screen.getByLabelText(byLabel('reason')), {
			target: { value: 'spam' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).toHaveBeenCalledWith({
			status: 'rejected',
			reason: 'spam',
		})
	})

	it('does not require the field when hidden', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={schema}
				conditions={[
					{ field: 'reason', visible: (v) => v.status === 'rejected' },
					{ field: 'reason', required: (v) => v.status === 'rejected' },
				]}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.input(screen.getByLabelText(byLabel('status')), {
			target: { value: 'approved' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).toHaveBeenCalledWith({ status: 'approved' })
	})
})

describe('DynamicForm — server errors', () => {
	it('shows a server field error and clears it on edit', () => {
		const { rerender } = render(
			<DynamicForm
				schema={z.object({ email: z.string() })}
				serverErrors={{ email: ['Already taken'] }}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByText('Already taken')).toBeInTheDocument()
		fireEvent.input(screen.getByLabelText(byLabel('email')), {
			target: { value: 'new@x.com' },
		})
		expect(screen.queryByText('Already taken')).not.toBeInTheDocument()
		// A fresh serverErrors object (new submit) resurfaces errors.
		rerender(
			<DynamicForm
				schema={z.object({ email: z.string() })}
				serverErrors={{ email: ['Still taken'] }}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByText('Still taken')).toBeInTheDocument()
	})
})

describe('DynamicForm — conveniences', () => {
	it('applies transform before onSubmit', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ name: z.string().min(1) })}
				transform={(d) => ({
					...d,
					slug: (d as { name: string }).name.toLowerCase(),
				})}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.input(screen.getByLabelText(byLabel('name')), {
			target: { value: 'Ada' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada', slug: 'ada' })
	})

	it('save-and-add-another submits then resets the form', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ name: z.string().min(1) })}
				saveAndAddAnother
				onSubmit={onSubmit}
			/>,
		)
		const input = screen.getByLabelText(byLabel('name')) as HTMLInputElement
		fireEvent.input(input, { target: { value: 'Ada' } })
		fireEvent.click(
			screen.getByRole('button', { name: 'Save and add another' }),
		)
		expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada' })
		expect(
			(screen.getByLabelText(byLabel('name')) as HTMLInputElement).value,
		).toBe('')
	})

	it('autosaves a draft and restores it on remount', () => {
		const map = new Map<string, string>()
		const storage = {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
			removeItem: (k: string) => void map.delete(k),
		}
		const { unmount } = render(
			<DynamicForm
				schema={z.object({ title: z.string() })}
				autosaveKey="draft:post"
				draftStorage={storage}
				onSubmit={vi.fn()}
			/>,
		)
		fireEvent.input(screen.getByLabelText(byLabel('title')), {
			target: { value: 'Half-written' },
		})
		expect(map.get('draft:post')).toBeTruthy()
		unmount()
		render(
			<DynamicForm
				schema={z.object({ title: z.string() })}
				autosaveKey="draft:post"
				draftStorage={storage}
				onSubmit={vi.fn()}
			/>,
		)
		expect(
			(screen.getByLabelText(byLabel('title')) as HTMLInputElement).value,
		).toBe('Half-written')
	})
})

describe('DynamicForm — exit criterion (wizard + nested array + conditional + dirty guard)', () => {
	const orderSchema = z.object({
		title: z.string().min(1),
		hasDiscount: z.string(),
		discountCode: z.string().optional(),
		lineItems: z.array(z.object({ sku: z.string().min(1), qty: z.number() })),
	})
	const orderSections: FormSection[] = [
		{ title: 'Order', fields: ['title', 'hasDiscount', 'discountCode'] },
		{ title: 'Line items', fields: ['lineItems'] },
	]
	const orderConditions = [
		{
			field: 'discountCode',
			visible: (v: Record<string, unknown>) => v.hasDiscount === 'yes',
			required: (v: Record<string, unknown>) => v.hasDiscount === 'yes',
		},
	]

	it('edits a nested child array + conditional field across a wizard, warning when dirty', () => {
		const onSubmit = vi.fn()
		const addUnload = vi.spyOn(window, 'addEventListener')
		render(
			<DynamicForm
				schema={orderSchema}
				sections={orderSections}
				conditions={orderConditions}
				wizard
				dirtyGuard
				onSubmit={onSubmit}
			/>,
		)

		// Step 1: discountCode hidden until hasDiscount === 'yes'.
		expect(
			screen.queryByLabelText(byLabel('discountCode')),
		).not.toBeInTheDocument()
		fireEvent.input(screen.getByLabelText(byLabel('title')), {
			target: { value: 'Winter sale' },
		})
		fireEvent.input(screen.getByLabelText(byLabel('hasDiscount')), {
			target: { value: 'yes' },
		})
		expect(screen.getByLabelText(byLabel('discountCode'))).toBeInTheDocument()

		// Dirty now → the unsaved-navigation guard is installed.
		expect(addUnload).toHaveBeenCalledWith('beforeunload', expect.any(Function))

		// Conditional-required: can't advance with the code empty.
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
		fireEvent.input(screen.getByLabelText(byLabel('discountCode')), {
			target: { value: 'WINTER' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getByText('Step 2 of 2')).toBeInTheDocument()

		// Step 2: add a nested child row and fill it.
		fireEvent.click(screen.getByRole('button', { name: /add line items/i }))
		fireEvent.input(screen.getByLabelText(byLabel('sku')), {
			target: { value: 'ABC' },
		})
		fireEvent.input(screen.getByLabelText(byLabel('qty')), {
			target: { value: '2' },
		})

		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).toHaveBeenCalledWith({
			title: 'Winter sale',
			hasDiscount: 'yes',
			discountCode: 'WINTER',
			lineItems: [{ sku: 'ABC', qty: 2 }],
		})
	})
})

describe('DynamicForm — array reorder', () => {
	it('renders move/remove controls per row', () => {
		render(
			<DynamicForm
				schema={z.object({ tags: z.array(z.string()) })}
				defaultValues={{ tags: ['a', 'b'] }}
				onSubmit={vi.fn()}
			/>,
		)
		expect(
			screen.getByRole('button', { name: /move tags 1 down/i }),
		).toBeInTheDocument()
		// First row can't move up; last can't move down.
		expect(
			(
				screen.getByRole('button', {
					name: /move tags 1 up/i,
				}) as HTMLButtonElement
			).disabled,
		).toBe(true)
		expect(
			(
				screen.getByRole('button', {
					name: /move tags 2 down/i,
				}) as HTMLButtonElement
			).disabled,
		).toBe(true)
	})
})
