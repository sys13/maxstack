/**
 * What a REST body is allowed to say when a call fails (#336).
 *
 * The defect this file pins: a driver error's `message` is the failed statement
 * — the SQL, every column in the projection, and the bound parameters — and
 * `fail()` used to hand it straight back, so `GET /api/book/nonsense` published
 * the table's shape and the caller's own input to an unauthenticated request.
 *
 * Two assertions, deliberately paired. The detail must reach **stderr**, or the
 * fix has traded a leak for an undiagnosable app; and it must not reach the
 * **body**, whichever handler produced it. The body half is asserted over every
 * exported handler rather than over `get` alone, because the leak was never a
 * property of one path — it was a property of the boundary they all share, and
 * a test pinned to one path would go green while a tenth handler added later
 * leaks.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from 'vitest'
import {
	countHandler,
	createHandler,
	deleteHandler,
	getHandler,
	getManyHandler,
	listHandler,
	restoreHandler,
	searchHandler,
	updateHandler,
} from './api.ts'
import {
	createSpecDb,
	registerSpecEntities,
	type SpecEntityShape,
} from './from-spec.ts'
import {
	LimitExceededError,
	NotFoundError,
	type OpContext,
	RateLimitedError,
	UnknownResourceError,
	UnsupportedOperationError,
	ValidationError,
} from './operations.ts'
import { PermissionError } from './permissions.ts'
import { ResourceRegistry } from './registry.ts'
import type { SproutStore } from './store.ts'

/** The issue's own entity: a projection wide enough that leaking it leaks
 * something worth having. */
const BOOK: SpecEntityShape = {
	name: 'book',
	fields: [
		{ name: 'title', type: 'string', required: true },
		{ name: 'author', type: 'string', required: false },
		{ name: 'rating', type: 'number', required: false },
		{ name: 'notes', type: 'string', required: false },
	],
}

const admin = { id: 'u-admin', role: 'admin' }

async function project(): Promise<OpContext> {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [BOOK])
	const { store } = await createSpecDb(registry, [BOOK])
	return { registry, store, user: admin }
}

/** A well-formed key that no row holds — the id the tests below travel with. */
const ABSENT_ID = '00000000-0000-4000-8000-000000000000'

/**
 * A project whose table has gone out from under the registry, so a *real*
 * driver error reaches `fail()` end to end.
 *
 * The three tests below used to reach the driver with the issue's own
 * `GET /api/book/nonsense`, whose id is not a uuid. Since #354 a key that cannot
 * exist is answered as a miss before any query runs, so that call is a 404 and
 * no longer produces a driver failure to report — but what #336 pins is what
 * happens when one *does*, and that must keep being asserted against a genuine
 * driver error rather than a hand-written `Error`. Dropping the table is the
 * cheapest way to keep one: the id is valid, the authorization passes, and
 * Postgres refuses the statement itself (SQLSTATE 42P01) with the projection in
 * the message — which is exactly the class of failure the boundary exists for.
 */
async function projectWithMissingTable(): Promise<OpContext> {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [BOOK])
	const { client, store } = await createSpecDb(registry, [BOOK])
	await client.exec('DROP TABLE "book"')
	return { registry, store, user: admin }
}

/**
 * Every exported handler, called with arguments that are well-formed *for that
 * handler* — so the only thing that varies across the list is how the call
 * fails, never whether it was asked properly.
 */
function everyHandler(
	ctx: OpContext,
	id: string,
): { name: string; call: () => Promise<{ status: number; body: unknown }> }[] {
	return [
		{ name: 'list', call: () => listHandler(ctx, 'book') },
		{ name: 'search', call: () => searchHandler(ctx, 'book', 'piranesi') },
		{ name: 'get', call: () => getHandler(ctx, 'book', id) },
		{ name: 'count', call: () => countHandler(ctx, 'book') },
		{ name: 'getMany', call: () => getManyHandler(ctx, 'book', [id]) },
		{ name: 'create', call: () => createHandler(ctx, 'book', { title: 'A' }) },
		{
			name: 'update',
			call: () => updateHandler(ctx, 'book', id, { title: 'B' }),
		},
		{ name: 'delete', call: () => deleteHandler(ctx, 'book', id) },
		{ name: 'restore', call: () => restoreHandler(ctx, 'book', id) },
	]
}

/**
 * The class-level assertion the issue asked for: no `/api/*` body, ever,
 * carries a statement fragment or a bound-parameter dump. Matched against the
 * serialized body, so a leak nested under `fieldErrors` counts too.
 */
function expectNoStatementLeak(body: unknown): void {
	const json = JSON.stringify(body) ?? ''
	expect(json).not.toContain('select ')
	expect(json).not.toContain('params:')
}

/** A store whose every method fails the way a driver fails. */
function throwingStore(error: unknown): SproutStore {
	const boom = () => Promise.reject(error)
	return new Proxy({} as SproutStore, {
		// `acceptsId` is the one member that is *not* async and not a query: it is
		// a synchronous shape test the ops consult before touching the store
		// (#354). Fabricating a rejected promise for it would be this proxy lying
		// about the interface — the ops would discard the promise unread and the
		// run would collect an unhandled rejection per call. Absent is the honest
		// answer, and it is the one that keeps every handler below reaching the
		// store, which is what this fixture exists to make them do.
		get: (_target, property) => (property === 'acceptsId' ? undefined : boom),
	})
}

/** Drizzle's wrapper verbatim — the string the issue found in a response. */
const DRIVER_ERROR = new Error(
	'Failed query: select "id", "title", "author", "rating", "notes" from "book" where "book"."id" = $1\nparams: nonsense',
)

let stderr: MockInstance<(...args: unknown[]) => void>

beforeEach(() => {
	// The detail is *supposed* to be printed; silencing it keeps the suite
	// readable while still letting us assert it happened.
	stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
	stderr.mockRestore()
})

describe('a driver failure is reported, not republished', () => {
	it('answers a driver failure with a generic body and a correlation id', async () => {
		const ctx = await projectWithMissingTable()
		// A failure raised inside the driver rather than in anything we
		// constructed — see `projectWithMissingTable` for why it is this one.
		const res = await getHandler(ctx, 'book', ABSENT_ID)

		expect(res.status).toBe(500)
		expect(res.body).toEqual({
			error: 'Internal error',
			errorId: expect.stringMatching(/^err_/),
		})
		expectNoStatementLeak(res.body)
	})

	it('prints the statement to stderr, keyed by the id the caller was given', async () => {
		const ctx = await projectWithMissingTable()
		const res = await getHandler(ctx, 'book', ABSENT_ID)
		const { errorId } = res.body as { errorId: string }

		const line = stderr.mock.calls
			.map((args) => String(args[0]))
			.find((l) => l.includes(errorId))
		expect(line).toBeDefined()
		const logged = JSON.parse(String(line)) as Record<string, unknown>
		expect(logged.level).toBe('error')
		expect(logged.resource).toBe('book')
		expect(logged.operation).toBe('get')
		// The half that must NOT be lost: an operator reading stderr still gets the
		// failing statement, which is the whole reason it was ever in the body.
		expect(String(logged.message)).toContain('select ')
		expect(String(logged.message)).toContain(ABSENT_ID)
	})

	it('leaks nothing from any handler, whatever the store throws', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [BOOK])
		const ctx: OpContext = {
			registry,
			store: throwingStore(DRIVER_ERROR),
			user: admin,
		}

		let reachedTheStore = 0
		for (const { name, call } of everyHandler(
			ctx,
			'00000000-0000-4000-8000-000000000000',
		)) {
			const res = await call()
			expectNoStatementLeak(res.body)
			// Either the store was reached (generic 500) or the op refused before it
			// on its own terms — never a 500 that quotes the driver.
			if (res.status === 500) {
				reachedTheStore++
				expect(res.body, name).toEqual({
					error: 'Internal error',
					errorId: expect.stringMatching(/^err_/),
				})
			}
		}
		// Otherwise a handler set that never reached the store would pass this test
		// by doing nothing.
		expect(reachedTheStore).toBeGreaterThan(4)
	})

	it('gives each failure its own id, so two reports are distinguishable', async () => {
		const ctx = await projectWithMissingTable()
		const a = (await getHandler(ctx, 'book', ABSENT_ID)).body as {
			errorId: string
		}
		const b = (
			await getHandler(ctx, 'book', '11111111-1111-4111-8111-111111111111')
		).body as { errorId: string }
		expect(a.errorId).not.toBe(b.errorId)
	})
})

describe('a refusal we constructed still says what it means', () => {
	/**
	 * The boundary is class membership, so this is the half that proves it did not
	 * become "hide everything". Each error is thrown from the store position to
	 * isolate `fail()`'s mapping from whatever op happens to raise it in practice.
	 */
	const cases: { error: Error; status: number; expect: (b: never) => void }[] =
		[
			{
				error: new NotFoundError('book', 'x'),
				status: 404,
				expect: (b: { error: string }) =>
					expect(b.error).toContain('Not found'),
			},
			{
				error: new UnknownResourceError('widget'),
				status: 404,
				expect: (b: { error: string }) =>
					expect(b.error).toContain('Unknown resource'),
			},
			{
				error: new PermissionError('book', 'read'),
				status: 403,
				expect: (b: { error: string }) => expect(b.error).toBeTruthy(),
			},
			{
				error: new ValidationError({ title: ['Required'] }),
				status: 422,
				expect: (b: { fieldErrors: Record<string, string[]> }) =>
					expect(b.fieldErrors.title).toEqual(['Required']),
			},
			{
				error: new LimitExceededError('book', 'status', 'doing', 2, 2),
				status: 422,
				expect: (b: { limit: { limit: number } }) =>
					expect(b.limit.limit).toBe(2),
			},
			{
				error: new UnsupportedOperationError(
					'book',
					'restore',
					'no softDelete',
				),
				status: 422,
				expect: (b: { error: string }) => expect(b.error).toContain('Cannot'),
			},
			{
				// Would otherwise fall into the generic 500 and tell a throttled caller
				// to retry immediately.
				error: new RateLimitedError('book', 'submit', 5),
				status: 429,
				expect: (b: { error: string }) =>
					expect(b.error).toContain('Too many requests'),
			},
		]

	for (const c of cases) {
		it(`${c.error.name} keeps its status and its body`, async () => {
			const registry = new ResourceRegistry()
			registerSpecEntities(registry, [BOOK])
			const res = await listHandler(
				{ registry, store: throwingStore(c.error), user: admin },
				'book',
			)
			expect(res.status).toBe(c.status)
			c.expect(res.body as never)
			expect(stderr).not.toHaveBeenCalled()
		})
	}

	it('a real validation refusal still arrives with its repair instructions', async () => {
		const ctx = await project()
		const res = await createHandler(ctx, 'book', { rating: 'not a number' })
		expect(res.status).toBe(422)
		expectNoStatementLeak(res.body)
		expect((res.body as { fieldErrors: object }).fieldErrors).toBeTruthy()
	})

	it('a missing row is still a 404 that names it', async () => {
		const ctx = await project()
		const res = await getHandler(
			ctx,
			'book',
			'00000000-0000-4000-8000-000000000000',
		)
		expect(res.status).toBe(404)
		expectNoStatementLeak(res.body)
	})
})
