/**
 * Task 38 exit (form side): an array-reference column (`meta.arrayReference`)
 * edits as the multi-value FK picker with **zero per-field config** — the form
 * is handed only the schema and the introspected columns, infers the widget, and
 * submits the selected ids as an array.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DynamicForm } from './DynamicForm.tsx'
import type { IntrospectedColumn } from './fields/field-semantics.ts'

const tags: IntrospectedColumn = {
	name: 'tags',
	type: 'json',
	meta: {
		arrayReference: { table: 'tag', column: 'id', displayField: 'name' },
	},
}
const options = [
	{ label: 'Ecosystem', value: 't1' },
	{ label: 'DX', value: 't2' },
]

describe('DynamicForm — array reference (task 38)', () => {
	it('infers the multi-value picker and submits selected ids as an array', async () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ tags: z.array(z.string()).optional() })}
				columns={[tags]}
				uiOptions={{ tags: { referenceOptions: options } }}
				onSubmit={onSubmit}
			/>,
		)
		// Auto-detected as a combobox picker (not a raw json textarea).
		fireEvent.focus(screen.getByRole('combobox'))
		fireEvent.click(screen.getByRole('option', { name: 'Ecosystem' }))
		fireEvent.focus(screen.getByRole('combobox'))
		fireEvent.click(screen.getByRole('option', { name: 'DX' }))
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({ tags: ['t1', 't2'] }),
		)
	})

	it('seeds the picker from the record’s existing references on edit', () => {
		render(
			<DynamicForm
				schema={z.object({ tags: z.array(z.string()).optional() })}
				columns={[tags]}
				uiOptions={{ tags: { referenceOptions: options } }}
				defaultValues={{ tags: ['t2'] }}
				onSubmit={vi.fn()}
			/>,
		)
		// The existing selection shows as a chip with a remove control.
		expect(
			screen.getByRole('button', { name: 'Remove DX' }),
		).toBeInTheDocument()
	})
})
