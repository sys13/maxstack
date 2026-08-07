/**
 * `generateProject` over a spec that declares **two pages on one entity** —
 * issue #337, end to end through the CLI's own generation loop.
 *
 * The unit half of this lives in `packages/mcp/src/generators.test.ts`
 * (`pageDescriptors`); what is pinned here is the wiring, because the wiring is
 * what was broken. `generateProject` folded each page to its entity's resource
 * *independently*, so a list page and a board page over `e-book` both emitted
 * `routes/book.tsx`: every run overwrote the file it had just written, every run
 * reported `unsafe regen overwritten`, and `maxstack validate` could never pass
 * again — which also made a genuinely unsafe overwrite invisible, since every
 * run already looked unsafe.
 *
 * The assertion that matters is therefore not "two files exist" but
 * `isRegenStable` on a **second** run over an untouched tree.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initCommand } from '../commands/init.ts'
import { opCommand } from '../commands/op.ts'
import { generateProject, isRegenStable } from './generate.ts'
import { loadProject } from './project.ts'

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
			id: 'e-book',
			name: 'Book',
			description: 'A book on the shelf',
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

const pageOp = (id: string, name: string, route: string, block: string) =>
	JSON.stringify({
		op: 'page.addPage',
		args: {
			page: {
				id,
				name,
				route,
				entityId: 'e-book',
				provenance,
				blocks: [{ id: `blk-${id}`, type: block, provenance }],
			},
		},
	})

describe('generateProject — two pages over one entity (issue #337)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-gen-337-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a reading log', git: false })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp('pg-books', 'Books', '/books', 'table') })
		await opCommand(dir, { op: pageOp('pg-shelf', 'Shelf', '/shelf', 'board') })
	}, 60_000)

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('emits one route module per page and regenerates stably', async () => {
		const project = await loadProject(dir)

		const first = await generateProject(project)
		const routeFiles = first.writes
			.map((w) => w.file)
			.filter((f) => f.startsWith('routes/'))
		expect(routeFiles).toContain('routes/book.tsx')
		expect(routeFiles).toContain('routes/shelf.tsx')
		// The first page over the entity keeps the bare name it has always had, so
		// an existing project is not renamed out from under itself.
		expect(routeFiles).not.toContain('routes/books.tsx')

		// The gate: nothing this run wrote gets clobbered by the next one.
		const second = await generateProject(project)
		expect(isRegenStable(second.writes)).toBe(true)
		const unsafe = second.writes.filter(
			(w) => w.action !== 'unchanged' && w.action !== 'skipped-user-owned',
		)
		expect(unsafe).toEqual([])
	}, 60_000)
})
