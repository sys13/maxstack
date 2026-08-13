/**
 * The new row at the foot of a list (#444).
 *
 * `<ResourceList>` is driven rather than the hook, because every property worth
 * pinning is about the row's *place in the table* and its relationship to the
 * permission: an editor under the right header, an affordance that is absent
 * rather than refusing, a draft that survives a refusal.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ResourceList } from './ResourceList.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'task',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'points', type: 'number', meta: { label: 'Points' } },
		{
			name: 'status',
			type: 'enum',
			enumValues: ['todo', 'done'],
			meta: { label: 'Status' },
		},
	],
}

const rows: Row[] = [{ id: '1', title: 'Alpha', points: 10, status: 'todo' }]

const ALL = { read: true, create: true, update: true, delete: true }

function list(props: Partial<Parameters<typeof ResourceList>[0]> = {}) {
	return render(
		<ResourceList
			resource={resource}
			rows={rows}
			can={ALL}
			creatable={['title', 'points', 'status']}
			{...props}
		/>,
	)
}

const addButton = () => screen.queryByRole('button', { name: /^Add/ })

describe('the affordance appears only when it can work', () => {
	it('renders an editor for each declared field, typed by the column', () => {
		list({ onRowCreate: vi.fn() })
		expect(screen.getByLabelText('Title').tagName).toBe('INPUT')
		expect(screen.getByLabelText('Points')).toHaveProperty('type', 'number')
		expect(screen.getByLabelText('Status').tagName).toBe('SELECT')
		expect(addButton()).not.toBeNull()
	})

	it('renders nothing without a create handler', () => {
		list()
		expect(screen.queryByLabelText('Title')).toBeNull()
		expect(addButton()).toBeNull()
	})

	it('renders nothing for a viewer who may not create', () => {
		// The wall is `opCreate` either way. This keeps the list from offering an
		// Add whose every use would be refused — the affordance is absent, not
		// present and apologetic.
		list({ onRowCreate: vi.fn(), can: { ...ALL, create: false } })
		expect(screen.queryByLabelText('Title')).toBeNull()
		expect(addButton()).toBeNull()
	})

	it('renders nothing when the block declared no field', () => {
		list({ onRowCreate: vi.fn(), creatable: [] })
		expect(addButton()).toBeNull()
	})

	it('puts each editor in the cell under its own header', () => {
		// The point of a line grid. A form whose boxes do not line up with the
		// columns is a modal that happens to be at the bottom of a table.
		list({ onRowCreate: vi.fn() })
		const headers = screen
			.getAllByRole('columnheader')
			.map((h) => h.textContent?.trim() ?? '')
		const cells = [
			...(screen.getByLabelText('Title').closest('tr')?.cells ?? []),
		]
		const titleAt = cells.findIndex((c) =>
			c.contains(screen.getByLabelText('Title')),
		)
		expect(headers[titleAt]).toBe('Title')
	})

	it('stays out of the way while the list is still loading', () => {
		list({ onRowCreate: vi.fn(), loading: true })
		expect(screen.queryByLabelText('Title')).toBeNull()
	})
})

describe('adding a row', () => {
	it('is not submittable until something is typed', () => {
		list({ onRowCreate: vi.fn() })
		expect(addButton()).toHaveProperty('disabled', true)
		fireEvent.change(screen.getByLabelText('Title'), {
			target: { value: 'Beta' },
		})
		expect(addButton()).toHaveProperty('disabled', false)
	})

	it('hands over only what was typed, and clears on success', async () => {
		// An untouched box is an absence, not a `null` — the caller drops empty
		// strings, so a defaulted column is left to default exactly as it does for
		// a row created from the New form.
		const onRowCreate = vi.fn(() => Promise.resolve())
		list({ onRowCreate })
		fireEvent.change(screen.getByLabelText('Title'), {
			target: { value: 'Beta' },
		})
		fireEvent.change(screen.getByLabelText('Points'), {
			target: { value: '7' },
		})
		await act(async () => {
			fireEvent.click(addButton() as HTMLElement)
		})
		expect(onRowCreate).toHaveBeenCalledWith({ title: 'Beta', points: 7 })
		expect(screen.getByLabelText('Title')).toHaveProperty('value', '')
		expect(screen.getByLabelText('Points')).toHaveProperty('value', '')
	})

	it('keeps the draft when the create is refused, and says so', async () => {
		// The version of this feature that costs the user their work is the one
		// that clears optimistically and then meets a 422. A refusal costs a
		// correction, not the typing.
		const onRowCreate = vi.fn(() => Promise.reject(new Error('422')))
		list({ onRowCreate })
		fireEvent.change(screen.getByLabelText('Title'), {
			target: { value: 'Beta' },
		})
		await act(async () => {
			fireEvent.click(addButton() as HTMLElement)
		})
		expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Beta')
		// And it says so, rather than sitting there looking like the click missed.
		expect(screen.getByText(/Could not add the row/)).toBeTruthy()
	})

	it('starts an enum with no selection rather than the first option', () => {
		// Pre-selecting would put a value in the record that nobody chose, and on a
		// required column it would be the one value the person could not avoid.
		list({ onRowCreate: vi.fn() })
		expect(screen.getByLabelText('Status')).toHaveProperty('value', '')
	})

	it('does not submit twice while a create is in flight', () => {
		let settle: () => void = () => {}
		const onRowCreate = vi.fn(
			() =>
				new Promise<void>((r) => {
					settle = r
				}),
		)
		list({ onRowCreate })
		fireEvent.change(screen.getByLabelText('Title'), {
			target: { value: 'Beta' },
		})
		fireEvent.click(addButton() as HTMLElement)
		fireEvent.click(addButton() as HTMLElement)
		expect(onRowCreate).toHaveBeenCalledTimes(1)
		expect(addButton()?.textContent).toBe('Adding…')
		settle()
	})
})
