/**
 * Running a source: what it writes, what it refuses to write, and
 * what happens when the other end is having a bad morning.
 *
 * The assertions worth reading twice are the ones about *not* writing. Most of
 * the damage an integration does is not "it failed" — it is that it succeeded
 * at writing something wrong: nulls over hand-typed values, duplicate rows every
 * run, a number column full of NaN.
 */

import type { EntitySpec, SourceSpec } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { createMemoryJobStore, JobQueue } from '../jobs/service.ts'
import type { FetchLike } from './fetch.ts'
import {
	allSourceHealth,
	enqueueEnrichment,
	registerSourceHandlers,
	SOURCE_JOB_TYPE,
	sourceHealth,
	sourceJobKey,
	writeTriggersEnrichment,
} from './queue.ts'
import { runEnrichment, runSync, type SourceWrite } from './service.ts'

const provenance = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium',
} as const

const book: EntitySpec = {
	id: 'e-book',
	name: 'Book',
	fields: [
		{
			id: 'fld-book-isbn',
			name: 'isbn',
			type: 'string',
			required: true,
			provenance,
		},
		{
			id: 'fld-book-title',
			name: 'title',
			type: 'string',
			required: true,
			provenance,
		},
		{
			id: 'fld-book-pages',
			name: 'pages',
			type: 'number',
			required: false,
			provenance,
		},
	],
	provenance,
}

const enrichSource = (overrides: Partial<SourceSpec> = {}): SourceSpec =>
	({
		id: 'src-isbn',
		key: 'isbn.lookup',
		description: 'ISBN lookup',
		mode: 'enrich',
		entityId: 'e-book',
		request: { url: 'https://openlibrary.org/isbn/{isbn}.json' },
		auth: { kind: 'none' },
		mapping: [
			{ from: 'title', to: 'fld-book-title' },
			{ from: 'number_of_pages', to: 'fld-book-pages' },
		],
		limits: {
			requestsPerMinute: 60,
			timeoutMs: 5000,
			maxAttempts: 3,
			backoffMs: 1000,
		},
		triggers: [{ kind: 'create' }],
		inputField: 'fld-book-isbn',
		declaredAt: '2026-07-28',
		provenance,
		...overrides,
	}) as SourceSpec

const syncSource = (overrides: Partial<SourceSpec> = {}): SourceSpec =>
	enrichSource({
		id: 'src-books',
		key: 'books.sync',
		mode: 'sync',
		request: { url: 'https://openlibrary.org/shelf.json' },
		inputField: undefined,
		triggers: [{ kind: 'webhook' }],
		collection: {
			path: 'items',
			idPath: 'id',
			idField: 'fld-book-isbn',
			maxRecords: 2,
		},
		...overrides,
	})

const jsonFetch = (document: unknown): FetchLike =>
	(async () => ({
		status: 200,
		headers: { get: () => null },
		text: async () => JSON.stringify(document),
	})) as FetchLike

describe('enrichment', () => {
	it('maps a response onto the row it was triggered for', async () => {
		const result = await runEnrichment(
			enrichSource(),
			book,
			{ id: 'row-1', isbn: '9780441013593' },
			{ fetch: jsonFetch({ title: 'Dune', number_of_pages: 412 }) },
		)
		expect(result.ok).toBe(true)
		expect(result.writes).toEqual([
			{
				kind: 'update',
				entityId: 'e-book',
				rowId: 'row-1',
				values: { 'fld-book-title': 'Dune', 'fld-book-pages': 412 },
			},
		])
	})

	it('does not fetch at all for a row with nothing to ask about', async () => {
		let called = false
		const fetch: FetchLike = async () => {
			called = true
			throw new Error('should not be called')
		}
		const result = await runEnrichment(
			enrichSource(),
			book,
			{ id: 'row-1', isbn: '' },
			{ fetch },
		)
		// A book with no ISBN is not an error, and it is not a request either.
		expect(called).toBe(false)
		expect(result).toMatchObject({ ok: true, writes: [] })
	})

	it('never writes null over a value a person typed', async () => {
		// The provider has a gap; the row keeps its hand-entered title.
		const result = await runEnrichment(
			enrichSource(),
			book,
			{ id: 'row-1', isbn: '1' },
			{ fetch: jsonFetch({ number_of_pages: 412 }) },
		)
		expect(result.writes[0]).toMatchObject({
			values: { 'fld-book-pages': 412 },
		})
		expect(result.writes[0]?.values).not.toHaveProperty('fld-book-title')
	})

	it('produces no write at all when the response said nothing usable', async () => {
		const result = await runEnrichment(
			enrichSource(),
			book,
			{ id: 'row-1', isbn: '1' },
			{ fetch: jsonFetch({ unrelated: true }) },
		)
		expect(result.writes).toEqual([])
	})

	it('refuses a value the column cannot hold, and says which and why', async () => {
		const result = await runEnrichment(
			enrichSource(),
			book,
			{ id: 'row-1', isbn: '1' },
			{
				fetch: jsonFetch({
					title: 'Dune',
					number_of_pages: 'about four hundred',
				}),
			},
		)
		expect(result.writes[0]?.values).toEqual({ 'fld-book-title': 'Dune' })
		expect(result.refusals).toEqual([
			{
				field: 'fld-book-pages',
				from: 'number_of_pages',
				reason: expect.stringMatching(/expected a number/),
			},
		])
	})

	it('returns a failure as an outcome rather than throwing at the caller', async () => {
		const result = await runEnrichment(
			enrichSource(),
			book,
			{ id: 'row-1', isbn: '1' },
			{
				fetch: (async () => ({
					status: 503,
					headers: { get: () => null },
					text: async () => '',
				})) as FetchLike,
			},
		)
		expect(result.ok).toBe(false)
		expect(result.error).toMatchObject({
			reason: 'http-error',
			retryable: true,
		})
		expect(result.writes).toEqual([])
	})
})

describe('sync', () => {
	it('upserts on the declared remote id and writes the id itself', async () => {
		const result = await runSync(syncSource(), book, {
			fetch: jsonFetch({
				items: [
					{ id: 'r1', title: 'Dune' },
					{ id: 'r2', title: 'Neuromancer' },
				],
			}),
		})
		expect(result.writes).toEqual([
			{
				kind: 'upsert',
				entityId: 'e-book',
				matchField: 'fld-book-isbn',
				matchValue: 'r1',
				values: { 'fld-book-title': 'Dune', 'fld-book-isbn': 'r1' },
			},
			{
				kind: 'upsert',
				entityId: 'e-book',
				matchField: 'fld-book-isbn',
				matchValue: 'r2',
				values: { 'fld-book-title': 'Neuromancer', 'fld-book-isbn': 'r2' },
			},
		])
	})

	it('skips a record with no stable id rather than inserting a row it can never match again', async () => {
		// Inserting it means every run adds it again — the duplicate-rows failure
		// this whole primitive exists to make impossible.
		const result = await runSync(syncSource(), book, {
			fetch: jsonFetch({
				items: [{ title: 'Anonymous' }, { id: 'r1', title: 'Dune' }],
			}),
		})
		expect(result.writes).toHaveLength(1)
		expect(result.skippedWithoutId).toBe(1)
	})

	it('reports truncation rather than hiding it', async () => {
		// "We synced 2 of 5" and "there are 2" are different facts.
		const result = await runSync(syncSource(), book, {
			fetch: jsonFetch({
				items: [1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, title: `T${n}` })),
			}),
		})
		expect(result.writes).toHaveLength(2)
		expect(result.truncated).toBe(3)
	})

	it('is safe to run twice — the second run produces the same upserts', async () => {
		const fetch = jsonFetch({ items: [{ id: 'r1', title: 'Dune' }] })
		const first = await runSync(syncSource(), book, { fetch })
		const second = await runSync(syncSource(), book, { fetch })
		expect(second.writes).toEqual(first.writes)
	})
})

describe('the refiner slot', () => {
	const refined = syncSource({ refine: true })

	it('takes the refiner’s values as final', async () => {
		const result = await runSync(refined, book, {
			fetch: jsonFetch({ items: [{ id: 'r1', title: 'dune' }] }),
			refiners: {
				'books.sync': ({ values }) => ({
					...values,
					'fld-book-title': String(values['fld-book-title']).toUpperCase(),
				}),
			},
		})
		expect(result.writes[0]?.values).toMatchObject({ 'fld-book-title': 'DUNE' })
	})

	it('is an extension point, not a bypass — its output is re-typed too', async () => {
		const result = await runSync(refined, book, {
			fetch: jsonFetch({ items: [{ id: 'r1', title: 'Dune' }] }),
			refiners: {
				'books.sync': () => ({
					'fld-book-pages': 'not a number',
					'fld-nope': 'no such column',
				}),
			},
		})
		expect(result.writes[0]?.values).toEqual({ 'fld-book-isbn': 'r1' })
		expect(result.refusals.map((r) => r.field).sort()).toEqual([
			'fld-book-pages',
			'fld-nope',
		])
	})

	it('falls back to the declared mapping when the slot is unfilled', async () => {
		const result = await runSync(refined, book, {
			fetch: jsonFetch({ items: [{ id: 'r1', title: 'Dune' }] }),
		})
		expect(result.writes[0]?.values).toMatchObject({ 'fld-book-title': 'Dune' })
	})

	it('is not called at all when the source did not declare one', async () => {
		let called = false
		await runSync(syncSource(), book, {
			fetch: jsonFetch({ items: [{ id: 'r1', title: 'Dune' }] }),
			refiners: {
				'books.sync': () => {
					called = true
					return {}
				},
			},
		})
		expect(called).toBe(false)
	})
})

/** The authority every run below borrows. There is no default: the worker
 * refuses a job that arrives without one, which is the point. */
const RUN_AS = { kind: 'service', role: 'admin' } as const

describe('on the queue', () => {
	const wire = (fetch: FetchLike, source = enrichSource()) => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		const applied: SourceWrite[] = []
		registerSourceHandlers({
			queue,
			sources: () => [source],
			entity: (id) => (id === 'e-book' ? book : undefined),
			apply: async (writes) => {
				applied.push(...writes)
			},
			readRow: async () => ({ id: 'row-1', isbn: '9780441013593' }),
			fetch,
		})
		return { queue, applied, source }
	}

	it('applies the writes through the caller’s own write path', async () => {
		const { queue, applied, source } = wire(jsonFetch({ title: 'Dune' }))
		await enqueueEnrichment(queue, source, 'row-1', 'occ-1', RUN_AS)
		await queue.tick()
		expect(applied).toEqual([
			{
				kind: 'update',
				entityId: 'e-book',
				rowId: 'row-1',
				values: { 'fld-book-title': 'Dune' },
			},
		])
	})

	it('a retried job does not enrich twice; a second trigger does', async () => {
		const { queue, source } = wire(jsonFetch({ title: 'Dune' }))
		const a = await enqueueEnrichment(queue, source, 'row-1', 'occ-1', RUN_AS)
		const b = await enqueueEnrichment(queue, source, 'row-1', 'occ-1', RUN_AS)
		expect(b.id).toBe(a.id)
		const c = await enqueueEnrichment(queue, source, 'row-1', 'occ-2', RUN_AS)
		expect(c.id).not.toBe(a.id)
		expect(sourceJobKey('k', 'occ', 'row')).toBe('source:k:row:occ')
	})

	it('honours the declared attempt budget on the job row', async () => {
		const { queue, source } = wire(jsonFetch({ title: 'Dune' }))
		const job = await enqueueEnrichment(queue, source, 'row-1', 'occ-1', RUN_AS)
		expect(job.maxAttempts).toBe(3)
	})

	it('does not dead-letter a source somebody removed mid-flight', async () => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		registerSourceHandlers({
			queue,
			sources: () => [],
			entity: () => book,
			apply: async () => {},
			fetch: jsonFetch({}),
		})
		await queue.enqueue({
			type: SOURCE_JOB_TYPE,
			payload: { sourceKey: 'gone', rowId: 'row-1' },
			runAs: RUN_AS,
		})
		await queue.tick()
		expect(await queue.deadLetter()).toHaveLength(0)
	})

	it('refuses a run that reached the worker with no runAs, before fetching', async () => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		let fetched = false
		registerSourceHandlers({
			queue,
			sources: () => [enrichSource()],
			entity: () => book,
			apply: async () => {},
			readRow: async () => ({ id: 'row-1', isbn: '1' }),
			fetch: (async () => {
				fetched = true
				return {
					status: 200,
					headers: { get: () => 'application/json' },
					text: async () => '{}',
				}
			}) as unknown as FetchLike,
		})
		// Enqueued the way nothing in the codebase can any more — `enqueueSync` and
		// `enqueueEnrichment` both require a `runAs`. This is the shape a job row
		// written by an older build would have.
		await queue.enqueue({
			type: SOURCE_JOB_TYPE,
			payload: { sourceKey: 'isbn.lookup', rowId: 'row-1' },
		})
		await queue.tick()
		// Permanent: an absent identity is a missing decision, not a flaky
		// downstream, so it dead-letters on the first attempt rather than after
		// three. And no third-party request was made as nobody.
		expect(await queue.deadLetter()).toHaveLength(1)
		expect(fetched).toBe(false)
	})

	it('hands the applier the borrowed authority and the entity the run used', async () => {
		const queue = new JobQueue({ store: createMemoryJobStore() })
		const seen: { runAs: unknown; entityId: string }[] = []
		const source = enrichSource()
		registerSourceHandlers({
			queue,
			sources: () => [source],
			entity: () => book,
			apply: async (_writes, _source, runAs, entity) => {
				seen.push({ runAs, entityId: entity.id })
			},
			readRow: async () => ({ id: 'row-1', isbn: '1' }),
			fetch: jsonFetch({ title: 'Dune' }),
		})
		await enqueueEnrichment(queue, source, 'row-1', 'occ-1', {
			kind: 'user',
			userId: 'u-1',
		})
		await queue.tick()
		expect(seen).toEqual([
			{ runAs: { kind: 'user', userId: 'u-1' }, entityId: 'e-book' },
		])
	})
})

describe('the enrichment loop guard', () => {
	// Issue #238. The guard used to be `origin !== 'system'` read off the audit
	// entry in the host's composition root, which made it testable only by
	// reading that file for a string. These assert the rule itself.
	it('lets a person’s write trigger the enrichments its entity declares', () => {
		expect(
			writeTriggersEnrichment({ userId: 'u-1', resourceId: 'row-1' } as never),
		).toBe(true)
	})

	it('refuses a write a source’s own run made, which is the loop', () => {
		// The exact shape of the loop: an `update`-triggered source's `opUpdate` is
		// a committed update to the entity it enriches.
		expect(
			writeTriggersEnrichment({
				resourceId: 'row-1',
				sourceKey: 'isbn.lookup',
			}),
		).toBe(false)
	})

	it('still lets another background writer trigger one', () => {
		// The behavioural difference from the old convention, and the reason for
		// the change: a background writer that adopts `origin: 'system'` for its
		// own reasons is not a source run, and silently disabling enrichment for it
		// was a failure whose symptom pointed at nothing.
		expect(writeTriggersEnrichment({ resourceId: 'row-1' })).toBe(true)
	})

	it('refuses a write that names no row, because there is nothing to enrich', () => {
		expect(writeTriggersEnrichment({})).toBe(false)
	})
})

describe('health, as a sentence somebody can act on', () => {
	const freshQueue = () => new JobQueue({ store: createMemoryJobStore() })

	it('reads never-run before anything has happened', async () => {
		const health = await sourceHealth(freshQueue(), enrichSource())
		expect(health.state).toBe('never-run')
		expect(health.summary).toMatch(/has not run yet/)
	})

	it('reads paused for a paused source, and says the data is from before', async () => {
		const health = await sourceHealth(
			freshQueue(),
			enrichSource({ paused: true }),
		)
		expect(health.state).toBe('paused')
		expect(health.summary).toMatch(/showing the data from before it stopped/)
	})

	it('reads failing after a failed run, and names the reason', async () => {
		const queue = freshQueue()
		const source = enrichSource()
		registerSourceHandlers({
			queue,
			sources: () => [source],
			entity: () => book,
			apply: async () => {},
			readRow: async () => ({ id: 'row-1', isbn: '1' }),
			fetch: (async () => ({
				status: 404,
				headers: { get: () => null },
				text: async () => '',
			})) as FetchLike,
		})
		await enqueueEnrichment(queue, source, 'row-1', 'occ-1', RUN_AS)
		await queue.tick()
		const health = await sourceHealth(queue, source)
		expect(health.state).toBe('failing')
		expect(health.consecutiveFailures).toBe(1)
		expect(health.summary).toMatch(/is failing.*404/)
	})

	it('reads ok after a successful run and stale a day later', async () => {
		const queue = freshQueue()
		const source = enrichSource()
		registerSourceHandlers({
			queue,
			sources: () => [source],
			entity: () => book,
			apply: async () => {},
			readRow: async () => ({ id: 'row-1', isbn: '1' }),
			fetch: jsonFetch({ title: 'Dune' }),
		})
		await enqueueEnrichment(queue, source, 'row-1', 'occ-1', RUN_AS)
		await queue.tick()
		expect((await sourceHealth(queue, source)).state).toBe('ok')
		// `now` is a parameter for the reason the scheduler's is.
		const later = new Date(Date.now() + 48 * 60 * 60 * 1000)
		const stale = await sourceHealth(queue, source, later)
		expect(stale.state).toBe('stale')
		expect(stale.summary).toMatch(/showing older data/)
	})

	it('reports every declared source, paused ones included', async () => {
		const health = await allSourceHealth(freshQueue(), {
			sources: { sources: [enrichSource(), syncSource({ paused: true })] },
		})
		expect(health.map((h) => h.sourceKey)).toEqual([
			'isbn.lookup',
			'books.sync',
		])
	})
})
