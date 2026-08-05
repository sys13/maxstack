/**
 * Fidelity fixture — a scaled-down stand-in for specbase's ~90-table stress set
 * (sprout.md §9). A CRM-shaped schema exercising every introspection path:
 * enums, inline FKs across many tables, uuid/text/number/boolean/date/json
 * columns, defaults, and heavy `withMeta`. The gate: introspect ALL of these
 * without error and resolve every FK.
 *
 * TODO(phase-0-followup): port the real specbase `database/gtm/schema.ts`
 * (89 tables) as the full fidelity gate before declaring Sprout done.
 */

import type { PgTable } from 'drizzle-orm/pg-core'
import {
	boolean,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { withMeta } from '../sprout/schema-builder.ts'

const ts = () => timestamp('createdAt').notNull().defaultNow()

export const orgTypeEnum = pgEnum('org_type', [
	'prospect',
	'customer',
	'partner',
])
export const dealStageEnum = pgEnum('deal_stage', [
	'lead',
	'qualified',
	'won',
	'lost',
])
export const activityKindEnum = pgEnum('activity_kind', [
	'call',
	'email',
	'meeting',
])

export const org = pgTable('org', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: withMeta(text('name'), { label: 'Name', required: true }).notNull(),
	type: withMeta(orgTypeEnum('type'), { label: 'Type' })
		.notNull()
		.default('prospect'),
	website: withMeta(text('website'), { format: 'url' }),
	createdAt: ts(),
})

export const contact = pgTable('contact', {
	id: uuid('id').primaryKey().defaultRandom(),
	orgId: uuid('orgId').references(() => org.id, { onDelete: 'cascade' }),
	email: withMeta(text('email'), { format: 'email', required: true }).notNull(),
	firstName: text('firstName').notNull(),
	lastName: text('lastName'),
	createdAt: ts(),
})

export const deal = pgTable('deal', {
	id: uuid('id').primaryKey().defaultRandom(),
	orgId: uuid('orgId').references(() => org.id, { onDelete: 'cascade' }),
	ownerId: uuid('ownerId').references(() => teamMember.id),
	stage: dealStageEnum('stage').notNull().default('lead'),
	amount: numeric('amount', { precision: 12, scale: 2 }),
	closed: boolean('closed').notNull().default(false),
	createdAt: ts(),
})

export const teamMember = pgTable('team_member', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	email: withMeta(text('email'), { format: 'email' }).notNull(),
	createdAt: ts(),
})

export const activity = pgTable('activity', {
	id: uuid('id').primaryKey().defaultRandom(),
	dealId: uuid('dealId').references(() => deal.id, { onDelete: 'cascade' }),
	contactId: uuid('contactId').references(() => contact.id),
	kind: activityKindEnum('kind').notNull(),
	notes: withMeta(text('notes'), { markdown: true }),
	minutes: integer('minutes'),
	metadata: jsonb('metadata'),
	createdAt: ts(),
})

export const note = pgTable('note', {
	id: uuid('id').primaryKey().defaultRandom(),
	orgId: uuid('orgId').references(() => org.id),
	authorId: uuid('authorId').references(() => teamMember.id),
	body: withMeta(text('body'), { markdown: true, required: true }).notNull(),
	createdAt: ts(),
})

export const tag = pgTable('tag', {
	id: uuid('id').primaryKey().defaultRandom(),
	label: text('label').notNull(),
})

export const orgTag = pgTable('org_tag', {
	id: uuid('id').primaryKey().defaultRandom(),
	orgId: uuid('orgId').references(() => org.id, { onDelete: 'cascade' }),
	tagId: uuid('tagId').references(() => tag.id, { onDelete: 'cascade' }),
})

export const task = pgTable('crm_task', {
	id: uuid('id').primaryKey().defaultRandom(),
	dealId: uuid('dealId').references(() => deal.id),
	assigneeId: uuid('assigneeId').references(() => teamMember.id),
	title: withMeta(text('title'), { required: true, maxLength: 200 }).notNull(),
	done: boolean('done').notNull().default(false),
	createdAt: ts(),
})

export const emailTemplate = pgTable('email_template', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	subject: text('subject').notNull(),
	body: withMeta(text('body'), { markdown: true, rows: 12 }).notNull(),
})

export const attachment = pgTable('attachment', {
	id: uuid('id').primaryKey().defaultRandom(),
	activityId: uuid('activityId').references(() => activity.id, {
		onDelete: 'cascade',
	}),
	file: withMeta(text('file'), { isFile: true, fileAccept: 'application/pdf' }),
	sizeBytes: integer('sizeBytes'),
})

export const FIXTURE_TABLES: { table: PgTable; expectedFks: number }[] = [
	{ table: org, expectedFks: 0 },
	{ table: contact, expectedFks: 1 },
	{ table: deal, expectedFks: 2 },
	{ table: teamMember, expectedFks: 0 },
	{ table: activity, expectedFks: 2 },
	{ table: note, expectedFks: 2 },
	{ table: tag, expectedFks: 0 },
	{ table: orgTag, expectedFks: 2 },
	{ table: task, expectedFks: 2 },
	{ table: emailTemplate, expectedFks: 0 },
	{ table: attachment, expectedFks: 1 },
]
