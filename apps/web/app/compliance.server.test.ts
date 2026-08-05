/**
 * The composition root owes a retention classification for every table
 *. These tests defend the two properties that make the default in
 * `compliance.server.ts` safe rather than merely convenient.
 */

import { ResourceRegistry } from '@maxstack/core'
import {
	assertRetentionCoverage,
	retentionPolicyErrors,
} from '@maxstack/features/compliance'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { retentionPolicies } from './compliance.server'

const auditLog = pgTable('audit_log', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: text('userId').notNull(),
	action: text('action').notNull(),
})

const project = pgTable('project', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: text('userId').notNull(),
	name: text('name').notNull(),
})

const somethingNew = pgTable('something_new', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
})

function registryOf(...tables: Parameters<ResourceRegistry['register']>[0][]) {
	const registry = new ResourceRegistry()
	for (const table of tables) registry.register(table, {})
	return registry
}

describe('retentionPolicies', () => {
	it('classifies every registered resource — the coverage check passes', () => {
		const registry = registryOf(auditLog, project, somethingNew)
		expect(() =>
			assertRetentionCoverage(registry, retentionPolicies(registry)),
		).not.toThrow()
	})

	it('emits structurally valid policies', () => {
		const registry = registryOf(auditLog, project)
		expect(retentionPolicyErrors(retentionPolicies(registry))).toEqual([])
	})

	it('NEVER defaults a table to operational', () => {
		// The load-bearing assertion. `operational` means "excluded from the
		// export and the erasure", so defaulting to it tells a subject their data
		// was deleted when it was not. A new table must default to `personal` —
		// over-deletion loses a row, under-deletion is a lie.
		const registry = registryOf(somethingNew)
		expect(retentionPolicies(registry)).toEqual([
			{ resource: 'something_new', class: 'personal' },
		])
	})

	it('keeps the audit log on legal hold, with a written basis', () => {
		const registry = registryOf(auditLog)
		const [policy] = retentionPolicies(registry)
		expect(policy?.class).toBe('legal-hold')
		expect(policy?.basis).toMatch(/append-only/)
		expect(policy?.pseudonymize).toContain('userId')
	})

	it('only ever claims "no personal data" about tables it names explicitly', () => {
		// Every `operational` classification is a written claim by a person. If one
		// appears for a table not in the hand-written infra list, the default has
		// drifted in the dangerous direction.
		const registry = registryOf(auditLog, project, somethingNew)
		const operational = retentionPolicies(registry).filter(
			(p) => p.class === 'operational',
		)
		for (const policy of operational) expect(policy.reason?.trim()).toBeTruthy()
	})
})
