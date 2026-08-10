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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	exportedSlotNames,
	MANIFEST_FILENAME,
	parseManifest,
	renderOwnedManifest,
} from '@maxstack/core/ownership'
import { assertAppendOnly } from '@maxstack/spec'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { genCommand } from './gen.ts'
import { initCommand } from './init.ts'
import { opCommand } from './op.ts'
import { slotsCommand, slotsFillCommand } from './slots.ts'

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

/**
 * `maxstack slots fill` — the write half (issue #390).
 *
 * Every assertion below covers a path that had no test: the stub write, the
 * manifest registration that decides whether a filled slot *executes*, and the
 * two refusals. The write is the one that matters most — a fill that clobbered
 * a slot the maintainer had already implemented would destroy owned code,
 * which is the single category of loss the ownership model exists to prevent.
 */
describe('maxstack slots fill (#390)', () => {
	let dir: string
	let slotFile: string

	/** A second page over the same entity, carrying a *declared* `slot:` block. */
	const declaredSlotPageOp = JSON.stringify({
		op: 'page.addPage',
		args: {
			page: {
				id: 'pg-reading-board',
				name: 'Reading board',
				route: '/reading-board',
				entityId: 'e-reading-item',
				provenance,
				blocks: [{ id: 'blk-widget', type: 'slot:widget', provenance }],
			},
		},
	})

	/**
	 * A second resource with no declared slot, so nothing but `slots fill` can
	 * have created (or registered) its slot file.
	 */
	const noteEntityOp = JSON.stringify({
		op: 'data.addEntity',
		args: {
			entity: {
				id: 'e-note',
				name: 'Note',
				description: 'A note',
				provenance,
				fields: [
					{
						id: 'fld-body',
						name: 'body',
						type: 'string',
						required: true,
						provenance,
					},
				],
			},
		},
	})

	const notePageOp = JSON.stringify({
		op: 'page.addPage',
		args: {
			page: {
				id: 'pg-notes',
				name: 'Notes',
				route: '/notes',
				entityId: 'e-note',
				provenance,
				blocks: [{ id: 'blk-note-table', type: 'table', provenance }],
			},
		},
	})

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-slots-fill-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a reading list' })
		await opCommand(dir, { op: entityOp })
		await opCommand(dir, { op: pageOp })
		await opCommand(dir, { op: declaredSlotPageOp })
		await opCommand(dir, { op: noteEntityOp })
		await opCommand(dir, { op: notePageOp })
		await genCommand(dir)
		slotFile = join(dir, 'app', 'routes', 'reading-item.slots.tsx')
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	function errors(): string {
		return vi.mocked(console.error).mock.calls.flat().join('\n')
	}

	async function refusal(fn: () => Promise<void>): Promise<string> {
		const err = vi.mocked(console.error)
		err.mockClear()
		process.exitCode = undefined
		await fn()
		const code = process.exitCode
		process.exitCode = undefined
		expect(code).toBe(1)
		return errors()
	}

	async function manifest() {
		return parseManifest(
			await readFile(join(dir, 'app', MANIFEST_FILENAME), 'utf8'),
		)
	}

	/**
	 * The loss the model exists to prevent. The second fill lands over a file
	 * whose first slot the maintainer has *already implemented* — the check is
	 * that their code is still there, byte for byte, and that the export list
	 * only grew. Append-only is asserted with the ledger guard
	 * (`assertAppendOnly`, #29) rather than a bespoke comparison.
	 */
	it('appends the second stub without rewriting a slot already filled by hand', async () => {
		// Generation already scaffolded this file for the page's declared
		// `slot:widget`, so the fill lands into a file that is not its own.
		expect(exportedSlotNames(await readFile(slotFile, 'utf8'))).toContain(
			'widget',
		)
		await slotsFillCommand('reading_ditem__header', dir)
		const stubbed = await readFile(slotFile, 'utf8')
		expect(exportedSlotNames(stubbed)).toContain('reading_ditem__header')

		// Make it owned code: a real implementation plus a helper the command
		// knows nothing about.
		const owned = `${stubbed.replace(
			/return <p>Block slot[^\n]*\n/,
			'return <h1>MY OWN HEADER</h1>\n',
		)}\nconst readingHelper = () => 'mine'\nvoid readingHelper\n`
		await writeFile(slotFile, owned)

		await slotsFillCommand('reading_ditem__row', dir)
		const after = await readFile(slotFile, 'utf8')

		// Nothing that was there was rewritten...
		expect(after).toContain(owned)
		expect(after).toContain('MY OWN HEADER')
		expect(after).toContain("const readingHelper = () => 'mine'")
		// ...and the export list only grew, in order.
		assertAppendOnly(
			exportedSlotNames(owned),
			exportedSlotNames(after),
			'slot file',
		)
		expect(exportedSlotNames(after)).toContain('reading_ditem__row')
		// The new props type arrives as its own prepended `import type` line
		// rather than being merged into the existing one. Two imports from the
		// same module is untidy — and it is the *right* trade: merging would mean
		// rewriting a line in a file the maintainer owns.
		expect(
			after.split('\n').filter((l) => l.includes("from '@maxstack/ui'")),
		).toHaveLength(2)

		// And re-filling an id that is already implemented is a no-op, not a
		// second stub over the top of the implementation.
		await slotsFillCommand('reading_ditem__header', dir)
		expect(await readFile(slotFile, 'utf8')).toBe(after)
	})

	/**
	 * A filled slot that never reaches the manifest is invisible to
	 * `ownership_drift` and to the ownership gates — and, worse, the runtime
	 * never imports it, so the bespoke UI silently does not render.
	 */
	it('registers the slot file as owned and points the route at it', async () => {
		// `note` declares no `slot:` block, so before this fill neither the file
		// nor any manifest entry for it exists — everything asserted here is the
		// fill's own work.
		const before = await manifest()
		expect(
			before.entries.find((e) => e.file === 'routes/note.slots.tsx'),
		).toBeUndefined()

		await slotsFillCommand('note__row', dir)

		const m = await manifest()
		const entry = m.entries.find((e) => e.file === 'routes/note.slots.tsx')
		expect(entry).toBeDefined()
		expect(entry?.ownership).toBe('user')
		expect(entry?.rolesVersion).toBe(1)
		// The registration that decides whether the fill *executes*: without it
		// `OWNED_SLOTS` has no entry and the app renders the generated block.
		const route = m.entries.find((e) => e.file === 'routes/note.tsx')
		expect(route?.slotFile).toBe('routes/note.slots.tsx')
		expect(renderOwnedManifest(m)).toContain('"note": slots_')
	})

	/** A declared `slot:<name>` block is scaffolded by generation itself. */
	it('refuses a declared page slot and says which command stubs it', async () => {
		const out = await refusal(() => slotsFillCommand('widget', dir))
		expect(out).toContain('declared page slot')
		expect(out).toContain('maxstack gen')
	})

	/**
	 * The retype #378 predicts: a human who read `reading_ditem__header` off the
	 * terminal types the name they *meant*. "not found" would read as the id
	 * being wrong; the escape rule is what makes the failure legible.
	 */
	it('refuses an unknown id by naming the escape rule (#378)', async () => {
		const out = await refusal(() =>
			slotsFillCommand('reading-item__header', dir),
		)
		expect(out).toContain('reading-item__header')
		// The repair, spelled out.
		expect(out).toContain('reading_ditem__header')
		// ...and the rule behind it, so the reader does not rename the entity.
		expect(out).toContain('- → _d')
		expect(out).toContain('do not rename a resource')
		expect(out).toContain('maxstack slots')
	})

	/** An id that resembles nothing still gets the rule, minus a suggestion. */
	it('refuses a nonsense id without inventing a suggestion', async () => {
		const out = await refusal(() => slotsFillCommand('not_a_slot_at_all', dir))
		expect(out).toContain('no slot "not_a_slot_at_all"')
		expect(out).not.toContain('Did you mean')
		expect(out).toContain('- → _d')
	})
})
