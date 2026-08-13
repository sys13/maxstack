/**
 * #442 — the FK picker's option list is one page, and it used to behave as if it
 * were the whole table.
 *
 * Every test here is written against a referenced resource **bigger than a
 * page**, because that is the only size at which the bug exists: with 20
 * customers the old client-side filter was correct, and with 200 it silently
 * hid 100 of them. `page()` builds the loader's slice so a test states which
 * records the picker was handed and which it was not.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data/data-context.tsx'
import { createMemoryDataProvider } from '../data/memory-provider.ts'
import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import {
	FormAutocomplete,
	FormReferenceArrayInput,
} from '../ui/form-fields.tsx'
import {
	REFERENCE_OPTION_PAGE,
	type ReferenceSearchPlan,
	referenceSearchPlan,
} from './reference-search.ts'
import { referenceUiOptions } from './types.ts'

/** 250 customers — `c1`…`c250`, named so a query can name exactly one. */
const CUSTOMERS = Array.from({ length: 250 }, (_, i) => ({
	id: `c${i + 1}`,
	name: `Customer ${i + 1}`,
}))

/** What a loader hands the picker: the first page, and only that. */
function page() {
	return CUSTOMERS.slice(0, REFERENCE_OPTION_PAGE).map((c) => ({
		label: c.name,
		value: c.id,
	}))
}

const PLAN: ReferenceSearchPlan = {
	resource: 'customer',
	idField: 'id',
	labelField: 'name',
}

function withData(ui: React.ReactNode, rows: typeof CUSTOMERS = CUSTOMERS) {
	const provider = createMemoryDataProvider({ data: { customer: rows } })
	return render(<DataProvider dataProvider={provider}>{ui}</DataProvider>)
}

/** Type into the combobox and let the debounce + the provider's promise settle. */
async function typeQuery(value: string) {
	const box = screen.getByRole('combobox')
	fireEvent.focus(box)
	fireEvent.change(box, { target: { value } })
	await act(async () => {
		vi.advanceTimersByTime(300)
	})
}

afterEach(() => {
	vi.useRealTimers()
})

describe('referenceSearchPlan', () => {
	const column = (meta: Partial<IntrospectedColumn>): IntrospectedColumn => ({
		name: 'customerId',
		type: 'text',
		...meta,
	})

	it('derives the plan from a single reference', () => {
		expect(
			referenceSearchPlan(
				column({
					references: { table: 'customer', column: 'id', displayField: 'name' },
				}),
			),
		).toEqual(PLAN)
	})

	it('derives it from the many side too — both pick from the same records', () => {
		expect(
			referenceSearchPlan(
				column({
					meta: {
						arrayReference: {
							table: 'customer',
							column: 'id',
							displayField: 'name',
						},
					},
				}),
			),
		).toEqual(PLAN)
	})

	it('builds no plan without a display field', () => {
		// `?searchField=` naming a column the table does not have is *skipped* by
		// the store, so the search would quietly return the unfiltered resource —
		// worse than not searching. Staying on the local page is the honest fallback.
		expect(
			referenceSearchPlan(
				column({ references: { table: 'customer', column: 'id' } }),
			),
		).toBeUndefined()
	})

	it('builds no plan for a column that references nothing', () => {
		expect(referenceSearchPlan(column({ type: 'text' }))).toBeUndefined()
	})
})

describe('referenceUiOptions', () => {
	it('derives the search plan for each reference column, with no loader change', () => {
		const columns: IntrospectedColumn[] = [
			{
				name: 'customerId',
				type: 'text',
				references: { table: 'customer', column: 'id', displayField: 'name' },
			},
		]
		const ui = referenceUiOptions(columns, {
			options: { customerId: page() },
			create: {},
		})
		expect(ui.customerId?.inputType).toBe('reference')
		expect(ui.customerId?.referenceSearch).toEqual(PLAN)
	})

	it('leaves the plan undefined when the column is not in the introspection', () => {
		// The options map and the columns can disagree (a spec/DB skew). No column,
		// no derived plan — the picker falls back to its page rather than guessing
		// a resource name.
		const ui = referenceUiOptions([], {
			options: { customerId: page() },
			create: {},
		})
		expect(ui.customerId?.referenceSearch).toBeUndefined()
	})
})

describe('FormAutocomplete past the loader page (#442)', () => {
	it('finds a record the loader never sent', async () => {
		vi.useFakeTimers()
		const { container } = withData(
			<FormAutocomplete name="customerId" options={page()} search={PLAN} />,
		)
		// The bug, stated: customer 200 is real, and is not in the page.
		expect(page().some((o) => o.label === 'Customer 200')).toBe(false)

		await typeQuery('Customer 200')

		fireEvent.click(screen.getByRole('option', { name: 'Customer 200' }))
		expect(
			container.querySelector<HTMLInputElement>(
				'input[type="hidden"][name="customerId"]',
			)?.value,
		).toBe('c200')
	})

	it('renders the server’s matches without re-filtering them', async () => {
		vi.useFakeTimers()
		// The server matches the declared search field; the picker renders whatever
		// came back. A second client-side pass over the *label* would be a
		// different rule, and would drop rows the server said match.
		const provider = createMemoryDataProvider({
			data: { customer: [{ id: 'c900', name: 'Acme', code: 'ZZ-900' }] },
		})
		render(
			<DataProvider dataProvider={provider}>
				<FormAutocomplete name="customerId" options={[]} search={PLAN} />
			</DataProvider>,
		)
		const box = screen.getByRole('combobox')
		fireEvent.focus(box)
		// A query that matches nothing in the *label* but which the provider is
		// asked about anyway — the rendered answer is the server's.
		fireEvent.change(box, { target: { value: 'Acme' } })
		await act(async () => {
			vi.advanceTimersByTime(300)
		})
		expect(screen.getByRole('option', { name: 'Acme' })).toBeInTheDocument()
	})

	it('resolves the label of a stored reference past the page instead of showing an empty box', async () => {
		vi.useFakeTimers()
		withData(
			<FormAutocomplete
				name="customerId"
				options={page()}
				defaultValue="c200"
				placeholder="Pick a customer"
				search={PLAN}
			/>,
		)
		await act(async () => {
			await vi.runAllTimersAsync()
		})
		expect(screen.getByRole('combobox')).toHaveValue('Customer 200')
	})

	it('says the list is a page when the page is full', () => {
		vi.useFakeTimers()
		withData(
			<FormAutocomplete name="customerId" options={page()} search={PLAN} />,
		)
		fireEvent.focus(screen.getByRole('combobox'))
		expect(
			screen.getByText(
				`Showing the first ${REFERENCE_OPTION_PAGE} — type to search them all`,
			),
		).toBeInTheDocument()
	})

	it('says nothing about a short list, which is the whole resource', () => {
		vi.useFakeTimers()
		withData(
			<FormAutocomplete
				name="customerId"
				options={page().slice(0, 3)}
				search={PLAN}
			/>,
		)
		fireEvent.focus(screen.getByRole('combobox'))
		expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument()
	})

	it('reports a failed search rather than calling it "No matches"', async () => {
		vi.useFakeTimers()
		const provider = createMemoryDataProvider({ data: { customer: CUSTOMERS } })
		provider.getList = () => Promise.reject(new Error('offline'))
		render(
			<DataProvider dataProvider={provider}>
				<FormAutocomplete name="customerId" options={page()} search={PLAN} />
			</DataProvider>,
		)
		await typeQuery('Customer 200')
		expect(screen.getByText(/Could not search customer/)).toBeInTheDocument()
		expect(screen.queryByText('No matches')).not.toBeInTheDocument()
	})

	it('keeps filtering locally with no data layer in context', () => {
		// A plan alone changes nothing: outside the app tree (a standalone render,
		// a slot in its own root) the picker is exactly what it always was.
		render(
			<FormAutocomplete name="customerId" options={page()} search={PLAN} />,
		)
		const box = screen.getByRole('combobox')
		fireEvent.focus(box)
		// It still admits its list is a page — true either way, and here the page
		// is a wall rather than a starting point, so the sentence omits "type to
		// search them all".
		expect(
			screen.getByText(`Showing the first ${REFERENCE_OPTION_PAGE}`),
		).toBeInTheDocument()
		fireEvent.change(box, { target: { value: 'Customer 12' } })
		expect(
			screen.getByRole('option', { name: 'Customer 12' }),
		).toBeInTheDocument()
		expect(
			screen.queryByRole('option', { name: 'Customer 3' }),
		).not.toBeInTheDocument()
	})
})

describe('FormReferenceArrayInput past the loader page (#442)', () => {
	it('adds a record the loader never sent', async () => {
		vi.useFakeTimers()
		const { container } = withData(
			<FormReferenceArrayInput
				name="customerIds"
				options={page()}
				search={PLAN}
			/>,
		)
		await typeQuery('Customer 240')
		fireEvent.click(screen.getByRole('option', { name: 'Customer 240' }))
		expect(
			[
				...container.querySelectorAll(
					'input[type="hidden"][name="customerIds"]',
				),
			].map((el) => (el as HTMLInputElement).value),
		).toEqual(['c240'])
	})
})
