/**
 * #443 — create-inline in the FK picker was fully built and reachable from
 * nothing.
 *
 * The tests split along the seam the issue draws. The *gates* — may this viewer
 * create one, is a name enough to make one — are server facts and are tested
 * where they are decided (`apps/web/app/reference-create.test.ts`). What is
 * testable here is everything downstream of the answer: a plan produces a
 * working "Create …" row, no plan produces no row at all, the write goes through
 * the ordinary provider, and a refusal says so instead of vanishing.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data/data-context.tsx'
import type { DataProvider as DataProviderContract } from '../data/data-provider.ts'
import { createMemoryDataProvider } from '../data/memory-provider.ts'
import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import {
	FormAutocomplete,
	FormReferenceArrayInput,
} from '../ui/form-fields.tsx'
import type { ReferenceCreatePlan } from './reference-create.ts'
import { referenceUiOptions } from './types.ts'

const PLAN: ReferenceCreatePlan = {
	resource: 'customer',
	idField: 'id',
	labelField: 'name',
}

const OPTIONS = [{ label: 'Customer 1', value: 'c1' }]

function withData(ui: React.ReactNode, provider?: DataProviderContract) {
	const dataProvider =
		provider ?? createMemoryDataProvider({ data: { customer: [] } })
	return {
		dataProvider,
		...render(<DataProvider dataProvider={dataProvider}>{ui}</DataProvider>),
	}
}

/** Type a name no loaded option carries, so the create row is the offer. */
function typeUnmatched(value = 'Northwind') {
	const box = screen.getByRole('combobox')
	fireEvent.focus(box)
	fireEvent.change(box, { target: { value } })
}

const createRow = () => screen.queryByRole('button', { name: /^Create/ })

describe('the picker offers create only when the server said it may', () => {
	it('offers it with a plan', () => {
		withData(
			<FormAutocomplete name="customerId" options={OPTIONS} create={PLAN} />,
		)
		typeUnmatched()
		expect(createRow()).not.toBeNull()
	})

	it('does not offer it without one', () => {
		// The permission half of the issue. A viewer who may pick a customer is not
		// thereby a viewer who may create one, and the row is *absent* rather than
		// refused on click — an affordance that promises and then 403s is the shape
		// #388 exists to stop.
		withData(<FormAutocomplete name="customerId" options={OPTIONS} />)
		typeUnmatched()
		expect(createRow()).toBeNull()
		expect(screen.getByText('No matches')).toBeTruthy()
	})

	it('does not offer it with a plan but no data layer to create through', () => {
		// Degrades exactly as the search does: with nothing to POST to there is no
		// handler, so there is no row, rather than a row whose click does nothing.
		render(
			<FormAutocomplete name="customerId" options={OPTIONS} create={PLAN} />,
		)
		typeUnmatched()
		expect(createRow()).toBeNull()
	})

	it('does not offer it for a query that already matches exactly', () => {
		withData(
			<FormAutocomplete name="customerId" options={OPTIONS} create={PLAN} />,
		)
		typeUnmatched('Customer 1')
		expect(createRow()).toBeNull()
	})
})

describe('creating from the picker', () => {
	it('writes through the ordinary provider and selects what came back', async () => {
		const { dataProvider, container } = withData(
			<FormAutocomplete name="customerId" options={OPTIONS} create={PLAN} />,
		)
		typeUnmatched()
		await act(async () => {
			fireEvent.click(createRow() as HTMLElement)
		})

		// The record exists, made of the typed string and nothing else.
		const page = await dataProvider.getList('customer')
		expect(page.data).toHaveLength(1)
		expect(page.data[0]?.name).toBe('Northwind')

		// And the form now submits its id — the point of the whole exercise.
		const hidden = container.querySelector<HTMLInputElement>(
			'input[type="hidden"][name="customerId"]',
		)
		expect(hidden?.value).toBe(String(page.data[0]?.id))
	})

	it('shows the label the server stored, not the label that was typed', async () => {
		// A create that trims, normalizes or titlecases would otherwise leave the
		// picker displaying something the row does not say.
		const memory = createMemoryDataProvider({ data: { customer: [] } })
		const normalizing: DataProviderContract = {
			...memory,
			create: (resource, data) =>
				memory.create(resource, { ...data, name: 'NORTHWIND' }),
		}
		withData(
			<FormAutocomplete name="customerId" options={OPTIONS} create={PLAN} />,
			normalizing,
		)
		typeUnmatched()
		await act(async () => {
			fireEvent.click(createRow() as HTMLElement)
		})
		expect(screen.getByRole('combobox')).toHaveProperty('value', 'NORTHWIND')
	})

	it('says a refused create was refused, and selects nothing', async () => {
		// The gates make a refusal here a surprise — a unique-name collision, a
		// custom validation, an `owner` rule reading the row. Before this issue
		// nothing awaited the handler, so a rejection was an unhandled rejection and
		// the picker just sat there looking like the click had missed.
		const memory = createMemoryDataProvider({ data: { customer: [] } })
		const refusing: DataProviderContract = {
			...memory,
			create: () => Promise.reject(new Error('nope')),
		}
		const { container } = withData(
			<FormAutocomplete name="customerId" options={OPTIONS} create={PLAN} />,
			refusing,
		)
		typeUnmatched()
		await act(async () => {
			fireEvent.click(createRow() as HTMLElement)
		})
		expect(screen.getByText(/Could not create customer/)).toBeTruthy()
		const hidden = container.querySelector<HTMLInputElement>(
			'input[type="hidden"][name="customerId"]',
		)
		expect(hidden?.value).toBe('')
	})

	it('prefers a hand-written onCreate over the derived one', async () => {
		// Owned code passing `onCreate` is a deliberate statement about how a record
		// gets made; a plan is a default. The provider must not also be called.
		const memory = createMemoryDataProvider({ data: { customer: [] } })
		const onCreate = vi.fn(() => ({ label: 'Mine', value: 'x1' }))
		const { container } = withData(
			<FormAutocomplete
				name="customerId"
				options={OPTIONS}
				create={PLAN}
				onCreate={onCreate}
			/>,
			memory,
		)
		typeUnmatched()
		await act(async () => {
			fireEvent.click(createRow() as HTMLElement)
		})
		expect(onCreate).toHaveBeenCalledWith('Northwind')
		expect((await memory.getList('customer')).data).toHaveLength(0)
		const hidden = container.querySelector<HTMLInputElement>(
			'input[type="hidden"][name="customerId"]',
		)
		expect(hidden?.value).toBe('x1')
	})

	it('adds the new record to the selection on the many side', async () => {
		const { dataProvider, container } = withData(
			<FormReferenceArrayInput
				name="tagIds"
				options={OPTIONS}
				create={{ ...PLAN, resource: 'tag' }}
			/>,
		)
		typeUnmatched('Urgent')
		await act(async () => {
			fireEvent.click(createRow() as HTMLElement)
		})
		const created = (await dataProvider.getList('tag')).data[0]
		expect(created?.name).toBe('Urgent')
		const hidden = container.querySelectorAll<HTMLInputElement>(
			'input[type="hidden"][name="tagIds"]',
		)
		expect([...hidden].map((i) => i.value)).toEqual([String(created?.id)])
	})
})

describe('referenceUiOptions routes the plan to its field', () => {
	const columns: IntrospectedColumn[] = [
		{
			name: 'customerId',
			type: 'text',
			references: { table: 'customer', column: 'id', displayField: 'name' },
		},
	]

	it('carries the create plan through to the field', () => {
		const ui = referenceUiOptions(columns, {
			options: { customerId: OPTIONS },
			create: { customerId: PLAN },
		})
		expect(ui.customerId?.referenceCreate).toEqual(PLAN)
	})

	it('leaves it undefined for a field the server gave no plan for', () => {
		// The default, and the safe direction: an FK column with options and no
		// create plan is one the viewer may read and may not write.
		const ui = referenceUiOptions(columns, {
			options: { customerId: OPTIONS },
			create: {},
		})
		expect(ui.customerId?.referenceOptions).toEqual(OPTIONS)
		expect(ui.customerId?.referenceCreate).toBeUndefined()
	})
})
