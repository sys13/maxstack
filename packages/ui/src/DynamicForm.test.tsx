import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DynamicForm } from './DynamicForm.tsx'
import { byLabel } from './test-support/label-query.ts'

describe('DynamicForm — rendering', () => {
	it('renders a labelled native input per scalar field', () => {
		render(
			<DynamicForm
				schema={z.object({ firstName: z.string(), age: z.number() })}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByText(byLabel('firstName'))).toBeInTheDocument()
		expect(screen.getByText(byLabel('age'))).toBeInTheDocument()
		// age is a number input
		const age = screen.getByLabelText(byLabel('age')) as HTMLInputElement
		expect(age.type).toBe('number')
	})

	it('applies auto-detected input types (email/url/date)', () => {
		render(
			<DynamicForm
				schema={z.object({ email: z.email(), site: z.url(), born: z.date() })}
				onSubmit={vi.fn()}
			/>,
		)
		expect(
			(screen.getByLabelText(byLabel('email')) as HTMLInputElement).type,
		).toBe('email')
		expect(
			(screen.getByLabelText(byLabel('site')) as HTMLInputElement).type,
		).toBe('url')
		// A `z.date()` still auto-detects to a date control — but since issue #139
		// that control is `<DateInput>`, not a native `type="date"`. The native one
		// cannot be typed into: Chrome's year segment takes six digits and swallows
		// `-`, so `2026-07-10` lands as `202607-10-dd`.
		//
		// This asserts the *behaviour* the old `type === 'date'` check stood in for,
		// and asserts more than it did: the field is labelled, and the date a person
		// types actually arrives.
		const born = screen.getByLabelText(byLabel('born')) as HTMLInputElement
		expect(born.placeholder).toBe('YYYY-MM-DD')
		fireEvent.change(born, { target: { value: '2026-07-10' } })
		expect(born.value).toBe('2026-07-10')
	})

	it('renders OPTIONAL and NULLABLE fields (the original silently dropped them)', () => {
		render(
			<DynamicForm
				schema={z.object({
					required: z.string(),
					maybe: z.string().optional(),
					oranull: z.string().nullable(),
				})}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByLabelText(byLabel('required'))).toBeInTheDocument()
		expect(screen.getByLabelText(byLabel('maybe'))).toBeInTheDocument()
		expect(screen.getByLabelText(byLabel('oranull'))).toBeInTheDocument()
	})

	it('marks required fields with an asterisk, not optional ones', () => {
		render(
			<DynamicForm
				schema={z.object({ req: z.string(), opt: z.string().optional() })}
				onSubmit={vi.fn()}
			/>,
		)
		// The required field's label wrapper carries the "*" (a sibling of the
		// <label>, so it stays out of the accessible name).
		const reqWrapper = screen.getByText(byLabel('req')).parentElement
		expect(reqWrapper?.textContent).toContain('*')
		const optWrapper = screen.getByText(byLabel('opt')).parentElement
		expect(optWrapper?.textContent).not.toContain('*')
	})

	it('renders a Base UI checkbox for booleans', () => {
		render(
			<DynamicForm
				schema={z.object({ subscribe: z.boolean() })}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByRole('checkbox')).toBeInTheDocument()
	})

	it('renders a select trigger for enums', () => {
		const { container } = render(
			<DynamicForm
				schema={z.object({ role: z.enum(['admin', 'user']) })}
				onSubmit={vi.fn()}
			/>,
		)
		// Base UI Select renders a hidden input carrying the field name.
		expect(container.querySelector('[name="role"]')).toBeInTheDocument()
		// The trigger shows the default (first) option.
		expect(screen.getByText('admin')).toBeInTheDocument()
	})

	it('renders a checkbox per option for array(enum) multi-selects', () => {
		render(
			<DynamicForm
				schema={z.object({ tags: z.array(z.enum(['a', 'b', 'c'])) })}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getAllByRole('checkbox')).toHaveLength(3)
	})

	it('renders nested objects as a fieldset with dotted-name inputs', () => {
		const { container } = render(
			<DynamicForm
				schema={z.object({
					address: z.object({ street: z.string(), city: z.string() }),
				})}
				onSubmit={vi.fn()}
			/>,
		)
		const group = screen.getByRole('group', { name: /address/i })
		expect(group).toBeInTheDocument()
		expect(
			container.querySelector('[name="address.street"]'),
		).toBeInTheDocument()
		expect(container.querySelector('[name="address.city"]')).toBeInTheDocument()
	})

	it('renders a repeater with an Add button for general arrays', () => {
		render(
			<DynamicForm
				schema={z.object({ aliases: z.array(z.string()) })}
				onSubmit={vi.fn()}
			/>,
		)
		expect(
			screen.getByRole('button', { name: /add aliases/i }),
		).toBeInTheDocument()
	})

	it('renders a branch selector for unions', () => {
		render(
			<DynamicForm
				schema={z.object({
					payment: z.union([
						z.object({ card: z.string() }),
						z.object({ iban: z.string() }),
					]),
				})}
				onSubmit={vi.fn()}
			/>,
		)
		const group = screen.getByRole('group', { name: /payment/i })
		expect(within(group).getByRole('combobox')).toBeInTheDocument()
	})

	it('honors uiOptions.inputType (textarea override) and helpText', () => {
		const { container } = render(
			<DynamicForm
				schema={z.object({ bio: z.string() })}
				uiOptions={{ bio: { inputType: 'textarea', helpText: 'Tell us more' } }}
				onSubmit={vi.fn()}
			/>,
		)
		expect(container.querySelector('textarea')).toBeInTheDocument()
		expect(screen.getByText('Tell us more')).toBeInTheDocument()
	})
})

describe('DynamicForm — submit + validation', () => {
	it('calls onSubmit with parsed, coerced values on valid submit', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ name: z.string().min(1), age: z.number() })}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.input(screen.getByLabelText(byLabel('name')), {
			target: { value: 'Ada' },
		})
		fireEvent.input(screen.getByLabelText(byLabel('age')), {
			target: { value: '42' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada', age: 42 })
	})

	it('renders a reference picker and submits the chosen id, not the label', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ title: z.string().min(1), authorId: z.string() })}
				uiOptions={{
					authorId: {
						inputType: 'reference',
						referenceOptions: [
							{ label: 'Ada Lovelace', value: 'a1' },
							{ label: 'Grace Hopper', value: 'g2' },
						],
					},
				}}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.input(screen.getByLabelText(byLabel('title')), {
			target: { value: 'Hello' },
		})
		// Open the combobox, type to filter, pick the option.
		const combo = screen.getByRole('combobox')
		fireEvent.focus(combo)
		fireEvent.change(combo, { target: { value: 'Grace' } })
		fireEvent.click(screen.getByRole('option', { name: 'Grace Hopper' }))
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

		expect(onSubmit).toHaveBeenCalledWith({ title: 'Hello', authorId: 'g2' })
	})

	it('auto-detects a FK column as a reference picker from columns alone', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ authorId: z.string() })}
				// No inputType override — `column.references` alone must select the
				// picker; the route only supplies the option list.
				columns={[
					{
						name: 'authorId',
						type: 'uuid',
						references: { table: 'author', column: 'id' },
						meta: {},
					},
				]}
				uiOptions={{
					authorId: {
						referenceOptions: [
							{ label: 'Ada Lovelace', value: 'a1' },
							{ label: 'Grace Hopper', value: 'g2' },
						],
					},
				}}
				onSubmit={onSubmit}
			/>,
		)
		const combo = screen.getByRole('combobox')
		fireEvent.focus(combo)
		fireEvent.change(combo, { target: { value: 'Ada' } })
		fireEvent.click(screen.getByRole('option', { name: 'Ada Lovelace' }))
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).toHaveBeenCalledWith({ authorId: 'a1' })
	})

	it('labels enum options from column meta.options, submitting raw values', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ status: z.enum(['want-next', 'owned']) })}
				columns={[
					{
						name: 'status',
						type: 'enum',
						enumValues: ['want-next', 'owned'],
						meta: {
							options: [
								{ label: 'Want next', value: 'want-next' },
								{ label: 'Owned', value: 'owned' },
							],
						},
					},
				]}
				onSubmit={onSubmit}
			/>,
		)
		// The trigger shows the default option's *label*, not its raw value.
		expect(screen.getByText('Want next')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).toHaveBeenCalledWith({ status: 'want-next' })
	})

	it('keeps an optional date union optional in DOM constraints (issue #31 repro)', () => {
		// The shape `generateValidationSchema` emits for an optional date column:
		// datetime | date | Date, wrapped in .optional(). The reported bug was the
		// rendered input carrying required="".
		const schema = z.object({
			due: z.iso
				.datetime({ offset: true, local: true })
				.or(z.iso.date())
				.or(z.date())
				.optional(),
		})
		render(<DynamicForm schema={schema} onSubmit={vi.fn()} />)
		const input = screen.getByLabelText(byLabel('due')) as HTMLInputElement
		expect(input.required).toBe(false)
	})

	it('does not call onSubmit and shows an error when validation fails', () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ name: z.string().min(1) })}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).not.toHaveBeenCalled()
	})

	it('wires getZodConstraint so required/min constraints reach the DOM', () => {
		render(
			<DynamicForm
				schema={z.object({ name: z.string().min(3) })}
				onSubmit={vi.fn()}
			/>,
		)
		const input = screen.getByLabelText(byLabel('name')) as HTMLInputElement
		expect(input.required).toBe(true)
		expect(input.minLength).toBe(3)
	})
})

describe('DynamicForm — json columns', () => {
	// The exact shape `generateValidationSchema` emits for a `json` column.
	const jsonColumn = z.preprocess(
		(v) => {
			if (typeof v !== 'string') return v
			try {
				return JSON.parse(v)
			} catch {
				return v
			}
		},
		z.union(
			[
				z.record(z.string(), z.unknown()),
				z.custom<unknown[]>((v) => Array.isArray(v)),
			],
			{ error: 'Expected a JSON object or array' },
		),
	)
	const schema = z.object({ extras: jsonColumn.nullable().optional() })

	it('renders one JSON textarea, not a union branch picker', () => {
		render(<DynamicForm schema={schema} onSubmit={vi.fn()} />)
		const area = screen.getByLabelText(byLabel('extras'))
		expect(area.tagName).toBe('TEXTAREA')
	})

	it('prefills the textarea from a raw array row value on edit', () => {
		render(
			<DynamicForm
				schema={schema}
				defaultValues={{ extras: ['linear', 'log'] }}
				onSubmit={vi.fn()}
			/>,
		)
		const area = screen.getByLabelText(byLabel('extras')) as HTMLTextAreaElement
		expect(JSON.parse(area.value)).toEqual(['linear', 'log'])
	})

	it('prefills from a raw object row value without stringifying leaves', () => {
		render(
			<DynamicForm
				schema={schema}
				defaultValues={{ extras: { unit: 'px', max: 10 } }}
				onSubmit={vi.fn()}
			/>,
		)
		const area = screen.getByLabelText(byLabel('extras')) as HTMLTextAreaElement
		// `max` must stay a number — Conform's initialValue would give "10".
		expect(JSON.parse(area.value)).toEqual({ unit: 'px', max: 10 })
	})

	it('submits a top-level array typed into the textarea as a real array', async () => {
		const onSubmit = vi.fn()
		render(<DynamicForm schema={schema} onSubmit={onSubmit} />)
		fireEvent.change(screen.getByLabelText(byLabel('extras')), {
			target: { value: '["alpha", "beta"]' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).toHaveBeenCalledWith({ extras: ['alpha', 'beta'] })
	})

	it('blocks invalid JSON text instead of submitting it', () => {
		const onSubmit = vi.fn()
		render(<DynamicForm schema={schema} onSubmit={onSubmit} />)
		fireEvent.change(screen.getByLabelText(byLabel('extras')), {
			target: { value: 'not json' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		expect(onSubmit).not.toHaveBeenCalled()
	})
})
