/**
 * What a caller is told when the *database* refuses a write (#352).
 *
 * The defect this file pins is the one #336 left behind. `fail()` maps by class
 * and forwards nothing it does not recognise, which is right — but no class
 * existed for an integrity violation, so a duplicate insert came back as
 * `{"error":"Internal error"}` with a 500, indistinguishable from the database
 * being down. A client cannot retry a 500; it can absolutely retry "that title
 * is taken".
 *
 * Every assertion below is about the *class* the error arrives as, never about
 * the prose. The message-text test is the load-bearing one: matching driver
 * strings is how the leak of #336 got in, so a lookalike message with no
 * SQLSTATE must stay a generic 500.
 */

import { describe, expect, it, vi } from 'vitest'
import { createHandler, deleteHandler } from './api.ts'
import {
	ConflictError,
	ConstraintViolationError,
	classifyConstraintViolation,
} from './constraints.ts'
import {
	createSpecDb,
	registerSpecEntities,
	type SpecEntityShape,
} from './from-spec.ts'
import type { OpContext } from './operations.ts'
import { ResourceRegistry } from './registry.ts'
import type { SproutStore } from './store.ts'

const BOOK: SpecEntityShape = {
	name: 'book',
	fields: [
		{ name: 'title', type: 'string', required: true },
		{ name: 'author', type: 'string', required: false },
		{ name: 'rating', type: 'number', required: false },
		{ name: 'notes', type: 'string', required: false },
	],
}

/**
 * A project whose `book` table carries the three constraints a real schema
 * grows: a unique key, a check, and a NOT NULL. They are added after the spec
 * DDL because the v1 spec vocabulary cannot declare them — which is the point:
 * a violation has to be classified from what the *driver* says, not from what
 * the spec knew.
 */
async function project(extraDdl: string[] = []): Promise<OpContext> {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [BOOK])
	const { client, store } = await createSpecDb(registry, [BOOK])
	for (const ddl of extraDdl) await client.exec(ddl)
	return { registry, store, user: { id: 'u-admin', role: 'admin' } }
}

const UNIQUE_TITLE =
	'ALTER TABLE "book" ADD CONSTRAINT "book_title_key" UNIQUE ("title")'
const RATING_CHECK =
	'ALTER TABLE "book" ADD CONSTRAINT "book_rating_check" CHECK ("rating" < 100)'
const NOTES_REQUIRED = 'ALTER TABLE "book" ALTER COLUMN "notes" SET NOT NULL'

/** The two things a body may never carry, whatever the status (#336). */
function expectNoStatementLeak(body: unknown): void {
	const json = JSON.stringify(body) ?? ''
	expect(json).not.toContain('insert into')
	expect(json).not.toContain('params:')
}

describe('a duplicate is a 409, not a generic 500', () => {
	it('names the field the caller has to change', async () => {
		const ctx = await project([UNIQUE_TITLE])
		expect(
			(await createHandler(ctx, 'book', { title: 'Piranesi' })).status,
		).toBe(201)

		const res = await createHandler(ctx, 'book', { title: 'Piranesi' })

		expect(res.status).toBe(409)
		const body = res.body as {
			error: string
			fieldErrors: Record<string, string[]>
			conflict: { fields: string[]; constraint?: string }
		}
		expect(body.conflict.fields).toEqual(['title'])
		expect(body.conflict.constraint).toBe('book_title_key')
		// The refusal arrives in the shape every write surface already renders, so
		// a form pins it to the input the person just typed in.
		expect(body.fieldErrors.title?.[0]).toBe(body.error)
		expect(body.error).toContain('title')
	})

	it('says nothing about the statement or the value that collided', async () => {
		const ctx = await project([UNIQUE_TITLE])
		await createHandler(ctx, 'book', { title: 'Piranesi', notes: 'secret' })

		const res = await createHandler(ctx, 'book', {
			title: 'Piranesi',
			notes: 'secret',
		})

		expectNoStatementLeak(res.body)
		// Postgres' own `detail` is `Key (title)=(Piranesi) already exists.` — the
		// conflicting row's value, which belongs to whoever wrote it, not to
		// whoever just lost the race. Naming the *column* is the actionable part;
		// echoing the value is not.
		const json = JSON.stringify(res.body) ?? ''
		expect(json).not.toContain('Piranesi')
		expect(json).not.toContain('already exists.')
		expect(json).not.toContain('secret')
	})

	it('carries the class, so every surface sees the same fact', async () => {
		const ctx = await project([UNIQUE_TITLE])
		await ctx.store.create('book', { title: 'Piranesi' })

		await expect(
			ctx.store.create('book', { title: 'Piranesi' }),
		).rejects.toThrow(ConflictError)
	})
})

describe('the other integrity violations are 422', () => {
	it('answers a broken check with the column the schema named it after', async () => {
		const ctx = await project([RATING_CHECK])

		const res = await createHandler(ctx, 'book', { title: 'A', rating: 500 })

		expect(res.status).toBe(422)
		const body = res.body as {
			error: string
			fieldErrors: Record<string, string[]>
			constraint: { kind: string; name?: string; fields: string[] }
		}
		expect(body.constraint.kind).toBe('check')
		expect(body.constraint.fields).toEqual(['rating'])
		expect(body.fieldErrors.rating).toBeDefined()
		expectNoStatementLeak(res.body)
	})

	it('answers a missing required column by the name the driver gives it', async () => {
		const ctx = await project([NOTES_REQUIRED])

		const res = await createHandler(ctx, 'book', { title: 'A' })

		expect(res.status).toBe(422)
		const body = res.body as {
			constraint: { kind: string; fields: string[] }
		}
		expect(body.constraint.kind).toBe('notNull')
		expect(body.constraint.fields).toEqual(['notes'])
	})

	it('classifies a foreign key by its SQLSTATE', () => {
		// 23503 needs a real FK to raise, and the v1 spec vocabulary emits none on
		// this table — so the mapping is pinned at the classifier, which is the
		// only place that decides. The driver shape is verbatim what pglite and
		// postgres.js both produce.
		const violation = classifyConstraintViolation(
			Object.assign(new Error('Failed query: insert into "book" …'), {
				cause: {
					code: '23503',
					table: 'book',
					constraint: 'book_author_fkey',
				},
			}),
			'book',
			['id', 'title', 'author'],
		)

		expect(violation).toBeInstanceOf(ConstraintViolationError)
		expect(violation).not.toBeInstanceOf(ConflictError)
		expect(violation?.kind).toBe('foreignKey')
		expect(violation?.fields).toEqual(['author'])
	})
})

describe('the classifier reads the code, never the prose', () => {
	it('leaves a lookalike message alone', () => {
		// Same words Postgres uses, no SQLSTATE anywhere: a driver we have not
		// taught the platform about, an app-level throw, a bug. Recognising this
		// would mean the boundary was matching text again.
		const impostor = new Error(
			'duplicate key value violates unique constraint "book_title_key"',
		)

		expect(
			classifyConstraintViolation(impostor, 'book', ['title']),
		).toBeUndefined()
	})

	it('keeps a lookalike a generic 500 at the REST boundary', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [BOOK])
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
		const ctx: OpContext = {
			registry,
			store: new Proxy({} as SproutStore, {
				get: () => () =>
					Promise.reject(
						new Error(
							'duplicate key value violates unique constraint "book_title_key"',
						),
					),
			}),
			user: { id: 'u-admin', role: 'admin' },
		}

		const res = await createHandler(ctx, 'book', { title: 'A' })
		stderr.mockRestore()

		expect(res.status).toBe(500)
		// Exact, not a subset match: this is the assertion that fails if the
		// impostor's prose ever reaches a body. Every field #450 added is derived
		// from the refusal *code*, so none of it can carry anything the driver
		// said — `fault: 'platform'` is the whole addition, and it is the fact
		// that tells an agent this one is not its request to fix.
		expect(res.body).toEqual({
			error: 'Internal error',
			errorId: expect.stringMatching(/^err_/),
			code: 'internal',
			message: 'Internal error',
			fault: 'platform',
			retry: { retryable: true },
			next: expect.stringContaining('Nothing you can change'),
		})
	})

	it('ignores a SQLSTATE that is not an integrity violation', () => {
		// 22P02 is a malformed literal — a different bug with a different answer
		// (#354), and nothing here may claim it.
		expect(
			classifyConstraintViolation({ code: '22P02' }, 'book', ['id']),
		).toBeUndefined()
	})

	it('finds the code under drizzle’s wrapper rather than one level up', () => {
		// Drizzle's own error carries the statement as its `message` and hangs the
		// driver's error off `cause`. A classifier that only looked at the top
		// object would find no code and forward every violation as a 500.
		const wrapped = Object.assign(new Error('Failed query: …'), {
			code: 'DRIZZLE',
			cause: { code: '23505', table: 'book', constraint: 'book_title_key' },
		})

		expect(
			classifyConstraintViolation(wrapped, 'book', ['title']),
		).toBeInstanceOf(ConflictError)
	})
})

describe('the classification survives a delete', () => {
	it('leaves an ordinary delete untouched', async () => {
		const ctx = await project([UNIQUE_TITLE])
		const created = (await createHandler(ctx, 'book', { title: 'A' })).body as {
			id: string
		}

		const res = await deleteHandler(ctx, 'book', created.id)

		expect(res.status).toBe(200)
	})
})
