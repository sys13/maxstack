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
import {
	BoardView,
	type ColumnOverrides,
	EMPTY_FILTERS,
	type OwnedRouteProps,
	ResourceList,
} from '@maxstack/ui'
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
		/**
		 * What `maxstack add view <resource>` emits, since #356 — the same
		 * `OwnedRouteProps` contract, plus its one distinguishing feature: a
		 * `columns` override map merged *over* the inferred rendering rather
		 * than replacing it. Pinned as text in
		 * `apps/maxstack/src/commands/view.test.ts`; this is where it renders.
		 *
		 * `columns` is module-level in the emitted file; it is scoped here only
		 * because this test file already binds that name.
		 */
		note: ({ list }: OwnedRouteProps) => {
			const columns: ColumnOverrides = {
				title: ({ value }) => (
					<span className="font-medium">{String(value ?? '—')}</span>
				),
			}
			return (
				<ResourceList {...list} columns={{ ...list.columns, ...columns }} />
			)
		},
		// A module emitted by `maxstack add view` BEFORE #356: it takes no props
		// and mounts its own client-side stack. The runtime must keep rendering
		// it — it is user-owned code in a project that may never re-scaffold.
		relic: () => <p>the old view, still rendering</p>,
		/**
		 * Stage 2 of #349: exactly what `emitResourcePage` writes for a page the
		 * runtime arranges as a board — `{...view}` spread, the declaration
		 * inlined as literals, and **no option list and no move derivation**,
		 * because those are the write-side guard rather than a drawing decision.
		 * Pinned byte-wise in
		 * `packages/maxstack-core/src/ownership/ownership.test.ts`.
		 */
		card: (props: OwnedRouteProps) => {
			captured = props
			const { view } = props
			if (!view) return null
			return <BoardView {...view} groupField="status" rankField="rank" />
		},
		/**
		 * The ejected board of #392's repro: a project with a board at `/` and a
		 * calendar at `/due`, **both over `task`**. This is the board's module,
		 * and its key is the module key `maxstack gen` wrote it under — `task`,
		 * the first page over the resource. The calendar's module key is `due`,
		 * and it is not ejected, so nothing here answers to it.
		 *
		 * The marker is loud on purpose: the whole assertion is that this module
		 * never renders on the calendar's page.
		 */
		task: (props: OwnedRouteProps) => {
			captured = props
			return <p>EJECTED BOARD MODULE</p>
		},
	},
	OWNED_SCHEDULE_HANDLERS: {},
	OWNED_SOURCE_REFINERS: {},
	OWNED_IMPORT_PARSERS: {},
	OWNED_LIVE_SURFACES: {},
}))

const { default: ProjectListPage, viewMoveHandler } = await import(
	'./project.page'
)

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
	// The route module this page owns, and the key its ejected module is mounted
	// by. One page over `book`, so it is the bare resource (#392).
	moduleKey: 'book',
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
	filters: EMPTY_FILTERS,
	sort: undefined,
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

/**
 * A page whose rows carry the two things only the *loader* can produce: a
 * foreign key resolved to the referenced record's title, and a storage key
 * signed into a fetchable URL. Neither is derivable in the browser — signing
 * needs a secret — so a module that refetches its own rows over REST cannot
 * render either one, which is exactly what `add view` did before #356.
 */
const noteColumns: SproutColumn[] = [
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
	{
		name: 'author',
		type: 'uuid',
		nullable: true,
		hasDefault: false,
		isPrimaryKey: false,
		references: { table: 'person', column: 'id' },
		meta: {},
	},
	{
		name: 'attachment',
		type: 'string',
		nullable: true,
		hasDefault: false,
		isPrimaryKey: false,
		meta: { isFile: true },
	},
]

const notePage: ProjectRoute = {
	...page,
	slug: 'notes',
	route: '/notes',
	name: 'Notes',
	resource: 'note',
	moduleKey: 'note',
	resourceLabel: 'Note',
}

const noteLoaderData = {
	...loaderData,
	page: notePage,
	nav: [notePage],
	columns: noteColumns,
	rows: [
		{
			id: '33333333-3333-3333-3333-333333333333',
			title: 'On dragons',
			author: 'p-ursula',
			attachment: 'uploads/notes/dragons.pdf',
		},
	],
	references: { person: { 'p-ursula': 'Ursula Le Guin' } },
	files: {
		'uploads/notes/dragons.pdf': {
			url: 'https://files.example/dragons.pdf?sig=deadbeef',
			name: 'dragons.pdf',
		},
	},
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

	it('renders what `maxstack add view` emits, references and files included (#356)', () => {
		// The #356 regression, at the surface it was reported on. `add view` used
		// to emit a props-less module that refetched its rows over REST against a
		// frozen introspection literal — so the loader's `resolveRowReferences`
		// and `resolveRowFiles` output was computed, shipped, and thrown away:
		// the FK cell rendered a raw id and the file cell an unsigned key.
		const html = render(noteLoaderData)
		expect(html).toContain('On dragons')
		// The FK resolved to the referenced record's title, not `p-ursula`.
		expect(html).toContain('Ursula Le Guin')
		expect(html).not.toContain('p-ursula')
		// The storage key signed into a fetchable URL, not the key.
		expect(html).toContain('https://files.example/dragons.pdf?sig=deadbeef')
		expect(html).not.toContain('uploads/notes/dragons.pdf')
		// And the verb's own contribution — the `columns` override — applied on
		// top of that inference rather than in place of it.
		expect(html).toContain('font-medium')
	})

	it('keeps rendering a module emitted in the pre-#356 shape', () => {
		// The migration story, and there is deliberately nothing to migrate: an
		// `add view` module already on disk takes no props, so the props it is
		// now handed are ignored and it renders exactly as it always did. A shape
		// change in the emitter must never reach into code the user owns.
		const relicPage = {
			...page,
			resource: 'relic',
			moduleKey: 'relic',
			slug: 'relics',
		}
		const html = render({
			...loaderData,
			page: relicPage,
			nav: [relicPage],
		})
		expect(html).toContain('the old view, still rendering')
	})

	it('is handed the list controls too, as one element it need only place', () => {
		// Issue #342. Search, facets and CSV export existed, were tested, and were
		// mounted on `/admin` and the workbench — the two surfaces a generated
		// app's users never see. Wiring them into the framework's page alone
		// would have made an eject *cost* them, which is the third shape #356
		// just removed. So they come down on the props contract.
		//
		// An element rather than a prop bag because the wiring is the part an
		// owned page must not reimplement: filter state in the query string, read
		// back by the loader, search upgrading to the ranked index when the
		// resource declares one. The owner chooses only where it goes.
		render()
		if (!captured) throw new Error('owned route was never rendered')
		expect(captured.toolbar).toBeDefined()
		expect(renderToString(<>{captured.toolbar}</>)).toContain('Export CSV')
	})

	it('drives sorting from the props, not from the rows it was handed', () => {
		// A list page is the first 100 rows of a table, so sorting the array in
		// the browser reorders a page rather than the list. `onSort` is what puts
		// `<ResourceList>` in controlled mode and sends the ordering back to the
		// loader as a URL somebody can bookmark.
		render()
		if (!captured) throw new Error('owned route was never rendered')
		expect(typeof captured.list.onSort).toBe('function')
	})

	it('still frames the page and still surfaces refused writes', () => {
		// The chrome is not the page: nav and theme stay the framework's, and a
		// refused cell edit has to be visible whether or not the page was
		// ejected — no owned module should have to remember to render it.
		const html = render()
		expect(html).toContain('Reader')
	})
})

/**
 * Stage 2 of #349: the same handover for a page the runtime *arranges*.
 *
 * The hard half. A benchmark app whose home page is a board had literally zero
 * of its UI in generated code — `eject` handed over a placeholder that was
 * 100% of the module — because an owned page had no way to reach the rows, the
 * introspection, the paging links or the write path a board needs.
 */
describe('an ejected board is handed the board it owns (#349 stage 2)', () => {
	const boardColumns: SproutColumn[] = [
		...columns,
		{
			name: 'status',
			type: 'enum',
			nullable: false,
			hasDefault: true,
			isPrimaryKey: false,
			enumValues: ['to-read', 'done'],
			// The declared options, as the loader's introspection carries them.
			// These are the board's columns — see the assertion below.
			meta: {
				label: 'Status',
				options: [
					{ label: 'To read', value: 'to-read' },
					{ label: 'Done', value: 'done' },
				],
			},
		},
		{
			name: 'rank',
			type: 'string',
			nullable: true,
			hasDefault: false,
			isPrimaryKey: false,
			meta: {},
		},
	]

	const boardView = {
		kind: 'board' as const,
		groupField: 'status',
		rankField: 'rank',
		move: true,
		options: [
			{ label: 'To read', value: 'to-read' },
			{ label: 'Done', value: 'done' },
		],
	}

	const boardPage: ProjectRoute = {
		...page,
		slug: 'cards',
		route: '/cards',
		name: 'Cards',
		resource: 'card',
		moduleKey: 'card',
		resourceLabel: 'Card',
		editable: [],
		view: boardView,
	}

	const boardData = {
		...loaderData,
		page: boardPage,
		nav: [boardPage],
		columns: boardColumns,
		editable: [],
		rows: [
			{
				id: '11111111-1111-1111-1111-111111111111',
				title: 'Dune',
				status: 'to-read',
				rank: 'm',
			},
			{
				id: '22222222-2222-2222-2222-222222222222',
				title: 'Piranesi',
				status: 'done',
				rank: 'm',
			},
		],
	}

	beforeEach(() => {
		captured = undefined
	})

	it('is handed the view props, not just the list ones', () => {
		render(boardData)
		if (!captured) throw new Error('owned route was never rendered')
		const view = captured.view
		if (!view) throw new Error('owned board route was handed no view props')
		expect(view.rows).toEqual(boardData.rows)
		expect(view.resource).toMatchObject({ name: 'card', primaryKey: 'id' })
		expect(view.rowHref(boardData.rows[0] ?? {})).toBe(
			'/cards/11111111-1111-1111-1111-111111111111',
		)
		expect(typeof view.linkComponent).toBe('function')
		expect(view.anchor).toBe('2026-01-01')
		// A board has no time axis, so it is handed no period navigation — the
		// framework's own board renders none either.
		expect(view.paging).toBeNull()
		expect(view.notice).toBeNull()
	})

	it('draws the real cards, in the columns the enum declares', () => {
		// The whole point, one level past the list: the module is the board.
		const html = render(boardData)
		expect(html).toContain('Dune')
		expect(html).toContain('Piranesi')
		// …and the framework's own surface did not render alongside it.
		expect(html.match(/Dune/g)).toHaveLength(1)
		// The columns. Note where they come from: the emitted module inlines NO
		// option list, and `<BoardView>` resolves them from the grouping column's
		// introspected `meta.options`, which arrived in `{...view}`. That is why
		// inlining them would have bought nothing and cost a write-side guard.
		expect(html).toContain('To read')
		expect(html).toContain('Done')
	})

	it('is handed a move handler when the board declares one', () => {
		render(boardData)
		expect(typeof captured?.view?.onMove).toBe('function')
	})

	it('is handed none when the board does not', () => {
		// A read-only board stays the read-only thing it looks like, ejected or
		// not: the affordance follows the declaration, not the ownership. The
		// view props still arrive — it is the write that is absent, not the page.
		const readOnly = { ...boardPage, view: { ...boardView, move: false } }
		render({ ...boardData, page: readOnly, nav: [readOnly] })
		expect(captured?.view).toBeDefined()
		expect(captured?.view?.onMove).toBeUndefined()
	})

	/**
	 * The `options` snag from the stage-1 design note, answered.
	 *
	 * A board's declared options are read by exactly two things: `<BoardView>`,
	 * which does not need them (it reads the introspected column, asserted
	 * above), and `boardMoveValues`, which refuses a drop on a destination the
	 * enum does not declare. So they are NOT inlined into the owned module —
	 * that would move a write-side check into a file the user is invited to
	 * edit — and the handler that applies them stays in framework code, reached
	 * through `view.onMove`.
	 *
	 * The refusal that actually matters is the server's: the values below are
	 * submitted to the record's own edit route, so `opUpdate` runs the same enum
	 * validation, permission check, WIP limit and audit entry as a form save.
	 * There is no board endpoint, which is why an ejected board cannot widen the
	 * write surface no matter what its author writes in the file.
	 */
	it('refuses a drop on a destination the enum does not declare', () => {
		const submitted: { values: Record<string, string>; id: string }[] = []
		const handler = viewMoveHandler(boardView, boardData.rows, 'id', (v, id) =>
			submitted.push({ values: v, id }),
		)
		const row = boardData.rows[0] as Record<string, unknown>

		// A declared destination writes the grouping column, through the record's
		// ordinary edit route.
		handler?.onMove?.(row, { value: 'done', index: 0 })
		expect(submitted).toHaveLength(1)
		expect(submitted[0]?.values).toMatchObject({ status: 'done' })
		expect(submitted[0]?.id).toBe('11111111-1111-1111-1111-111111111111')

		// An undeclared one writes nothing at all — not an empty update, which
		// would still cost an audit entry.
		handler?.onMove?.(row, { value: 'archived', index: 0 })
		handler?.onMove?.(row, { value: '', index: 0 })
		expect(submitted).toHaveLength(1)
	})
})

/**
 * The surface the issue is actually about: the *generated* page, un-ejected.
 *
 * #342 was found by building the same app twice. The maxstack arm's entire
 * control surface was four elements — two nav links, "+ New" and "Edit" — over
 * a list of books that could not be searched, sorted or filtered, while the
 * 427-line hand-written arm had all of it. Every component needed already
 * existed in this repo and rendered three routes away.
 */
describe('the generated list page has the capabilities the admin has (#342)', () => {
	// A resource with no owned module, so the framework's own surface renders.
	const shelfPage: ProjectRoute = {
		...page,
		slug: 'shelf',
		route: '/shelf',
		name: 'Shelf',
		resource: 'shelf',
		moduleKey: 'shelf',
		resourceLabel: 'Book',
	}
	const shelfData = {
		...loaderData,
		page: shelfPage,
		nav: [shelfPage],
		columns: [
			...columns,
			{
				name: 'status',
				type: 'enum' as const,
				nullable: false,
				hasDefault: true,
				isPrimaryKey: false,
				enumValues: ['reading', 'finished'],
				meta: { label: 'Status' },
			},
		],
	}

	it('offers search, the derived facets and export', () => {
		const html = render(shelfData)
		// `reader`'s `status` enum would have produced shelf tabs for free: the
		// facet is derived from introspection, no op and no declaration.
		expect(html).toContain('Search')
		expect(html).toContain('Status')
		expect(html).toContain('Export CSV')
	})

	it('makes its column headers sort', () => {
		// `<ResourceList>` had rendered sortable headers for a year, gated on
		// `meta.sortable === true` — a key nothing ever wrote. So the capability
		// was implemented and unreachable on every list in the product.
		const html = render(shelfData)
		expect(html).toContain('aria-label="Sort by Title"')
	})

	it('says nothing matched rather than offering to seed an app that has rows', () => {
		// A filtered list that came back empty is not an empty app. "Add the
		// first book" is the wrong offer — there are books — and "load sample
		// data" is worse.
		const html = render({
			...shelfData,
			rows: [],
			filters: { search: 'zzz', filter: {} },
		})
		expect(html).toContain('No matches')
		expect(html).not.toContain('Add the first')
	})
})

/**
 * Two pages over one entity, one of them ejected (issue #392).
 *
 * `OWNED_ROUTES` is keyed by the **module** key — the manifest entry id the
 * generator wrote the module under, which since #337 is the resource only for
 * the *first* page over it. The mount looked the map up by `page.resource`, so
 * both pages over `task` resolved to the same entry: eject the board at `/` and
 * the calendar at `/due` rendered the board's module, under the board's own
 * heading, instead of its own surface. A user who ejects one page lost a page
 * they never touched.
 *
 * The repro is the real one from a live project, and the assertion is the
 * user-visible fact rather than the lookup: the calendar page still draws a
 * calendar.
 */
describe('an ejected module mounts on its own page only (#392)', () => {
	const taskColumns: SproutColumn[] = [
		...columns,
		{
			name: 'dueOn',
			type: 'date',
			nullable: true,
			hasDefault: false,
			isPrimaryKey: false,
			meta: { label: 'Due' },
		},
	]

	/** The board at `/`, ejected — module key `task` (the first page over it). */
	const boardPage: ProjectRoute = {
		...page,
		slug: '',
		route: '/',
		name: 'Board',
		resource: 'task',
		moduleKey: 'task',
		resourceLabel: 'Task',
		editable: [],
		view: {
			kind: 'board',
			groupField: 'title',
			move: false,
			options: [],
		},
	}

	/**
	 * The calendar at `/due`, NOT ejected — same resource, module key `due`. The
	 * key is what `pageModuleKeys` gives the second page over an entity: a stem
	 * of its own page id, not the resource.
	 */
	const calendarPage: ProjectRoute = {
		...page,
		slug: 'due',
		route: '/due',
		name: 'Due',
		resource: 'task',
		moduleKey: 'due',
		resourceLabel: 'Task',
		editable: [],
		view: {
			kind: 'calendar',
			dateField: 'dueOn',
			display: 'month',
			timezone: 'UTC',
			reschedule: false,
		},
	}

	const rows = [
		{
			id: '11111111-1111-1111-1111-111111111111',
			title: 'Dune',
			dueOn: '2026-01-14',
		},
	]

	const dataFor = (p: ProjectRoute) => ({
		...loaderData,
		page: p,
		nav: [boardPage, calendarPage],
		columns: taskColumns,
		editable: [],
		rows,
	})

	beforeEach(() => {
		captured = undefined
	})

	it('renders the calendar page as a calendar, not as the ejected board', () => {
		const html = render(dataFor(calendarPage))
		// The regression: before the fix this page mounted `OWNED_ROUTES.task`.
		expect(html).not.toContain('EJECTED BOARD MODULE')
		expect(captured).toBeUndefined()
		// …and its own surface is the one that rendered.
		expect(html).toContain('data-calendar-display="month"')
		expect(html).toContain('Dune')
	})

	it('still mounts the ejected module on the page that was ejected', () => {
		// The other half: keying by the module key must not stop an eject from
		// taking effect on its own page.
		const html = render(dataFor(boardPage))
		expect(html).toContain('EJECTED BOARD MODULE')
		expect(captured).toBeDefined()
	})
})
