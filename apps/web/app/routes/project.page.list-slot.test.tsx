/**
 * @vitest-environment jsdom
 *
 * What a filled **`list` block slot** is actually handed (issue #398).
 *
 * `project.page.owned-route.test.tsx` settled the same question one rung up:
 * an ejected module is given exactly the props the framework's own list would
 * have rendered with, *not a subset*, because a subset makes "you own this
 * page" quietly cost you inline editing (#349).
 *
 * The `list` slot is the rung below — replace the rendering, keep the derived
 * page around it — and it was handed seven read-only props while the generated
 * list next to it was rendered with the declared actions of `view.addAction`,
 * the selection those actions run over, the ordering the loader honoured, and
 * the inline edit and inline create handlers. So the cheapest way to change how
 * a list *looks* silently forfeited every interaction the platform declares,
 * and the author's only way back was to rebuild the write path by hand — an
 * eject in all but name, which is the trade this seam exists to prevent.
 *
 * These tests capture the props the slot is called with. The last one is the
 * one that matters: they are sufficient to render the stock action controls, so
 * a bespoke list keeps a declared action without re-implementing it.
 *
 * Server markup rather than a client-only render, following the owned-route
 * test: assertions read `renderToString` output.
 */

import type { SproutColumn } from '@maxstack/core'
// The narrow entry point, for the reason `project.page.tsx` imports it that
// way: the package index pulls in the code generators, and with them ts-morph.
import { blockSlotId } from '@maxstack/core/ownership/block-slots'
import { DEFAULT_THEME } from '@maxstack/spec'
import {
	EMPTY_FILTERS,
	type ListActionDescriptor,
	type ListSlotProps,
	type Row,
	RowActionButtons,
} from '@maxstack/ui'
import { renderToString } from 'react-dom/server'
import { createRoutesStub } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRoute } from '~/project-routes'

/** The props the filled slot was called with, captured per test. */
let captured: ListSlotProps | undefined

/**
 * The project's owned code. `OWNED_SLOTS` is keyed by **resource** and then by
 * the derived slot id, which is what `maxstack slots fill` writes into
 * `book.slots.tsx`. The component here stands in for that fill: a bespoke list
 * region that also renders the stock row-action control, to prove the handover
 * is sufficient rather than merely present.
 */
vi.mock('~/owned.generated', () => ({
	OWNED_SLOTS: {
		book: {
			book__list: (props: ListSlotProps) => {
				captured = props
				return (
					<div>
						<p>BESPOKE LIST</p>
						<RowActionButtons
							actions={props.actions}
							rowId={String(props.rows[0]?.id)}
							onRun={props.runAction}
							busy={props.actionBusy}
						/>
					</div>
				)
			},
		},
	},
	OWNED_ROUTES: {},
	OWNED_SCHEDULE_HANDLERS: {},
	OWNED_SOURCE_REFINERS: {},
	OWNED_IMPORT_PARSERS: {},
	OWNED_LIVE_SURFACES: {},
}))

const { default: ProjectListPage } = await import('./project.page')

const columns: SproutColumn[] = [
	{
		name: 'id',
		type: 'uuid',
		nullable: false,
		hasDefault: true,
		isPrimaryKey: true,
		meta: {},
	},
	{
		name: 'title',
		type: 'string',
		nullable: false,
		hasDefault: false,
		isPrimaryKey: false,
		meta: {},
	},
]

const page: ProjectRoute = {
	slug: 'books',
	route: '/books',
	name: 'Books',
	resource: 'book',
	moduleKey: 'book',
	resourceLabel: 'Book',
	slots: [],
	replacesList: null,
	order: null,
	variant: 'table',
	fields: null,
	editable: ['title'],
	creatable: ['title'],
	view: null,
}

/** One declared action, at both arities — the thing a bespoke list used to
 *  lose. */
const archive: ListActionDescriptor = {
	key: 'archive',
	label: 'Archive',
	description: 'Move the book out of the active list',
	arity: 'both',
	maxSelection: 50,
	undoable: true,
}

/** Bound as its own const so `rowHref` can be called with a `Row` rather than
 *  with `Row | undefined` off the end of an array index. */
const firstRow: Row = {
	id: '11111111-1111-1111-1111-111111111111',
	title: 'Dune',
}

const loaderData = {
	page,
	nav: [page],
	title: 'Reader',
	theme: DEFAULT_THEME,
	demoRows: 0,
	primaryKey: 'id',
	columns,
	rows: [
		firstRow,
		{ id: '22222222-2222-2222-2222-222222222222', title: 'Piranesi' },
	],
	can: { read: true, create: true, update: true, delete: false },
	editable: ['title'],
	creatable: ['title'],
	actions: [archive],
	references: {},
	files: {},
	demoAvailable: false,
	demoIds: ['11111111-1111-1111-1111-111111111111'],
	anchor: '2026-01-01',
	truncated: false,
	liveKey: undefined,
	liveSlot: undefined,
	filters: EMPTY_FILTERS,
	sort: { field: 'title', dir: 'asc' as const },
	referenceOptions: {},
}

function render(data: Record<string, unknown> = loaderData): string {
	// `Link` and `useFetcher` need a router even on the server.
	const Stub = createRoutesStub([
		{
			path: '/',
			Component: () => (
				<ProjectListPage
					loaderData={
						data as unknown as Parameters<
							typeof ProjectListPage
						>[0]['loaderData']
					}
				/>
			),
		},
	])
	return renderToString(<Stub initialEntries={['/']} />)
}

describe('a filled `list` slot is handed the controller (#398)', () => {
	beforeEach(() => {
		captured = undefined
	})

	it('is mounted under the id derived from the resource and the role', () => {
		// The mock keys the fill as `book__list`; if the derivation moved, the
		// slot would silently stop mounting and every test below would pass
		// vacuously against the generated list instead.
		expect(blockSlotId({ resource: 'book', role: 'list' })).toBe('book__list')
		expect(render()).toContain('BESPOKE LIST')
	})

	it('replaces the rendering and keeps the resolved read state', () => {
		render()
		if (!captured) throw new Error('list slot was never rendered')
		expect(captured.rows).toEqual(loaderData.rows)
		expect(captured.columns.map((c) => c.name)).toEqual(['id', 'title'])
		expect(captured.rowHref(firstRow)).toBe(
			'/books/11111111-1111-1111-1111-111111111111',
		)
		// Sample rows stay marked. A bespoke list that cannot tell seeded data
		// apart un-marks it, which is a claim about the data, not a style.
		expect(captured.demoIds).toEqual(loaderData.demoIds)
	})

	it('is handed the declared actions and their runner, not just rows', () => {
		// The regression itself. Before #398 every assertion in this block was
		// `undefined`: the slot got rows, references, files, an href and an empty
		// state, and nothing that could write.
		render()
		if (!captured) throw new Error('list slot was never rendered')
		expect(captured.actions).toEqual([archive])
		expect(typeof captured.runAction).toBe('function')
		expect(captured.actionBusy).toBe(false)
		expect(captured.selectedIds).toEqual([])
		expect(typeof captured.onSelectedChange).toBe('function')
	})

	it('is handed the ordering the loader honoured, and a way to change it', () => {
		// Not the rows' own order: sorting is server-side because these rows are
		// one page of a table. A slot that re-sorted what arrived would reorder
		// the page and call it the list.
		render()
		if (!captured) throw new Error('list slot was never rendered')
		expect(captured.sort).toEqual({ field: 'title', dir: 'asc' })
		expect(typeof captured.onSort).toBe('function')
	})

	it('is handed the inline write paths and the permissions that gate them', () => {
		render()
		if (!captured) throw new Error('list slot was never rendered')
		expect(captured.editable).toEqual(['title'])
		expect(typeof captured.onCellSave).toBe('function')
		expect(captured.creatable).toEqual(['title'])
		expect(typeof captured.onRowCreate).toBe('function')
		// Delete is denied for this session, and the slot has to be able to tell:
		// the wall is the server either way, and an affordance whose every click
		// is refused is worse than none.
		expect(captured.can).toEqual({
			read: true,
			create: true,
			update: true,
			delete: false,
		})
	})

	it('hands over enough to render the stock action control', () => {
		// Sufficiency, not presence — the assertion the owned-route test ends on.
		// `RowActionButtons` is rendered by the *slot*, from the props it was
		// given, so a bespoke list keeps a declared action without owning one
		// line of the write path.
		expect(render()).toContain('Archive')
	})
})
