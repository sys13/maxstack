/**
 * Issue #342 — the control bar a generated app's list surface gets by default.
 *
 * The bug this pins is not a missing component. `<FilterForm>` and `csv.ts`
 * shipped, tested, a year before; they were mounted on `/admin` and the
 * workbench and nowhere the app's own users could reach. So these tests assert
 * *composition*: one element that a route can render and hand to an ejected
 * page, carrying search, the derived facets and export together.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_FILTERS } from './filterable.ts'
import { ListControls } from './ListControls.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'book',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{
			name: 'status',
			type: 'enum',
			enumValues: ['reading', 'finished'],
			meta: { label: 'Status' },
		},
	],
}

const rows: Row[] = [
	{ id: '1', title: 'Dune', status: 'finished' },
	{ id: '2', title: 'Piranesi', status: 'reading' },
]

/**
 * Capture the file `downloadCsv` would have written, without a real download.
 *
 * The blob body is not readable synchronously; the CSV *content* is already
 * pinned by `csv.test.ts` against `resourceToCsv`, which is what this bar
 * calls. What is unpinned — and what these tests are for — is whether the bar
 * exports at all, and under which name.
 */
function captureDownload(): { name?: string } {
	const out: { name?: string } = {}
	vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:stub')
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		out.name = this.download
	})
	return out
}

describe('<ListControls> (#342)', () => {
	it('offers search and the derived facets — no hand-written filter code', () => {
		render(
			<ListControls
				resource={resource}
				rows={rows}
				value={EMPTY_FILTERS}
				onChange={() => {}}
			/>,
		)
		// `reader`'s `status` enum produces shelf tabs for free: the facet comes
		// from introspection, exactly as it does in the admin.
		expect(screen.getByLabelText('Search')).toBeTruthy()
		expect(screen.getByLabelText('Status')).toBeTruthy()
	})

	it('reports a search back in the same shape the URL codec encodes', () => {
		const onChange = vi.fn()
		render(
			<ListControls
				resource={resource}
				rows={rows}
				value={EMPTY_FILTERS}
				onChange={onChange}
			/>,
		)
		fireEvent.change(screen.getByLabelText('Search'), {
			target: { value: 'dune' },
		})
		expect(onChange).toHaveBeenCalledWith({ search: 'dune', filter: {} })
	})

	it('exports the rows it was handed, under the resource name', () => {
		const out = captureDownload()
		render(
			<ListControls
				resource={resource}
				rows={rows}
				value={EMPTY_FILTERS}
				onChange={() => {}}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
		expect(out.name).toBe('book.csv')
	})

	it('names a filtered export as one', () => {
		// Two downloads called `book.csv` holding different row sets is how a
		// spreadsheet ends up being the wrong one.
		const out = captureDownload()
		render(
			<ListControls
				resource={resource}
				rows={rows}
				value={{ filter: { status: 'reading' } }}
				onChange={() => {}}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
		expect(out.name).toBe('book-filtered.csv')
	})

	it('refuses to export an empty list', () => {
		// A CSV of headers alone reads as a broken export rather than as an empty
		// list.
		render(
			<ListControls
				resource={resource}
				rows={[]}
				value={EMPTY_FILTERS}
				onChange={() => {}}
			/>,
		)
		expect(
			screen
				.getByRole('button', { name: 'Export CSV' })
				.hasAttribute('disabled'),
		).toBe(true)
	})

	it('renders export alone when a resource has nothing to filter on', () => {
		// A control bar that controls nothing is worse than none — but the rows
		// are still exportable, so the button carries the bar by itself.
		render(
			<ListControls
				resource={{
					name: 'ping',
					primaryKey: 'id',
					columns: [{ name: 'id', type: 'uuid', meta: {} }],
				}}
				rows={rows}
				value={EMPTY_FILTERS}
				onChange={() => {}}
			/>,
		)
		expect(screen.queryByLabelText('Search')).toBeNull()
		expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy()
	})
})
