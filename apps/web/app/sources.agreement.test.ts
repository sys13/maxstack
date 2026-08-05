/**
 * The source runner's web-side chain, end to end.
 *
 * `packages/features/src/sources/service.test.ts` proves a run fetches, maps,
 * refines and reports correctly once something drives it. This file proves the
 * **other half of the sentence** — that the intent a run produces actually lands
 * on rows, through the app's own write path, under a borrowed identity:
 *
 *   `sources.declare` → `SourceWrite` → `applyWritesWith` → `opCreate`/`opUpdate`
 *   → a validated, audited row
 *
 * That half is exactly what did not exist. Issue #173 built every piece of the
 * feature and `registerSourceHandlers` was called nowhere in `apps/web`, so a
 * declared source was a row on the jobs page that never ran — machinery that was
 * green in its own package for as long as it was absent from the app. The
 * `describe` at the bottom is the mechanical guard against that recurring: it
 * asserts the composition root still calls the runner and still feeds it the
 * generated refiner registry.
 *
 * It is the same relationship `live.agreement.test.ts` has with
 * `sprout/live.test.ts`: the behaviour is tested in the package, the *wiring
 * from a declaration* is tested here.
 */

import {
	createSpecDb,
	type OpContext,
	opList,
	ResourceRegistry,
	registerSpecEntities,
} from '@maxstack/core'
import {
	createMemoryAuditSink,
	type StoredAuditEntry,
} from '@maxstack/features/audit'
import { createMemoryJobStore, JobQueue } from '@maxstack/features/jobs'
import {
	enqueueSync,
	registerSourceHandlers,
	type SourceWrite,
} from '@maxstack/features/sources'
import {
	applyOp,
	newSpecSystem,
	type SourceSpec,
	type SpecOp,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it, vi } from 'vitest'
import {
	applyWritesWith,
	enqueueSyncsWith,
	userForRunAs,
} from './sources.server'
import { groundedEntityShapes } from './spec-sprout'
import { orgsForIdentity } from './sprout.server'

const meta = (n: number) => ({
	id: `op-src-${n}` as const,
	origin: 'human' as const,
	appliedAt: '2026-07-29' as const,
	actor: { surface: 'harness' as const },
})

/** A book entity: a required title, a number the mapping can get wrong, the
 * remote id a sync matches on, and the column a tenant-scoped registration
 * stamps. */
const BOOK_FIELDS = [
	{ id: 'fld-title', name: 'title', type: 'string', required: true },
	{ id: 'fld-pages', name: 'pages', type: 'number', required: false },
	{ id: 'fld-remote', name: 'remoteId', type: 'string', required: false },
	{ id: 'fld-org', name: 'organizationId', type: 'string', required: false },
]

function spec(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-book',
					name: 'Book',
					description: 'A book on the shelf.',
					fields: BOOK_FIELDS,
				},
			},
		} as SpecOp,
		meta(1),
	)
}

const BOOK = {
	id: 'e-book',
	name: 'Book',
	description: 'A book on the shelf.',
	fields: BOOK_FIELDS,
} as never

/** The applier reads exactly two things off a source — the entity it writes to
 * and the key it names in a failure — so the fixture carries exactly two. */
const SOURCE = {
	key: 'books.sync',
	entityId: 'e-book',
} as unknown as SourceSpec

/**
 * Ground the spec into a runtime and hand back a context, as the app does.
 *
 * The identity is the real one: {@link userForRunAs} over a service `runAs` is
 * pure (only the `user` kind reads the auth table), so the test borrows an
 * identity through the same function a run does — including the `sourceKey`
 * marker the enrichment loop guard reads and the org a tenant-scoped write
 * needs.
 *
 * `tenantScoped` re-registers the resource the way owned code registering a
 * multi-tenant table does. Tenancy is a registry fact rather than a spec one, so
 * this is the only way to have a tenant-scoped resource in a test at all.
 */
async function runtime(
	opts: { orgId?: string; tenantScoped?: boolean } = {},
): Promise<{ ctx: OpContext; audit: StoredAuditEntry[] }> {
	const shapes = groundedEntityShapes(spec())
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, shapes)
	if (opts.tenantScoped) {
		const entry = registry.get('book')
		if (entry) entry.config.tenantField = 'organizationId'
	}
	const { store } = await createSpecDb(registry, shapes)
	const sink = createMemoryAuditSink()
	return {
		ctx: {
			registry,
			store,
			audit: sink,
			user: await userForRunAs(
				{ kind: 'service', role: 'admin', orgId: opts.orgId },
				SOURCE.key,
			),
		},
		audit: sink.entries,
	}
}

describe('a run’s intent lands through the app’s own write path', () => {
	it('translates field ids to columns and updates the named row', async () => {
		const { ctx } = await runtime()
		const created = await ctx.store.create('book', { title: 'Untitled' })
		const id = String(created.id)
		const writes: SourceWrite[] = [
			{
				kind: 'update',
				entityId: 'e-book',
				rowId: id,
				// Field IDs, which is what the feature layer speaks. The ops speak
				// columns, and this translation is the only place the two meet.
				values: { 'fld-title': 'Dune', 'fld-pages': 412 },
			},
		]
		await applyWritesWith(ctx, writes, SOURCE, BOOK)
		const [row] = await opList(ctx, 'book', { filter: { id }, limit: 1 })
		expect(row).toMatchObject({ title: 'Dune', pages: 412 })
	})

	it('an upsert creates once and matches its own row the second time', async () => {
		const { ctx } = await runtime()
		const write: SourceWrite = {
			kind: 'upsert',
			entityId: 'e-book',
			matchField: 'fld-remote' as never,
			matchValue: 'OL123',
			values: { 'fld-title': 'Dune', 'fld-remote': 'OL123' },
		}
		await applyWritesWith(ctx, [write], SOURCE, BOOK)
		// The second run is the whole reason a remote id is required: it must match
		// the row the first one made rather than making it again.
		await applyWritesWith(
			ctx,
			[{ ...write, values: { ...write.values, 'fld-title': 'Dune (rev)' } }],
			SOURCE,
			BOOK,
		)
		const rows = await opList(ctx, 'book', { limit: 10 })
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ title: 'Dune (rev)', remoteId: 'OL123' })
	})

	it('a value the column refuses fails the run instead of landing a lie', async () => {
		const { ctx } = await runtime()
		// The write path is `opCreate`, so the column's own schema is what decides.
		// A source that could write past it would be a second write path with its
		// own, weaker copy of validation.
		await expect(
			applyWritesWith(
				ctx,
				[
					{
						kind: 'upsert',
						entityId: 'e-book',
						matchField: 'fld-remote' as never,
						matchValue: 'OL999',
						// No title, and title is required.
						values: { 'fld-remote': 'OL999' },
					},
				],
				SOURCE,
				BOOK,
			),
		).rejects.toThrow(/books\.sync/)
		expect(await opList(ctx, 'book', { limit: 10 })).toHaveLength(0)
	})

	it('drops a mapping onto a field the entity no longer has, without failing', async () => {
		const { ctx } = await runtime()
		const created = await ctx.store.create('book', { title: 'Untitled' })
		await applyWritesWith(
			ctx,
			[
				{
					kind: 'update',
					entityId: 'e-book',
					rowId: String(created.id),
					values: { 'fld-title': 'Dune', 'fld-gone': 'whatever' },
				},
			],
			SOURCE,
			BOOK,
		)
		// Entities and sources are edited by different people on different days; a
		// stale mapping entry is ordinary, and a 500 in a background job is not how
		// it should read.
		const [row] = await opList(ctx, 'book', { limit: 1 })
		expect(row).toMatchObject({ title: 'Dune' })
	})
})

describe('a tenant-scoped entity and the org a run borrows', () => {
	it('refuses the whole run with a sentence naming the fix, not "Permission denied"', async () => {
		const { ctx } = await runtime({ tenantScoped: true })
		// The combination that did not work at all before #237, and that nothing
		// said anything about until a nightly dead letter did: a source writing
		// into a tenant-scoped entity under an identity with no active org.
		await expect(
			applyWritesWith(
				ctx,
				[
					{
						kind: 'upsert',
						entityId: 'e-book',
						matchField: 'fld-remote' as never,
						matchValue: 'OL1',
						values: { 'fld-title': 'Dune', 'fld-remote': 'OL1' },
					},
				],
				SOURCE,
				BOOK,
			),
		).rejects.toThrow(/tenant-scoped.*runAs\.orgId/s)
		// Read through the store, not the ops: an org-less identity cannot read a
		// tenant-scoped resource either, which is the same refusal under test.
		expect(await ctx.store.list('book', { limit: 10 })).toHaveLength(0)
	})

	it('lands rows in the declared org once the runAs carries one', async () => {
		const { ctx } = await runtime({ tenantScoped: true, orgId: 'org-acme' })
		await applyWritesWith(
			ctx,
			[
				{
					kind: 'upsert',
					entityId: 'e-book',
					matchField: 'fld-remote' as never,
					matchValue: 'OL1',
					values: { 'fld-title': 'Dune', 'fld-remote': 'OL1' },
				},
			],
			SOURCE,
			BOOK,
		)
		const [row] = await opList(ctx, 'book', { limit: 10 })
		// The tenant column is stamped by the ops from the identity's org, exactly
		// as it is for a person's write — the source never supplies it.
		expect(row).toMatchObject({ title: 'Dune', organizationId: 'org-acme' })
	})

	it('leaves an entity that is not tenant-scoped alone', async () => {
		const { ctx } = await runtime()
		await applyWritesWith(
			ctx,
			[
				{
					kind: 'upsert',
					entityId: 'e-book',
					matchField: 'fld-remote' as never,
					matchValue: 'OL1',
					values: { 'fld-title': 'Dune', 'fld-remote': 'OL1' },
				},
			],
			SOURCE,
			BOOK,
		)
		expect(await opList(ctx, 'book', { limit: 10 })).toHaveLength(1)
	})
})

/**
 * A declared sync source over a stubbed endpoint. Everything except the socket
 * is real: the declaration goes through `sources.declare` (so the validator saw
 * it), the run goes through `registerSourceHandlers` on a real `JobQueue`, and
 * the writes go through the ops onto a real pglite.
 */
function syncSpec(): { spec: SpecSystem; source: SourceSpec } {
	const declared = applyOp(
		spec(),
		{
			op: 'sources.declare',
			args: {
				source: {
					id: 'src-books',
					key: 'books.sync',
					description: 'Pull the shelf from the catalogue service.',
					mode: 'sync',
					entityId: 'e-book',
					request: { url: 'https://api.example.com/books' },
					auth: { kind: 'none' },
					mapping: [
						{ from: 'title', to: 'fld-title' },
						{ from: 'pages', to: 'fld-pages' },
					],
					limits: {
						requestsPerMinute: 60,
						timeoutMs: 5000,
						maxAttempts: 3,
						backoffMs: 1000,
					},
					triggers: [{ kind: 'manual' }],
					collection: {
						path: 'items',
						idPath: 'id',
						idField: 'fld-remote',
						maxRecords: 50,
					},
				},
			},
		} as SpecOp,
		meta(2),
	)
	const source = (declared.sources?.sources ?? [])[0] as SourceSpec
	return { spec: declared, source }
}

describe('a 200 produces rows: the run, end to end', () => {
	// The join #236 could not observe. Its verification run reached a real host
	// that never answered, and the happy path stayed covered in two halves that
	// never met: `features/sources/service.test.ts` proves fetch → intent over a
	// stub, this file's first describe proves intent → rows over a real registry.
	// Here the two meet in one process, driven by the real handler, so "a 200
	// produces rows" is observed rather than inferred. Only the socket is stubbed
	// — and it has to be, because the SSRF guard refuses loopback by design, so a
	// local server cannot be the other end of a real run.
	const RESPONSE = {
		items: [
			{ id: 'OL1', title: 'Dune', pages: 412 },
			{ id: 'OL2', title: 'Emma', pages: 474 },
			// No id: skipped rather than inserted, because a row the next run cannot
			// match is a row every run adds again.
			{ title: 'Anonymous' },
		],
	}

	async function run(opts: { orgId?: string; tenantScoped?: boolean } = {}) {
		const { source } = syncSpec()
		const { ctx, audit } = await runtime(opts)
		const queue = new JobQueue({ store: createMemoryJobStore() })
		registerSourceHandlers({
			queue,
			sources: () => [source],
			entity: () => BOOK,
			// The app's own applier, over the app's own write path.
			apply: (writes, declared, _runAs, entity) =>
				applyWritesWith(ctx, writes, declared, entity),
			fetch: async () => ({
				status: 200,
				headers: { get: () => 'application/json' },
				text: async () => JSON.stringify(RESPONSE),
			}),
		})
		await enqueueSync(queue, source, 'occ-1', {
			kind: 'service',
			role: 'admin',
			...(opts.orgId ? { orgId: opts.orgId } : {}),
		})
		await queue.tick()
		return { ctx, queue, audit }
	}

	it('fetches, maps, upserts, and the rows are there', async () => {
		const { ctx, queue } = await run()
		const rows = await opList(ctx, 'book', { limit: 10, orderBy: 'remoteId' })
		expect(rows).toHaveLength(2)
		expect(rows).toMatchObject([
			{ title: 'Dune', pages: 412, remoteId: 'OL1' },
			{ title: 'Emma', pages: 474, remoteId: 'OL2' },
		])
		const [job] = await queue.list({ limit: 1 })
		expect(job?.status).toBe('succeeded')
		expect(job?.result).toMatchObject({
			ok: true,
			writes: 2,
			skippedWithoutId: 1,
		})
		expect(await queue.deadLetter()).toHaveLength(0)
	})

	it('every row it wrote is stamped with the source that wrote it', async () => {
		// The input the enrichment loop guard reads. The guard's rule
		// is tested in `features/sources/service.test.ts`; this is the other half —
		// that a real run's writes actually carry the marker the rule asks about.
		const { audit } = await run()
		expect(audit).toHaveLength(2)
		expect(audit.every((e) => e.sourceKey === 'books.sync')).toBe(true)
		expect(audit.every((e) => e.origin === 'system')).toBe(true)
	})

	it('fails the run with the stated reason when the entity is tenant-scoped and no org is declared', async () => {
		const { ctx, queue } = await run({ tenantScoped: true })
		expect(await ctx.store.list('book', { limit: 10 })).toHaveLength(0)
		const [job] = await queue.list({ limit: 1 })
		// The failure a person reads on the jobs page: the sentence names what to
		// declare, rather than `Permission denied: create on book`.
		expect(job?.error ?? '').toMatch(/tenant-scoped.*runAs\.orgId/s)
	})

	it('lands the same rows in the declared org', async () => {
		const { ctx } = await run({ tenantScoped: true, orgId: 'org-acme' })
		const rows = await opList(ctx, 'book', { limit: 10 })
		expect(rows).toHaveLength(2)
		expect(rows.every((r) => r.organizationId === 'org-acme')).toBe(true)
	})
})

/**
 * The fan-out.
 *
 * A tenant-scoped sync used to have exactly one shape that worked: one schedule
 * per org, each declaring its own `runAs.orgId`. That is honest and does not
 * survive a customer list — the declaration has to be added on signup and removed
 * on churn, by hand, forever. `runAs.eachOrg` is the other shape: one declaration,
 * one bounded run per tenant.
 *
 * Two halves, tested as two: `fanOutRunAs` (in the spec package) decides what the
 * runs are, and this decides that they are actually *enqueued* as separate runs —
 * which is where the idempotency key lives, and where 200 runs collapsing into one
 * row would look exactly like a working fan-out.
 */
describe('a sync that runs once per org', () => {
	const OCCURRENCE = {
		scheduleKey: 'crm.nightly',
		scheduledFor: new Date('2026-07-29T09:00:00.000Z'),
		idempotencyKey: 'sched:crm.nightly:2026-07-29T09:00:00.000Z',
	}

	const SYNC_SOURCE = {
		key: 'crm.pull',
		entityId: 'e-book',
		limits: { maxAttempts: 3 },
	} as unknown as SourceSpec

	const orgs =
		(orgIds: string[], truncated = false) =>
		async () => ({
			orgIds,
			truncated,
		})

	function queue(): JobQueue {
		return new JobQueue({ store: createMemoryJobStore() })
	}

	it('enqueues one run per org, each carrying that org and nothing else new', async () => {
		const q = queue()
		const enqueued = await enqueueSyncsWith(
			q,
			[SYNC_SOURCE],
			{
				...OCCURRENCE,
				runAs: { kind: 'service', role: 'importer', eachOrg: true },
			},
			orgs(['org-a', 'org-b', 'org-c']),
		)
		expect(enqueued).toBe(3)
		const jobs = await q.list({ limit: 10 })
		expect(jobs).toHaveLength(3)
		expect(jobs.map((j) => j.runAs?.orgId).sort()).toEqual([
			'org-a',
			'org-b',
			'org-c',
		])
		// The run acts in one org, so it does not still claim to act in all of them.
		expect(jobs.every((j) => j.runAs?.eachOrg === undefined)).toBe(true)
	})

	it('keys each org’s run separately, so they are runs and not one run', async () => {
		const q = queue()
		await enqueueSyncsWith(
			q,
			[SYNC_SOURCE],
			{
				...OCCURRENCE,
				runAs: { kind: 'service', role: 'importer', eachOrg: true },
			},
			orgs(['org-a', 'org-b']),
		)
		const keys = (await q.list({ limit: 10 })).map((j) => j.idempotencyKey)
		// The failure this pins: one occurrence + one source key is *one*
		// idempotency key, so without the org in it the second org's run would be
		// silently dropped as a duplicate of the first — a fan-out that fans out to
		// one tenant and reports success.
		expect(new Set(keys).size).toBe(2)
		expect(keys.every((k) => k?.includes('crm.pull'))).toBe(true)
		expect(keys.some((k) => k?.endsWith('#org-b'))).toBe(true)
	})

	it('a re-delivered occurrence enqueues the same runs, not a second set', async () => {
		const q = queue()
		const occurrence = {
			...OCCURRENCE,
			runAs: { kind: 'service' as const, role: 'importer', eachOrg: true },
		}
		await enqueueSyncsWith(
			q,
			[SYNC_SOURCE],
			occurrence,
			orgs(['org-a', 'org-b']),
		)
		await enqueueSyncsWith(
			q,
			[SYNC_SOURCE],
			occurrence,
			orgs(['org-a', 'org-b']),
		)
		// Idempotency per org, not just per occurrence: the fan-out did not trade
		// the at-most-once property for the per-tenant one.
		expect(await q.list({ limit: 10 })).toHaveLength(2)
	})

	it('runs the bound’s worth and says what it skipped', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const q = queue()
		const enqueued = await enqueueSyncsWith(
			q,
			[SYNC_SOURCE],
			{
				...OCCURRENCE,
				runAs: {
					kind: 'service',
					role: 'importer',
					eachOrg: true,
					maxOrgs: 2,
				},
			},
			orgs(['org-a', 'org-b', 'org-c', 'org-d']),
		)
		expect(enqueued).toBe(2)
		// Loud, because the alternative reads as coverage: a schedule that runs two
		// of four tenants every night and reports success.
		expect(warn.mock.calls.flat().join()).toMatch(/skipped 2 more/)
		warn.mockRestore()
	})

	it('a fan-out that resolved no org enqueues nothing and says so', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const q = queue()
		const enqueued = await enqueueSyncsWith(
			q,
			[SYNC_SOURCE],
			{ ...OCCURRENCE, runAs: { kind: 'user', userId: 'u1', eachOrg: true } },
			orgs([]),
		)
		expect(enqueued).toBe(0)
		expect(await q.list({ limit: 10 })).toHaveLength(0)
		// "Ran, nothing to do" and "could not find a single tenant to run in" are
		// the same silence otherwise.
		expect(warn.mock.calls.flat().join()).toMatch(/member of no organization/)
		warn.mockRestore()
	})

	it('leaves a schedule that declares one org exactly as it was', async () => {
		const q = queue()
		const runAs = { kind: 'service' as const, role: 'importer', orgId: 'org-a' }
		const enqueued = await enqueueSyncsWith(
			q,
			[SYNC_SOURCE],
			{ ...OCCURRENCE, runAs },
			// Never consulted: enumerating tenants for a declaration that named one
			// would be a query per fire for an answer already written down.
			async () => {
				throw new Error('the single-org path must not enumerate orgs')
			},
		)
		expect(enqueued).toBe(1)
		const [job] = await q.list({ limit: 10 })
		expect(job?.runAs).toEqual(runAs)
		expect(job?.idempotencyKey).not.toContain('#')
	})
})

/**
 * Which orgs a fan-out covers, against a real registry and a real database.
 *
 * The rule here is the one worth driving for real rather than stubbing: a service
 * role covers every tenant (there is no membership to narrow it and the
 * declaration is the review), and a user covers the tenants a membership row
 * *still* says they belong to — the set version of why `activeOrgFor` re-verifies
 * a claim instead of trusting the job row.
 */
describe('which orgs a fan-out covers', () => {
	// No `id` field: the grounded table's primary key is a real uuid the store
	// generates, exactly as a tenant table's is — so the ids under test are the ids
	// the enumeration would actually read rather than tidy strings.
	const ORG_FIELDS = [
		{ id: 'fld-org-name', name: 'name', type: 'string', required: true },
	]
	const MEMBER_FIELDS = [
		{ id: 'fld-mem-user', name: 'userId', type: 'string', required: true },
		{
			id: 'fld-mem-org',
			name: 'organizationId',
			type: 'string',
			required: true,
		},
	]

	/** A tenanted project: organizations, memberships, and the rows to match. */
	async function tenants(opts: { orgs?: boolean } = { orgs: true }) {
		let system = spec()
		if (opts.orgs !== false)
			system = applyOp(
				system,
				{
					op: 'data.addEntity',
					args: {
						entity: {
							id: 'e-organization',
							name: 'Organization',
							description: 'A tenant.',
							fields: ORG_FIELDS,
						},
					},
				} as SpecOp,
				meta(10),
			)
		system = applyOp(
			system,
			{
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-member',
						name: 'Member',
						description: 'A membership row.',
						fields: MEMBER_FIELDS,
					},
				},
			} as SpecOp,
			meta(11),
		)
		const shapes = groundedEntityShapes(system)
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, shapes)
		const { store } = await createSpecDb(registry, shapes)
		return { registry, store }
	}

	it('a service role covers every org, in a stable order', async () => {
		const { registry, store } = await tenants()
		const ids: string[] = []
		for (const name of ['c', 'a', 'b'])
			ids.push(String((await store.create('organization', { name })).id))
		const { orgIds, truncated } = await orgsForIdentity(registry, store, {
			kind: 'service',
			role: 'importer',
			eachOrg: true,
		})
		// Every org, ordered by id rather than by insertion: the fan-out has to be
		// the same set of runs on every fire, including when it truncates.
		expect(orgIds).toEqual([...ids].sort())
		expect(truncated).toBe(false)
	})

	it('a user covers only the orgs a membership row still says they belong to', async () => {
		const { registry, store } = await tenants()
		const [a, b, c] = await Promise.all(
			['a', 'b', 'c'].map(async (name) =>
				String((await store.create('organization', { name })).id),
			),
		)
		await store.create('member', { userId: 'u1', organizationId: a })
		await store.create('member', { userId: 'u1', organizationId: c })
		await store.create('member', { userId: 'u2', organizationId: b })
		const { orgIds } = await orgsForIdentity(registry, store, {
			kind: 'user',
			userId: 'u1',
			eachOrg: true,
		})
		// Not `b`: somebody else's tenant. A borrowed identity that fanned out over
		// every org would be a background job with more authority than the person it
		// borrowed from.
		expect(orgIds).toEqual([a, c].sort())
	})

	it('counts an org once even when the user has two membership rows in it', async () => {
		const { registry, store } = await tenants()
		const a = String((await store.create('organization', { name: 'a' })).id)
		await store.create('member', { userId: 'u1', organizationId: a })
		await store.create('member', { userId: 'u1', organizationId: a })
		const { orgIds } = await orgsForIdentity(registry, store, {
			kind: 'user',
			userId: 'u1',
			eachOrg: true,
		})
		expect(orgIds).toEqual([a])
	})

	it('covers nothing in a project that has no organizations at all', async () => {
		const { registry, store } = await tenants({ orgs: false })
		// The honest answer, and the caller says it out loud rather than logging a
		// successful occurrence that did no work.
		expect(
			await orgsForIdentity(registry, store, {
				kind: 'service',
				role: 'importer',
				eachOrg: true,
			}),
		).toEqual({ orgIds: [], truncated: false })
	})
})

describe('the composition root actually wires the runner', () => {
	it('getJobQueue registers the source handler with the generated refiners', async () => {
		// The finding of issues #235 and #236, made mechanical: every piece of this
		// feature was correct and none of it ran, because this one call was absent.
		const { readFile } = await import('node:fs/promises')
		const src = await readFile(
			new URL('./sprout.server.ts', import.meta.url),
			'utf8',
		)
		const body = src.split('export function getJobQueue(')[1] ?? ''
		expect(body).toContain('registerSourceHandlers({')
		expect(body).toContain('refiners: OWNED_SOURCE_REFINERS')
		// And the schedule trigger: a declared sync fires off a declared schedule's
		// occurrence rather than off a timer this app invented.
		expect(body).toContain('enqueueScheduledSyncs')
	})

	it('the scheduled-sync path supplies the real org enumerator', async () => {
		// `enqueueSyncsWith` is tested above against a stub, which is what makes the
		// bound testable and is also exactly how a fan-out could end up wired to
		// nothing in the app — the shape of #235 and #236. This asserts the one
		// caller still hands it the enumeration that reads real tenant rows.
		const { readFile } = await import('node:fs/promises')
		const src = await readFile(
			new URL('./sources.server.ts', import.meta.url),
			'utf8',
		)
		const body =
			src.split('export async function enqueueScheduledSyncs(')[1] ?? ''
		expect(body).toContain('enqueueSyncsWith(')
		expect(body).toContain('orgsForRunAs')
	})

	it('a committed write triggers enrichment, and a source’s own write does not', async () => {
		const { readFile } = await import('node:fs/promises')
		const src = await readFile(
			new URL('./sprout.server.ts', import.meta.url),
			'utf8',
		)
		const body = src.split('export function getAuditSink(')[1] ?? ''
		expect(body).toContain('enqueueWriteEnrichments')
		// The loop guard. Without it an `update`-triggered source enriches its own
		// output forever, and the failure only shows up in a running deployment.
		// It is now a named, tested function rather than an inline string compare
		// — so what this asserts is that the sink still asks, and the
		// rule itself is pinned by behaviour in `features/sources/service.test.ts`.
		expect(body).toContain('writeTriggersEnrichment(entry)')
		// And the tenant the triggering write happened in: an
		// enrichment of somebody's row has to be able to reach that row.
		expect(body).toContain('orgId: entry.orgId')
	})
})
