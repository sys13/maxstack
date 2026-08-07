import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type BulkActionContext, ResourceList } from './ResourceList.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'

const resource: IntrospectedResource = {
	name: 'post',
	primaryKey: 'id',
	columns: [
		{ name: 'id', type: 'uuid', meta: {} },
		{ name: 'title', type: 'string', meta: { label: 'Title' } },
		{ name: 'points', type: 'number', meta: { sortable: true } },
		{ name: 'secret', type: 'string', meta: { hidden: true } },
		{
			name: 'authorId',
			type: 'uuid',
			references: { table: 'user', column: 'id' },
		},
	],
}

const rows: Row[] = [
	{ id: '1', title: 'Alpha', points: 10, secret: 's1', authorId: 'u1' },
	{ id: '2', title: 'Beta', points: 30, secret: 's2', authorId: 'u2' },
	{ id: '3', title: 'Gamma', points: 20, secret: 's3', authorId: 'u3' },
]

function first(elements: HTMLElement[]): HTMLElement {
	const el = elements[0]
	if (!el) throw new Error('expected at least one element')
	return el
}

function headers() {
	return screen
		.getAllByRole('columnheader')
		.map((h) => h.textContent?.trim() ?? '')
}

describe('ResourceList column inference', () => {
	it('skips hidden and primary-key columns', () => {
		render(<ResourceList resource={resource} rows={rows} />)
		const hs = headers()
		expect(hs).toContain('Title')
		expect(hs.join(' ')).not.toContain('secret')
		expect(hs.join(' ')).not.toContain('id')
	})

	it('shows the primary key when asked', () => {
		render(<ResourceList resource={resource} rows={rows} showPrimaryKey />)
		expect(headers().join(' ')).toContain('Id')
	})

	it('humanizes a raw column name with no meta.label', () => {
		render(<ResourceList resource={resource} rows={rows} />)
		// `authorId` has no meta.label at all — it must not render lowercase/raw.
		expect(headers()).toContain('Author Id')
	})

	it('renders an empty state naming the resource, not "row"', () => {
		render(<ResourceList resource={resource} rows={[]} />)
		expect(screen.getByText('No records yet')).toBeInTheDocument()
		expect(
			screen.getByText('Add the first post to get started.'),
		).toBeInTheDocument()
	})

	it("prefers the resource's declared label over its id", () => {
		// `name` is an identifier (it is what `references.table` is matched
		// against); `label` is what a human calls one of these.
		render(
			<ResourceList
				resource={{ ...resource, name: 'reading-item', label: 'Reading item' }}
				rows={[]}
			/>,
		)
		expect(
			screen.getByText('Add the first Reading item to get started.'),
		).toBeInTheDocument()
	})

	it('renders skeleton rows while loading', () => {
		render(
			<ResourceList resource={resource} rows={rows} loading skeletonRows={3} />,
		)
		expect(screen.getAllByTestId('skeleton-row')).toHaveLength(3)
	})
})

describe('ResourceList cell overrides (the eject seam)', () => {
	it('replaces a cell via the columns prop', () => {
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				columns={{
					title: ({ value }) => <em data-testid="custom">{`!${value}`}</em>,
				}}
			/>,
		)
		expect(screen.getAllByTestId('custom')[0]).toHaveTextContent('!Alpha')
	})
})

describe('ResourceList sorting', () => {
	it('client-sorts a sortable column on header click', () => {
		render(<ResourceList resource={resource} rows={rows} />)
		const pointsHeader = screen.getByRole('button', { name: /points/i })
		// First click → ascending: 10, 20, 30.
		fireEvent.click(pointsHeader)
		let bodyRows = screen.getAllByRole('row').slice(1)
		expect(within(first(bodyRows)).getByText('10')).toBeInTheDocument()
		// Second click → descending: 30 first.
		fireEvent.click(pointsHeader)
		bodyRows = screen.getAllByRole('row').slice(1)
		expect(within(first(bodyRows)).getByText('30')).toBeInTheDocument()
	})

	it('defers to a controlled onSort without reordering locally', () => {
		const seen: string[] = []
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				onSort={(s) => seen.push(`${s.field}:${s.dir}`)}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: /points/i }))
		expect(seen).toEqual(['points:asc'])
		// Controlled: DOM order is unchanged (parent owns the data).
		const bodyRows = screen.getAllByRole('row').slice(1)
		expect(within(first(bodyRows)).getByText('Alpha')).toBeInTheDocument()
	})
})

describe('ResourceList pagination', () => {
	it('paginates client-side when pageSize is set', () => {
		render(<ResourceList resource={resource} rows={rows} pageSize={2} />)
		expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
		expect(screen.getAllByRole('row').slice(1)).toHaveLength(2)
		fireEvent.click(screen.getByRole('button', { name: /Next/ }))
		expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
		expect(screen.getAllByRole('row').slice(1)).toHaveLength(1)
	})
})

describe('ResourceList per-row actions', () => {
	it('renders each row action inside that row, not after the table', () => {
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				rowActions={(row) => (
					<button type="button">Approve {String(row.title)}</button>
				)}
			/>,
		)
		// The point of the prop: the control is a descendant of its own <tr>.
		// A detached list of buttons below the table would pass a naive
		// "is the button on screen" assertion and still be the bug.
		for (const title of ['Alpha', 'Beta', 'Gamma']) {
			const cell = screen.getByText(title).closest('tr')
			if (!cell) throw new Error(`no row for ${title}`)
			expect(
				within(cell).getByRole('button', { name: `Approve ${title}` }),
			).toBeInTheDocument()
		}
		expect(headers()).toContain('Actions')
	})

	it('keeps the bespoke-row slot spanning the full width', () => {
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				rowHref={(row) => `/p/${String(row.id)}`}
				rowActions={() => <button type="button">Go</button>}
				renderRow={({ row }) => <span>row {String(row.title)}</span>}
			/>,
		)
		// cols (title, points, authorId) + rowHref + rowActions = 5.
		const body = first(screen.getAllByText(/^row /)).closest('td')
		expect(body?.getAttribute('colspan')).toBe('5')
	})
})

describe('ResourceList selection + bulk actions', () => {
	it('selects rows and select-all, surfacing the selection to bulkActions', () => {
		const seen: BulkActionContext[] = []
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				selectable
				bulkActions={(ctx) => {
					seen.push(ctx)
					return (
						<button type="button" onClick={ctx.clear}>
							Act on {ctx.selectedIds.length}
						</button>
					)
				}}
			/>,
		)
		// No bar until something is selected.
		expect(screen.queryByRole('toolbar')).toBeNull()
		fireEvent.click(screen.getByLabelText('Select row 1'))
		expect(screen.getByRole('toolbar')).toHaveTextContent('1 selected')
		const ctx = seen.at(-1)
		expect(ctx?.selectedIds).toEqual(['1'])
		expect((ctx?.selectedRows ?? [])[0]).toMatchObject({ title: 'Alpha' })

		// Select-all grabs every visible row.
		fireEvent.click(screen.getByLabelText('Select all'))
		expect(screen.getByRole('toolbar')).toHaveTextContent('3 selected')

		// The action's clear() resets and hides the bar.
		fireEvent.click(screen.getByRole('button', { name: /Act on/ }))
		expect(screen.queryByRole('toolbar')).toBeNull()
	})

	it('drives a controlled selection', () => {
		const onSelectedChange = vi.fn()
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				selectable
				selectedIds={['2']}
				onSelectedChange={onSelectedChange}
				bulkActions={() => null}
			/>,
		)
		expect(screen.getByLabelText('Select row 2')).toBeChecked()
		fireEvent.click(screen.getByLabelText('Select row 1'))
		expect(onSelectedChange).toHaveBeenCalledWith(['2', '1'])
	})
})

describe('ResourceList permission gating (task 35)', () => {
	const allowed = { read: true, create: true, update: true, delete: true }

	it('passes the capabilities to bulkActions so a toolbar can strip its own actions', () => {
		const seen: BulkActionContext[] = []
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				selectable
				can={{ read: true, create: false, update: true, delete: false }}
				bulkActions={(ctx) => {
					seen.push(ctx)
					return ctx.can.delete ? <button type="button">Delete</button> : null
				}}
			/>,
		)
		fireEvent.click(screen.getByLabelText('Select row 1'))
		expect(seen.at(-1)?.can.delete).toBe(false)
		expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
	})

	it('suppresses the selection column when neither update nor delete is allowed', () => {
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				selectable
				can={{ read: true, create: false, update: false, delete: false }}
				bulkActions={() => <button type="button">Delete</button>}
			/>,
		)
		expect(screen.queryByLabelText('Select all')).toBeNull()
		expect(screen.queryByLabelText('Select row 1')).toBeNull()
	})

	it('keeps the selection column when at least one of update/delete is allowed', () => {
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				selectable
				can={{ ...allowed, update: false, create: false }}
				bulkActions={() => null}
			/>,
		)
		expect(screen.getByLabelText('Select all')).toBeInTheDocument()
	})
})

describe('ResourceList edit-in-place (task 40)', () => {
	it('edits a text cell and saves on Enter', () => {
		const onCellSave = vi.fn()
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				editable={['title']}
				onCellSave={onCellSave}
			/>,
		)
		fireEvent.click(
			first(screen.getAllByRole('button', { name: 'Edit Title' })),
		)
		const input = screen.getByLabelText('Title')
		expect(input).toHaveValue('Alpha')
		fireEvent.change(input, { target: { value: 'Alpha 2' } })
		fireEvent.keyDown(input, { key: 'Enter' })
		expect(onCellSave).toHaveBeenCalledWith(rows[0], 'title', 'Alpha 2')
		// The editor closed back to display mode.
		expect(screen.queryByLabelText('Title')).toBeNull()
	})

	it('parses a number cell and saves a number', () => {
		const onCellSave = vi.fn()
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				editable={['points']}
				onCellSave={onCellSave}
			/>,
		)
		fireEvent.click(
			first(screen.getAllByRole('button', { name: 'Edit Points' })),
		)
		const input = screen.getByLabelText('Points')
		fireEvent.change(input, { target: { value: '42' } })
		fireEvent.keyDown(input, { key: 'Enter' })
		expect(onCellSave).toHaveBeenCalledWith(rows[0], 'points', 42)
	})

	it('cancels on Escape and skips saving an unchanged value on blur', () => {
		const onCellSave = vi.fn()
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				editable={['title']}
				onCellSave={onCellSave}
			/>,
		)
		fireEvent.click(
			first(screen.getAllByRole('button', { name: 'Edit Title' })),
		)
		let input = screen.getByLabelText('Title')
		fireEvent.change(input, { target: { value: 'discarded' } })
		fireEvent.keyDown(input, { key: 'Escape' })
		expect(onCellSave).not.toHaveBeenCalled()
		// Re-open and blur untouched: still no save.
		fireEvent.click(
			first(screen.getAllByRole('button', { name: 'Edit Title' })),
		)
		input = screen.getByLabelText('Title')
		fireEvent.blur(input)
		expect(onCellSave).not.toHaveBeenCalled()
	})

	it('offers no editor for a column the list never named', () => {
		// `editable` is an allow-list, not a hint: a column absent from it renders
		// as the plain read-only cell it always was. This is what keeps a declared
		// capability from widening to the whole row.
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				editable={['title']}
				onCellSave={vi.fn()}
			/>,
		)
		expect(screen.getAllByRole('button', { name: 'Edit Title' }).length).toBe(3)
		expect(screen.queryByRole('button', { name: 'Edit Points' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Edit Author Id' })).toBeNull()
	})

	it('offers no editor with no way to save', () => {
		// Without `onCellSave` a click would open an editor whose commit goes
		// nowhere — an affordance that silently discards what was typed.
		render(
			<ResourceList resource={resource} rows={rows} editable={['title']} />,
		)
		expect(screen.queryByRole('button', { name: 'Edit Title' })).toBeNull()
	})

	it('suppresses editing without update capability', () => {
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				editable={['title']}
				onCellSave={vi.fn()}
				can={{ read: true, create: false, update: false, delete: false }}
			/>,
		)
		expect(screen.queryByRole('button', { name: 'Edit Title' })).toBeNull()
	})
})

describe('ResourceList edit-in-place, cells that hold no value or too much', () => {
	const enumResource: IntrospectedResource = {
		name: 'task',
		primaryKey: 'id',
		columns: [
			{ name: 'id', type: 'uuid', meta: {} },
			{
				name: 'status',
				type: 'enum',
				nullable: true,
				enumValues: ['todo', 'doing'],
				meta: {},
			},
		],
	}
	const unset: Row[] = [{ id: '1', status: null }]

	function openStatus() {
		fireEvent.click(
			first(screen.getAllByRole('button', { name: 'Edit Status' })),
		)
		return screen.getByLabelText('Status')
	}

	it('opens an empty enum cell on no value rather than on the first option', () => {
		// A `<select>` can only show one of its own options, so with none matching
		// the browser silently picks the first — and the cell then displays a value
		// the database does not have. It also made that option unreachable: it was
		// already selected, so choosing it changed nothing and saved nothing.
		const onCellSave = vi.fn()
		render(
			<ResourceList
				resource={enumResource}
				rows={unset}
				editable={['status']}
				onCellSave={onCellSave}
			/>,
		)
		const select = openStatus()
		expect(select).toHaveValue('')
		fireEvent.change(select, { target: { value: 'todo' } })
		expect(onCellSave).toHaveBeenCalledWith(unset[0], 'status', 'todo')
	})

	it('clears a nullable enum to null, not to an empty string', () => {
		// The blank option is a value, and the value it is is `null` — an empty
		// string would land in the column as an option that does not exist.
		const onCellSave = vi.fn()
		render(
			<ResourceList
				resource={enumResource}
				rows={[{ id: '1', status: 'todo' }]}
				editable={['status']}
				onCellSave={onCellSave}
			/>,
		)
		fireEvent.change(openStatus(), { target: { value: '' } })
		expect(onCellSave).toHaveBeenCalledWith(
			{ id: '1', status: 'todo' },
			'status',
			null,
		)
	})

	it('shows a NOT NULL enum its empty state without letting it be committed', () => {
		// The state is real, so it is shown; the write would be refused by the
		// server, so the option is not selectable. A cell that hid the emptiness
		// would be lying about the row to avoid an error it cannot cause.
		render(
			<ResourceList
				resource={{
					...enumResource,
					columns: enumResource.columns.map((c) =>
						c.name === 'status' ? { ...c, nullable: false } : c,
					),
				}}
				rows={unset}
				editable={['status']}
				onCellSave={vi.fn()}
			/>,
		)
		openStatus()
		expect(screen.getByRole('option', { name: '—' })).toBeDisabled()
	})

	it('does not flatten a stored line break when a cell is merely focused', () => {
		// A text input strips every CR and LF from its value. So the editor's text
		// differed from the stored string without anybody typing, the
		// unchanged-value check missed, and a click plus a click elsewhere wrote
		// the flattened string back. An edit nobody made, destroying the only copy
		// of the line breaks.
		const onCellSave = vi.fn()
		const multi: Row[] = [{ id: '1', title: 'line one\nline two' }]
		render(
			<ResourceList
				resource={resource}
				rows={multi}
				editable={['title']}
				onCellSave={onCellSave}
			/>,
		)
		fireEvent.click(
			first(screen.getAllByRole('button', { name: 'Edit Title' })),
		)
		const input = screen.getByLabelText('Title')
		expect(input).toHaveValue('line oneline two')
		fireEvent.blur(input)
		expect(onCellSave).not.toHaveBeenCalled()
	})
})

describe('ResourceList load-more footer (task 40)', () => {
	it('renders Load more instead of a pager and forwards the click', () => {
		const onLoadMore = vi.fn()
		render(
			<ResourceList
				resource={resource}
				rows={rows}
				onLoadMore={onLoadMore}
				hasMore
				total={10}
			/>,
		)
		expect(screen.queryByText(/Page 1 of/)).toBeNull()
		fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
		expect(onLoadMore).toHaveBeenCalledTimes(1)
	})

	it('disables the button while fetching and reports completion', () => {
		const { rerender } = render(
			<ResourceList
				resource={resource}
				rows={rows}
				onLoadMore={vi.fn()}
				hasMore
				isFetchingMore
			/>,
		)
		expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
		rerender(
			<ResourceList
				resource={resource}
				rows={rows}
				onLoadMore={vi.fn()}
				hasMore={false}
				total={3}
			/>,
		)
		expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()
		expect(screen.getByText('3 of 3 loaded')).toBeInTheDocument()
	})
})
