/**
 * `maxstack add view <resource>` — the infer-then-eject verb (Plan v5 task 36).
 * Proves it scaffolds an *owned* view with the inferred columns written out
 * explicitly, flips the route to `ejected`, and that a subsequent `gen` skips it
 * so column edits survive regeneration (the task's exit criterion).
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
	it('introspects a resource out of a spec and writes its columns out explicitly', () => {
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
		// The inferred columns are spelled out (the guesser output)...
		expect(src).toContain('"name": "title"')
		expect(src).toContain('"name": "views"')
		expect(src).toContain('satisfies IntrospectedResource')
		// ...the projection dropped the fields the display side ignores...
		expect(src).not.toContain('isPrimaryKey')
		expect(src).not.toContain('"relations"')
		// ...it fetches via the typed hook and demonstrates the eject seam.
		expect(src).toContain('useList("post"')
		expect(src).toContain('export default function PostView()')
		expect(src).toContain('columns={columns}')
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
		expect(src).toContain('ResourceList')
		expect(src).toContain('"name": "published"')

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
	})

	it('editing a column survives regeneration (the exit criterion)', async () => {
		const file = join(dir, 'app/routes/post.tsx')
		const edited = (await readFile(file, 'utf8')).replace(
			'"label": "Views"',
			'"label": "Reads"',
		)
		expect(edited).toContain('"label": "Reads"')
		await writeFile(file, edited)

		await genCommand(dir)

		// The gen pass left the owned view untouched.
		expect(await readFile(file, 'utf8')).toContain('"label": "Reads"')
	})
})
