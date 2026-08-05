/**
 * Issue #188's gating clause, as tests:
 *
 * > A delete-my-data flow that misses a related table is a legal exposure the
 * > user believes is handled. It must be **derived from the relation graph**,
 * > not hand-listed, and it must **fail loudly** when it encounters a table with
 * > no declared retention policy — silence is the dangerous outcome here.
 *
 * The completeness test is the point of this file: a `comment` on the subject's
 * `post` carries no `userId`, so the owner-column-only flow that shipped before
 * #188 silently dropped it from both the export and the erasure. It is asserted
 * against the *store*, not against the report, because the report is written by
 * the same code being tested.
 */

import type { PGlite } from '@electric-sql/pglite'
import { ResourceRegistry } from '@maxstack/core'
import { createDrizzleStore } from '@maxstack/core/demo'
import { bootPglite } from '@maxstack/core/testing'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ERASED_SUBJECT, eraseUserData } from './erasure-service.ts'
import { exportUserData } from './export-service.ts'
import {
	assertRetentionCoverage,
	deletionOrder,
	RetentionCoverageError,
	type RetentionPolicy,
	relationEdges,
	retentionPolicyErrors,
} from './retention.ts'

// A schema with the shape that matters: `post` is directly owned, `comment`
// hangs off `post` with NO owner column of its own, and `attachment` hangs off
// `comment` — two hops from the subject. `audit_entry` is the legal-hold case
// and `tag` the operational one.
const post = pgTable('post', {
	id: uuid('id').primaryKey().defaultRandom(),
	authorId: text('authorId').notNull(),
	title: text('title').notNull(),
})

const comment = pgTable('comment', {
	id: uuid('id').primaryKey().defaultRandom(),
	postId: uuid('postId').references(() => post.id),
	body: text('body').notNull(),
})

const attachment = pgTable('attachment', {
	id: uuid('id').primaryKey().defaultRandom(),
	commentId: uuid('commentId').references(() => comment.id),
	filename: text('filename').notNull(),
})

const auditEntry = pgTable('audit_entry', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: text('userId').notNull(),
	action: text('action').notNull(),
})

const tag = pgTable('tag', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
})

const DDL = `
CREATE TABLE post (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorId" text NOT NULL,
  title text NOT NULL
);
CREATE TABLE comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "postId" uuid REFERENCES post(id),
  body text NOT NULL
);
CREATE TABLE attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "commentId" uuid REFERENCES comment(id),
  filename text NOT NULL
);
CREATE TABLE audit_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" text NOT NULL,
  action text NOT NULL
);
CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
`

const POLICIES: RetentionPolicy[] = [
	{ resource: 'post', class: 'personal' },
	{ resource: 'comment', class: 'personal' },
	{ resource: 'attachment', class: 'personal' },
	{
		resource: 'audit_entry',
		class: 'legal-hold',
		basis:
			'The audit trail is append-only by design; deleting entries destroys the record of what happened. See.',
		pseudonymize: ['userId'],
	},
	{
		resource: 'tag',
		class: 'operational',
		reason: 'A global vocabulary list; rows are not about any person.',
	},
]

let client: PGlite
let registry: ResourceRegistry
let store: ReturnType<typeof createDrizzleStore>

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	registry = new ResourceRegistry()
	registry.register(post, {})
	registry.register(comment, {})
	registry.register(attachment, {})
	registry.register(auditEntry, {})
	registry.register(tag, {})
	store = createDrizzleStore(drizzle({ client }), registry)
})

afterAll(async () => {
	await client.close()
})

beforeEach(async () => {
	for (const table of ['attachment', 'comment', 'post', 'audit_entry', 'tag'])
		await client.exec(`DELETE FROM ${table};`)
})

/** The subject's post, a comment on it, and an attachment on that comment. */
async function seedSubject(userId: string) {
	const created = await store.create('post', {
		authorId: userId,
		title: 'mine',
	})
	const postId = String(created.id)
	const madeComment = await store.create('comment', {
		postId,
		body: 'a reply, with no owner column of its own',
	})
	await store.create('attachment', {
		commentId: String(madeComment.id),
		filename: 'two-hops-away.png',
	})
	await store.create('audit_entry', { userId, action: 'post.create' })
	await store.create('tag', { name: 'global' })
	return { postId }
}

describe('the relation graph is derived, not hand-listed', () => {
	it('finds the many-to-one edges from the registry', () => {
		expect(relationEdges(registry)).toEqual(
			expect.arrayContaining([
				{ from: 'comment', column: 'postId', to: 'post' },
				{ from: 'attachment', column: 'commentId', to: 'comment' },
			]),
		)
	})

	it('orders deletion children-before-parents', () => {
		const { order, cycles } = deletionOrder(registry)
		expect(cycles).toEqual([])
		expect(order.indexOf('attachment')).toBeLessThan(order.indexOf('comment'))
		expect(order.indexOf('comment')).toBeLessThan(order.indexOf('post'))
	})
})

describe('an unclassified table is a hard failure', () => {
	it('refuses to export when any table is unclassified, naming it', async () => {
		const partial = POLICIES.filter((p) => p.resource !== 'comment')
		await expect(
			exportUserData({ registry, store, policies: partial }, 'u1'),
		).rejects.toBeInstanceOf(RetentionCoverageError)
		await expect(
			exportUserData({ registry, store, policies: partial }, 'u1'),
		).rejects.toThrow(/comment/)
	})

	it('refuses to erase when any table is unclassified', async () => {
		const partial = POLICIES.filter((p) => p.resource !== 'attachment')
		await expect(
			eraseUserData({ registry, store, policies: partial }, 'u1', 'u1'),
		).rejects.toBeInstanceOf(RetentionCoverageError)
	})

	it('refuses a classification that is a claim without an author', () => {
		expect(
			retentionPolicyErrors([{ resource: 'tag', class: 'operational' }]).join(),
		).toMatch(/no reason/)
		expect(
			retentionPolicyErrors([
				{ resource: 'audit_entry', class: 'legal-hold' },
			]).join(),
		).toMatch(/no basis/)
		expect(
			retentionPolicyErrors([
				{ resource: 'audit_entry', class: 'legal-hold', basis: 'statute' },
			]).join(),
		).toMatch(/names no columns to pseudonymize/)
	})

	it('accepts a fully classified registry', () => {
		expect(() => assertRetentionCoverage(registry, POLICIES)).not.toThrow()
	})
})

describe('completeness — the thing a hand-listed flow gets wrong', () => {
	it('EXPORTS a row two relation hops from the subject, with no owner column', async () => {
		await seedSubject('u1')
		const dump = await exportUserData(
			{ registry, store, policies: POLICIES },
			'u1',
		)
		expect(dump.resources.post).toHaveLength(1)
		// The owner-column-only flow missed both of these entirely.
		expect(dump.resources.comment).toHaveLength(1)
		expect(dump.resources.attachment).toHaveLength(1)
		expect(dump.viaRelation).toEqual(['attachment', 'comment'])
		// An operational table is not somebody's personal data.
		expect(dump.resources.tag).toBeUndefined()
		// A legal-hold table IS exported: the subject may see a record being
		// retained about them, even though erasure will not delete it.
		expect(dump.resources.audit_entry).toHaveLength(1)
		expect(dump.legalHold).toEqual(['audit_entry'])
	})

	it('ERASES those rows too — asserted against the store, not the report', async () => {
		await seedSubject('u1')
		await eraseUserData({ registry, store, policies: POLICIES }, 'u1', 'u1')
		// The report is written by the code under test, so the store is the
		// witness that matters.
		expect(await store.list('post', {})).toHaveLength(0)
		expect(await store.list('comment', {})).toHaveLength(0)
		expect(await store.list('attachment', {})).toHaveLength(0)
	})

	it('does not touch another subject’s rows on the way through the graph', async () => {
		await seedSubject('u1')
		const other = await store.create('post', {
			authorId: 'u2',
			title: 'not mine',
		})
		await store.create('comment', {
			postId: String(other.id),
			body: 'someone else’s reply',
		})
		await eraseUserData({ registry, store, policies: POLICIES }, 'u1', 'u1')
		expect(await store.list('post', {})).toHaveLength(1)
		expect(await store.list('comment', {})).toHaveLength(1)
	})

	it('leaves an operational table alone', async () => {
		await seedSubject('u1')
		await eraseUserData({ registry, store, policies: POLICIES }, 'u1', 'u1')
		expect(await store.list('tag', {})).toHaveLength(1)
	})
})

describe('legal hold — the audit-log conflict', () => {
	it('retains the row and replaces the subject identifier', async () => {
		await seedSubject('u1')
		const report = await eraseUserData(
			{ registry, store, policies: POLICIES },
			'u1',
			'u1',
		)
		const rows = await store.list('audit_entry', {})
		expect(rows).toHaveLength(1)
		// The trail still says somebody did this — which is what makes it useful —
		// and no longer says who.
		expect(rows[0]?.userId).toBe(ERASED_SUBJECT)
		expect(rows[0]?.action).toBe('post.create')
		expect(report.pseudonymized).toEqual(['audit_entry'])
		expect(
			report.entries.find((e) => e.resource === 'audit_entry'),
		).toMatchObject({ erased: 0, retained: 1 })
	})
})
