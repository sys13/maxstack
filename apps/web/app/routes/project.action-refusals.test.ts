/**
 * What a generated page's actions do with a request they do not serve (#376).
 *
 * A dogfood session built the app, could not find the page's own routes
 * anywhere it could ask, and probed: `{"intent":"delete"}` as JSON → 500,
 * `DELETE <route>/<id>` → 500. Both are caller errors, and both came back as
 * ours — a 5xx reads as "I found a bug in the platform", so the session stopped
 * and reported the delete path unverified over a button that works.
 *
 * So the regression these pin is a **status class**, not a message: a wrong
 * guess at one of these URLs must be 4xx. The second half pins that the refusal
 * names the shapes that *do* work, out of the same `pageContract` endpoint list
 * `query_spec {section:"pages"}` publishes — a refusal that says only "no" costs
 * the same round trip the 500 did.
 *
 * The two surfaces are exercised directly, with the spec resolution and the
 * store mocked: what is under test is the action's own gate, which runs before
 * either, and the write handlers are stubs so the accepted shapes can be
 * asserted as *reaching* them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What `data(body, init)` returns. Spelled out rather than imported: react-router
 * exports the type only as `UNSAFE_DataWithResponseInit`, and the two fields the
 * assertions read are the whole of it.
 */
interface Refused {
	data: { error: string }
	init?: { status?: number; headers?: Record<string, string> }
}

const updateHandler = vi.fn(async () => ({ status: 200, body: {} }))
const deleteHandler = vi.fn(async () => ({ status: 200, body: {} }))
const createHandler = vi.fn(async () => ({ status: 200, body: {} }))

// The contract helpers stay real — a refusal composed from a stubbed contract
// would prove nothing about the sentence a caller actually reads.
vi.mock('@maxstack/core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@maxstack/core')>()),
	updateHandler,
	deleteHandler,
	createHandler,
}))

const page = { slug: 'decks', route: '/decks', resource: 'deck' }

vi.mock('~/project.server', () => ({
	resolveProjectResource: async () => ({
		page,
		nav: [],
		resource: 'deck',
		primaryKey: 'id',
		introspection: { name: 'deck', columns: [], primaryKey: 'id' },
	}),
	projectChrome: async () => ({ title: 'Decks', theme: {}, demoRows: 0 }),
}))

vi.mock('~/sprout.server', () => ({
	getContext: async () => ({}),
	referenceFieldOptions: async () => ({ options: {}, create: {} }),
	relatedRecords: async () => [],
	resolveRowFiles: () => ({}),
}))

vi.mock('~/live.server', () => ({ liveSlotFor: async () => undefined }))

const { action: editAction } = await import('./project.edit.server')
const { action: newAction } = await import('./project.new.server')

/** The `data(...)` an action refuses with, as status + message. */
function refusal(result: unknown): { status: number; error: string } {
	const { data, init } = result as Refused
	return { status: init?.status ?? 200, error: data.error }
}

const record = (request: Request) =>
	editAction({ request, params: { page: 'decks', id: 'r1' } })

const create = (request: Request) =>
	newAction({ request, params: { page: 'decks' } })

beforeEach(() => {
	updateHandler.mockClear()
	deleteHandler.mockClear()
	createHandler.mockClear()
})

describe('POST <route>/:id — the record surface', () => {
	it('refuses a verb it does not serve with 405, not a TypeError', async () => {
		// React Router routes EVERY non-GET method to `action`, so this used to
		// reach `request.formData()` on a body-less request and throw.
		const res = refusal(
			await record(
				new Request('http://x/decks/r1', {
					method: 'DELETE',
				}),
			),
		)
		expect(res.status).toBe(405)
		expect(res.error).toContain('DELETE is not served here')
		// One round trip: the refusal names both shapes that do work.
		expect(res.error).toContain('intent=delete')
		expect(res.error).toContain('DELETE /api/deck/:id')
	})

	it('names the verbs it does serve in `Allow`', async () => {
		const { init } = (await record(
			new Request('http://x/decks/r1', { method: 'PUT' }),
		)) as Refused
		expect(init?.headers).toMatchObject({ Allow: 'GET, POST' })
	})

	it('refuses a JSON `intent` with 400 instead of updating with it', async () => {
		// In the JSON branch every key is a field name, so this reached
		// `updateHandler`, where zod stripped the unknown key and the resulting
		// empty update became a driver error.
		const res = refusal(
			await record(
				new Request('http://x/decks/r1', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ intent: 'delete' }),
				}),
			),
		)
		expect(res.status).toBe(400)
		expect(res.error).toContain('`intent` is a form field here')
		expect(updateHandler).not.toHaveBeenCalled()
		expect(deleteHandler).not.toHaveBeenCalled()
	})

	it('refuses a malformed JSON body with 400', async () => {
		const res = refusal(
			await record(
				new Request('http://x/decks/r1', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{ not json',
				}),
			),
		)
		expect(res.status).toBe(400)
		expect(res.error).toContain('Body is not a JSON object')
	})

	it('still updates from a JSON object of field values', async () => {
		await record(
			new Request('http://x/decks/r1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Renamed' }),
			}),
		)
		expect(updateHandler).toHaveBeenCalledWith({}, 'deck', 'r1', {
			title: 'Renamed',
		})
	})

	it('still deletes from a form body with intent=delete', async () => {
		const body = new URLSearchParams({ intent: 'delete' })
		await record(new Request('http://x/decks/r1', { method: 'POST', body }))
		expect(deleteHandler).toHaveBeenCalledWith({}, 'deck', 'r1')
	})

	it('names the accepted shapes on an unrecognized form body', async () => {
		const body = new URLSearchParams({ intent: 'archive' })
		const res = refusal(
			await record(new Request('http://x/decks/r1', { method: 'POST', body })),
		)
		expect(res.status).toBe(400)
		expect(res.error).toContain('Unsupported action')
		expect(res.error).toContain('POST /decks/:id')
	})
})

describe('POST <route>/new — the create surface', () => {
	it('refuses a verb it does not serve with 405', async () => {
		const res = refusal(
			await create(new Request('http://x/decks/new', { method: 'DELETE' })),
		)
		expect(res.status).toBe(405)
		expect(res.error).toContain('POST /decks/new')
	})

	it('refuses a form-encoded body with 400 rather than a SyntaxError', async () => {
		// `request.json()` was unguarded here, so the create form's own encoding
		// sent by hand — the obvious guess — was a 500 too.
		const body = new URLSearchParams({ title: 'Deck' })
		const res = refusal(
			await create(new Request('http://x/decks/new', { method: 'POST', body })),
		)
		expect(res.status).toBe(400)
		expect(res.error).toContain('Body is not a JSON object')
		expect(createHandler).not.toHaveBeenCalled()
	})

	it('still creates from a JSON object of field values', async () => {
		await create(
			new Request('http://x/decks/new', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Deck' }),
			}),
		)
		expect(createHandler).toHaveBeenCalledWith({}, 'deck', { title: 'Deck' })
	})
})
