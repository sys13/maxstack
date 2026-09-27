/**
 * Per-cell history (#307).
 *
 * The failure this pins: the audit log recorded which fields an update touched
 * and never what they held, so a cell's past could not be shown or queried
 * without a hand-built history table. What must hold instead:
 *
 *  - a field that declares a history keeps every value it takes, with who wrote
 *    it and when, bounded by its declared `keep`;
 *  - a write that does not change the value adds nothing, and a cell a person's
 *    edit held against a sync gets no entry for the sync;
 *  - the history is written by the ops and never by a caller, rides on a record
 *    read and not on a page of rows, and costs nothing where nothing declared it.
 *
 * Against a real (pglite) store, through `opCreate`/`opUpdate`, because keeping
 * the history in the row is an argument about the write the store performs.
 */

import { describe, expect, it } from 'vitest'
import { updateHandler } from './api.ts'
import {
	appendCellHistory,
	CELL_HISTORY_COLUMN,
	readCellHistory,
} from './cell-history.ts'
import { stampFor } from './cell-provenance.ts'
import {
	createSpecDb,
	registerSpecEntities,
	type SpecEntityShape,
	specSchemaDdl,
} from './from-spec.ts'
import {
	type OpAuditEntry,
	type OpContext,
	opCreate,
	opGet,
	opGetMany,
	opList,
	opUpdate,
	opUpdateDetailed,
} from './operations.ts'
import type { SproutUser } from './permissions.ts'
import { ResourceRegistry } from './registry.ts'

const DEAL: SpecEntityShape = {
	name: 'deal',
	fields: [
		{ name: 'name', type: 'string', required: true },
		{ name: 'stage', type: 'string', required: false, history: { keep: 3 } },
		{
			name: 'amount',
			type: 'number',
			required: false,
			history: { keep: 10 },
			merge: { humanEditWins: true },
		},
		{ name: 'notes', type: 'string', required: false },
	],
}

/** An entity that declares nothing — the control group. */
const NOTE: SpecEntityShape = {
	name: 'note',
	fields: [{ name: 'body', type: 'string', required: false }],
}

const person: SproutUser = { id: 'u-rep', role: 'admin', origin: 'session' }
const crm: SproutUser = {
	id: 'service:sync',
	role: 'admin',
	origin: 'system',
	sourceKey: 'hubspot',
}

async function project() {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [DEAL, NOTE])
	const { store } = await createSpecDb(registry, [DEAL, NOTE])
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

async function aDeal() {
	const p = await project()
	const created = await opCreate(p.as(person), 'deal', {
		name: 'Acme renewal',
		stage: 'lead',
	})
	return { ...p, id: String(created.id) }
}

const historyOf = async (ctx: OpContext, id: string, column: string) =>
	readCellHistory(await opGet(ctx, 'deal', id))[column] ?? []

describe('a field that keeps its history', () => {
	it('records every value it takes, oldest first, with who wrote it and when', async () => {
		const { as, id } = await aDeal()
		await opUpdate(as(person), 'deal', id, { stage: 'qualified' })
		await opUpdate(as(crm), 'deal', id, { stage: 'proposal' })

		const stage = await historyOf(as(person), id, 'stage')
		expect(stage.map((e) => e.value)).toEqual(['lead', 'qualified', 'proposal'])
		expect(stage[0]).toMatchObject({ by: 'u-rep', origin: 'session' })
		expect(stage[2]).toMatchObject({
			by: 'service:sync',
			origin: 'system',
			source: 'hubspot',
		})
		expect(Date.parse(stage[2]?.at ?? '')).not.toBeNaN()
	})

	it('keeps only the declared number of values, dropping the oldest', async () => {
		const { as, id } = await aDeal()
		for (const stage of ['qualified', 'proposal', 'won'])
			await opUpdate(as(person), 'deal', id, { stage })
		const stage = await historyOf(as(person), id, 'stage')
		expect(stage.map((e) => e.value)).toEqual(['qualified', 'proposal', 'won'])
	})

	it('adds nothing for a save that leaves the value as it was', async () => {
		// The edit page posts every field. A person who changed the name has not
		// written a new stage, and a history that said so would be noise that
		// pushes real values out of a bounded window.
		const { as, audit, id } = await aDeal()
		await opUpdate(as(person), 'deal', id, {
			name: 'Acme renewal FY27',
			stage: 'lead',
		})
		expect(await historyOf(as(person), id, 'stage')).toHaveLength(1)
		expect(audit.at(-1)?.metadata?.fields).not.toContain(CELL_HISTORY_COLUMN)
	})

	it('does not start a history with a blank a create form left', async () => {
		const { as } = await project()
		const row = await opCreate(as(person), 'deal', { name: 'Blank', stage: '' })
		expect(readCellHistory(row).stage).toBeUndefined()
	})

	it('gives a held cell no entry for the sync that did not write it', async () => {
		const { as, id } = await aDeal()
		await opUpdate(as(person), 'deal', id, { amount: 1200 })
		const { held } = await opUpdateDetailed(as(crm), 'deal', id, {
			amount: 900,
			stage: 'proposal',
		})
		expect(held).toEqual(['amount'])
		const amount = await historyOf(as(person), id, 'amount')
		expect(amount.map((e) => e.value)).toEqual([1200])
		// The sync's other cell landed, and its history says the sync wrote it.
		const stage = await historyOf(as(person), id, 'stage')
		expect(stage.at(-1)).toMatchObject({ value: 'proposal', source: 'hubspot' })
	})

	it('keeps nothing for a field that did not declare a history', async () => {
		const { as, id } = await aDeal()
		await opUpdate(as(person), 'deal', id, { notes: 'called Tuesday' })
		const row = await opGet(as(person), 'deal', id)
		expect(readCellHistory(row).notes).toBeUndefined()
	})
})

describe('where the history is read', () => {
	it('rides on a record read, not on a page of rows', async () => {
		// A list shows current values. Shipping up to `keep` past copies of every
		// declared field on every row would make a page's weight grow with how
		// often its rows were edited.
		const { as, id } = await aDeal()
		await opUpdate(as(person), 'deal', id, { stage: 'won' })
		expect(await opGet(as(person), 'deal', id)).toHaveProperty(
			CELL_HISTORY_COLUMN,
		)
		const [listed] = await opList(as(person), 'deal')
		expect(listed).toMatchObject({ id, stage: 'won' })
		expect(listed).not.toHaveProperty(CELL_HISTORY_COLUMN)
		const [batched] = await opGetMany(as(person), 'deal', [id])
		expect(batched).not.toHaveProperty(CELL_HISTORY_COLUMN)
	})

	it('cannot be forged by a caller', async () => {
		const { as, id } = await aDeal()
		const forged = {
			stage: [
				{ value: 'won', by: 'u-ceo', origin: 'session', at: '2020-01-01' },
			],
		}
		const res = await updateHandler(as(person), 'deal', id, {
			stage: 'qualified',
			[CELL_HISTORY_COLUMN]: forged,
		})
		expect(res.status).toBe(200)
		const stage = readCellHistory(res.body as Record<string, unknown>).stage
		expect(stage?.map((e) => e.value)).toEqual(['lead', 'qualified'])
		// …and a body of nothing but history is refused as not writable.
		const only = await updateHandler(as(person), 'deal', id, {
			[CELL_HISTORY_COLUMN]: forged,
		})
		expect(only.status).toBe(400)
		expect(
			(only.body as { immutableFields: string[] }).immutableFields,
		).toEqual([CELL_HISTORY_COLUMN])
	})

	it('gives an entity that declares no history no column at all', async () => {
		const { registry, as } = await project()
		const columns = registry.get('note')?.resource.columns.map((c) => c.name)
		expect(columns).not.toContain(CELL_HISTORY_COLUMN)
		const row = await opCreate(as(person), 'note', { body: 'hi' })
		expect(row).not.toHaveProperty(CELL_HISTORY_COLUMN)
		const ddl = specSchemaDdl([DEAL, NOTE])
		expect(ddl).toContain(
			`ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "${CELL_HISTORY_COLUMN}" jsonb;`,
		)
		expect(ddl).not.toContain(
			`"note" ADD COLUMN IF NOT EXISTS "${CELL_HISTORY_COLUMN}"`,
		)
	})
})

describe('appendCellHistory', () => {
	it('returns the payload untouched when no column keeps a history', async () => {
		const { registry } = await project()
		const columns = registry.get('note')?.resource.columns ?? []
		const data = { body: 'x' }
		expect(
			appendCellHistory({
				columns,
				existing: null,
				data,
				stamp: stampFor(person),
			}),
		).toBe(data)
	})

	it('stores a date as the string it reads back as', async () => {
		const { registry } = await project()
		const columns = (registry.get('deal')?.resource.columns ?? []).map((c) =>
			c.name === 'stage' ? { ...c, type: 'date' as const } : c,
		)
		const out = appendCellHistory({
			columns,
			existing: null,
			data: { stage: new Date('2026-09-01T00:00:00.000Z') },
			stamp: stampFor(person),
		})
		expect(readCellHistory(out).stage?.[0]?.value).toBe(
			'2026-09-01T00:00:00.000Z',
		)
	})

	it('reads malformed history as none rather than failing', () => {
		expect(readCellHistory({ [CELL_HISTORY_COLUMN]: 'not json' })).toEqual({})
		expect(
			readCellHistory({
				[CELL_HISTORY_COLUMN]: { stage: [{ value: 1 }, 'x'], amount: 3 },
			}),
		).toEqual({})
	})
})
