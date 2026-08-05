/**
 * Task 39 exit: a resource with a markdown body + an image upload + a password
 * field renders the right editors with **zero per-field config** — the form is
 * handed only the schema and the introspected `columns`, exactly what a route
 * already ships, and infers every widget from there.
 */

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DynamicForm } from './DynamicForm.tsx'
import type { IntrospectedColumn } from './fields/field-semantics.ts'
import { byLabel } from './test-support/label-query.ts'

const col = (
	name: string,
	over: Partial<IntrospectedColumn> = {},
): IntrospectedColumn => ({ name, type: 'string', ...over })

describe('DynamicForm — rich inputs (task 39)', () => {
	it('renders markdown / image-upload / password editors from inference alone', () => {
		render(
			<DynamicForm
				schema={z.object({
					title: z.string(),
					body: z.string().optional(),
					coverImage: z.string().optional(),
					password: z.string().optional(),
				})}
				columns={[
					col('title'),
					col('body', { meta: { markdown: true } }),
					col('coverImage', { meta: { isFile: true, fileAccept: 'image/*' } }),
					col('password'),
				]}
				onSubmit={vi.fn()}
			/>,
		)

		// Markdown editor: a Write / Preview tab pair over a markdown textarea.
		expect(screen.getByRole('tab', { name: /write/i })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /preview/i })).toBeInTheDocument()
		expect(screen.getByPlaceholderText(/write markdown/i)).toBeInTheDocument()

		// Image uploader: a drop zone with an image-specific choose button.
		expect(
			screen.getByRole('button', { name: /choose image/i }),
		).toBeInTheDocument()
		expect(screen.getByText(/drag and drop/i)).toBeInTheDocument()

		// Password: a native password input (secret, never a plain text box).
		expect(
			(screen.getByLabelText(byLabel('password')) as HTMLInputElement).type,
		).toBe('password')

		// The plain title stayed a plain text input — nothing over-detected.
		expect(
			(screen.getByLabelText(byLabel('title')) as HTMLInputElement).type,
		).toBe('text')
	})

	it('markdown preview renders the typed markdown', () => {
		render(
			<DynamicForm
				schema={z.object({ body: z.string().optional() })}
				columns={[col('body', { meta: { markdown: true } })]}
				onSubmit={vi.fn()}
			/>,
		)
		fireEvent.change(screen.getByPlaceholderText(/write markdown/i), {
			target: { value: '# Hi\n\n**bold**' },
		})
		fireEvent.click(screen.getByRole('tab', { name: /preview/i }))
		expect(screen.getByRole('heading', { name: 'Hi' })).toBeInTheDocument()
		expect(screen.getByText('bold').tagName).toBe('STRONG')
	})

	it('submits the value typed into the markdown editor', async () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ body: z.string().optional() })}
				columns={[col('body', { meta: { markdown: true } })]}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.change(screen.getByPlaceholderText(/write markdown/i), {
			target: { value: 'hello world' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({ body: 'hello world' }),
		)
	})

	it('detects a color picker and a star rating from metadata', () => {
		render(
			<DynamicForm
				schema={z.object({
					brandColor: z.string().optional(),
					rating: z.number().optional(),
				})}
				columns={[
					col('brandColor', { meta: { format: 'color' } }),
					col('rating', { type: 'number', meta: { format: 'rating', max: 5 } }),
				]}
				onSubmit={vi.fn()}
			/>,
		)
		// Color: a native color swatch alongside a hex field.
		expect(screen.getByLabelText('Color picker')).toHaveAttribute(
			'type',
			'color',
		)
		// Rating: a 5-radio group of stars.
		const rating = screen.getByRole('radiogroup', { name: /rating/i })
		expect(within(rating).getAllByRole('radio')).toHaveLength(5)
	})

	it('star rating click submits the chosen number', async () => {
		const onSubmit = vi.fn()
		render(
			<DynamicForm
				schema={z.object({ rating: z.number().optional() })}
				columns={[
					col('rating', { type: 'number', meta: { format: 'rating' } }),
				]}
				onSubmit={onSubmit}
			/>,
		)
		const rating = screen.getByRole('radiogroup', { name: /rating/i })
		fireEvent.click(within(rating).getByRole('radio', { name: '4 stars' }))
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ rating: 4 }))
	})

	it('uploads a picked image to /api/upload and previews the returned URL (task 60)', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					key: 'k1.png',
					url: '/files/k1.png?exp=1&sig=abc',
					name: 'pic.png',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)
		vi.stubGlobal('fetch', fetchMock)
		try {
			render(
				<DynamicForm
					schema={z.object({ coverImage: z.string().optional() })}
					columns={[
						col('coverImage', {
							meta: { isFile: true, fileAccept: 'image/*' },
						}),
					]}
					onSubmit={vi.fn()}
				/>,
			)
			const file = new File(['x'], 'pic.png', { type: 'image/png' })
			// The file <input> is visually hidden but present in the drop zone.
			const input = document.querySelector(
				'input[type="file"]',
			) as HTMLInputElement
			Object.defineProperty(input, 'files', {
				value: [file],
				configurable: true,
			})
			fireEvent.change(input)
			const img = await screen.findByAltText('pic.png')
			expect((img as HTMLImageElement).src).toContain(
				'/files/k1.png?exp=1&sig=abc',
			)
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/upload',
				expect.objectContaining({ method: 'POST' }),
			)
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('leaves inference untouched when no columns are supplied', () => {
		// Without `columns`, a markdown-flagged field can't be known — the form
		// still infers everything a schema alone can (here: a plain textarea-less
		// text input), proving the prop is purely additive.
		render(
			<DynamicForm
				schema={z.object({ password: z.string(), plain: z.string() })}
				onSubmit={vi.fn()}
			/>,
		)
		// password is still detected by NAME even with no columns.
		expect(
			(screen.getByLabelText(byLabel('password')) as HTMLInputElement).type,
		).toBe('password')
		expect(
			(screen.getByLabelText(byLabel('plain')) as HTMLInputElement).type,
		).toBe('text')
	})
})
