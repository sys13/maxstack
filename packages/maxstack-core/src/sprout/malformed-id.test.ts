/**
 * A key that cannot exist is answered like a key that does not exist (#354).
 *
 * `GET /api/book/nonsense` against a `uuid` primary key failed inside the
 * driver, so it came back 500 while `GET /api/book/<absent uuid>` came back 404
 * — two answers to one question, and the wrong one of the two tells a client to
 * retry a URL that will never work. #335 fixed the routing half (a root page no
 * longer reads every undeclared path as a record id); this is the op half, and
 * it covers every direct REST call as well as `/decks/nonsense` under a declared
 * page.
 *
 * The thing these tests actually pin is *where the decision lives*. Whether a
 * given string could be a key is a fact about the schema behind the store —
 * `'r1'` is impossible against `uuid` and ordinary against `text`, and a store
 * with no columns at all has no opinion — so it is asked of the store
 * (`SproutStore.acceptsId`) and only an explicit `false` refuses. A store that
 * does not implement it must keep behaving exactly as it did, which is what
 * makes every hand-written test id elsewhere in the suite safe.
 */

import { describe, expect, it, vi } from 'vitest'
import {
	deleteHandler,
	getHandler,
	getManyHandler,
	updateHandler,
} from './api.ts'
import {
	createSpecDb,
	registerSpecEntities,
	type SpecEntityShape,
} from './from-spec.ts'
import { NotFoundError, type OpContext, opGet } from './operations.ts'
import { ResourceRegistry } from './registry.ts'
import type { Row, SproutStore } from './store.ts'

const BOOK: SpecEntityShape = {
	name: 'book',
	fields: [
		{ name: 'title', type: 'string', required: true },
		{ name: 'author', type: 'string', required: false },
	],
}

const admin = { id: 'u-admin', role: 'admin' }

/** A well-formed key no row holds — the control arm for every case below. */
const ABSENT_ID = '00000000-0000-4000-8000-000000000000'

async function project(): Promise<{ ctx: OpContext; id: string }> {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [BOOK])
	const { store } = await createSpecDb(registry, [BOOK])
	const ctx: OpContext = { registry, store, user: admin }
	const row = await store.create('book', { title: 'Piranesi' })
	return { ctx, id: String(row.id) }
}

describe('a malformed id is a miss, not a failure', () => {
	it('answers the issue’s own request with 404', async () => {
		const { ctx } = await project()

		const res = await getHandler(ctx, 'book', 'nonsense')

		expect(res.status).toBe(404)
		// The same answer a well-formed absent key gets, down to the shape of the
		// body — that is the whole claim. Only the echoed id differs, because the
		// two calls asked about different ids.
		const absent = await getHandler(ctx, 'book', ABSENT_ID)
		expect(res.status).toBe(absent.status)
		expect(Object.keys(res.body as object)).toEqual(
			Object.keys(absent.body as object),
		)
		expect((res.body as { error: string }).error).toBe(
			(absent.body as { error: string }).error.replace(ABSENT_ID, 'nonsense'),
		)
	})

	it('answers it the same way on every id-taking op', async () => {
		const { ctx } = await project()

		expect((await getHandler(ctx, 'book', 'nonsense')).status).toBe(404)
		expect(
			(await updateHandler(ctx, 'book', 'nonsense', { title: 'B' })).status,
		).toBe(404)
		expect((await deleteHandler(ctx, 'book', 'nonsense')).status).toBe(404)
	})

	it('costs no query at all', async () => {
		const { ctx } = await project()
		const get = vi.spyOn(ctx.store, 'get')

		await getHandler(ctx, 'book', 'nonsense')

		// 404ing *before* the store is the point: an id that cannot exist must not
		// spend a round-trip, or a crawler probing paths is a load generator.
		expect(get).not.toHaveBeenCalled()
	})

	it('throws the error the ops already had, not a new one', async () => {
		const { ctx } = await project()

		await expect(opGet(ctx, 'book', 'nonsense')).rejects.toBeInstanceOf(
			NotFoundError,
		)
	})

	it('still finds the row when the id is well-formed', async () => {
		const { ctx, id } = await project()

		const res = await getHandler(ctx, 'book', id)

		expect(res.status).toBe(200)
		expect((res.body as { title: string }).title).toBe('Piranesi')
	})
})

describe('a batch drops the impossible ids instead of failing', () => {
	it('returns the rows it could find', async () => {
		const { ctx, id } = await project()

		const res = await getManyHandler(ctx, 'book', ['nonsense', id])

		// Previously the malformed id failed the whole round-trip, so one bad FK
		// value blanked every reference on the page.
		expect(res.status).toBe(200)
		expect((res.body as Row[]).map((r) => r.id)).toEqual([id])
	})
})

describe('the store decides what malformed means, not the op', () => {
	it('refuses nothing when the store has no opinion', async () => {
		// The in-memory shape a test or a non-Postgres backend uses: no `acceptsId`,
		// so `'r1'` is an ordinary key and reaches the store exactly as before. This
		// is the sweep the issue warned about, pinned rather than hoped for.
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [BOOK])
		const rows = new Map<string, Row>([['r1', { id: 'r1', title: 'Made up' }]])
		const store = {
			get: (_r: string, id: string) => Promise.resolve(rows.get(id) ?? null),
			getMany: (_r: string, ids: readonly string[]) =>
				Promise.resolve(ids.map((i) => rows.get(i)).filter((r) => r != null)),
		} as unknown as SproutStore
		const ctx: OpContext = { registry, store, user: admin }

		expect((await getHandler(ctx, 'book', 'r1')).status).toBe(200)
		expect((await getManyHandler(ctx, 'book', ['r1'])).body).toHaveLength(1)
	})

	it('reads the primary key’s declared type, not the caller’s guess', async () => {
		const { ctx } = await project()
		const accepts = ctx.store.acceptsId?.bind(ctx.store)

		expect(accepts?.('book', ABSENT_ID)).toBe(true)
		expect(accepts?.('book', 'nonsense')).toBe(false)
		// `10` is not a uuid either, and the digits reading that `matchProjectPath`
		// allows for hand-rolled integer keys must not leak into a uuid table.
		expect(accepts?.('book', '10')).toBe(false)
		// An unregistered resource is not this method's refusal to make — `opGet`
		// answers that with `UnknownResourceError` before it ever asks.
		expect(accepts?.('widget', 'nonsense')).toBe(true)
	})
})
