/**
 * `maxstack eject <route-id>` — what it hands over, and what it says it hands
 * over (issue #349).
 *
 * The command had no test at all. That is not a coincidence: it printed
 * `"maxstack gen" will no longer overwrite it` and stopped, which is true of
 * any file and says nothing about the one being ejected. Meanwhile the file
 * itself was a heading and a comment — the page kept rendering from the runtime
 * resolving `spec/` at request time — so eject's headline promise, whole-page
 * ownership, was not kept and nothing anywhere said so.
 *
 * These run the real command against a real generated project.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ejectCommand } from './eject.ts'
import { genCommand } from './gen.ts'
import { initCommand } from './init.ts'
import { opCommand } from './op.ts'

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
			],
		},
	},
})

/** An ordinary list page — the shape every benchmark's initial pages have. */
const listPageOp = JSON.stringify({
	op: 'page.addPage',
	args: {
		page: {
			id: 'pg-posts',
			name: 'Posts',
			route: '/posts',
			entityId: 'e-post',
			provenance: { ...provenance, priority: 'high' },
			blocks: [{ id: 'blk-table', type: 'table', provenance }],
		},
	},
})

describe('maxstack eject (integration)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-eject-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a blog' })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: listPageOp })
		await genCommand(dir)
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	async function output(fn: () => Promise<void>): Promise<string> {
		const log = vi.mocked(console.log)
		log.mockClear()
		await fn()
		return log.mock.calls.flat().join('\n')
	}

	it('hands over a module that actually renders the page', async () => {
		// The #349 regression, read off the artifact the user is left holding.
		const src = await readFile(join(dir, 'app/routes/post.tsx'), 'utf8')
		expect(src).toContain('<ResourceList {...list} />')
		expect(src).toContain('OwnedRouteProps')
		expect(src).not.toContain('generated resource list renders here')
	})

	it('says which half of the page the file owns', async () => {
		const out = await output(() => ejectCommand(dir, 'post', { dryRun: true }))
		expect(out).toContain('This module now renders the page')
		// And names the half it does not own, so "you own this" is not read as
		// "this file is the whole app".
		expect(out).toContain('loader')
		expect(out).toContain('spec/')
	})

	it('leaves the same note in the file it writes', async () => {
		await ejectCommand(dir, 'post', {})
		const src = await readFile(join(dir, 'app/routes/post.tsx'), 'utf8')
		expect(src).toContain('EJECTED')
		expect(src).toContain('LOADER')
		// Never clobbers: the module body survives the banner swap intact.
		expect(src).toContain('<ResourceList {...list} />')
		expect(src).not.toContain('AUTO-GENERATED')

		const manifest = JSON.parse(
			await readFile(join(dir, 'app/.generated.routes.json'), 'utf8'),
		)
		const entry = manifest.entries.find((e: { id: string }) => e.id === 'post')
		expect(entry.ownership).toBe('ejected')
	})

	it('survives regeneration, banner and body alike', async () => {
		await genCommand(dir)
		const src = await readFile(join(dir, 'app/routes/post.tsx'), 'utf8')
		expect(src).toContain('EJECTED')
		expect(src).not.toContain('AUTO-GENERATED')
	})
})

describe('maxstack eject warns off a page it cannot materialize (#349)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-eject-view-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a planner' })
		await opCommand(dir, {
			op: JSON.stringify({
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-task',
						name: 'Task',
						description: 'a task',
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
								id: 'fld-due',
								name: 'dueAt',
								type: 'date',
								required: false,
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
						id: 'pg-calendar',
						name: 'Calendar',
						route: '/calendar',
						entityId: 'e-task',
						provenance: { ...provenance, priority: 'high' },
						blocks: [
							{
								id: 'blk-cal',
								type: 'calendar',
								calendar: {
									dateField: 'dueAt',
									display: 'month',
									timezone: 'UTC',
								},
								provenance,
							},
						],
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

	it('names the trade before making it', async () => {
		// Ejecting a view page swaps a working calendar for a placeholder,
		// because an owned module replaces the framework's whole surface. That is
		// a foot-gun the command has to name before it fires.
		const log = vi.mocked(console.log)
		log.mockClear()
		await ejectCommand(dir, 'task', { dryRun: true })
		const out = log.mock.calls.flat().join('\n')
		expect(out).toContain('PLACEHOLDER, not the page')
		expect(out).toContain('calendar')
		expect(out).toContain('block slot')
		// The materialized wording must NOT appear — that is the claim #349 is about.
		expect(out).not.toContain('This module now renders the page')
	})
})
