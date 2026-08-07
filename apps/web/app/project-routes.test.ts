import {
	accept,
	manual,
	newSpecSystem,
	type PageSpec,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { pagePath } from './page-path'
import { getRoutes, matchProjectPath, resolveRoute } from './project-routes'

function specWith(pages: PageSpec[]): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	return { ...spec, pages: { pages } }
}

const subscriptions: PageSpec = {
	id: 'pg-subscriptions',
	name: 'Subscriptions',
	route: '/subscriptions',
	entityId: 'e-subscription',
	provenance: suggested(),
	blocks: [
		{ id: 'blk-table', type: 'table', provenance: suggested() },
		{ id: 'blk-renewals', type: 'slot:renewals', provenance: suggested() },
	],
}

const reading: PageSpec = {
	id: 'pg-reading',
	name: 'Reading List',
	route: '/reading',
	entityId: 'e-reading-item',
	provenance: suggested(),
	blocks: [{ id: 'blk-list', type: 'table', provenance: suggested() }],
}

describe('getRoutes', () => {
	it('derives one navigable route per page, mapping route→slug and entity→resource', () => {
		const routes = getRoutes(specWith([subscriptions, reading]))
		expect(routes).toEqual([
			{
				slug: 'subscriptions',
				route: '/subscriptions',
				name: 'Subscriptions',
				resource: 'subscription',
				resourceLabel: null,
				slots: ['renewals'],
				replacesList: null,
				order: null,
				variant: 'table',
				fields: null,
				editable: [],
				view: null,
			},
			{
				slug: 'reading',
				route: '/reading',
				name: 'Reading List',
				resource: 'reading-item',
				resourceLabel: null,
				slots: [],
				replacesList: null,
				order: null,
				variant: 'table',
				fields: null,
				editable: [],
				view: null,
			},
		])
	})

	/**
	 * Issue #302: inline editing is a declared capability, so the declaration has
	 * to survive the trip from the spec block to the running route. It defaults to
	 * `[]` rather than to null — "no cell is editable" and "this block said
	 * nothing" are the same fact, and a capability whose absence and emptiness
	 * read differently eventually gets treated as a tri-state.
	 */
	it("carries the block's inline-editable fields onto the route", () => {
		const editableList: PageSpec = {
			id: 'pg-tasks',
			name: 'Tasks',
			route: '/tasks',
			entityId: 'e-task',
			provenance: suggested(),
			blocks: [
				{
					id: 'blk-table',
					type: 'table',
					editable: ['title', 'status'],
					provenance: suggested(),
				},
			],
		}
		const [route] = getRoutes(specWith([editableList]))
		expect(route?.editable).toEqual(['title', 'status'])
		// A page that declared nothing is a read-only list, not an undefined one.
		expect(getRoutes(specWith([reading]))[0]?.editable).toEqual([])
	})

	/**
	 * Issue #317: a book app whose `/` is "Shelf" and whose `/reading-list` is
	 * "Reading list" backs both pages with one `book` entity. Nothing on the
	 * route said what a *row* was called, so every screen that needed the word
	 * used the page's name and told the user they were adding a shelf.
	 */
	it("carries the entity's display name beside the resource id", () => {
		const shelf: PageSpec = {
			id: 'pg-shelf',
			name: 'Shelf',
			route: '/',
			entityId: 'e-book',
			provenance: suggested(),
			blocks: [{ id: 'blk-shelf', type: 'table', provenance: suggested() }],
		}
		const readingList: PageSpec = {
			...shelf,
			id: 'pg-reading-list',
			name: 'Reading list',
			route: '/reading-list',
			blocks: [{ id: 'blk-rl', type: 'table', provenance: suggested() }],
		}
		const base = specWith([shelf, readingList])
		const spec: SpecSystem = {
			...base,
			data: {
				entities: [
					{
						id: 'e-book',
						name: 'Book',
						provenance: suggested(),
						fields: [],
					},
				],
			},
		}
		// One entity, two page names, one noun — and it is neither page's.
		expect(
			getRoutes(spec).map((r) => [r.name, r.resource, r.resourceLabel]),
		).toEqual([
			['Shelf', 'book', 'Book'],
			['Reading list', 'book', 'Book'],
		])
	})

	it('has no resource label for a page backed by no entity', () => {
		const about: PageSpec = {
			id: 'pg-about',
			name: 'About',
			route: '/about',
			provenance: suggested(),
			blocks: [],
		}
		const [route] = getRoutes(specWith([about]))
		expect(route?.resource).toBeNull()
		expect(route?.resourceLabel).toBeNull()
	})

	it("exposes a table block's order (spec-as-data ranking)", () => {
		const ranked: PageSpec = {
			...reading,
			blocks: [
				{
					id: 'blk-list',
					type: 'table',
					order: { field: 'points', direction: 'desc' },
					provenance: suggested(),
				},
			],
		}
		expect(getRoutes(specWith([ranked]))[0]?.order).toEqual({
			field: 'points',
			direction: 'desc',
		})
	})

	it("exposes a table block's presentation variant, defaulting to table", () => {
		const carded: PageSpec = {
			...reading,
			blocks: [
				{
					id: 'blk-list',
					type: 'table',
					variant: 'cards',
					provenance: suggested(),
				},
			],
		}
		expect(getRoutes(specWith([carded]))[0]?.variant).toBe('cards')
		expect(getRoutes(specWith([reading]))[0]?.variant).toBe('table')
	})

	it("exposes a table block's field selection, else null", () => {
		const selected: PageSpec = {
			...reading,
			blocks: [
				{
					id: 'blk-list',
					type: 'table',
					fields: ['title', 'rating', 'review'],
					provenance: suggested(),
				},
			],
		}
		expect(getRoutes(specWith([selected]))[0]?.fields).toEqual([
			'title',
			'rating',
			'review',
		])
		expect(getRoutes(specWith([reading]))[0]?.fields).toBeNull()
	})

	it('grounds pages accepted-else-all: once one page is accepted, suggested siblings drop out', () => {
		const spec = specWith([
			{ ...subscriptions, provenance: accept(suggested()) },
			reading, // still merely suggested
		])
		expect(getRoutes(spec).map((r) => r.slug)).toEqual(['subscriptions'])
	})

	it('treats a hand-added (manual) page as live — it counts as accepted', () => {
		const spec = specWith([
			{ ...subscriptions, provenance: accept(suggested()) },
			{ ...reading, provenance: manual() },
		])
		expect(getRoutes(spec).map((r) => r.slug)).toEqual([
			'subscriptions',
			'reading',
		])
	})

	it('resolves a slug to its page, and misses cleanly', () => {
		const spec = specWith([subscriptions, reading])
		expect(resolveRoute(spec, 'reading')?.resource).toBe('reading-item')
		expect(resolveRoute(spec, 'nope')).toBeUndefined()
	})

	it('tolerates a page with no backing entity (resource is null)', () => {
		const spec = specWith([{ ...reading, entityId: undefined, blocks: [] }])
		expect(getRoutes(spec)[0]?.resource).toBeNull()
	})
})

describe('replacesList', () => {
	const withSlot = (mode?: 'append' | 'replace'): SpecSystem =>
		specWith([
			{
				...reading,
				blocks: [
					{ id: 'blk-list', type: 'table', provenance: suggested() },
					{
						id: 'blk-shelf',
						type: 'slot:shelf',
						mode,
						provenance: suggested(),
					},
				],
			},
		])

	it('names the slot that replaces the default list', () => {
		expect(getRoutes(withSlot('replace'))[0]?.replacesList).toBe('shelf')
	})

	it('is null for an appending slot — the default', () => {
		// Both the explicit `append` and an omitted mode must leave the list in
		// place; replacement is strictly opt-in.
		expect(getRoutes(withSlot('append'))[0]?.replacesList).toBeNull()
		expect(getRoutes(withSlot())[0]?.replacesList).toBeNull()
	})

	it('still lists the replacing slot as a slot', () => {
		// The slot renders in its declared position; `replacesList` only decides
		// whether the table renders too.
		expect(getRoutes(withSlot('replace'))[0]?.slots).toEqual(['shelf'])
	})
})

describe('flag gating', () => {
	const gatedPage: PageSpec = { ...reading, flag: 'reading-v2' }
	const gatedBlock: PageSpec = {
		...subscriptions,
		blocks: [
			{ id: 'blk-table', type: 'table', provenance: suggested() },
			{
				id: 'blk-renewals',
				type: 'slot:renewals',
				flag: 'renewals-beta',
				provenance: suggested(),
			},
		],
	}

	it('composes a gated page only when the flag is on for the viewer', () => {
		const spec = specWith([subscriptions, gatedPage])
		expect(getRoutes(spec, { 'reading-v2': true }).map((r) => r.slug)).toEqual([
			'subscriptions',
			'reading',
		])
		expect(getRoutes(spec, { 'reading-v2': false }).map((r) => r.slug)).toEqual(
			['subscriptions'],
		)
	})

	it('404s the slug too, not just the nav entry — a hidden link is still typeable', () => {
		const spec = specWith([gatedPage])
		expect(resolveRoute(spec, 'reading', { 'reading-v2': true })?.name).toBe(
			'Reading List',
		)
		expect(
			resolveRoute(spec, 'reading', { 'reading-v2': false }),
		).toBeUndefined()
	})

	it('drops a gated block from the page it is on, leaving the page itself', () => {
		const spec = specWith([gatedBlock])
		expect(getRoutes(spec, { 'renewals-beta': true })[0]?.slots).toEqual([
			'renewals',
		])
		const off = getRoutes(spec, { 'renewals-beta': false })
		expect(off).toHaveLength(1)
		expect(off[0]?.slots).toEqual([])
	})

	it('treats an unknown or unevaluated flag as off — a forgotten context hides, never leaks', () => {
		// No values passed at all: the un-threaded caller case.
		expect(getRoutes(specWith([gatedPage]))).toEqual([])
		// A gate naming a flag that is not declared any more (a hand-edited spec).
		expect(getRoutes(specWith([gatedPage]), { 'other-flag': true })).toEqual([])
	})

	it('leaves ungated pages and blocks completely unaffected', () => {
		expect(getRoutes(specWith([subscriptions, reading]), {})).toEqual(
			getRoutes(specWith([subscriptions, reading])),
		)
	})
})

describe('date-arranged views', () => {
	const withCalendar: PageSpec = {
		...subscriptions,
		blocks: [
			{ id: 'blk-table', type: 'table', provenance: suggested() },
			{
				id: 'blk-cal',
				type: 'calendar',
				calendar: {
					dateField: 'renewsOn',
					display: 'month',
					timezone: 'America/New_York',
					reschedule: true,
				},
				provenance: suggested(),
			},
		],
	}

	it('resolves the first calendar block onto the route', () => {
		const route = getRoutes(specWith([withCalendar]))[0]
		expect(route?.view).toEqual({
			kind: 'calendar',
			dateField: 'renewsOn',
			display: 'month',
			timezone: 'America/New_York',
			reschedule: true,
		})
	})

	it('resolves a timeline block, dependency field and all', () => {
		const route = getRoutes(
			specWith([
				{
					...subscriptions,
					blocks: [
						{
							id: 'blk-gantt',
							type: 'timeline',
							timeline: {
								startField: 'startDate',
								endField: 'dueDate',
								timezone: 'UTC',
								dependsOn: 'blockedBy',
							},
							provenance: suggested(),
						},
					],
				},
			]),
		)[0]
		expect(route?.view).toMatchObject({
			kind: 'timeline',
			dependsOn: 'blockedBy',
		})
	})

	it('is null for an ordinary list page, and for a view block with no declaration', () => {
		expect(getRoutes(specWith([reading]))[0]?.view).toBeNull()
		// A hand-edited spec file can produce this; the op cannot. A calendar with
		// no date field is a blank grid, so it is skipped rather than rendered.
		expect(
			getRoutes(
				specWith([
					{
						...reading,
						blocks: [
							{ id: 'blk-cal', type: 'calendar', provenance: suggested() },
						],
					},
				]),
			)[0]?.view,
		).toBeNull()
	})

	it('drops a view whose block is rejected or gated off for the viewer', () => {
		const gated: PageSpec = {
			...withCalendar,
			blocks: [
				{
					...(withCalendar.blocks[1] as (typeof withCalendar.blocks)[number]),
					flag: 'planner',
				},
			],
		}
		expect(getRoutes(specWith([gated]), { planner: false })[0]?.view).toBeNull()
		expect(
			getRoutes(specWith([gated]), { planner: true })[0]?.view,
		).not.toBeNull()
	})
})

describe('board views', () => {
	/**
	 * A board needs its grouping field's *declared options* — they are the
	 * columns, and the write path checks a drop against them — so the spec has to
	 * carry the entity, not just the page.
	 */
	const specWithBoard = (page: PageSpec): SpecSystem => {
		const spec = specWith([page])
		return {
			...spec,
			data: {
				entities: [
					{
						id: 'e-subscription',
						name: 'Subscription',
						provenance: suggested(),
						fields: [
							{
								id: 'fld-status',
								name: 'status',
								type: 'enum',
								required: false,
								options: [
									{ label: 'Trial', value: 'trial' },
									{ label: 'Active', value: 'active' },
								],
								provenance: suggested(),
							},
							{
								id: 'fld-rank',
								name: 'boardRank',
								type: 'string',
								required: false,
								rank: true,
								provenance: suggested(),
							},
						],
					},
				],
			},
		}
	}

	const withBoard: PageSpec = {
		...subscriptions,
		blocks: [
			{ id: 'blk-table', type: 'table', provenance: suggested() },
			{
				id: 'blk-board',
				type: 'board',
				board: {
					groupField: 'status',
					rankField: 'boardRank',
					move: true,
				},
				provenance: suggested(),
			},
		],
	}

	it('resolves the board block with its columns already looked up', () => {
		expect(getRoutes(specWithBoard(withBoard))[0]?.view).toEqual({
			kind: 'board',
			groupField: 'status',
			rankField: 'boardRank',
			move: true,
			options: [
				{ label: 'Trial', value: 'trial' },
				{ label: 'Active', value: 'active' },
			],
		})
	})

	it('skips a board whose grouping column has no declared values', () => {
		// A hand-edited spec can produce this; the op cannot. Columns that were
		// "whatever is in the table" would appear and vanish with the data, so the
		// board is skipped rather than drawn as an empty frame.
		const spec = specWithBoard(withBoard)
		const [entity] = spec.data.entities
		const stripped: SpecSystem = {
			...spec,
			data: {
				entities: [
					{
						...(entity as NonNullable<typeof entity>),
						fields: [
							{
								...(entity?.fields[0] as NonNullable<
									typeof entity
								>['fields'][0]),
								options: undefined,
							},
						],
					},
				],
			},
		}
		expect(getRoutes(stripped)[0]?.view).toBeNull()
	})
})

describe('matchProjectPath', () => {
	// A page declares its own URL, and it may be more than one segment. The
	// router used to mount `:page`, `:page/new` and `:page/:id`, each of which
	// binds exactly one segment to the page — so a page declared at `/app/decks`
	// matched `:page/:id` as page `app` + record `decks` and 404'd on a page
	// nobody declared. Every page in every benchmark uses two segments, so no
	// benchmark app was reachable at all.
	const decks: PageSpec = {
		id: 'pg-decks',
		name: 'Decks',
		route: '/app/decks',
		entityId: 'e-subscription',
		provenance: suggested(),
		blocks: [{ id: 'blk-t', type: 'table', provenance: suggested() }],
	}

	it('resolves a multi-segment page and its record surfaces', () => {
		const spec = specWith([decks])
		expect(matchProjectPath(spec, '/app/decks')).toMatchObject({
			kind: 'list',
			page: { slug: 'app/decks' },
		})
		expect(matchProjectPath(spec, '/app/decks/new')).toMatchObject({
			kind: 'new',
			page: { slug: 'app/decks' },
		})
		expect(matchProjectPath(spec, '/app/decks/parse')).toMatchObject({
			kind: 'parse',
			page: { slug: 'app/decks' },
		})
		expect(matchProjectPath(spec, '/app/decks/42')).toMatchObject({
			kind: 'edit',
			page: { slug: 'app/decks' },
			id: '42',
		})
	})

	it('still resolves a single-segment page exactly as before', () => {
		const spec = specWith([subscriptions])
		expect(matchProjectPath(spec, '/subscriptions')).toMatchObject({
			kind: 'list',
		})
		expect(matchProjectPath(spec, '/subscriptions/new')).toMatchObject({
			kind: 'new',
		})
		expect(matchProjectPath(spec, '/subscriptions/7')).toMatchObject({
			kind: 'edit',
			id: '7',
		})
	})

	it('lets a declared page win over an interpretation of one', () => {
		// If the author declared a page at `/app/decks/new`, that is what the URL
		// means — not "create a deck". Guessing past a declaration is how a
		// declared route becomes unreachable, which is the defect being fixed.
		const literal: PageSpec = {
			...decks,
			id: 'pg-new',
			route: '/app/decks/new',
		}
		const match = matchProjectPath(specWith([decks, literal]), '/app/decks/new')
		expect(match).toMatchObject({
			kind: 'list',
			page: { slug: 'app/decks/new' },
		})
	})

	it('404s an undeclared path instead of inventing a page from it', () => {
		const spec = specWith([decks])
		// `app` alone is the head of a declared slug, not a page.
		expect(matchProjectPath(spec, '/app')).toBeUndefined()
		expect(matchProjectPath(spec, '/nope')).toBeUndefined()
		expect(matchProjectPath(spec, '/nope/1')).toBeUndefined()
	})

	it('does not match a page gated behind a flag that is off', () => {
		const gated: PageSpec = { ...decks, flag: 'beta' }
		const spec = specWith([gated])
		expect(
			matchProjectPath(spec, '/app/decks', { beta: false }),
		).toBeUndefined()
		expect(
			matchProjectPath(spec, '/app/decks/1', { beta: false }),
		).toBeUndefined()
		expect(matchProjectPath(spec, '/app/decks', { beta: true })).toMatchObject({
			kind: 'list',
		})
	})

	it('decodes a percent-encoded record id', () => {
		expect(
			matchProjectPath(specWith([decks]), '/app/decks/a%2Fb'),
		).toMatchObject({ kind: 'edit', id: 'a/b' })
	})
})

describe('a page declared at the root', () => {
	// The same defect as #251/#252 one more level out: `/` is a legitimate route
	// for a page to declare — for most apps the natural one — and it used to be
	// composed into the nav, linked to, and then served the platform's landing
	// page instead. The router half of that fix is `routes/home.tsx` asking the
	// spec first; this is the resolution half.
	const root: PageSpec = {
		id: 'pg-root',
		name: 'Decks',
		route: '/',
		entityId: 'e-subscription',
		provenance: suggested(),
		blocks: [{ id: 'blk-t', type: 'table', provenance: suggested() }],
	}

	it('collapses `/` to the empty slug', () => {
		expect(getRoutes(specWith([root]))[0]).toMatchObject({
			slug: '',
			route: '/',
		})
	})

	it('resolves the root and its single-segment record surfaces', () => {
		const spec = specWith([root])
		expect(matchProjectPath(spec, '/')).toMatchObject({
			kind: 'list',
			page: { slug: '' },
		})
		expect(matchProjectPath(spec, '')).toMatchObject({ kind: 'list' })
		expect(matchProjectPath(spec, '/new')).toMatchObject({
			kind: 'new',
			page: { slug: '' },
		})
		expect(matchProjectPath(spec, '/parse')).toMatchObject({ kind: 'parse' })
		expect(matchProjectPath(spec, '/42')).toMatchObject({
			kind: 'edit',
			page: { slug: '' },
			id: '42',
		})
	})

	it('reads a single segment as a record only when a root page exists', () => {
		// Without a page at `/`, the root interpretation is never reached and an
		// undeclared single-segment path 404s exactly as it did before.
		const spec = specWith([subscriptions])
		expect(matchProjectPath(spec, '/')).toBeUndefined()
		expect(matchProjectPath(spec, '/42')).toBeUndefined()
		expect(matchProjectPath(spec, '/new')).toBeUndefined()
	})

	it('still lets a declared page win over a record on the root', () => {
		const spec = specWith([root, subscriptions])
		expect(matchProjectPath(spec, '/subscriptions')).toMatchObject({
			kind: 'list',
			page: { slug: 'subscriptions' },
		})
	})

	it('does not serve the root to a viewer its flag is off for', () => {
		const spec = specWith([{ ...root, flag: 'beta' }])
		expect(matchProjectPath(spec, '/', { beta: false })).toBeUndefined()
		// And the single-segment reading goes with it — otherwise `/42` would
		// reach a page the viewer cannot see.
		expect(matchProjectPath(spec, '/42', { beta: false })).toBeUndefined()
		expect(matchProjectPath(spec, '/', { beta: true })).toMatchObject({
			kind: 'list',
		})
	})

	it('404s a single segment that cannot be a record id', () => {
		// The regression this guards: with a page at `/` — the shape `maxstack
		// init` scaffolds — every undeclared single-segment path became a record
		// lookup, reached the store and died there, so the app had no 404 at all
		// and every typo was a 500.
		const spec = specWith([root])
		expect(matchProjectPath(spec, '/nonsense')).toBeUndefined()
		expect(matchProjectPath(spec, '/books')).toBeUndefined()
		expect(matchProjectPath(spec, '/pricing')).toBeUndefined()
		// Not a uuid, just uuid-ish: still a word as far as the store is concerned.
		expect(
			matchProjectPath(spec, '/00000000-0000-0000-0000-00000000000'),
		).toBeUndefined()
	})

	it('still opens a record whose id is shaped like a key', () => {
		// The other direction: the narrowing must not cost the legitimate case.
		const spec = specWith([root])
		const uuid = '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607'
		expect(matchProjectPath(spec, `/${uuid}`)).toMatchObject({
			kind: 'edit',
			page: { slug: '' },
			id: uuid,
		})
		expect(matchProjectPath(spec, '/42')).toMatchObject({
			kind: 'edit',
			id: '42',
		})
		expect(matchProjectPath(spec, '/new')).toMatchObject({ kind: 'new' })
		expect(matchProjectPath(spec, '/parse')).toMatchObject({ kind: 'parse' })
	})

	it('leaves a declared page own record space unnarrowed', () => {
		// Only the *root* reading competes with the app's whole URL space. Under a
		// declared page the author asked for the record space, so a text primary
		// key keeps working there.
		const spec = specWith([root, subscriptions])
		expect(matchProjectPath(spec, '/subscriptions/abc')).toMatchObject({
			kind: 'edit',
			page: { slug: 'subscriptions' },
			id: 'abc',
		})
	})

	it('treats a trailing slash as the same page, not a new one', () => {
		expect(
			matchProjectPath(specWith([subscriptions]), '/subscriptions/'),
		).toMatchObject({
			kind: 'list',
			page: { slug: 'subscriptions' },
		})
	})
})

describe('pagePath', () => {
	it('builds URLs under an ordinary page', () => {
		expect(pagePath('decks')).toBe('/decks')
		expect(pagePath('decks', 'new')).toBe('/decks/new')
		expect(pagePath('app/decks', '42')).toBe('/app/decks/42')
	})

	it('never produces a protocol-relative URL for the root page', () => {
		// `/${''}/new` is `//new`, which a browser resolves as `https://new/` —
		// an off-site navigation rather than a broken in-app link. This is the
		// whole reason the helper exists.
		expect(pagePath('')).toBe('/')
		expect(pagePath('', 'new')).toBe('/new')
		expect(pagePath('', '42')).toBe('/42')
	})
})
