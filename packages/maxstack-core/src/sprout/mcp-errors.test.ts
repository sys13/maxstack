/**
 * What an MCP tool result is allowed to say when a call fails (#353).
 *
 * #336 fixed the REST surface: a driver error's `message` is the failed
 * statement — the SQL, every column in the projection, and the bound parameters
 * — and `fail()` used to hand it straight back. The MCP surface ran the same ops
 * over the same driver and still returned `err(e.message)`, so
 * `tools/call {name: "get_record"}` answered with everything `GET /api/book/…`
 * had stopped answering with.
 *
 * The severity is genuinely lower and the fix is scoped to say so, which is what
 * the `exposure` half of this file is about. What is *not* lower is the class:
 * the CRUD tools reached here need a registry and a store, so the only host that
 * wires them is the web app's `POST /mcp` — authenticated, but over the network,
 * reachable with an API key scoped to one resource, and answering into a
 * transcript that gets pasted into an issue. Everything below therefore asserts
 * the network default; `jsonrpc.test.ts` asserts that a host may opt out of it
 * and what happens when one does.
 *
 * Paired assertions, as in `api.test.ts`: the detail must reach **stderr** (or
 * the fix has traded a leak for an undiagnosable app) and must not reach the
 * **result** — and the refusals a caller can act on must survive, or the fix has
 * turned "you sent a duplicate" into "something went wrong".
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
	createSpecDb,
	registerSpecEntities,
	type SpecEntityShape,
} from './from-spec.ts'
import { executeMCPTool, type McpToolResult } from './mcp.ts'
import { NotFoundError, type OpContext } from './operations.ts'
import { ResourceRegistry } from './registry.ts'
import type { SproutStore } from './store.ts'

/** #336's own entity — a projection wide enough that leaking it leaks
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

/** A well-formed key that no row holds. */
const ABSENT_ID = '00000000-0000-4000-8000-000000000000'

/**
 * A project whose table has gone out from under the registry, so a **real**
 * driver error travels the whole way to the tool result.
 *
 * Same fixture, and the same reasoning, as `api.test.ts`: a hand-written `Error`
 * would prove only that the boundary redacts strings somebody handed it. What
 * has to be pinned is that it redacts the string *Postgres* hands it, with the
 * projection already inside.
 */
async function projectWithMissingTable(): Promise<OpContext> {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [BOOK])
	const { client, store } = await createSpecDb(registry, [BOOK])
	await client.exec('DROP TABLE "book"')
	return { registry, store, user: admin }
}

async function project(): Promise<OpContext> {
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [BOOK])
	const { store } = await createSpecDb(registry, [BOOK])
	return { registry, store, user: admin }
}

function text(res: McpToolResult): string {
	return res.content.map((c) => c.text).join('\n')
}

/**
 * The class-level assertion: no tool result, ever, carries a statement fragment
 * or a bound-parameter dump.
 */
function expectNoStatementLeak(res: McpToolResult): void {
	expect(text(res)).not.toContain('select ')
	expect(text(res)).not.toContain('params:')
}

/** Drizzle's wrapper verbatim — the string #336 found in a response body. */
const DRIVER_ERROR = new Error(
	'Failed query: select "id", "title", "author", "rating", "notes" from "book" where "book"."id" = $1\nparams: nonsense',
)

/** A store whose every method fails the way a driver fails. See the note in
 * `api.test.ts`: `acceptsId` is synchronous and must stay absent. */
function throwingStore(error: unknown): SproutStore {
	const boom = () => Promise.reject(error)
	return new Proxy({} as SproutStore, {
		get: (_target, property) => (property === 'acceptsId' ? undefined : boom),
	})
}

/**
 * Every generic tool, called with arguments that are well-formed *for that
 * tool*, so the only thing that varies is how the call fails.
 *
 * Asserted over the whole vocabulary rather than over `get_record` alone,
 * because the leak was never a property of one tool — it was a property of the
 * boundary they share, and a test pinned to one of them goes green the day an
 * eleventh is added.
 */
function everyTool(): { name: string; args: Record<string, unknown> }[] {
	return [
		{ name: 'list_records', args: { resource: 'book' } },
		{ name: 'get_record', args: { resource: 'book', id: ABSENT_ID } },
		{ name: 'search_records', args: { resource: 'book', query: 'piranesi' } },
		{
			name: 'create_record',
			args: { resource: 'book', data: { title: 'A' } },
		},
		{
			name: 'update_record',
			args: { resource: 'book', id: ABSENT_ID, data: { title: 'B' } },
		},
		{ name: 'delete_record', args: { resource: 'book', id: ABSENT_ID } },
		{ name: 'query_records', args: { resource: 'book' } },
	]
}

let stderr: MockInstance<(...args: unknown[]) => void>

beforeEach(() => {
	// The detail is *supposed* to be printed; silencing it keeps the suite
	// readable while still letting us assert it happened.
	stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
	stderr.mockRestore()
})

describe('an MCP tool reports a driver failure, it does not republish it', () => {
	it('answers with a correlation id and no statement', async () => {
		const ctx = await projectWithMissingTable()
		const res = await executeMCPTool(ctx, 'get_record', {
			resource: 'book',
			id: ABSENT_ID,
		})

		expect(res.isError).toBe(true)
		expect(text(res)).toMatch(/^Internal error \[err_[a-z0-9]+\]\./)
		expectNoStatementLeak(res)
	})

	it('prints the statement to stderr, keyed by the id the caller was given', async () => {
		const ctx = await projectWithMissingTable()
		const res = await executeMCPTool(ctx, 'get_record', {
			resource: 'book',
			id: ABSENT_ID,
		})
		const errorId = /err_[a-z0-9]+/.exec(text(res))?.[0]
		expect(errorId).toBeDefined()

		const line = stderr.mock.calls
			.map((args) => String(args[0]))
			.find((l) => l.includes(String(errorId)))
		expect(line).toBeDefined()
		const logged = JSON.parse(String(line)) as Record<string, unknown>
		expect(logged.level).toBe('error')
		expect(logged.resource).toBe('book')
		expect(logged.operation).toBe('get')
		// The half that must NOT be lost: an operator reading stderr still gets
		// the failing statement, which is the whole reason it was ever in the reply.
		expect(String(logged.message)).toContain('select ')
	})

	it('leaks nothing from any generic tool, whatever the store throws', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [BOOK])
		const ctx: OpContext = {
			registry,
			store: throwingStore(DRIVER_ERROR),
			user: admin,
		}

		let reachedTheStore = 0
		for (const { name, args } of everyTool()) {
			const res = await executeMCPTool(ctx, name, args)
			expectNoStatementLeak(res)
			if (text(res).startsWith('Internal error [')) reachedTheStore++
		}
		// Otherwise a vocabulary that never reached the store would pass this test
		// while asserting nothing at all.
		expect(reachedTheStore).toBeGreaterThan(0)
	})

	it('leaks nothing through the legacy per-resource names either', async () => {
		// Unadvertised but still executable (see `executeMCPTool`), so still a
		// reachable path to the same boundary.
		const ctx = await projectWithMissingTable()
		const res = await executeMCPTool(ctx, 'get_book', { id: ABSENT_ID })
		expectNoStatementLeak(res)
		expect(text(res)).toContain('Internal error [')
	})
})

describe('the refusals a caller can act on still come back verbatim', () => {
	it('reports a miss as a miss', async () => {
		const ctx = await project()
		const res = await executeMCPTool(ctx, 'get_record', {
			resource: 'book',
			id: ABSENT_ID,
		})
		expect(res.isError).toBe(true)
		expect(text(res)).not.toContain('Internal error')
		// The class `mcpFail` lets through, spelled by the op itself — still the
		// first line, unchanged, because several of these messages *are* the
		// repair instruction and #450 adds to them rather than replacing them.
		const [first, ...rest] = text(res).split('\n')
		expect(first).toBe(new NotFoundError('book', ABSENT_ID).message)
		// And the facts a bare message could not carry: whose refusal it was, and
		// whether an agent should come back.
		expect(rest.join('\n')).toContain('fault=caller')
		expect(rest.join('\n')).toContain('retry=no')
	})

	it('reports a validation refusal as its field errors', async () => {
		const ctx = await project()
		const res = await executeMCPTool(ctx, 'create_record', {
			resource: 'book',
			data: {},
		})
		expect(res.isError).toBe(true)
		// Still parseable JSON: this reply is the machine-readable one, so the
		// envelope is merged into the object rather than appended after it.
		const fieldErrors = JSON.parse(text(res)) as Record<string, unknown>
		expect(fieldErrors).toHaveProperty('title')
		expect(fieldErrors._refusal).toMatchObject({
			code: 'validation_failed',
			fault: 'caller',
		})
	})

	it('reports an unknown resource as one', async () => {
		const ctx = await project()
		const res = await executeMCPTool(ctx, 'list_records', {
			resource: 'nosuchthing',
		})
		expect(res.isError).toBe(true)
		expect(text(res)).toContain('nosuchthing')
		expect(text(res)).not.toContain('Internal error')
	})
})
