/**
 * `maxstack slots` — the human half of slot discovery (issue #378).
 *
 * A dogfood session built a `reading item` entity, read
 * `reading_ditem__header` off this command, and filed it as a mangling bug. It
 * is not one: slot ids are exported function names, so they are escaped
 * (`-` → `_d`, `_` → `_u`) rather than folded, because folding would let
 * `read-item` and `read_item` derive the same id. The inventory carries that
 * note as a top-level field — but a top-level field is invisible to someone
 * reading a *table of ids*, which is all this surface prints, so the note has
 * to reach the terminal too.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initCommand } from './init.ts'
import { opCommand } from './op.ts'
import { slotsCommand } from './slots.ts'

const provenance = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}

/** A hyphenated resource — the only kind whose ids look "wrong". */
const entityOp = JSON.stringify({
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-reading-item',
			name: 'Reading item',
			description: 'Something to read',
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

const pageOp = JSON.stringify({
	op: 'page.addPage',
	args: {
		page: {
			id: 'pg-reading-items',
			name: 'Reading items',
			route: '/reading-items',
			entityId: 'e-reading-item',
			provenance: { ...provenance, priority: 'high' },
			blocks: [{ id: 'blk-table', type: 'table', provenance }],
		},
	},
})

describe('maxstack slots explains its own ids (#378)', () => {
	let dir: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-slots-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a reading list' })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp })
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

	it('prints the escape map and the reason beside the escaped ids', async () => {
		const out = await output(() => slotsCommand(dir))
		// The id that was reported as a bug is really printed here.
		expect(out).toContain('reading_ditem__header')
		// The map...
		expect(out).toContain('- → _d')
		expect(out).toContain('_ → _u')
		expect(out).toContain('_z')
		// ...and the reason, which is the half that stops a reader renaming the
		// entity to get a prettier id.
		expect(out).toMatch(/reversible/)
		expect(out).toMatch(/collide/)
		expect(out).toMatch(/do not rename a resource/)
		// Markdown backticks belong to the other two surfaces, not the terminal.
		expect(out).not.toContain('`')
	})

	it('carries the same note in --json, where an agent reads it', async () => {
		const out = await output(() => slotsCommand(dir, { json: true }))
		const inventory = JSON.parse(out)
		expect(inventory.idEscaping).toContain('`_d`')
		expect(inventory.idEscaping).toMatch(/collide/)
	})
})
