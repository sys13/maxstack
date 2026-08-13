import { describe, expect, it } from 'vitest'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import { createHandler, updateHandler } from './api.ts'
import {
	AUTHENTICATED_WRITES,
	createSpecDb,
	ensureSpecSchema,
	pickTitleField,
	registerSpecEntities,
	type SpecEntityShape,
	type SpecFieldShape,
	specSchemaDdl,
	tableFromSpecEntity,
} from './from-spec.ts'
import { introspectTable } from './introspection.ts'
import { executeMCPTool } from './mcp.ts'
import { opCreate, opDelete, opGet, opList, opUpdate } from './operations.ts'
import { canPerformAction, PermissionError } from './permissions.ts'
import { ResourceRegistry } from './registry.ts'
import { generateValidationSchema } from './validation.ts'

const subscription: SpecEntityShape = {
	name: 'subscription',
	fields: [
		{ name: 'name', type: 'string', required: true },
		{ name: 'costMonthly', type: 'number', required: true },
		{ name: 'renewsOn', type: 'date', required: false },
		{ name: 'cancelled', type: 'boolean', required: false },
		{ name: 'plan', type: 'enum', required: false },
		{ name: 'extras', type: 'json', required: false },
	],
}

describe('tableFromSpecEntity', () => {
	it('introspects back to the matching Sprout column types', () => {
		const resource = introspectTable(tableFromSpecEntity(subscription))
		expect(resource.name).toBe('subscription')
		expect(resource.primaryKey).toBe('id')
		const types = Object.fromEntries(
			resource.columns.map((c) => [c.name, c.type]),
		)
		expect(types).toMatchObject({
			id: 'uuid',
			name: 'string',
			costMonthly: 'number',
			renewsOn: 'date',
			cancelled: 'boolean',
			plan: 'string', // spec enums carry no value list → text
			extras: 'json',
		})
	})

	it('carries requiredness + labels through withMeta', () => {
		const resource = introspectTable(tableFromSpecEntity(subscription))
		const byName = new Map(resource.columns.map((c) => [c.name, c]))
		expect(byName.get('name')?.meta).toMatchObject({
			label: 'Name',
			required: true,
		})
		expect(byName.get('costMonthly')?.meta).toMatchObject({
			label: 'Cost Monthly',
			required: true,
		})
		expect(byName.get('renewsOn')?.meta).toMatchObject({ required: false })
	})

	it('never doubles a spec-declared id field into a second column', () => {
		const withId: SpecEntityShape = {
			name: 'thing',
			fields: [{ name: 'id', type: 'string', required: true }],
		}
		const resource = introspectTable(tableFromSpecEntity(withId))
		expect(resource.columns.filter((c) => c.name === 'id')).toHaveLength(1)
		expect(resource.columns[0]?.type).toBe('uuid')
	})
})

const story: SpecEntityShape = {
	name: 'story',
	fields: [
		{ name: 'title', type: 'string', required: true },
		{
			name: 'status',
			type: 'enum',
			required: false,
			options: [
				{ label: 'Draft', value: 'draft' },
				{ label: 'Published', value: 'published' },
			],
		},
		{
			name: 'authorId',
			type: 'string',
			required: false,
			reference: { table: 'author', column: 'id', displayField: 'name' },
		},
	],
}

describe('reference + enum options bridging (task 32)', () => {
	it('emits a uuid FK carrying meta.reference for a reference field', () => {
		const resource = introspectTable(tableFromSpecEntity(story))
		const authorId = resource.columns.find((c) => c.name === 'authorId')
		expect(authorId?.type).toBe('uuid')
		expect(authorId?.references).toEqual({
			table: 'author',
			column: 'id',
			displayField: 'name',
		})
	})

	it('carries enum options through to meta.options + enumValues', () => {
		const resource = introspectTable(tableFromSpecEntity(story))
		const status = resource.columns.find((c) => c.name === 'status')
		expect(status?.meta.options).toEqual([
			{ label: 'Draft', value: 'draft' },
			{ label: 'Published', value: 'published' },
		])
		expect(status?.meta.enumValues).toEqual(['draft', 'published'])
	})

	it('introspects a spec enum as a real enum column', () => {
		// The DB column is text, but introspection surfaces the metadata's value
		// list as first-class `enumValues` — so validation emits `z.enum` and the
		// form renders a select on every surface, not just where `meta.options`
		// happens to be consulted.
		const resource = introspectTable(tableFromSpecEntity(story))
		const status = resource.columns.find((c) => c.name === 'status')
		expect(status?.type).toBe('enum')
		expect(status?.enumValues).toEqual(['draft', 'published'])
	})

	it('validates a spec enum against its option values', () => {
		const resource = introspectTable(tableFromSpecEntity(story))
		const schema = generateValidationSchema(resource, 'create')
		expect(schema.safeParse({ title: 'Hi', status: 'published' }).success).toBe(
			true,
		)
		expect(schema.safeParse({ title: 'Hi', status: 'bogus' }).success).toBe(
			false,
		)
	})

	it('keeps an FK column a uuid even when options ride along', () => {
		// Belt-and-braces: an option list on a reference column is picker chrome,
		// never enum-ness — the column must stay an id-holding FK.
		const odd: SpecEntityShape = {
			name: 'odd',
			fields: [
				{
					name: 'ownerId',
					type: 'string',
					required: false,
					reference: { table: 'author', column: 'id' },
					options: [{ label: 'X', value: 'x' }],
				},
			],
		}
		const resource = introspectTable(tableFromSpecEntity(odd))
		const owner = resource.columns.find((c) => c.name === 'ownerId')
		expect(owner?.type).toBe('uuid')
		expect(owner?.enumValues).toBeUndefined()
	})

	it('makes a reference column uuid in the DDL', () => {
		const ddl = specSchemaDdl([story])
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "authorId" uuid')
	})

	// Issue #194: the statements are an unordered `IF NOT EXISTS` set, so their
	// sequence carries no meaning — but it is output, and grounding order is
	// install order. Two orders of the same bundles must not yield two schemas.
	it('emits in table-name order, invariant under the input permutation', () => {
		const forward = specSchemaDdl([subscription, story])
		expect(specSchemaDdl([story, subscription])).toBe(forward)
		expect(forward.indexOf('"story"')).toBeLessThan(
			forward.indexOf('"subscription"'),
		)
	})
})

// "Belongs to a user": the auth bundle's user table has text ids,
// so a reference grounded with `idType: 'text'` must land as a text FK.
const post: SpecEntityShape = {
	name: 'post',
	fields: [
		{
			name: 'ownerId',
			type: 'string',
			required: true,
			reference: {
				table: 'user',
				column: 'id',
				displayField: 'name',
				idType: 'text',
			},
		},
		{ name: 'title', type: 'string', required: true },
	],
}

describe('text-id references', () => {
	it('emits a text FK carrying meta.reference when idType is text', () => {
		const resource = introspectTable(tableFromSpecEntity(post))
		const owner = resource.columns.find((c) => c.name === 'ownerId')
		expect(owner?.type).toBe('string')
		expect(owner?.references).toEqual({
			table: 'user',
			column: 'id',
			displayField: 'name',
			idType: 'text',
		})
	})

	it('makes the column text in the DDL', () => {
		const ddl = specSchemaDdl([post])
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "ownerId" text')
	})

	it('never picks an FK string field as the titleField', () => {
		const registry = new ResourceRegistry()
		const entries = registerSpecEntities(registry, [post])
		expect(entries[0]?.config.titleField).toBe('title')
	})

	it('accepts a non-uuid id value through validation', () => {
		const resource = introspectTable(tableFromSpecEntity(post))
		const schema = generateValidationSchema(resource, 'create')
		expect(
			schema.safeParse({ ownerId: 'ba-3aX9cKq', title: 'Hello' }).success,
		).toBe(true)
	})
})

// Issue #43: an upgrade path's `fromItem`/`toItem` rendered the referenced
// item's *own first FK* (its category id) as the title — the pick must skip
// reference columns and prefer name-ish fields.
describe('pickTitleField', () => {
	it('skips a leading FK string field (the issue #43 shape)', () => {
		expect(
			pickTitleField([
				{
					name: 'category',
					type: 'string',
					reference: { table: 'category', column: 'id' },
				},
				{ name: 'label', type: 'string' },
			]),
		).toBe('label')
	})

	it('prefers `name`, then `title`, over an earlier plain string', () => {
		expect(
			pickTitleField([
				{ name: 'slug', type: 'string' },
				{ name: 'title', type: 'string' },
				{ name: 'name', type: 'string' },
			]),
		).toBe('name')
		expect(
			pickTitleField([
				{ name: 'slug', type: 'string' },
				{ name: 'title', type: 'string' },
			]),
		).toBe('title')
	})

	it('never prefers a name-ish field that is itself an FK', () => {
		expect(
			pickTitleField([
				{ name: 'summary', type: 'string' },
				{
					name: 'name',
					type: 'string',
					reference: { table: 'user', column: 'id' },
				},
			]),
		).toBe('summary')
	})

	it('understands the Sprout-column shape (`references`)', () => {
		expect(
			pickTitleField([
				{
					name: 'ownerId',
					type: 'string',
					references: { table: 'user', column: 'id' },
				},
				{ name: 'headline', type: 'string' },
			]),
		).toBe('headline')
	})

	it('returns undefined when every string field is an FK', () => {
		expect(
			pickTitleField([
				{
					name: 'itemId',
					type: 'string',
					reference: { table: 'item', column: 'id' },
				},
				{ name: 'count', type: 'number' },
			]),
		).toBeUndefined()
	})
})

describe('specSchemaDdl / ensureSpecSchema', () => {
	it('is additive and idempotent against a live database', async () => {
		const client = await bootPglite()
		await ensureSpecSchema(client, [subscription])
		await client.query(
			`INSERT INTO "subscription" ("name", "costMonthly") VALUES ('Netflix', 15.99)`,
		)

		// The spec grows a field; re-sync must keep existing rows + add the column.
		const grown: SpecEntityShape = {
			...subscription,
			fields: [
				...subscription.fields,
				{ name: 'renewalUrl', type: 'string', required: false },
			],
		}
		await ensureSpecSchema(client, [grown])
		await ensureSpecSchema(client, [grown]) // idempotent

		const rows = await client.query<{ name: string; renewalUrl: unknown }>(
			`SELECT "name", "renewalUrl" FROM "subscription"`,
		)
		expect(rows.rows).toEqual([{ name: 'Netflix', renewalUrl: null }])
		await client.close()
	})

	it('reconciles a column that later gains a reference', async () => {
		// The trap this guards: a field ships as a bare string, so the column is
		// `text`; the spec later declares it a foreign key, so the emitted type
		// becomes `uuid`; `ADD COLUMN IF NOT EXISTS` silently does nothing on the
		// existing database, and the app runs with drizzle and Postgres disagreeing
		// about the column until some unrelated query fails.
		const client = await bootPglite()
		const member: SpecEntityShape = {
			name: 'member',
			fields: [
				{ name: 'organizationId', type: 'string', required: true },
				{ name: 'role', type: 'string', required: false },
			],
		}
		await ensureSpecSchema(client, [member])
		const orgId = '11111111-1111-4111-8111-111111111111'
		await client.query(
			`INSERT INTO "member" ("organizationId", "role") VALUES ('${orgId}', 'owner')`,
		)

		const declared: SpecEntityShape = {
			...member,
			fields: [
				{
					name: 'organizationId',
					type: 'string',
					required: true,
					reference: { table: 'organization', column: 'id' },
				} as SpecFieldShape,
				{ name: 'role', type: 'string', required: false },
			],
		}
		await ensureSpecSchema(client, [declared])
		await ensureSpecSchema(client, [declared]) // idempotent

		const type = await client.query<{ data_type: string }>(
			`SELECT data_type FROM information_schema.columns
			 WHERE table_name = 'member' AND column_name = 'organizationId'`,
		)
		expect(type.rows[0]?.data_type).toBe('uuid')
		// The row survives the type change with its value intact — the point of
		// the USING cast rather than a drop-and-recreate.
		const rows = await client.query<{ organizationId: string }>(
			`SELECT "organizationId" FROM "member"`,
		)
		expect(rows.rows).toEqual([{ organizationId: orgId }])
		await client.close()
	})

	it('fails loudly when a reference column holds something that is not an id', async () => {
		// A cast failure here means the column was never really a foreign key.
		// Finding that out at migration time is the whole point of the `USING`.
		const client = await bootPglite()
		const member: SpecEntityShape = {
			name: 'member2',
			fields: [{ name: 'organizationId', type: 'string', required: true }],
		}
		await ensureSpecSchema(client, [member])
		await client.query(
			`INSERT INTO "member2" ("organizationId") VALUES ('not-an-id')`,
		)
		const declared: SpecEntityShape = {
			...member,
			fields: [
				{
					name: 'organizationId',
					type: 'string',
					required: true,
					reference: { table: 'organization', column: 'id' },
				} as SpecFieldShape,
			],
		}
		await expect(ensureSpecSchema(client, [declared])).rejects.toThrow()
		await client.close()
	})

	it('emits no reconciliation for a field with no reference', () => {
		// The exception is scoped to declared references: a plain field's type
		// cannot change, because no op can change it.
		expect(specSchemaDdl([subscription])).not.toContain('DO $$')
	})

	it('quotes camelCase identifiers in the DDL', () => {
		const ddl = specSchemaDdl([subscription])
		expect(ddl).toContain('"costMonthly" real')
		expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "subscription"')
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "renewsOn" timestamp')
	})
})

describe('registerSpecEntities + createSpecDb', () => {
	it('serves CRUD over the spec entities end-to-end', async () => {
		const registry = new ResourceRegistry()
		const entries = registerSpecEntities(registry, [subscription])
		expect(entries[0]?.config.titleField).toBe('name')
		expect(entries[0]?.config.group).toBe('App')

		const { client, store } = await createSpecDb(registry, [subscription])
		const created = await store.create('subscription', {
			name: 'Fastmail',
			costMonthly: 5,
			cancelled: false,
			// date fields take ISO strings (mode 'string') — what JSON/forms send
			renewsOn: '2026-08-01T00:00:00Z',
		})
		expect(created.id).toBeTruthy()
		expect(String(created.renewsOn)).toContain('2026-08-01')
		expect(await store.list('subscription')).toHaveLength(1)

		const updated = await store.update('subscription', String(created.id), {
			costMonthly: 6,
		})
		expect(updated?.costMonthly).toBe(6)
		expect(await store.delete('subscription', String(created.id))).toBe(true)
		await client.close()
	})

	it('orders list rows by a column (spec-as-data ranking)', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [subscription])
		const { client, store } = await createSpecDb(registry, [subscription])
		for (const [name, cost] of [
			['Mid', 5],
			['Top', 99],
			['Low', 1],
		] as const) {
			await store.create('subscription', { name, costMonthly: cost })
		}
		const desc = await store.list('subscription', {
			orderBy: 'costMonthly',
			orderDir: 'desc',
		})
		expect(desc.map((r) => r.name)).toEqual(['Top', 'Mid', 'Low'])
		const asc = await store.list('subscription', {
			orderBy: 'costMonthly',
			orderDir: 'asc',
		})
		expect(asc.map((r) => r.name)).toEqual(['Low', 'Mid', 'Top'])
		// An unknown column is ignored (no throw) rather than 500-ing.
		const unordered = await store.list('subscription', { orderBy: 'nope' })
		expect(unordered).toHaveLength(3)
		await client.close()
	})

	it('threads an access config onto every registered entity', () => {
		const registry = new ResourceRegistry()
		const entries = registerSpecEntities(registry, [subscription, story], {
			access: AUTHENTICATED_WRITES,
		})
		for (const entry of entries) {
			expect(entry.config.access).toBe(AUTHENTICATED_WRITES)
		}
		// The default stays rule-less (open) — securing is the caller's call.
		const open = new ResourceRegistry()
		expect(registerSpecEntities(open, [subscription])[0]?.config.access).toBe(
			undefined,
		)
	})

	it('a declared portal reconciles with the write posture instead of overriding it', async () => {
		// The posture and the declaration have to compose, and the
		// wrong composition is the tempting one: dropping AUTHENTICATED_WRITES for
		// the whole entity because "it has a public portal now". That is exactly
		// "the portal route writes its own rows", one layer down.
		const registry = new ResourceRegistry()
		const [entry] = registerSpecEntities(
			registry,
			[
				{
					...subscription,
					portals: [
						{
							key: 'suggest',
							description: 'Anyone may suggest a subscription.',
							resource: 'subscription',
							audience: 'public',
							scope: 'collection',
							readFields: ['name'],
							writes: [
								{ action: 'create', fields: ['name'], rateLimitPerHour: 10 },
							],
							filter: { field: 'name', equals: 'suggested' },
							layout: 'feed',
							paused: false,
						},
					],
				},
			],
			{ access: AUTHENTICATED_WRITES },
		)
		// It is no longer the shared constant — it is a reconciliation OF it…
		expect(entry?.config.access).not.toBe(AUTHENTICATED_WRITES)
		// …and the plan is on the registry, where `authorize()` can reach it.
		expect(entry?.config.portals).toHaveLength(1)
		expect(registry.findPortal('suggest')?.entry).toBe(entry)
		// The posture survives for every non-portal caller…
		expect(
			await canPerformAction('subscription', entry?.config.access, 'create', {
				user: null,
			}),
		).toBe(false)
		// …and `update`, which no portal declared, is untouched even for a portal.
		expect(
			await canPerformAction('subscription', entry?.config.access, 'update', {
				user: null,
			}),
		).toBe(false)
	})

	it('AUTHENTICATED_WRITES denies anonymous writes but keeps reads public', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [subscription], {
			access: AUTHENTICATED_WRITES,
		})
		const { client, store } = await createSpecDb(registry, [subscription])
		const anonymous = { registry, store, user: null }
		const member = { registry, store, user: { id: 'u1', role: 'member' } }

		await expect(
			opCreate(anonymous, 'subscription', { name: 'X', costMonthly: 1 }),
		).rejects.toThrow(PermissionError)

		const created = await opCreate(member, 'subscription', {
			name: 'Fastmail',
			costMonthly: 5,
		})
		const id = String(created.id)
		await expect(
			opUpdate(anonymous, 'subscription', id, { costMonthly: 9 }),
		).rejects.toThrow(PermissionError)
		await expect(opDelete(anonymous, 'subscription', id)).rejects.toThrow(
			PermissionError,
		)

		// Reads stay public — no rule on 'read'.
		expect(await opList(anonymous, 'subscription')).toHaveLength(1)

		// An authenticated session passes the same gates.
		await opUpdate(member, 'subscription', id, { costMonthly: 6 })
		expect(await opDelete(member, 'subscription', id)).toBe(true)
		await client.close()
	})

	it('getMany resolves rows by id in one round-trip (batch primitive)', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [subscription])
		const { client, store } = await createSpecDb(registry, [subscription])
		const a = await store.create('subscription', { name: 'A', costMonthly: 1 })
		const b = await store.create('subscription', { name: 'B', costMonthly: 2 })
		await store.create('subscription', { name: 'C', costMonthly: 3 })

		const rows = await store.getMany('subscription', [
			String(a.id),
			String(b.id),
		])
		expect(rows.map((r) => r.name).sort()).toEqual(['A', 'B'])
		expect(await store.getMany('subscription', [])).toEqual([])
		await client.close()
	})

	it('list filters by equality and case-insensitive search', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [subscription])
		const { client, store } = await createSpecDb(registry, [subscription])
		await store.create('subscription', {
			name: 'Netflix',
			costMonthly: 15,
			cancelled: false,
		})
		await store.create('subscription', {
			name: 'Spotify',
			costMonthly: 10,
			cancelled: true,
		})

		const active = await store.list('subscription', {
			filter: { cancelled: false },
		})
		expect(active.map((r) => r.name)).toEqual(['Netflix'])

		const found = await store.list('subscription', {
			search: 'SPOT',
			searchFields: ['name'],
		})
		expect(found.map((r) => r.name)).toEqual(['Spotify'])

		// An unknown filter/search column is ignored, not a 500.
		const all = await store.list('subscription', {
			filter: { nope: 'x' },
			search: 'e',
			searchFields: ['missing'],
		})
		expect(all).toHaveLength(2)
		await client.close()
	})

	it('list filters by inclusive numeric/date range (>=/<=)', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [subscription])
		const { client, store } = await createSpecDb(registry, [subscription])
		for (const [name, cost, renews] of [
			['Cheap', 5, '2026-01-15T00:00:00Z'],
			['Mid', 15, '2026-06-15T00:00:00Z'],
			['Pricey', 30, '2026-12-15T00:00:00Z'],
		] as const) {
			await store.create('subscription', {
				name,
				costMonthly: cost,
				renewsOn: renews,
			})
		}

		// A closed numeric range is inclusive on both ends.
		const midCost = await store.list('subscription', {
			range: { costMonthly: { gte: 10, lte: 30 } },
			orderBy: 'costMonthly',
		})
		expect(midCost.map((r) => r.name)).toEqual(['Mid', 'Pricey'])

		// An open-ended bound (only `gte`) leaves the other end unbounded.
		const dear = await store.list('subscription', {
			range: { costMonthly: { gte: 20 } },
		})
		expect(dear.map((r) => r.name)).toEqual(['Pricey'])

		// A date range compares ISO timestamps.
		const firstHalf = await store.list('subscription', {
			range: { renewsOn: { lte: '2026-07-01T00:00:00Z' } },
			orderBy: 'renewsOn',
		})
		expect(firstHalf.map((r) => r.name)).toEqual(['Cheap', 'Mid'])

		// A blank bound and an unknown range column are both no-ops, not 500s.
		const allRows = await store.list('subscription', {
			range: { costMonthly: { gte: '' }, nope: { gte: 1, lte: 2 } },
		})
		expect(allRows).toHaveLength(3)
		await client.close()
	})
})

/**
 * The overlap window — the predicate a ranged calendar and every
 * timeline needed, and read a capped 500 rows for the want of.
 *
 * The two cases that make it a distinct predicate rather than two `range`
 * bounds are asserted directly, because both fail *silently* when it is wrong:
 * a row straddling the window's start disappears from a range test on its
 * start column, and a row with a NULL end disappears from an AND of two range
 * bounds. A calendar that silently drops a row is the worst failure a calendar
 * has, which is why the cap was the previous answer.
 */
describe('list overlaps a window', () => {
	const booking: SpecEntityShape = {
		name: 'booking',
		fields: [
			{ name: 'name', type: 'string', required: true },
			{ name: 'startsOn', type: 'date', required: true },
			{ name: 'endsOn', type: 'date', required: false },
		],
	}

	it('keeps straddling rows and NULL-ended rows, and drops the ones outside', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [booking])
		const { client, store } = await createSpecDb(registry, [booking])
		const rows: [string, string, string | null][] = [
			// Starts before the window and ends inside it: the case a range test on
			// the start column alone loses.
			['straddles-start', '2026-05-20T00:00:00Z', '2026-06-05T00:00:00Z'],
			// Starts inside and ends after: the mirror case.
			['straddles-end', '2026-06-25T00:00:00Z', '2026-07-10T00:00:00Z'],
			// Spans the whole window without either bound inside it.
			['covers', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'],
			['inside', '2026-06-10T00:00:00Z', '2026-06-12T00:00:00Z'],
			// A milestone: no end. The case an AND of two range bounds loses.
			['milestone-inside', '2026-06-15T00:00:00Z', null],
			['milestone-outside', '2026-03-15T00:00:00Z', null],
			['before', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
			['after', '2026-08-01T00:00:00Z', '2026-08-05T00:00:00Z'],
		]
		for (const [name, startsOn, endsOn] of rows)
			await store.create('booking', {
				name,
				startsOn,
				...(endsOn ? { endsOn } : {}),
			})

		const june = await store.list('booking', {
			overlaps: {
				startColumn: 'startsOn',
				endColumn: 'endsOn',
				from: '2026-06-01T00:00:00Z',
				to: '2026-07-01T00:00:00Z',
			},
			orderBy: 'startsOn',
		})
		expect(new Set(june.map((r) => r.name))).toEqual(
			new Set([
				'covers',
				'straddles-start',
				'inside',
				'milestone-inside',
				'straddles-end',
			]),
		)
		await client.close()
	})

	it('is a no-op when either column is unknown, rather than a 500', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [booking])
		const { client, store } = await createSpecDb(registry, [booking])
		await store.create('booking', {
			name: 'only',
			startsOn: '2026-06-10T00:00:00Z',
		})
		// A stale view naming a column the resource no longer has widens to the
		// row cap that already applied — it never narrows, and never throws.
		const all = await store.list('booking', {
			overlaps: {
				startColumn: 'startsOn',
				endColumn: 'goneAway',
				from: '2030-01-01T00:00:00Z',
				to: '2030-02-01T00:00:00Z',
			},
		})
		expect(all).toHaveLength(1)
		await client.close()
	})
})

// ---------------------------------------------------------------------------
// Board columns: a WIP limit and a manual-ordering key.
//
// The gating criterion is that a limit binds *where the write happens*, so
// these drive it through the REST handlers — the path an agent or a script
// takes, which has never seen the board that draws the limit.
// ---------------------------------------------------------------------------

const tracked: SpecEntityShape = {
	name: 'issue',
	fields: [
		{ name: 'title', type: 'string', required: true },
		{
			name: 'status',
			type: 'enum',
			required: false,
			options: [
				{ label: 'To do', value: 'todo' },
				{ label: 'Doing', value: 'doing' },
				{ label: 'Done', value: 'done' },
			],
			limits: { doing: 2 },
		},
		{ name: 'boardRank', type: 'string', required: false, rank: true },
	],
}

describe('WIP limits are enforced where the write happens', () => {
	const ctxFor = async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [tracked])
		const { client, store } = await createSpecDb(registry, [tracked])
		return { client, ctx: { registry, store, user: null } }
	}

	it('carries the declared caps onto the column, where both halves read them', () => {
		const resource = introspectTable(tableFromSpecEntity(tracked))
		const status = resource.columns.find((c) => c.name === 'status')
		expect(status?.meta.valueLimits).toEqual({ doing: 2 })
	})

	it('refuses the create that would overfill a column, over REST', async () => {
		const { client, ctx } = await ctxFor()
		for (const title of ['One', 'Two'])
			expect(
				(await createHandler(ctx, 'issue', { title, status: 'doing' })).status,
			).toBe(201)

		const third = await createHandler(ctx, 'issue', {
			title: 'Three',
			status: 'doing',
		})
		expect(third.status).toBe(422)
		expect(third.body).toMatchObject({
			fieldErrors: { status: [expect.stringContaining('is full')] },
			limit: { field: 'status', value: 'doing', limit: 2, current: 2 },
		})
		// And it is a refusal, not a silent drop: the row does not exist.
		expect(
			await ctx.store.count('issue', { filter: { status: 'doing' } }),
		).toBe(2)
		await client.close()
	})

	it('refuses the update that would move a third card into a full column', async () => {
		const { client, ctx } = await ctxFor()
		for (const title of ['One', 'Two'])
			await createHandler(ctx, 'issue', { title, status: 'doing' })
		const spare = await createHandler(ctx, 'issue', {
			title: 'Spare',
			status: 'todo',
		})
		const id = String((spare.body as Record<string, unknown>).id)

		const moved = await updateHandler(ctx, 'issue', id, { status: 'doing' })
		expect(moved.status).toBe(422)
		expect((moved.body as { error: string }).error).toContain('is full')
		// The row kept its column rather than half-moving.
		expect((await opGet(ctx, 'issue', id)).status).toBe('todo')
		await client.close()
	})

	it('lets a card already in a full column be edited and reordered', async () => {
		// A cap on arrivals must not turn a full column into a read-only one —
		// renaming a card, or dragging it up one place, touches no slot.
		const { client, ctx } = await ctxFor()
		const first = await createHandler(ctx, 'issue', {
			title: 'One',
			status: 'doing',
		})
		await createHandler(ctx, 'issue', { title: 'Two', status: 'doing' })
		const id = String((first.body as Record<string, unknown>).id)

		expect(
			(await updateHandler(ctx, 'issue', id, { title: 'One (renamed)' }))
				.status,
		).toBe(200)
		// Re-stating the same column is a reorder, not an arrival.
		expect(
			(
				await updateHandler(ctx, 'issue', id, {
					status: 'doing',
					boardRank: '3',
				})
			).status,
		).toBe(200)
		await client.close()
	})

	it('caps only the values that declare one, and never a move out', async () => {
		const { client, ctx } = await ctxFor()
		for (const title of ['a', 'b', 'c', 'd'])
			expect(
				(await createHandler(ctx, 'issue', { title, status: 'todo' })).status,
			).toBe(201)
		const one = await createHandler(ctx, 'issue', {
			title: 'e',
			status: 'doing',
		})
		const id = String((one.body as Record<string, unknown>).id)
		expect(
			(await updateHandler(ctx, 'issue', id, { status: 'done' })).status,
		).toBe(200)
		await client.close()
	})

	it('reaches MCP callers too — the same rule, not a second copy of it', async () => {
		const { client, ctx } = await ctxFor()
		for (const title of ['One', 'Two'])
			await createHandler(ctx, 'issue', { title, status: 'doing' })
		const result = await executeMCPTool(ctx, 'create_issue', {
			title: 'Three',
			status: 'doing',
		})
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('is full')
		await client.close()
	})
})

describe('rank columns are never null', () => {
	it('emits a database default, so the column is total the moment it exists', () => {
		const ddl = specSchemaDdl([tracked])
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "boardRank" text DEFAULT (')
		expect(ddl).toContain('clock_timestamp()')
		// Only the rank column gets one — nothing else changes shape.
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "title" text;')
	})

	it('backfills rows that predate the declaration, in one key space', async () => {
		// The failure this prevents: adding the rank column to a table with rows in
		// it leaves an unordered region no single-row write can place a card into.
		const registry = new ResourceRegistry()
		const before: SpecEntityShape = {
			name: 'issue',
			fields: tracked.fields.filter((f) => f.name !== 'boardRank'),
		}
		registerSpecEntities(registry, [before])
		const { client, store } = await createSpecDb(registry, [before])
		for (const title of ['One', 'Two'])
			await store.create('issue', { title, status: 'todo' })

		// The board is declared later — the additive DDL runs again.
		await ensureSpecSchema(client, [tracked])
		const rows = await client.query<{ boardRank: string | null }>(
			'select "boardRank" from issue',
		)
		expect(rows.rows).toHaveLength(2)
		for (const row of rows.rows) {
			expect(row.boardRank).toMatch(/^[0-9]*[1-9]$/)
		}
		await client.close()
	})

	it('stamps a new row at the end of the column without the client saying so', async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [tracked])
		const { client, store } = await createSpecDb(registry, [tracked])
		const first = await store.create('issue', { title: 'One' })
		const second = await store.create('issue', { title: 'Two' })
		expect(typeof first.boardRank).toBe('string')
		// Monotone: later rows sort after earlier ones, so a create appends.
		expect(String(second.boardRank) >= String(first.boardRank)).toBe(true)
		await client.close()
	})

	it('hides the key from forms without hiding it from the validator', () => {
		// The board writes the rank through the record's ordinary edit route, so
		// the update schema has to accept it; the *form* must never render it.
		const resource = introspectTable(tableFromSpecEntity(tracked))
		const rank = resource.columns.find((c) => c.name === 'boardRank')
		expect(rank?.meta).toMatchObject({ rankKey: true, hidden: true })
		expect(
			generateValidationSchema(resource, 'update').safeParse({
				boardRank: '35',
			}).success,
		).toBe(true)
	})
})

describe('derived values never reach the schema', () => {
	// The structural guarantee behind "the spec declares, the runtime evaluates":
	// a rollup or computed field has no column, no DDL, and no migration. If either
	// of these ever emitted one, an additive-only promise would be broken by a
	// feature that only ever reads.
	const withDerived: SpecEntityShape = {
		name: 'mealplan',
		fields: [{ name: 'week', type: 'date', required: true }],
		computed: [
			{
				name: 'doubled',
				expr: {
					kind: 'binary',
					op: '*',
					left: { kind: 'field', field: 'week' },
					right: { kind: 'literal', value: 2 },
				},
			},
		],
		rollups: [
			{
				name: 'shoppingList',
				over: 'ingredient',
				via: [{ column: 'mealplanId', table: 'mealplan' }],
				fn: 'sum',
				column: 'quantity',
			},
		],
	}

	it('emits no DDL for a computed field or a rollup', () => {
		const ddl = specSchemaDdl([withDerived])
		expect(ddl).toContain('"week" timestamp')
		expect(ddl).not.toContain('doubled')
		expect(ddl).not.toContain('shoppingList')
		// Exactly one CREATE and one ADD COLUMN — the stored field only.
		expect(ddl.match(/ADD COLUMN/g)).toHaveLength(1)
	})

	it('builds no drizzle column for a computed field or a rollup', () => {
		const table = tableFromSpecEntity(withDerived)
		const names = Object.keys(table as unknown as Record<string, unknown>)
		expect(names).not.toContain('doubled')
		expect(names).not.toContain('shoppingList')
	})
})

// ---------------------------------------------------------------------------
// Date round-trip: a row must be postable back through the API it
// was read from. A spec `date` is a `timestamp` in mode: 'string', so the store
// hands back `2026-03-08 09:00:00` — a space where ISO wants a `T` — and the
// generated Zod schema used to accept only the `T` form. Read a row, change
// something else, save: 422 on a column the caller never touched.
// ---------------------------------------------------------------------------

describe('a row round-trips through its own API', () => {
	const appointment: SpecEntityShape = {
		name: 'appointment',
		fields: [
			{ name: 'title', type: 'string', required: true },
			{ name: 'startsAt', type: 'date', required: false },
		],
	}
	const ctxFor = async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [appointment])
		const { client, store } = await createSpecDb(registry, [appointment])
		return { client, ctx: { registry, store, user: null } }
	}

	it('accepts the row it just handed out, unchanged', async () => {
		const { client, ctx } = await ctxFor()
		const created = await createHandler(ctx, 'appointment', {
			title: 'Standup',
			startsAt: '2026-03-08T09:00:00',
		})
		expect(created.status).toBe(201)
		const row = created.body as Record<string, unknown>
		const id = String(row.id)

		// The shape the platform itself emits — asserted, not assumed, because
		// the whole bug is that this differs from what the validator accepted.
		expect(String(row.startsAt)).toMatch(/^2026-03-08 09:00:00/)

		// Read-modify-write: the caller edits the title and posts the record back
		// with the date exactly as it was received.
		const saved = await updateHandler(ctx, 'appointment', id, {
			title: 'Standup (moved room)',
			startsAt: String(row.startsAt),
		})
		expect(saved.status).toBe(200)
		const after = saved.body as Record<string, unknown>
		expect(after.title).toBe('Standup (moved room)')
		// The untouched column still reads the same instant it did before.
		expect(String(after.startsAt)).toMatch(/^2026-03-08 09:00:00/)
		await client.close()
	})

	it('still refuses a date that is not one', async () => {
		// The normalizer widens the accepted set by exactly one separator; it is
		// not a hole through which any string reaches the column.
		const { client, ctx } = await ctxFor()
		const bad = await createHandler(ctx, 'appointment', {
			title: 'Bad',
			startsAt: 'next tuesday',
		})
		expect(bad.status).toBe(422)
		expect(bad.body).toHaveProperty('fieldErrors')
		await client.close()
	})
})

describe('a row round-trips on the nullability axis too', () => {
	// #218 made a read-back date acceptable to its own API. This is the same
	// principle one axis over: the API *emits* `null` for every unset optional
	// column, so the API has to *accept* `null` back. Before the fix update mode
	// applied `.optional()` without `.nullable()`, so `POST {plan:null}` 200'd
	// and `PATCH {plan:null}` 422'd on the very same column.
	const book: SpecEntityShape = {
		name: 'book',
		fields: [
			{ name: 'title', type: 'string', required: true },
			{ name: 'rating', type: 'number', required: false },
			{ name: 'genre', type: 'string', required: false },
			{ name: 'finishedOn', type: 'date', required: false },
			{ name: 'shelved', type: 'boolean', required: false },
			{ name: 'notes', type: 'json', required: false },
		],
	}
	const ctxFor = async () => {
		const registry = new ResourceRegistry()
		registerSpecEntities(registry, [book])
		const { client, store } = await createSpecDb(registry, [book])
		return { client, ctx: { registry, store, user: null } }
	}

	it('takes back the whole row it just handed out, nulls and all', async () => {
		const { client, ctx } = await ctxFor()
		const created = await createHandler(ctx, 'book', { title: 'Piranesi' })
		expect(created.status).toBe(201)
		const row = created.body as Record<string, unknown>

		// The shape the read path emits — asserted, because it is half the bug.
		for (const field of ['rating', 'genre', 'finishedOn', 'shelved', 'notes'])
			expect(row[field]).toBeNull()

		const { id, createdAt, updatedAt, ...readBack } = row
		const saved = await updateHandler(ctx, 'book', String(id), readBack)
		expect(saved.status).toBe(200)
		await client.close()
	})

	it('clears a set optional column — and the clear actually persists', async () => {
		const { client, ctx } = await ctxFor()
		const created = await createHandler(ctx, 'book', {
			title: 'Piranesi',
			rating: 3,
			genre: 'Fantasy',
			finishedOn: '2026-03-08T09:00:00',
		})
		const id = String((created.body as Record<string, unknown>).id)

		const saved = await updateHandler(ctx, 'book', id, {
			rating: null,
			genre: null,
			finishedOn: null,
		})
		expect(saved.status).toBe(200)
		// Not merely accepted — written. A 200 that silently dropped the key
		// would leave the field just as uncleavable as the 422 did.
		const after = saved.body as Record<string, unknown>
		expect(after.rating).toBeNull()
		expect(after.genre).toBeNull()
		expect(after.finishedOn).toBeNull()
		const reread = (await opGet(ctx, 'book', id)) as Record<string, unknown>
		expect(reread.rating).toBeNull()
		expect(reread.finishedOn).toBeNull()
		await client.close()
	})

	it('leaves no reason to overload a real value as a sentinel', async () => {
		// `rating: 0` was the only way to say "unrated" while null 422'd, which
		// stores a legitimate score as a marker for its own absence.
		const { client, ctx } = await ctxFor()
		const created = await createHandler(ctx, 'book', {
			title: 'Piranesi',
			rating: 3,
		})
		const id = String((created.body as Record<string, unknown>).id)
		const cleared = await updateHandler(ctx, 'book', id, { rating: null })
		expect((cleared.body as Record<string, unknown>).rating).not.toBe(0)
		expect((cleared.body as Record<string, unknown>).rating).toBeNull()
		await client.close()
	})

	it('still refuses null for a required column', async () => {
		const { client, ctx } = await ctxFor()
		const created = await createHandler(ctx, 'book', { title: 'Piranesi' })
		const id = String((created.body as Record<string, unknown>).id)
		const bad = await updateHandler(ctx, 'book', id, { title: null })
		expect(bad.status).toBe(422)
		expect(bad.body).toHaveProperty('fieldErrors')
		await client.close()
	})
})

// ---------------------------------------------------------------------------
// Issue #345 — a number field's declared presentation.
//
// `meta.min`/`max`/`step`/`format` already drove the rating, slider and duration
// widgets; what was missing was any path to them from the spec, so the widget
// was chosen by the column's *name* and the scale was fixed at the code default.
// ---------------------------------------------------------------------------

describe('a number field carries its declared presentation onto the column', () => {
	const shelf: SpecEntityShape = {
		name: 'book',
		fields: [
			{ name: 'title', type: 'string', required: true },
			{
				name: 'rating',
				type: 'number',
				required: false,
				display: { format: 'rating', max: 10, step: 0.5 },
			},
			// The escape hatch: same name, stated as a plain number.
			{
				name: 'imdbRating',
				type: 'number',
				required: false,
				display: { format: 'number' },
			},
			{ name: 'pages', type: 'number', required: false },
		],
	}

	it('grounds display onto meta, and leaves an undeclared field alone', () => {
		const resource = introspectTable(tableFromSpecEntity(shelf))
		const col = (name: string) => resource.columns.find((c) => c.name === name)
		expect(col('rating')?.meta).toMatchObject({
			format: 'rating',
			max: 10,
			step: 0.5,
		})
		expect(col('imdbRating')?.meta.format).toBe('number')
		// An undeclared number is unchanged — inference still applies to it.
		expect(col('pages')?.meta.format).toBeUndefined()
		expect(col('pages')?.meta.max).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// Issue #414 — a field's declared filter control.
//
// `meta.filterable` was already read by the list-filter derivation in both
// directions and no spec op wrote it, so the only layer a person writes in
// could not say "not this column". `meta.filterOperators` is the new half.
// ---------------------------------------------------------------------------

describe('a field carries its declared filter control onto the column', () => {
	const ledger: SpecEntityShape = {
		name: 'invoice',
		fields: [
			{ name: 'reference', type: 'string', required: true },
			{
				name: 'internalNote',
				type: 'string',
				required: false,
				filter: { filterable: false },
			},
			{
				name: 'year',
				type: 'number',
				required: false,
				filter: { operators: ['eq'] },
			},
			{ name: 'total', type: 'number', required: false },
		],
	}

	it('grounds filter onto meta, and leaves an undeclared field alone', () => {
		const resource = introspectTable(tableFromSpecEntity(ledger))
		const col = (name: string) => resource.columns.find((c) => c.name === name)
		expect(col('internalNote')?.meta.filterable).toBe(false)
		expect(col('year')?.meta.filterOperators).toEqual(['eq'])
		expect(col('total')?.meta.filterable).toBeUndefined()
		expect(col('total')?.meta.filterOperators).toBeUndefined()
	})
})
