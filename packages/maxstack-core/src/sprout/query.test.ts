/**
 * Cross-resource query over pglite.
 *
 * The shape under test is the issue's own question — "customers with an active
 * campaign whose health score is below 50" — answered in ONE call, plus the four
 * things that make a join dangerous if they are not true: the joined entity's own
 * permission runs, the tenant scope holds on every table rather than only the
 * root, and the depth and size caps bind.
 */

import type { PGlite } from '@electric-sql/pglite'
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzleStore } from '../demo/store.ts'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import { executeMCPTool, generateMCPTools } from './mcp.ts'
import { type OpContext, opCreate, ValidationError } from './operations.ts'
import { PermissionError } from './permissions.ts'
import { opQuery, QUERY_LIMITS, queryEdges } from './query.ts'
import { ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'

const customer = pgTable('customer', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: withMeta(text('name'), { label: 'Name', required: true }).notNull(),
	healthScore: integer('healthScore'),
	organizationId: text('organizationId'),
})

const campaign = pgTable('campaign', {
	id: uuid('id').primaryKey().defaultRandom(),
	customerId: withMeta(uuid('customerId'), { label: 'Customer' }).references(
		() => customer.id,
	),
	status: text('status'),
	organizationId: text('organizationId'),
})

/** The third hop, for the depth cap. */
const touch = pgTable('touch', {
	id: uuid('id').primaryKey().defaultRandom(),
	campaignId: withMeta(uuid('campaignId'), { label: 'Campaign' }).references(
		() => campaign.id,
	),
	note: text('note'),
	organizationId: text('organizationId'),
})

/** Readable by admins only — the entity a member must not reach *through* a
 * customer any more than directly. */
const contract = pgTable('contract', {
	id: uuid('id').primaryKey().defaultRandom(),
	customerId: withMeta(uuid('customerId'), { label: 'Customer' }).references(
		() => customer.id,
	),
	value: text('value'),
	organizationId: text('organizationId'),
})

const DDL = `
CREATE TABLE "customer" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "healthScore" integer,
  "organizationId" text
);
CREATE TABLE "campaign" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customerId" uuid REFERENCES customer(id),
  "status" text,
  "organizationId" text
);
CREATE TABLE "touch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaignId" uuid REFERENCES campaign(id),
  "note" text,
  "organizationId" text
);
CREATE TABLE "contract" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customerId" uuid REFERENCES customer(id),
  "value" text,
  "organizationId" text
);
`

const acme = { id: 'u-acme', role: 'member', orgId: 'org-acme' }
const acmeAdmin = { id: 'a-acme', role: 'admin', orgId: 'org-acme' }
const globex = { id: 'u-globex', role: 'member', orgId: 'org-globex' }
const orgless = { id: 'u-none', role: 'admin' }

let client: PGlite
let registry: ResourceRegistry
let ctxFor: (user: OpContext['user']) => OpContext
const ids: Record<string, string> = {}

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	registry = new ResourceRegistry()
	registry.register(customer, { tenantField: 'organizationId' })
	registry.register(campaign, { tenantField: 'organizationId' })
	registry.register(touch, { tenantField: 'organizationId' })
	registry.register(contract, {
		tenantField: 'organizationId',
		access: { read: 'admin' },
	})
	const store = createDrizzleStore(drizzle({ client }), registry)
	ctxFor = (user) => ({ registry, store, user })

	const acmeCtx = ctxFor(acme)
	// Acme: one healthy customer with an active campaign, one at-risk customer
	// with an active campaign (the answer), one at-risk customer whose only
	// campaign is paused, and one at-risk customer with no campaign at all.
	for (const [key, name, score] of [
		['healthy', 'Healthy Co', 90],
		['atRisk', 'At Risk Co', 30],
		['paused', 'Paused Co', 20],
		['lonely', 'Lonely Co', 10],
	] as const) {
		const row = await opCreate(acmeCtx, 'customer', {
			name,
			healthScore: score,
		})
		ids[key] = String(row.id)
	}
	for (const [customerKey, status] of [
		['healthy', 'active'],
		['atRisk', 'active'],
		['paused', 'paused'],
	] as const) {
		const row = await opCreate(acmeCtx, 'campaign', {
			customerId: ids[customerKey],
			status,
		})
		ids[`campaign-${customerKey}`] = String(row.id)
	}
	await opCreate(acmeCtx, 'touch', {
		campaignId: ids['campaign-atRisk'],
		note: 'called them',
	})
	await opCreate(acmeCtx, 'contract', {
		customerId: ids.atRisk,
		value: 'confidential',
	})
	// Globex: a campaign hung off ACME's at-risk customer. Nothing stops a foreign
	// org writing that FK — what must hold is that acme never sees the row and
	// globex never sees the customer.
	await opCreate(ctxFor(globex), 'campaign', {
		customerId: ids.atRisk,
		status: 'active',
	})
})

afterAll(async () => {
	await client.close()
})

describe('queryEdges', () => {
	it('derives both directions from declared references', () => {
		const entry = registry.get('customer')
		if (!entry) throw new Error('customer not registered')
		const edges = queryEdges(registry, entry)
		expect(edges.map((e) => e.name)).toEqual(
			expect.arrayContaining([
				'campaign_via_customerId',
				'contract_via_customerId',
			]),
		)
		const campaignEdge = edges.find((e) => e.name === 'campaign_via_customerId')
		expect(campaignEdge?.kind).toBe('one-to-many')

		const child = registry.get('campaign')
		if (!child) throw new Error('campaign not registered')
		const forward = queryEdges(registry, child).find(
			(e) => e.resource === 'customer',
		)
		expect(forward?.kind).toBe('many-to-one')
	})
})

describe('opQuery — the joined question, in one call', () => {
	it('answers "customers with an active campaign whose health score is below 50"', async () => {
		const result = await opQuery(ctxFor(acme), {
			resource: 'customer',
			range: { healthScore: { lte: 50 } },
			traverse: [
				{
					edge: 'campaign_via_customerId',
					where: { status: 'active' },
					required: true,
				},
			],
		})
		expect(result.rows.map((r) => r.record.name)).toEqual(['At Risk Co'])
		expect(result.truncated).toBe(false)
		const related = result.rows[0]?.related?.campaign_via_customerId
		expect(Array.isArray(related) && related.length).toBe(1)
	})

	it('walks a forward reference too, yielding one row or null', async () => {
		const result = await opQuery(ctxFor(acme), {
			resource: 'campaign',
			where: { status: 'paused' },
			traverse: [{ edge: 'customer' }],
		})
		expect(result.rows).toHaveLength(1)
		const parent = result.rows[0]?.related?.customer
		expect(parent && !Array.isArray(parent) ? parent.record.name : null).toBe(
			'Paused Co',
		)
	})

	it('expands without filtering when required is absent', async () => {
		const result = await opQuery(ctxFor(acme), {
			resource: 'customer',
			traverse: [{ edge: 'campaign_via_customerId' }],
		})
		expect(result.rows).toHaveLength(4)
		const lonely = result.rows.find((r) => r.record.name === 'Lonely Co')
		expect(lonely?.related?.campaign_via_customerId).toEqual([])
	})

	it('refuses a predicate on a column the resource does not declare', async () => {
		await expect(
			opQuery(ctxFor(acme), {
				resource: 'customer',
				where: { nope: 'x' },
			}),
		).rejects.toBeInstanceOf(ValidationError)
	})

	it('refuses an edge that is not a declared reference — there is no ad-hoc join', async () => {
		await expect(
			opQuery(ctxFor(acme), {
				resource: 'customer',
				traverse: [{ edge: 'customer JOIN contract ON 1=1' }],
			}),
		).rejects.toBeInstanceOf(ValidationError)
	})
})

describe('a join is not a permission-laundering path', () => {
	it('refuses the whole call when the joined entity is unreadable', async () => {
		await expect(
			opQuery(ctxFor(acme), {
				resource: 'customer',
				traverse: [{ edge: 'contract_via_customerId' }],
			}),
		).rejects.toBeInstanceOf(PermissionError)
	})

	it('refuses it row-lessly — before any root row is read, so the answer is not data-dependent', async () => {
		// No acme customer matches, so a data-dependent gate would return an empty
		// result here and a refusal for the query above. Same refusal, either way.
		await expect(
			opQuery(ctxFor(acme), {
				resource: 'customer',
				where: { name: 'Nobody' },
				traverse: [{ edge: 'contract_via_customerId' }],
			}),
		).rejects.toBeInstanceOf(PermissionError)
	})

	it('lets an admin through the same edge', async () => {
		const result = await opQuery(ctxFor(acmeAdmin), {
			resource: 'customer',
			traverse: [{ edge: 'contract_via_customerId', required: true }],
		})
		expect(result.rows).toHaveLength(1)
		expect(result.rows[0]?.record.name).toBe('At Risk Co')
	})

	it('returns nothing from the joined entity over MCP, and says why', async () => {
		const res = await executeMCPTool(ctxFor(acme), 'query_records', {
			resource: 'customer',
			traverse: [{ edge: 'contract_via_customerId' }],
		})
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).not.toContain('confidential')
	})
})

describe('tenancy holds on every table in the traversal', () => {
	it("never shows another org's related row under an in-tenant parent", async () => {
		const result = await opQuery(ctxFor(acme), {
			resource: 'customer',
			where: { name: 'At Risk Co' },
			traverse: [{ edge: 'campaign_via_customerId' }],
		})
		const related = result.rows[0]?.related?.campaign_via_customerId
		expect(Array.isArray(related) && related.length).toBe(1)
		expect(
			Array.isArray(related) &&
				related.every((r) => r.record.organizationId === 'org-acme'),
		).toBe(true)
	})

	it('does not let another org reach the parent it hung a row off', async () => {
		const result = await opQuery(ctxFor(globex), {
			resource: 'campaign',
			traverse: [{ edge: 'customer' }],
		})
		expect(result.rows).toHaveLength(1)
		// The campaign is globex's; the customer it points at is acme's, so the
		// forward hop resolves to nothing rather than to another org's row.
		expect(result.rows[0]?.related?.customer).toBeNull()
	})

	it('denies a scoped traversal to an identity with no active org — even an admin', async () => {
		await expect(
			opQuery(ctxFor(orgless), {
				resource: 'customer',
				traverse: [{ edge: 'campaign_via_customerId' }],
			}),
		).rejects.toBeInstanceOf(PermissionError)
	})
})

describe('the walk is bounded', () => {
	it('refuses a traversal deeper than the cap', async () => {
		const deep = {
			resource: 'customer',
			traverse: [
				{
					edge: 'campaign_via_customerId',
					traverse: [
						{
							edge: 'touch_via_campaignId',
							traverse: [{ edge: 'campaign' }],
						},
					],
				},
			],
		}
		await expect(opQuery(ctxFor(acme), deep)).rejects.toBeInstanceOf(
			ValidationError,
		)
	})

	it('allows exactly the cap', async () => {
		const result = await opQuery(ctxFor(acme), {
			resource: 'customer',
			traverse: [
				{
					edge: 'campaign_via_customerId',
					required: true,
					traverse: [{ edge: 'touch_via_campaignId', required: true }],
				},
			],
		})
		expect(result.rows.map((r) => r.record.name)).toEqual(['At Risk Co'])
	})

	it('refuses more edges than the cap allows', async () => {
		await expect(
			opQuery(ctxFor(acme), {
				resource: 'customer',
				traverse: Array.from({ length: QUERY_LIMITS.maxEdges + 1 }, () => ({
					edge: 'campaign_via_customerId',
				})),
			}),
		).rejects.toBeInstanceOf(ValidationError)
	})

	it('clamps the result size to the cap however large a limit is asked for', async () => {
		const ctx = ctxFor(acme)
		for (let i = 0; i < QUERY_LIMITS.maxLimit + 5; i++)
			await opCreate(ctx, 'customer', { name: `Bulk ${i}`, healthScore: 1 })
		const result = await opQuery(ctx, {
			resource: 'customer',
			limit: 5_000,
		})
		expect(result.rows.length).toBe(QUERY_LIMITS.maxLimit)
		expect(result.scanned).toBeLessThanOrEqual(QUERY_LIMITS.maxRootScan)
	})
})

describe('the MCP surface (issue #320 bound intact)', () => {
	it('offers query_records once, with the resource in the arguments', async () => {
		const tools = await generateMCPTools(registry, acmeAdmin)
		const names = tools.map((t) => t.name)
		expect(names.filter((n) => n === 'query_records')).toHaveLength(1)
		expect(names.some((n) => n.endsWith('_customer'))).toBe(false)
		expect(names.length).toBeLessThanOrEqual(12)
	})

	it('offers it only where a declared reference joins two readable resources', async () => {
		const lone = new ResourceRegistry()
		lone.register(customer)
		expect(
			(await generateMCPTools(lone, acmeAdmin)).map((t) => t.name),
		).not.toContain('query_records')
	})

	it('reports the traversable edges through describe_resources, not through tools/list', async () => {
		const res = await executeMCPTool(ctxFor(acmeAdmin), 'describe_resources', {
			resource: 'customer',
		})
		const body = JSON.parse(res.content[0]?.text ?? '{}') as {
			relations?: { edge: string }[]
		}
		expect(body.relations?.map((r) => r.edge)).toEqual(
			expect.arrayContaining(['campaign_via_customerId']),
		)
	})

	it('hides an edge whose far side the caller may not read', async () => {
		const res = await executeMCPTool(ctxFor(acme), 'describe_resources', {
			resource: 'customer',
		})
		const body = JSON.parse(res.content[0]?.text ?? '{}') as {
			relations?: { edge: string }[]
		}
		expect(body.relations?.map((r) => r.edge)).not.toContain(
			'contract_via_customerId',
		)
	})

	it('answers the joined question through the tool, in one call', async () => {
		const res = await executeMCPTool(ctxFor(acme), 'query_records', {
			resource: 'customer',
			range: { healthScore: { lte: 50 } },
			traverse: [
				{
					edge: 'campaign_via_customerId',
					where: { status: 'active' },
					required: true,
				},
			],
			limit: 10,
		})
		expect(res.isError).toBeUndefined()
		const body = JSON.parse(res.content[0]?.text ?? '{}') as {
			rows: { record: { name: string } }[]
		}
		expect(body.rows.map((r) => r.record.name)).toEqual(['At Risk Co'])
	})
})
