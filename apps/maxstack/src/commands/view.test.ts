/**
 * `maxstack add view <resource>` — the infer-then-eject verb (Plan v5 task 36).
 * Proves it scaffolds an *owned* view, flips the route to `ejected`, and that a
 * subsequent `gen` skips it so cell edits survive regeneration (the task's exit
 * criterion).
 *
 * Since #356 it also pins the *shape*: an owned route module on the same
 * `OwnedRouteProps` contract `maxstack eject` emits against, not a props-less
 * module that refetches over REST behind a loader that already ran. The
 * assertions that the frozen introspection literal and the `useList` call are
 * gone are the regression itself — that literal drifted from the schema and
 * that refetch dropped the loader's resolved references and signed file URLs.
 * That the emitted body actually renders those two things is proven where it
 * can be rendered: `apps/web/app/routes/project.page.owned-route.test.tsx`.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { minimalPRD, newSpecSystem, type SpecSystem } from '@maxstack/spec'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderViewModule, resolveView } from '../lib/view.ts'
import { genCommand } from './gen.ts'
import { initCommand } from './init.ts'
import { opCommand } from './op.ts'
import { addViewCommand } from './view.ts'

const provenance = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}

const entityOp = JSON.stringify({
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-post',
			name: 'Post',
			description: 'A blog post',
			provenance,
			fields: [
				{
					id: 'fld-title',
					name: 'title',
					type: 'string',
					required: true,
					provenance,
				},
				{
					id: 'fld-body',
					name: 'body',
					type: 'string',
					required: false,
					provenance,
				},
				{
					id: 'fld-views',
					name: 'views',
					type: 'number',
					required: false,
					provenance,
				},
				{
					id: 'fld-published',
					name: 'published',
					type: 'boolean',
					required: false,
					provenance,
				},
			],
		},
	},
})

const pageOp = JSON.stringify({
	op: 'page.addPage',
	args: {
		page: {
			id: 'pg-posts',
			name: 'Posts',
			route: '/posts',
			entityId: 'e-post',
			provenance: { ...provenance, priority: 'high' },
			blocks: [{ id: 'blk-table', type: 'table', provenance }],
			e2eTests: ['the posts table lists every post'],
		},
	},
})

function specWithPost(): SpecSystem {
	const spec = newSpecSystem(
		minimalPRD({
			title: 'Blog',
			tldr: 'a blog',
			problem: 'people want to write',
			northStar: 'weekly writers',
			persona: 'the author',
			differentiation: 'grown safely',
		}),
	)
	spec.data.entities.push({
		id: 'e-post',
		name: 'Post',
		description: 'A blog post',
		provenance,
		fields: [
			{
				id: 'fld-title',
				name: 'title',
				type: 'string',
				required: true,
				provenance,
			},
			{
				id: 'fld-views',
				name: 'views',
				type: 'number',
				required: false,
				provenance,
			},
		],
	})
	return spec
}

describe('resolveView / renderViewModule (pure)', () => {
	it('introspects a resource and emits an owned module on the OwnedRouteProps contract', () => {
		const view = resolveView(specWithPost(), 'post')
		expect(view.resource).toBe('post')
		expect(view.pascal).toBe('Post')
		expect(view.titleField).toBe('title')
		// id + the two declared fields.
		expect(view.introspection.columns.map((c) => c.name)).toEqual([
			'id',
			'title',
			'views',
		])

		const src = renderViewModule(view)
		// It is an owned ROUTE module, on the same contract `maxstack eject`
		// emits against (#356): the loader's payload arrives as props and the
		// list is drawn by spreading it.
		expect(src).toContain(
			'export default function PostView({\n\tlist,\n\tnewHref,\n\ttoolbar,\n\tLink,\n}: OwnedRouteProps)',
		)
		// The list's control bar reaches an `add view` module on the same prop,
		// in the same place, as an ejected one (#342/#356).
		expect(src).toContain('{toolbar}')
		expect(src).toContain('type OwnedRouteProps')
		expect(src).toContain(
			'<ResourceList {...list} columns={{ ...list.columns, ...columns }} />',
		)
		// The eject seam survives, as an override merged over inference — not as
		// a replacement for it.
		expect(src).toContain('const columns: ColumnOverrides = {')
		expect(src).toContain('title: ({ value }) => (')
		// The frozen introspection literal is GONE, not moved. It was a copy of a
		// shape the loader computes live, so it went stale the moment a field was
		// added; `list.resource` is introspected per request.
		expect(src).not.toContain('satisfies IntrospectedResource')
		expect(src).not.toContain('"name": "title"')
		expect(src).not.toContain('primaryKey')
		// …and so is the client refetch behind a loader that already fetched, and
		// the duplicate provider stack it needed.
		expect(src).not.toContain('useList')
		expect(src).not.toContain('DataProvider')
		expect(src).not.toContain('NotificationProvider')
		expect(src).not.toContain('createRestDataProvider')
	})

	it('omits the override map entirely for a resource with no title field', () => {
		// Nothing to demonstrate the seam on, so no dangling empty literal and no
		// `ColumnOverrides` import to lint as unused — just the shared body.
		const src = renderViewModule({
			resource: 'post',
			pascal: 'Post',
			introspection: { name: 'post' } as never,
		})
		expect(src).toContain('<ResourceList {...list} />')
		expect(src).not.toContain('ColumnOverrides')
		expect(src).not.toContain('columns=')
	})

	it('never picks an FK column as the titleField', () => {
		// The issue's shape: item's *first* string field is its category FK — the
		// scaffolded title cell must land on `name`, not render a raw uuid.
		const spec = specWithPost()
		spec.data.entities.push(
			{
				id: 'e-category',
				name: 'Category',
				description: 'A gear category',
				provenance,
				fields: [
					{
						id: 'fld-cat-name',
						name: 'name',
						type: 'string',
						required: true,
						provenance,
					},
				],
			},
			{
				id: 'e-item',
				name: 'Item',
				description: 'A piece of gear',
				provenance,
				fields: [
					{
						id: 'fld-item-category',
						name: 'category',
						type: 'string',
						required: true,
						reference: 'e-category',
						provenance,
					},
					{
						id: 'fld-item-name',
						name: 'name',
						type: 'string',
						required: true,
						provenance,
					},
				],
			},
		)
		expect(resolveView(spec, 'item').titleField).toBe('name')
	})

	it('throws with the known list for an unknown resource', () => {
		expect(() => resolveView(specWithPost(), 'nope')).toThrow(
			/unknown resource "nope"/,
		)
	})

	// #360: the emitter hardcoded `ResourceList`, so scaffolding a view onto a
	// page the spec declares as `cards` or `feed` silently rewrote it as a table
	// — the quiet cousin of the board downgrade the command already warns about.
	it("emits the page's declared list variant, not always a table", () => {
		const view = resolveView(specWithPost(), 'post')

		const cards = renderViewModule(view, { variant: 'cards' })
		expect(cards).toContain('CardGrid')
		expect(cards).not.toContain('ResourceList')
		// Sorted on the binding rather than the `type ` prefix, so the scaffold's
		// first `lint --write` is a no-op.
		expect(cards).toContain(
			"import {\n\tCardGrid,\n\ttype ColumnOverrides,\n\ttype OwnedRouteProps,\n} from '@maxstack/ui'",
		)

		const feed = renderViewModule(view, { variant: 'feed' })
		expect(feed).toContain('FeedList')
		expect(feed).not.toContain('ResourceList')

		// An absent surface (no page yet) and an explicit table both stay a table.
		expect(renderViewModule(view)).toContain('<ResourceList {...list}')
		expect(renderViewModule(view, { variant: 'table' })).toContain(
			'<ResourceList {...list}',
		)
	})

	it("passes a card/feed page's declared field subset through", () => {
		const view = resolveView(specWithPost(), 'post')
		const src = renderViewModule(view, {
			variant: 'cards',
			fields: ['title', 'views'],
		})
		expect(src).toContain('primaryField="title"')
		expect(src).toContain("secondaryFields={['title', 'views']}")
		// …and the column override still merges over the inferred cells.
		expect(src).toContain('columns={{ ...list.columns, ...columns }}')

		// A table's columns come from introspection, so a field list there would be
		// a literal standing in for something the loader computes live.
		const table = renderViewModule(view, {
			variant: 'table',
			fields: ['title', 'views'],
		})
		expect(table).not.toContain('primaryField')
		expect(table).not.toContain('secondaryFields')
	})
})

describe('maxstack add view (integration)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-view-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a blog' })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp })
		await genCommand(dir)
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('scaffolds an owned view and flips the route to ejected', async () => {
		await addViewCommand(dir, 'post')
		const file = join(dir, 'app/routes/post.tsx')
		const src = await readFile(file, 'utf8')
		expect(src).toContain('THIS FILE IS YOURS')
		expect(src).toContain('<ResourceList {...list}')
		// The `published` field is not baked into this file at all — the loader
		// introspects it per request, so adding a field to the spec later shows
		// up here without an edit (#356).
		expect(src).not.toContain('published')

		const manifest = JSON.parse(
			await readFile(join(dir, 'app/.generated.routes.json'), 'utf8'),
		)
		const entry = manifest.entries.find((e: { id: string }) => e.id === 'post')
		expect(entry.ownership).toBe('ejected')
		expect(entry.file).toBe('routes/post.tsx')
		// Reused the route path the generator had recorded.
		expect(entry.routePath).toBe('/posts')
	})

	it('warns with a page.addPage fix when no spec page targets the resource', async () => {
		// `e-orphan` exists in the data layer but no page points at it — the view
		// would 404 in dev, so the command must say so and hand over the fix.
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-orphan',
						name: 'Orphan',
						description: 'no page targets this',
						provenance,
						fields: [
							{
								id: 'fld-orphan-name',
								name: 'name',
								type: 'string',
								required: true,
								provenance,
							},
						],
					},
				},
			}),
		})
		const log = vi.mocked(console.log)
		log.mockClear()
		await addViewCommand(dir, 'orphan')
		const out = log.mock.calls.flat().join('\n')
		expect(out).toContain('no accepted page in the spec targets "orphan"')
		expect(out).toContain('"op":"page.addPage"')
		expect(out).toContain('"entityId":"e-orphan"')
	})

	it('does not warn when a page already targets the resource', async () => {
		const log = vi.mocked(console.log)
		log.mockClear()
		// `--force`, because "post" is already scaffolded by the test above and a
		// second run is now refused (#360). That is the point of this file's
		// never-clobber block below; here it is only how we reach the log again.
		await addViewCommand(dir, 'post', { force: true })
		const out = log.mock.calls.flat().join('\n')
		expect(out).not.toContain('no accepted page')
		expect(out).not.toContain('renders a TABLE')
	})

	it('warns when the page it would render at is arranged by a view block', async () => {
		// The one case `add view` reaches that `maxstack eject` refuses. The props
		// contract still serves it — `project.page.tsx` builds the list props
		// before the owned-route branch whatever the page's arrangement is — so
		// the emitted module renders. It renders a *table*, though, because an
		// owned module replaces the page's whole surface, and trading a working
		// board for a table silently is the same foot-gun #349 made eject name.
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-sprint',
						name: 'Sprint',
						description: 'a unit of work',
						provenance,
						fields: [
							{
								id: 'fld-sprint-name',
								name: 'name',
								type: 'string',
								required: true,
								provenance,
							},
							{
								id: 'fld-sprint-status',
								name: 'status',
								type: 'enum',
								required: true,
								// The declared options are what make this a board at all:
								// they are its columns, and the runtime skips a board
								// whose grouping field has none — rendering the page as a
								// plain list, which is not a case worth warning about.
								options: [
									{ label: 'Todo', value: 'todo' },
									{ label: 'Done', value: 'done' },
								],
								provenance,
							},
						],
					},
				},
			}),
		})
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-sprint-board',
						name: 'Sprint board',
						route: '/sprints',
						entityId: 'e-sprint',
						provenance,
						blocks: [
							{
								id: 'blk-board',
								type: 'board',
								board: { groupField: 'status' },
								provenance,
							},
						],
					},
				},
			}),
		})
		const log = vi.mocked(console.log)
		log.mockClear()
		await addViewCommand(dir, 'sprint')
		const out = log.mock.calls.flat().join('\n')
		expect(out).toContain('"Sprint board"')
		expect(out).toContain('renders a TABLE')
		// …and it is a warning, not a refusal: the file still lands.
		expect(
			await readFile(join(dir, 'app/routes/sprint.tsx'), 'utf8'),
		).toContain('OwnedRouteProps')
	})

	it('editing a column survives regeneration (the exit criterion)', async () => {
		const file = join(dir, 'app/routes/post.tsx')
		const edited = (await readFile(file, 'utf8')).replace(
			'font-medium',
			'font-black uppercase',
		)
		expect(edited).toContain('font-black uppercase')
		await writeFile(file, edited)

		await genCommand(dir)

		// The gen pass left the owned view untouched.
		expect(await readFile(file, 'utf8')).toContain('font-black uppercase')
	})
})

/**
 * Never-clobber (issue #360).
 *
 * `maxstack gen` skipping an ejected route was already proven above. The hole
 * was that `add view` itself wrote with a bare `fs.write`, so the one command
 * whose output says THIS FILE IS YOURS was also the one command that would
 * silently overwrite it — on the very re-run #356 made the documented upgrade
 * path from the old props-less module to the loader-fed one.
 *
 * Its own project so the assertions do not depend on how many times the
 * integration block above scaffolded.
 */
describe('maxstack add view never-clobbers (issue #360)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-view-own-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a blog' })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp })
		await genCommand(dir)
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('refuses a second run and leaves the edited file byte-for-byte', async () => {
		const file = join(dir, 'app/routes/post.tsx')
		await addViewCommand(dir, 'post')

		// The user then owns it — the whole point of the verb. Two edits: one in
		// the demonstrated cell override, one a hand-written helper the scaffold
		// would never re-emit, so a clobber cannot be mistaken for a no-op diff.
		const mine = `${(await readFile(file, 'utf8')).replace(
			'font-medium',
			'font-black uppercase tracking-tight',
		)}\nexport function myHelper() {\n\treturn 'irreplaceable'\n}\n`
		await writeFile(file, mine)
		const before = await readFile(file)

		await expect(addViewCommand(dir, 'post')).rejects.toThrow(
			/refusing to overwrite .*post\.tsx — you own it/,
		)

		// Byte-for-byte, not "contains my edit": a partial rewrite that happened to
		// keep one string would pass the weaker assertion.
		expect(await readFile(file)).toEqual(before)
		// …and the manifest entry it would have re-flipped is untouched too.
		const manifest = JSON.parse(
			await readFile(join(dir, 'app/.generated.routes.json'), 'utf8'),
		)
		expect(
			manifest.entries.find((e: { id: string }) => e.id === 'post').ownership,
		).toBe('ejected')
	})

	it('names the opt-in in the refusal, and --force takes it', async () => {
		const file = join(dir, 'app/routes/post.tsx')
		await expect(addViewCommand(dir, 'post')).rejects.toThrow(
			/maxstack add view post .*--force/s,
		)

		// The escape hatch works, and only it does. This is the documented upgrade
		// path from a stale scaffold shape, so it must exist — but it has to be
		// said out loud, which is the entire fix.
		await addViewCommand(dir, 'post', { force: true })
		const src = await readFile(file, 'utf8')
		expect(src).not.toContain('myHelper')
		expect(src).toContain('THIS FILE IS YOURS')
	})

	it('refuses a file the manifest does not know about at all', async () => {
		// Never generated, never scaffolded — somebody hand-wrote a route module.
		// There is no manifest entry to consult, so an ownership check that only
		// read the manifest would clobber it. Presence on disk is the claim.
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-note',
						name: 'Note',
						description: 'a note',
						provenance,
						fields: [
							{
								id: 'fld-note-title',
								name: 'title',
								type: 'string',
								required: true,
								provenance,
							},
						],
					},
				},
			}),
		})
		const file = join(dir, 'app/routes/note.tsx')
		await writeFile(file, '// hand-written, tracked by nothing\n')
		const before = await readFile(file)

		await expect(addViewCommand(dir, 'note')).rejects.toThrow(
			/refusing to overwrite/,
		)
		expect(await readFile(file)).toEqual(before)
	})

	it('still writes over the framework-generated module (infer-then-eject)', async () => {
		// The case that must NOT be refused: `gen` wrote this route, so the bytes
		// being replaced are the generator's own. Scaffolding over them is the
		// workflow, not a clobber — the same distinction `writeGenerated` draws.
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-draft',
						name: 'Draft',
						description: 'a draft',
						provenance,
						fields: [
							{
								id: 'fld-draft-title',
								name: 'title',
								type: 'string',
								required: true,
								provenance,
							},
						],
					},
				},
			}),
		})
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-drafts',
						name: 'Drafts',
						route: '/drafts',
						entityId: 'e-draft',
						provenance,
						blocks: [{ id: 'blk-draft-table', type: 'table', provenance }],
					},
				},
			}),
		})
		await genCommand(dir)
		const generated = join(dir, 'app/routes/draft.tsx')
		expect(await readFile(generated, 'utf8')).toContain('AUTO-GENERATED')

		await addViewCommand(dir, 'draft')
		expect(await readFile(generated, 'utf8')).toContain('THIS FILE IS YOURS')
	})

	it("emits the page's declared variant end-to-end (issue #360)", async () => {
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'page.setBlockVariant',
				args: {
					pageId: 'pg-drafts',
					blockId: 'blk-draft-table',
					variant: 'cards',
				},
			}),
		})
		await addViewCommand(dir, 'draft', { force: true })
		const src = await readFile(join(dir, 'app/routes/draft.tsx'), 'utf8')
		expect(src).toContain('<CardGrid {...list}')
		expect(src).not.toContain('ResourceList')
	})
})

/**
 * Page-scoped targeting (issue #434).
 *
 * `add view` used to take a *resource* and key its manifest entry by it, while
 * everything else in the ownership path — eject, the manifest, `OWNED_ROUTES`,
 * the never-clobber writer — is keyed by the page's module key. Those agree only
 * when an entity has exactly one page. On a second page the verb had no argument
 * that could reach it: before #392 the resource-keyed entry hijacked every page
 * over the entity, and after #392 it silently landed on the first.
 *
 * Two pages over one entity is therefore the whole fixture. The load-bearing
 * assertion is not that the second page got a module — it is that the FIRST
 * page's module is byte-for-byte what `gen` left there.
 */
describe('maxstack add view targets a page, not a resource (issue #434)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-view-page-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a blog' })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp })
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-post-archive',
						name: 'Archive',
						route: '/archive',
						entityId: 'e-post',
						provenance,
						blocks: [{ id: 'blk-archive-table', type: 'table', provenance }],
					},
				},
			}),
		})
		await genCommand(dir)
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	const manifestOf = async () =>
		JSON.parse(
			await readFile(join(dir, 'app/.generated.routes.json'), 'utf8'),
		) as {
			entries: {
				id: string
				file: string
				routePath: string
				ownership: string
			}[]
		}

	it('gen wrote two modules — the second under its own module key (#337)', async () => {
		const entries = (await manifestOf()).entries
		expect(entries.find((e) => e.id === 'post')?.file).toBe('routes/post.tsx')
		expect(entries.find((e) => e.id === 'post-archive')?.file).toBe(
			'routes/post-archive.tsx',
		)
	})

	it('refuses the bare resource rather than silently picking the first page', async () => {
		// The bug, stated as a test: "post" is genuinely ambiguous once two pages
		// render it, and each page is a separate owned module — so there is no
		// answer to guess at, only one to ask for.
		await expect(addViewCommand(dir, 'post')).rejects.toThrow(
			/"post" has 2 pages/,
		)
		// …and the error hands over arguments that work, one per page.
		await expect(addViewCommand(dir, 'post')).rejects.toThrow(
			/maxstack add view \/archive/,
		)
		// Refused before any write: both modules are still the generator's.
		expect(await readFile(join(dir, 'app/routes/post.tsx'), 'utf8')).toContain(
			'AUTO-GENERATED',
		)
		expect(
			await readFile(join(dir, 'app/routes/post-archive.tsx'), 'utf8'),
		).toContain('AUTO-GENERATED')
	})

	it('scaffolds the SECOND page by route path and leaves the first untouched', async () => {
		const first = await readFile(join(dir, 'app/routes/post.tsx'))

		await addViewCommand(dir, '/archive')

		const owned = await readFile(
			join(dir, 'app/routes/post-archive.tsx'),
			'utf8',
		)
		expect(owned).toContain('THIS FILE IS YOURS')
		expect(owned).toContain('<ResourceList {...list}')
		// The banner names the argument that lands here, so the `--force` re-run
		// it documents is the one that rewrites this file.
		expect(owned).toContain('maxstack add view /archive')

		// The first page is byte-for-byte what gen left — not "still contains
		// AUTO-GENERATED", which a partial rewrite would also satisfy. This is the
		// assertion the resource-keyed writer could not pass: it wrote
		// routes/post.tsx whichever page you meant.
		expect(await readFile(join(dir, 'app/routes/post.tsx'))).toEqual(first)

		const entries = (await manifestOf()).entries
		// Keyed by module key, matching what `eject` writes and what the mount
		// looks an owned module up by (#392).
		const ejected = entries.find((e) => e.id === 'post-archive')
		expect(ejected).toMatchObject({
			ownership: 'ejected',
			file: 'routes/post-archive.tsx',
			routePath: '/archive',
		})
		// The sibling's entry is untouched, and in particular still the
		// framework's to regenerate.
		expect(entries.find((e) => e.id === 'post')?.ownership).toBe('generated')
		// No resource-keyed stowaway entry beside it.
		expect(entries.filter((e) => e.id === 'post')).toHaveLength(1)
	})

	it('reaches the first page by page id, module key or route', async () => {
		const archive = await readFile(join(dir, 'app/routes/post-archive.tsx'))

		await addViewCommand(dir, 'pg-posts')

		expect(await readFile(join(dir, 'app/routes/post.tsx'), 'utf8')).toContain(
			'THIS FILE IS YOURS',
		)
		// …and the page scaffolded first is not rewritten as a side effect.
		expect(await readFile(join(dir, 'app/routes/post-archive.tsx'))).toEqual(
			archive,
		)
		const entries = (await manifestOf()).entries
		expect(entries.find((e) => e.id === 'post')).toMatchObject({
			ownership: 'ejected',
			file: 'routes/post.tsx',
			routePath: '/posts',
		})
	})

	it('regeneration leaves both owned modules alone', async () => {
		const before = await Promise.all([
			readFile(join(dir, 'app/routes/post.tsx')),
			readFile(join(dir, 'app/routes/post-archive.tsx')),
		])
		await genCommand(dir)
		expect(
			await Promise.all([
				readFile(join(dir, 'app/routes/post.tsx')),
				readFile(join(dir, 'app/routes/post-archive.tsx')),
			]),
		).toEqual(before)
	})

	it('names an unknown page rather than reporting an unknown resource', async () => {
		await expect(addViewCommand(dir, '/nope')).rejects.toThrow(
			/no page "\/nope" in the spec/,
		)
		await expect(addViewCommand(dir, 'pg-nope')).rejects.toThrow(
			/Known pages:[\s\S]*\/archive/,
		)
	})
})
