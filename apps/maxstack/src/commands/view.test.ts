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
			'export default function PostView({ list, newHref, Link }: OwnedRouteProps)',
		)
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
		await addViewCommand(dir, 'post')
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
						id: 'pg-sprint-board',
						name: 'Sprint board',
						route: '/sprints',
						entityId: 'e-sprint',
						provenance,
						blocks: [{ id: 'blk-board', type: 'board', provenance }],
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
