/**
 * Running a declared list action, over pglite.
 *
 * `view.test.ts` in `@maxstack/spec` pins what may be *declared*. This pins what
 * a run actually *does*, and it is organized around the one question that
 * matters: **can a batch reach further than the caller could reach one row at a
 * time?** The answer has to be no on every axis at once — tenant, permission,
 * per-value limit, declared cap, declared option list — because a bulk write is
 * exactly where a single missing check stops being a bug and becomes a breach.
 *
 * The tenancy test is the one to read first. It is the test issue #417 names as
 * the one that matters, phrased for writes: a selection that reaches past the
 * caller's org must fail on those rows rather than succeed.
 */

import type { PGlite } from '@electric-sql/pglite'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzleStore } from '../demo/store.ts'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import type { ActionPlan, ActionRunResult } from './actions.ts'
import { actionPlansFor, actionWrite, findActionPlan } from './actions.ts'
import {
	InvalidActionChoiceError,
	type OpAuditEntry,
	type OpContext,
	opCreate,
	opGet,
	opRunAction,
	opUndoAction,
	SelectionTooLargeError,
	UnknownActionError,
	UnsupportedOperationError,
} from './operations.ts'
import { PermissionError } from './permissions.ts'
import { ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'

const task = pgTable('task', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: withMeta(text('title'), { label: 'Title', required: true }).notNull(),
	status: withMeta(text('status'), {
		label: 'Status',
		options: [
			{ label: 'Open', value: 'open' },
			{ label: 'Doing', value: 'doing' },
			{ label: 'Archived', value: 'archived' },
		],
	}),
	organizationId: text('organizationId'),
})

const DDL = `
CREATE TABLE "task" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" text NOT NULL,
  "status" text,
  "organizationId" text
);
`

const archive: ActionPlan = {
	key: 'archive',
	label: 'Archive',
	description: 'Move the ticked tasks out of the working list.',
	arity: 'selection',
	set: { status: 'archived' },
	maxSelection: 3,
	undoable: true,
}

const move: ActionPlan = {
	key: 'move',
	label: 'Move',
	description: 'Move one task to another column.',
	arity: 'row',
	set: {},
	choose: { column: 'status', options: ['open', 'doing', 'archived'] },
	maxSelection: 1,
	undoable: false,
}

const purge: ActionPlan = {
	key: 'purge',
	label: 'Purge',
	description: 'An admin-only sweep.',
	arity: 'selection',
	set: { status: 'archived' },
	role: 'admin',
	maxSelection: 3,
	undoable: false,
}

const acme = { id: 'u-acme', role: 'member', orgId: 'org-acme' }
const globex = { id: 'u-globex', role: 'member', orgId: 'org-globex' }
const admin = { id: 'u-admin', role: 'admin', orgId: 'org-acme' }

let client: PGlite
let ctxFor: (user: OpContext['user'], audit?: OpContext['audit']) => OpContext

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	const registry = new ResourceRegistry()
	registry.register(task, {
		tenantField: 'organizationId',
		actions: [archive, move, purge],
	})
	const store = createDrizzleStore(drizzle({ client }), registry)
	ctxFor = (user, audit) => ({ registry, store, user, audit })
})

afterAll(async () => {
	await client.close()
})

/** Three fresh open tasks in one org, returned as ids. */
async function seed(
	user: OpContext['user'],
	n: number,
	prefix: string,
): Promise<string[]> {
	const ids: string[] = []
	for (let i = 0; i < n; i++) {
		const row = await opCreate(ctxFor(user), 'task', {
			title: `${prefix}-${i}`,
			status: 'open',
		})
		ids.push(String(row.id))
	}
	return ids
}

const statusOf = async (
	user: OpContext['user'],
	id: string,
): Promise<unknown> => (await opGet(ctxFor(user), 'task', id)).status

describe('plan lookup', () => {
	it('finds by key, and offers `both` at either arity', () => {
		expect(findActionPlan([archive, move], 'move')?.label).toBe('Move')
		expect(findActionPlan([archive], 'nope')).toBeUndefined()
		expect(actionPlansFor([archive, move], 'row').map((p) => p.key)).toEqual([
			'move',
		])
		expect(
			actionPlansFor([archive, { ...move, arity: 'both' }], 'selection').map(
				(p) => p.key,
			),
		).toEqual(['archive', 'move'])
	})

	it('composes the fixed write and the chosen value into one payload', () => {
		expect(actionWrite(archive, undefined)).toEqual({ status: 'archived' })
		expect(actionWrite(move, 'doing')).toEqual({ status: 'doing' })
	})
})

describe('a run writes exactly what was declared', () => {
	it('applies the declared value to every selected row', async () => {
		const ids = await seed(acme, 3, 'apply')
		const result = await opRunAction(ctxFor(acme), 'task', 'archive', {
			ids,
			batchId: 'b-apply',
		})
		expect(result.applied.map((o) => o.id).sort()).toEqual([...ids].sort())
		expect(result.failed).toEqual([])
		for (const id of ids) expect(await statusOf(acme, id)).toBe('archived')
	})

	it('refuses an action the resource does not declare', async () => {
		await expect(
			opRunAction(ctxFor(acme), 'task', 'nope', {
				ids: ['x'],
				batchId: 'b',
			}),
		).rejects.toBeInstanceOf(UnknownActionError)
	})
})

describe('the batch cannot reach further than the caller', () => {
	it('does NOT write rows in another tenant — the test that matters', async () => {
		const mine = await seed(acme, 1, 'mine')
		const theirs = await seed(globex, 1, 'theirs')
		const result = await opRunAction(ctxFor(acme), 'task', 'archive', {
			ids: [...mine, ...theirs],
			batchId: 'b-tenant',
		})

		expect(result.applied.map((o) => o.id)).toEqual(mine)
		expect(result.failed.map((o) => o.id)).toEqual(theirs)
		// Reads as "not found" rather than "forbidden" — a batch must not become a
		// way to learn that a row exists in somebody else's org.
		expect(result.failed[0]?.error).toContain('Not found')
		// And the row itself is untouched.
		expect(await statusOf(globex, theirs[0] as string)).toBe('open')
	})

	it('enforces the declared role on the BATCH, over and above the per-row check', async () => {
		const ids = await seed(acme, 1, 'role')
		await expect(
			opRunAction(ctxFor(acme), 'task', 'purge', { ids, batchId: 'b-role' }),
		).rejects.toBeInstanceOf(PermissionError)
		// Refused before a single row was read: the row is untouched.
		expect(await statusOf(acme, ids[0] as string)).toBe('open')

		const ok = await opRunAction(ctxFor(admin), 'task', 'purge', {
			ids,
			batchId: 'b-role-ok',
		})
		expect(ok.applied).toHaveLength(1)
	})

	it('a partial failure keeps the successes and names every refusal by id', async () => {
		const ids = await seed(acme, 2, 'partial')
		const result = await opRunAction(ctxFor(acme), 'task', 'archive', {
			ids: [...ids, '00000000-0000-0000-0000-000000000000'],
			batchId: 'b-partial',
		})
		expect(result.requested).toBe(3)
		expect(result.applied).toHaveLength(2)
		expect(result.failed).toHaveLength(1)
		expect(result.failed[0]?.error).toBeTruthy()
	})
})

describe('the declared cap', () => {
	it('refuses a selection over it WHOLE, rather than applying the first N', async () => {
		const ids = await seed(acme, 4, 'cap')
		await expect(
			opRunAction(ctxFor(acme), 'task', 'archive', { ids, batchId: 'b-cap' }),
		).rejects.toBeInstanceOf(SelectionTooLargeError)
		// Nothing was written — the refusal is the whole run, not a truncation.
		for (const id of ids) expect(await statusOf(acme, id)).toBe('open')
	})

	it('refuses an empty selection rather than reporting a successful no-op', async () => {
		await expect(
			opRunAction(ctxFor(acme), 'task', 'archive', {
				ids: [],
				batchId: 'b-empty',
			}),
		).rejects.toBeInstanceOf(SelectionTooLargeError)
	})

	it('deduplicates before checking the cap, so a repeated id is not a wider selection', async () => {
		const ids = await seed(acme, 2, 'dedup')
		const doubled = [...ids, ...ids]
		const result = await opRunAction(ctxFor(acme), 'task', 'archive', {
			ids: doubled,
			batchId: 'b-dedup',
		})
		expect(result.requested).toBe(2)
		expect(result.applied).toHaveLength(2)
	})
})

describe('the chosen value is bounded by the declaration, not by the caller', () => {
	it('applies a declared option', async () => {
		const [id] = await seed(acme, 1, 'choose')
		await opRunAction(ctxFor(acme), 'task', 'move', {
			ids: [id as string],
			choice: 'doing',
			batchId: 'b-choose',
		})
		expect(await statusOf(acme, id as string)).toBe('doing')
	})

	it('refuses a value outside the declared options', async () => {
		const [id] = await seed(acme, 1, 'bad-choice')
		await expect(
			opRunAction(ctxFor(acme), 'task', 'move', {
				ids: [id as string],
				choice: 'deleted',
				batchId: 'b-bad',
			}),
		).rejects.toBeInstanceOf(InvalidActionChoiceError)
		expect(await statusOf(acme, id as string)).toBe('open')
	})

	it('refuses a missing choice rather than writing the fixed half alone', async () => {
		const [id] = await seed(acme, 1, 'no-choice')
		await expect(
			opRunAction(ctxFor(acme), 'task', 'move', {
				ids: [id as string],
				batchId: 'b-none',
			}),
		).rejects.toBeInstanceOf(InvalidActionChoiceError)
		expect(await statusOf(acme, id as string)).toBe('open')
	})
})

describe('undo', () => {
	it('puts back exactly what the run overwrote, through the ordinary write path', async () => {
		const ids = await seed(acme, 2, 'undo')
		// Give the two rows different prior values, so a restore that wrote one
		// blanket value would be visible.
		await opRunAction(ctxFor(acme), 'task', 'move', {
			ids: [ids[0] as string],
			choice: 'doing',
			batchId: 'b-pre',
		})

		const run = await opRunAction(ctxFor(acme), 'task', 'archive', {
			ids,
			batchId: 'b-undo',
		})
		expect(await statusOf(acme, ids[0] as string)).toBe('archived')

		const undone = await opUndoAction(ctxFor(acme), 'task', run, 'b-undo-1')
		expect(undone.applied).toHaveLength(2)
		expect(await statusOf(acme, ids[0] as string)).toBe('doing')
		expect(await statusOf(acme, ids[1] as string)).toBe('open')
	})

	it('records only the columns the run wrote, so an unrelated edit survives it', async () => {
		const [id] = await seed(acme, 1, 'narrow')
		const run = await opRunAction(ctxFor(acme), 'task', 'archive', {
			ids: [id as string],
			batchId: 'b-narrow',
		})
		expect(run.applied[0]?.before).toEqual({ status: 'open' })
	})

	it('refuses to undo an action declared not undoable, rather than doing nothing quietly', async () => {
		const [id] = await seed(acme, 1, 'no-undo')
		const run = await opRunAction(ctxFor(acme), 'task', 'move', {
			ids: [id as string],
			choice: 'doing',
			batchId: 'b-noundo',
		})
		expect(run.applied[0]?.before).toBeUndefined()
		await expect(
			opUndoAction(ctxFor(acme), 'task', run, 'b-noundo-1'),
		).rejects.toBeInstanceOf(UnsupportedOperationError)
	})

	it('is itself authorized — a caller who lost the role cannot undo their way past it', async () => {
		const ids = await seed(acme, 1, 'undo-role')
		const run = await opRunAction(ctxFor(admin), 'task', 'purge', {
			ids,
			batchId: 'b-undo-role',
		})
		await expect(
			opUndoAction(ctxFor(acme), 'task', run, 'b-undo-role-1'),
		).rejects.toBeInstanceOf(PermissionError)
	})
})

describe('the audit trail', () => {
	it('writes one batch entry naming the selection, ALONGSIDE the per-row updates', async () => {
		const entries: OpAuditEntry[] = []
		const ids = await seed(acme, 2, 'audit')
		await opRunAction(
			ctxFor(acme, async (e) => {
				entries.push(e)
			}),
			'task',
			'archive',
			{ ids, batchId: 'b-audit' },
		)

		// The per-row entries are not suppressed — they are real writes.
		expect(entries.filter((e) => e.action === 'update')).toHaveLength(2)

		const batch = entries.find((e) => e.action === 'action:archive')
		expect(batch).toBeDefined()
		const metadata = batch?.metadata as Record<string, unknown>
		expect(metadata.batchId).toBe('b-audit')
		expect(metadata.requested).toBe(2)
		expect(metadata.applied).toEqual(ids)
		expect(metadata.write).toEqual({ status: 'archived' })
		// The reversal record, because this action declared itself undoable.
		expect(metadata.before).toEqual({
			[ids[0] as string]: { status: 'open' },
			[ids[1] as string]: { status: 'open' },
		})
	})

	it('records a run that changed nothing — the run somebody will ask about', async () => {
		const entries: OpAuditEntry[] = []
		const theirs = await seed(globex, 1, 'audit-none')
		const result: ActionRunResult = await opRunAction(
			ctxFor(acme, async (e) => {
				entries.push(e)
			}),
			'task',
			'archive',
			{ ids: theirs, batchId: 'b-none' },
		)
		expect(result.applied).toEqual([])
		const batch = entries.find((e) => e.action === 'action:archive')
		expect(batch).toBeDefined()
		expect((batch?.metadata ?? {})['applied']).toEqual([])
	})
})
