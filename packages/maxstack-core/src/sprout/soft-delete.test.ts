/**
 * Soft delete (`ResourceConfig.softDelete`) over pglite: `opDelete`
 * stamps `deletedAt` instead of removing the row, every read op filters it out
 * by default with an `includeDeleted` escape hatch, and `opRestore` clears it.
 * Mirrors tenancy.test.ts's shape (a self-contained table + registry, real
 * pglite store) for the same reason: prove the behavior end-to-end through the
 * op layer, not just unit-test a helper.
 */

import type { PGlite } from '@electric-sql/pglite'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzleStore } from '../demo/store.ts'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import { restoreHandler } from './api.ts'
import {
	NotFoundError,
	type OpContext,
	opCount,
	opCreate,
	opDelete,
	opGet,
	opGetMany,
	opList,
	opRestore,
	opUpdate,
	UnsupportedOperationError,
} from './operations.ts'
import { ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'

const note = pgTable('note', {
	id: uuid('id').primaryKey().defaultRandom(),
	body: withMeta(text('body'), { label: 'Body', required: true }).notNull(),
	deletedAt: timestamp('deletedAt'),
})

const DDL = `
CREATE TABLE "note" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "body" text NOT NULL,
  "deletedAt" timestamp
);
`

const admin = { id: 'admin', role: 'admin' }

let client: PGlite
let ctx: OpContext

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	const registry = new ResourceRegistry()
	registry.register(note, { softDelete: true })
	const store = createDrizzleStore(drizzle({ client }), registry)
	ctx = { registry, store, user: admin }
})

afterAll(async () => {
	await client.close()
})

describe('soft delete', () => {
	let liveId: string

	it('a client-sent deletedAt on create is ignored — a row is always created live', async () => {
		const created = await opCreate(ctx, 'note', {
			body: 'hello',
			deletedAt: new Date().toISOString(),
		})
		expect(created.deletedAt).toBeNull()
		liveId = created.id as string
	})

	it('opDelete stamps deletedAt instead of removing the row', async () => {
		const ok = await opDelete(ctx, 'note', liveId)
		expect(ok).toBe(true)
		// Gone from the default (live-only) scope...
		await expect(opGet(ctx, 'note', liveId)).rejects.toThrow(NotFoundError)
		// ...but still physically present with includeDeleted.
		const row = await opGet(ctx, 'note', liveId, { includeDeleted: true })
		expect(row.deletedAt).not.toBeNull()
	})

	it('opList/opCount exclude soft-deleted rows by default, includeDeleted brings them back', async () => {
		const other = await opCreate(ctx, 'note', { body: 'still live' })

		const defaultList = await opList(ctx, 'note')
		expect(defaultList.map((r) => r.id)).toEqual([other.id])
		expect(await opCount(ctx, 'note')).toBe(1)

		const withDeleted = await opList(ctx, 'note', { includeDeleted: true })
		expect(withDeleted.map((r) => r.id).sort()).toEqual(
			[liveId, other.id].sort(),
		)
		expect(await opCount(ctx, 'note', { includeDeleted: true })).toBe(2)
	})

	it('opGetMany excludes soft-deleted rows by default', async () => {
		const other = (await opList(ctx, 'note'))[0]
		const rows = await opGetMany(ctx, 'note', [liveId, other?.id as string])
		expect(rows.map((r) => r.id)).toEqual([other?.id])
		const withDeleted = await opGetMany(
			ctx,
			'note',
			[liveId, other?.id as string],
			{ includeDeleted: true },
		)
		expect(withDeleted).toHaveLength(2)
	})

	it('a soft-deleted row cannot be edited through opUpdate', async () => {
		await expect(
			opUpdate(ctx, 'note', liveId, { body: 'edited' }),
		).rejects.toThrow(NotFoundError)
	})

	it('deleting an already-deleted row 404s (no double-stamp)', async () => {
		await expect(opDelete(ctx, 'note', liveId)).rejects.toThrow(NotFoundError)
	})

	it('a client-sent deletedAt through opUpdate is stripped, not applied', async () => {
		const row = await opCreate(ctx, 'note', { body: 'no self-delete' })
		const updated = await opUpdate(ctx, 'note', row.id as string, {
			body: 'still no self-delete',
			deletedAt: new Date().toISOString(),
		})
		expect(updated.deletedAt).toBeNull()
	})

	it('opRestore clears deletedAt, making the row live again', async () => {
		const restored = await opRestore(ctx, 'note', liveId)
		expect(restored.deletedAt).toBeNull()
		const row = await opGet(ctx, 'note', liveId)
		expect(row.id).toBe(liveId)
	})

	it('opRestore 404s on a row that is not deleted', async () => {
		await expect(opRestore(ctx, 'note', liveId)).rejects.toThrow(NotFoundError)
	})

	// Typed, not a bare Error: `POST /api/:resource/:id/restore` renders this as
	// a 422 ("this resource has no undo"), and a bare Error would 500 there.
	it('opRestore throws UnsupportedOperationError without soft delete', async () => {
		const registry = new ResourceRegistry()
		const plain = pgTable('plain_note', {
			id: uuid('id').primaryKey().defaultRandom(),
			body: text('body').notNull(),
		})
		registry.register(plain, {})
		const store = createDrizzleStore(drizzle({ client }), registry)
		await client.exec(
			`CREATE TABLE plain_note (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL);`,
		)
		const plainCtx: OpContext = { registry, store, user: admin }
		const row = await opCreate(plainCtx, 'plain_note', { body: 'x' })
		await expect(
			opRestore(plainCtx, 'plain_note', row.id as string),
		).rejects.toThrow(UnsupportedOperationError)

		const { status } = await restoreHandler(
			plainCtx,
			'plain_note',
			row.id as string,
		)
		expect(status).toBe(422)
	})
})
