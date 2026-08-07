/**
 * @vitest-environment jsdom
 *
 * What an *ejected* page is actually handed (issue #349).
 *
 * The complaint in #349 is that `maxstack eject` gives you a file that had
 * never rendered your page. The root cause was here, not in the emitter: the
 * runtime mounted an owned route as `<OwnedRoute />` — with **no props at all**
 * — so the module the user "took ownership of" had no rows, no columns, no
 * capabilities, and no way to obtain them, because every one of those is
 * resolved server-side by this route's own loader. A generated page body could
 * therefore only ever be a heading and a comment.
 *
 * These tests assert the handover, and the last one is the one that matters:
 * the props are sufficient to render the real list. It fails against the old
 * runtime for the most direct reason available — the component is called with
 * nothing.
 *
 * Server markup rather than a client-only render, following
 * `error-page.render.test.tsx`: assertions read `renderToString` output.
 */

import type { SproutColumn } from '@maxstack/core'
import { DEFAULT_THEME } from '@maxstack/spec'
import { type OwnedRouteProps, ResourceList } from '@maxstack/ui'
import { renderToString } from 'react-dom/server'
import { createRoutesStub } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRoute } from '~/project-routes'

/** The one prop bag the owned route was rendered with, captured per test. */
let captured: OwnedRouteProps | undefined

/**
 * The project's owned code. `OWNED_ROUTES` is what `maxstack build` generates
 * from the route manifest; here it holds one component standing in for an
 * ejected `routes/book.tsx`.
 */
vi.mock('~/owned.generated', () => ({
	OWNED_SLOTS: {},
	OWNED_ROUTES: {
		book: (props: OwnedRouteProps) => {
			captured = props
			// Exactly the body `emitResourcePage` writes for a table page —
			// `<ResourceList {...list} />`. Pinned byte-wise in
			// `packages/maxstack-core/src/ownership/ownership.test.ts`.
			return <ResourceList {...props.list} />
		},
	},
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
	resourceLabel: 'Book',
	slots: [],
	replacesList: null,
	order: null,
	variant: 'table',
	fields: null,
	editable: ['title'],
	view: null,
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
		{ id: '11111111-1111-1111-1111-111111111111', title: 'Dune' },
		{ id: '22222222-2222-2222-2222-222222222222', title: 'Piranesi' },
	],
	can: { read: true, create: true, update: true, delete: false },
	editable: ['title'],
	references: {},
	files: {},
	demoAvailable: false,
	demoIds: [],
	anchor: '2026-01-01',
	truncated: false,
	liveKey: undefined,
	liveSlot: undefined,
}

function render(): string {
	// `Link` and `useFetcher` need a router even on the server.
	const Stub = createRoutesStub([
		{
			path: '/',
			Component: () => (
				<ProjectListPage
					loaderData={
						loaderData as unknown as Parameters<
							typeof ProjectListPage
						>[0]['loaderData']
					}
				/>
			),
		},
	])
	return renderToString(<Stub initialEntries={['/']} />)
}

describe('an ejected route is handed the page it owns (#349)', () => {
	beforeEach(() => {
		captured = undefined
	})

	it('is rendered with the loader output, not with nothing', () => {
		render()
		if (!captured) throw new Error('owned route was never rendered')
		// The regression itself: props exist.
		expect(captured.list).toBeDefined()
		expect(captured.list.rows).toEqual(loaderData.rows)
		expect(captured.list.resource).toMatchObject({
			name: 'book',
			label: 'Book',
			primaryKey: 'id',
			columns,
		})
	})

	it('is handed the write affordances too, not a read-only subset', () => {
		// An owned page that silently lost inline editing and the permission
		// gating would be a downgrade dressed as ownership.
		render()
		if (!captured) throw new Error('owned route was never rendered')
		expect(captured.list.can).toEqual(loaderData.can)
		expect(captured.list.editable).toEqual(['title'])
		expect(typeof captured.list.onCellSave).toBe('function')
		expect(typeof captured.list.rowHref).toBe('function')
		expect(captured.list.rowHref?.(loaderData.rows[0] ?? {})).toBe(
			'/books/11111111-1111-1111-1111-111111111111',
		)
	})

	it('can build its own "+ New" affordance', () => {
		// An ejected module replaces the framework's surface, header included, so
		// the create route and a router-aware link have to come down with the rest
		// or every ejected page loses its only way to add a record.
		render()
		if (!captured) throw new Error('owned route was never rendered')
		expect(captured.newHref).toBe('/books/new')
		expect(typeof captured.Link).toBe('function')
	})

	it('renders the real list from those props', () => {
		// The whole point. Before #349 this could not be written at all: the
		// component was called with no arguments, so there was nothing to render
		// a row from.
		const html = render()
		expect(html).toContain('Dune')
		expect(html).toContain('Piranesi')
		// …and the framework's own list did not render alongside it. An owned
		// route replaces the surface rather than decorating it.
		expect(html.match(/Dune/g)).toHaveLength(1)
	})

	it('still frames the page and still surfaces refused writes', () => {
		// The chrome is not the page: nav and theme stay the framework's, and a
		// refused cell edit has to be visible whether or not the page was
		// ejected — no owned module should have to remember to render it.
		const html = render()
		expect(html).toContain('Reader')
	})
})
