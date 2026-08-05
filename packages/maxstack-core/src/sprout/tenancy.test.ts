/**
 * Multi-tenancy (task 51, d-tenancy-model) over pglite: a resource declaring
 * `tenantField` is org-scoped through every op — lists/counts filter to the
 * active org, creates stamp it, cross-org rows read as 404, updates cannot
 * re-home a row, and a scoped resource without an active org is denied. Two
 * orgs must see fully disjoint data through the same registry + store.
 */

import type { PGlite } from '@electric-sql/pglite'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzleStore } from '../demo/store.ts'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import {
	NotFoundError,
	type OpContext,
	opCount,
	opCreate,
	opDelete,
	opGet,
	opGetMany,
	opList,
	opUpdate,
} from './operations.ts'
import { PermissionError } from './permissions.ts'
import { ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'

const project = pgTable('project', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: withMeta(text('name'), { label: 'Name', required: true }).notNull(),
	organizationId: text('organizationId'),
})

const DDL = `
CREATE TABLE "project" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "organizationId" text
);
`

const acme = { id: 'u-acme', role: 'member', orgId: 'org-acme' }
const globex = { id: 'u-globex', role: 'member', orgId: 'org-globex' }
const orgless = { id: 'u-orgless', role: 'admin' }

let client: PGlite
let ctxFor: (user: OpContext['user']) => OpContext

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	const registry = new ResourceRegistry()
	registry.register(project, { tenantField: 'organizationId' })
	const store = createDrizzleStore(drizzle({ client }), registry)
	ctxFor = (user) => ({ registry, store, user })
})

afterAll(async () => {
	await client.close()
})

describe('tenant scoping (task 51)', () => {
	let acmeProjectId: string

	it('stamps the active org on create, overriding any client value', async () => {
		const created = await opCreate(ctxFor(acme), 'project', {
			name: 'Acme roadmap',
			organizationId: 'org-globex', // hostile: try to write into another org
		})
		expect(created.organizationId).toBe('org-acme')
		acmeProjectId = created.id as string
		await opCreate(ctxFor(globex), 'project', { name: 'Globex plan' })
	})

	it('lists and counts only the active org, even with a hostile filter', async () => {
		const acmeRows = await opList(ctxFor(acme), 'project')
		expect(acmeRows.map((r) => r.name)).toEqual(['Acme roadmap'])
		const widened = await opList(ctxFor(acme), 'project', {
			filter: { organizationId: 'org-globex' },
		})
		expect(widened.map((r) => r.name)).toEqual(['Acme roadmap'])
		expect(await opCount(ctxFor(acme), 'project')).toBe(1)
		expect(await opCount(ctxFor(globex), 'project')).toBe(1)
	})

	it('switching orgs re-scopes the same store', async () => {
		const switched = await opList(
			ctxFor({ ...acme, orgId: 'org-globex' }),
			'project',
		)
		expect(switched.map((r) => r.name)).toEqual(['Globex plan'])
	})

	it("reads another org's row as 404, not 403", async () => {
		await expect(
			opGet(ctxFor(globex), 'project', acmeProjectId),
		).rejects.toThrow(NotFoundError)
		expect(await opGet(ctxFor(acme), 'project', acmeProjectId)).toMatchObject({
			name: 'Acme roadmap',
		})
	})

	it('filters cross-org ids out of getMany', async () => {
		const rows = await opGetMany(ctxFor(globex), 'project', [acmeProjectId])
		expect(rows).toEqual([])
	})

	it('cannot update or re-home a row from another org', async () => {
		await expect(
			opUpdate(ctxFor(globex), 'project', acmeProjectId, { name: 'stolen' }),
		).rejects.toThrow(NotFoundError)
		// Same-org update succeeds but the tenant column stays immutable.
		const updated = await opUpdate(ctxFor(acme), 'project', acmeProjectId, {
			name: 'Acme roadmap v2',
			organizationId: 'org-globex',
		})
		expect(updated.name).toBe('Acme roadmap v2')
		expect(updated.organizationId).toBe('org-acme')
	})

	it('cannot delete a row from another org', async () => {
		await expect(
			opDelete(ctxFor(globex), 'project', acmeProjectId),
		).rejects.toThrow(NotFoundError)
		expect(await opDelete(ctxFor(acme), 'project', acmeProjectId)).toBe(true)
	})

	it('denies a scoped resource without an active org — even for admins', async () => {
		await expect(opList(ctxFor(orgless), 'project')).rejects.toThrow(
			PermissionError,
		)
		await expect(
			opCreate(ctxFor(orgless), 'project', { name: 'nope' }),
		).rejects.toThrow(PermissionError)
		await expect(opList(ctxFor(null), 'project')).rejects.toThrow(
			PermissionError,
		)
	})

	it('leaves unscoped resources untouched', async () => {
		const registry = new ResourceRegistry()
		registry.register(project, {}) // same table, no tenantField
		const store = createDrizzleStore(drizzle({ client }), registry)
		const rows = await opList({ registry, store, user: orgless }, 'project')
		expect(rows.map((r) => r.name)).toEqual(['Globex plan'])
	})
})
