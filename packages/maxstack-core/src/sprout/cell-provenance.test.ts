/**
 * Per-cell provenance and `humanEditWins` (#460).
 *
 * The failure this pins: a declared source, an importer with an upsert key or an
 * agent over MCP silently reverted every hand edit on its next run, and nothing
 * in the row said a person had ever touched it. What must hold instead:
 *
 *  - a person's value in a field declaring `humanEditWins` survives a machine
 *    write, the machine's *other* fields still land, and the held field is
 *    reported rather than swallowed;
 *  - a field with no policy is last-wins exactly as before, and an entity with no
 *    policy anywhere has no stamps column at all;
 *  - the stamps are written by the ops and never by a caller.
 *
 * Against a real (pglite) store, through `opCreate`/`opUpdate`, because the
 * atomicity argument for keeping stamps in the row is a property of the write
 * the store actually performs.
 */

import { describe, expect, it } from 'vitest'
import { updateHandler } from './api.ts'
import {
	CELL_PROVENANCE_COLUMN,
	isHumanStamp,
	mergeCellWrite,
	readStamps,
	stampFor,
} from './cell-provenance.ts'
import {
	createSpecDb,
	registerSpecEntities,
	type SpecEntityShape,
	specSchemaDdl,
} from './from-spec.ts'
import type { ImportPlan, ImportPlanShape } from './imports.ts'
import { executeMCPTool } from './mcp.ts'
import {
	type OpAuditEntry,
	type OpContext,
	opApplyImport,
	opCreate,
	opGet,
	opUpdate,
	opUpdateDetailed,
} from './operations.ts'
import type { SproutUser } from './permissions.ts'
import { ResourceRegistry } from './registry.ts'

const BOOK: SpecEntityShape = {
	name: 'book',
	fields: [
		{ name: 'title', type: 'string', required: true },
		{ name: 'isbn', type: 'string', required: false },
		{
			name: 'coverUrl',
			type: 'string',
			required: false,
			merge: { humanEditWins: true },
		},
		{
			name: 'pages',
			type: 'number',
			required: false,
			merge: { humanEditWins: false },
		},
	],
}

/** An entity that declares nothing — the control group. */
const NOTE: SpecEntityShape = {
	name: 'note',
	fields: [{ name: 'body', type: 'string', required: false }],
}

const person: SproutUser = { id: 'u-host', role: 'admin', origin: 'session' }
/** A source run, as `userForRunAs` builds one: borrowed identity + source key. */
const openlibrary: SproutUser = {
	id: 'service:sync',
	role: 'admin',
	origin: 'system',
	sourceKey: 'openlibrary',
}
const agent: SproutUser = { id: 'u-host', role: 'admin', origin: 'mcp' }
const script: SproutUser = {
	id: 'u-host',
	role: 'admin',
	origin: 'api-key',
	apiKeyId: 'key-1',
}

async function project() {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [BOOK, NOTE])
	const { store } = await createSpecDb(registry, [BOOK, NOTE])
	const audit: OpAuditEntry[] = []
	const as = (user: SproutUser): OpContext => ({
		registry,
		store,
		user,
		audit: (entry) => {
			audit.push(entry)
		},
	})
	return { registry, store, audit, as }
}

async function handEdited() {
	const p = await project()
	const created = await opCreate(p.as(openlibrary), 'book', {
		title: 'Dune',
		coverUrl: 'https://covers.example/dune-v1.jpg',
		pages: 412,
	})
	const id = String(created.id)
	// The host corrects the cover by hand.
	await opUpdate(p.as(person), 'book', id, {
		coverUrl: 'https://covers.example/dune-correct.jpg',
	})
	return { ...p, id }
}

describe('a hand edit outranks a machine write', () => {
	it('keeps the value a person wrote when a source run writes it again, and says so', async () => {
		const { as, id } = await handEdited()
		const outcome = await opUpdateDetailed(as(openlibrary), 'book', id, {
			coverUrl: 'https://covers.example/dune-v2.jpg',
			title: 'Dune (40th anniversary)',
		})
		// The held cell is reported, not swallowed…
		expect(outcome.held).toEqual(['coverUrl'])
		// …it kept the person's value…
		expect(outcome.row.coverUrl).toBe('https://covers.example/dune-correct.jpg')
		// …and the machine's other field still landed: one held cell is not a
		// reason to refuse a sync the rest of its row.
		expect(outcome.row.title).toBe('Dune (40th anniversary)')
		const stored = await opGet(as(person), 'book', id)
		expect(stored.coverUrl).toBe('https://covers.example/dune-correct.jpg')
	})

	it('holds against an agent over MCP and an api key too — any machine, not only a source', async () => {
		const { as, id } = await handEdited()
		for (const machine of [agent, script]) {
			const { held, row } = await opUpdateDetailed(as(machine), 'book', id, {
				coverUrl: 'https://covers.example/agent-guess.jpg',
			})
			expect(held).toEqual(['coverUrl'])
			expect(row.coverUrl).toBe('https://covers.example/dune-correct.jpg')
		}
	})

	it('still lets a later person change it — the rule orders writers, it does not freeze the cell', async () => {
		const { as, id } = await handEdited()
		const row = await opUpdate(as(person), 'book', id, {
			coverUrl: 'https://covers.example/dune-final.jpg',
		})
		expect(row.coverUrl).toBe('https://covers.example/dune-final.jpg')
	})

	it('writes nothing, audits nothing and returns the row when every cell is held', async () => {
		const { as, id, audit } = await handEdited()
		const before = audit.length
		const { held, row } = await opUpdateDetailed(as(openlibrary), 'book', id, {
			coverUrl: 'https://covers.example/dune-v2.jpg',
		})
		expect(held).toEqual(['coverUrl'])
		expect(row.coverUrl).toBe('https://covers.example/dune-correct.jpg')
		// No `update` entry for a write that did not happen — a history feed that
		// showed one would claim the sync changed something.
		expect(audit.length).toBe(before)
	})

	it('names the held field on the audit entry of a partial write', async () => {
		const { as, id, audit } = await handEdited()
		await opUpdate(as(openlibrary), 'book', id, {
			coverUrl: 'https://covers.example/dune-v2.jpg',
			title: 'Dune II',
		})
		const last = audit.at(-1)
		expect(last?.metadata).toEqual({ fields: ['title'], held: ['coverUrl'] })
		expect(last?.sourceKey).toBe('openlibrary')
	})

	it('does not report a machine re-sending the value the person already set', async () => {
		const { as, id } = await handEdited()
		const { held } = await opUpdateDetailed(as(openlibrary), 'book', id, {
			coverUrl: 'https://covers.example/dune-correct.jpg',
			title: 'Dune',
		})
		// Nothing was refused: the cell already says that.
		expect(held).toEqual([])
	})
})

describe('without the policy, last write wins exactly as before', () => {
	it('lets a machine overwrite a hand edit on a field with no policy', async () => {
		const { as, id } = await handEdited()
		await opUpdate(as(person), 'book', id, { title: 'Dune, corrected' })
		const row = await opUpdate(as(openlibrary), 'book', id, {
			title: 'Dune',
		})
		expect(row.title).toBe('Dune')
		// No stamp for a field nobody declared a policy on.
		expect(readStamps(row).title).toBeUndefined()
	})

	it('stamps but does not hold under humanEditWins:false', async () => {
		const { as, id } = await handEdited()
		await opUpdate(as(person), 'book', id, { pages: 400 })
		const { row, held } = await opUpdateDetailed(as(openlibrary), 'book', id, {
			pages: 412,
		})
		expect(held).toEqual([])
		expect(row.pages).toBe(412)
		expect(readStamps(row).pages).toMatchObject({
			origin: 'system',
			source: 'openlibrary',
		})
	})

	it('gives an entity with no policy no stamps column at all', async () => {
		const { registry, as } = await project()
		const columns = registry.get('note')?.resource.columns.map((c) => c.name)
		expect(columns).not.toContain(CELL_PROVENANCE_COLUMN)
		const row = await opCreate(as(person), 'note', { body: 'hi' })
		expect(row).not.toHaveProperty(CELL_PROVENANCE_COLUMN)
		// And the DDL only adds the column where a policy was declared, so every
		// table that declares none is byte-for-byte what it was.
		const ddl = specSchemaDdl([BOOK, NOTE])
		expect(ddl).toContain(
			`ALTER TABLE "book" ADD COLUMN IF NOT EXISTS "${CELL_PROVENANCE_COLUMN}" jsonb;`,
		)
		expect(ddl).not.toContain(
			`"note" ADD COLUMN IF NOT EXISTS "${CELL_PROVENANCE_COLUMN}"`,
		)
	})

	it('lets a machine overwrite a machine', async () => {
		const { as } = await project()
		const created = await opCreate(as(openlibrary), 'book', {
			title: 'Emma',
			coverUrl: 'https://covers.example/emma-1.jpg',
		})
		const { row, held } = await opUpdateDetailed(
			as({ ...openlibrary, sourceKey: 'googlebooks' }),
			'book',
			String(created.id),
			{ coverUrl: 'https://covers.example/emma-2.jpg' },
		)
		expect(held).toEqual([])
		expect(row.coverUrl).toBe('https://covers.example/emma-2.jpg')
		expect(readStamps(row).coverUrl?.source).toBe('googlebooks')
	})
})

describe('the stamp says who wrote the cell', () => {
	it('records the person, the origin and when', async () => {
		const { as, id } = await handEdited()
		const row = await opGet(as(person), 'book', id)
		const stamp = readStamps(row).coverUrl
		expect(stamp).toMatchObject({ by: 'u-host', origin: 'session' })
		expect(Number.isNaN(Date.parse(stamp?.at ?? ''))).toBe(false)
		expect(isHumanStamp(stamp)).toBe(true)
	})

	it('does not let a full-form save claim a cell the person did not change', async () => {
		const { as } = await project()
		const created = await opCreate(as(openlibrary), 'book', {
			title: 'Emma',
			coverUrl: 'https://covers.example/emma-1.jpg',
		})
		const id = String(created.id)
		// The edit page posts every field; the host only changed the title.
		await opUpdate(as(person), 'book', id, {
			title: 'Emma.',
			coverUrl: 'https://covers.example/emma-1.jpg',
		})
		// So the cover is still the source's, and the next run may replace it.
		const { row, held } = await opUpdateDetailed(as(openlibrary), 'book', id, {
			coverUrl: 'https://covers.example/emma-2.jpg',
		})
		expect(held).toEqual([])
		expect(row.coverUrl).toBe('https://covers.example/emma-2.jpg')
	})

	it('does not stamp a blank a person left on a create form, so an enrichment can fill it', async () => {
		const { as } = await project()
		const created = await opCreate(as(person), 'book', {
			title: 'Persuasion',
			coverUrl: null,
		})
		expect(readStamps(created).coverUrl).toBeUndefined()
		const row = await opUpdate(as(openlibrary), 'book', String(created.id), {
			coverUrl: 'https://covers.example/persuasion.jpg',
		})
		expect(row.coverUrl).toBe('https://covers.example/persuasion.jpg')
	})

	it('cannot be forged by a caller', async () => {
		const { as, id } = await handEdited()
		// A client claiming the cell was last written by a source, to unpin it…
		const forged = {
			coverUrl: {
				by: 'service:sync',
				origin: 'system',
				source: 'openlibrary',
				at: '2020-01-01T00:00:00.000Z',
			},
		}
		const res = await updateHandler(as(person), 'book', id, {
			title: 'Dune',
			[CELL_PROVENANCE_COLUMN]: forged,
		})
		expect(res.status).toBe(200)
		expect(
			readStamps(res.body as Record<string, unknown>).coverUrl?.origin,
		).toBe('session')
		// …and a body of nothing but stamps is refused as not writable.
		const only = await updateHandler(as(person), 'book', id, {
			[CELL_PROVENANCE_COLUMN]: forged,
		})
		expect(only.status).toBe(400)
		expect(
			(only.body as { immutableFields: string[] }).immutableFields,
		).toEqual([CELL_PROVENANCE_COLUMN])
	})
})

describe('a re-import after a hand edit', () => {
	it('leaves the edit alone and reports the held cell per line', async () => {
		const { as, id } = await handEdited()
		const importer: ImportPlanShape = {
			key: 'catalogue',
			description: 'The catalogue export',
			format: 'csv',
			resource: 'book',
			columns: [],
			upsertColumn: 'isbn',
			maxRows: 100,
			paused: false,
		}
		const plan: ImportPlan = {
			importer,
			key: 'catalogue',
			resource: 'book',
			rows: [
				{
					line: 1,
					action: 'update',
					matchedId: id,
					data: {
						title: 'Dune',
						coverUrl: 'https://covers.example/from-the-file.jpg',
					},
					raw: {},
				},
			],
			counts: { create: 0, update: 1, invalid: 0 },
			truncated: false,
		}
		// Run by the person — an import is still a machine write: the cells are
		// the file's, and a re-import is the writer the issue found reverting edits.
		const result = await opApplyImport(as(person), plan)
		expect(result.updated).toBe(1)
		expect(result.held).toEqual([{ line: 1, fields: ['coverUrl'] }])
		const row = await opGet(as(person), 'book', id)
		expect(row.coverUrl).toBe('https://covers.example/dune-correct.jpg')
	})
})

describe('update_record over MCP', () => {
	it('tells the agent which fields were held, after the row', async () => {
		const { as, id } = await handEdited()
		const result = await executeMCPTool(as(agent), 'update_record', {
			resource: 'book',
			id,
			data: { coverUrl: 'https://covers.example/agent.jpg', title: 'Dune' },
		})
		expect(result.isError).toBeUndefined()
		const [row, note] = result.content
		expect(JSON.parse(row?.text ?? '{}').title).toBe('Dune')
		expect(note?.text).toContain('Not written: coverUrl')
		expect(note?.text).toContain('Do not retry')
	})
})

describe('mergeCellWrite', () => {
	it('returns the payload untouched for columns with no policy', () => {
		const data = { title: 'x' }
		const merged = mergeCellWrite({
			columns: [
				{
					name: 'title',
					type: 'string',
					nullable: true,
					hasDefault: false,
					isPrimaryKey: false,
					meta: {},
				},
			],
			existing: { title: 'y' },
			data,
			stamp: stampFor(openlibrary),
		})
		// The same object — no copy, no stamp — so a resource with no declared
		// policy writes exactly what it wrote before this existed.
		expect(merged.data).toBe(data)
		expect(merged.held).toEqual([])
	})

	it('treats an unclassified origin, and any source or importer key, as a machine', () => {
		expect(isHumanStamp(stampFor(person))).toBe(true)
		expect(isHumanStamp(stampFor({ id: 'p', origin: 'portal' }))).toBe(true)
		expect(isHumanStamp(stampFor(openlibrary))).toBe(false)
		expect(isHumanStamp(stampFor(person, { importer: 'catalogue' }))).toBe(
			false,
		)
		// A manual source run borrows the operator's session identity; the value
		// is still the source's.
		expect(
			isHumanStamp(stampFor({ ...person, sourceKey: 'openlibrary' })),
		).toBe(false)
	})
})
