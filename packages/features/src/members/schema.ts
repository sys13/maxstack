/**
 * Organization / member schema — reimplemented on the canonical stack
 * (drizzle-orm/pg-core + pglite) from mxscratchpad's sqlite `database/schema.ts`.
 * Only the four tables the member service touches are staged here (user,
 * organization, member, invitation); the original's better-auth tables
 * (session/account/verification/passkey/…) are out of scope for this feature.
 */

import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export type MemberRole = 'owner' | 'admin' | 'member'

// Column names are camelCase — identical to the field names the `members`
// bundle contributes — so these tables resolve against the same physical
// columns whether they were materialized by the bundle (from-spec derives
// `"organizationId"`/`"createdAt"` columns from the field names) or by the
// owned-code fallback DDL below. See issue #91.
export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	createdAt: timestamp('createdAt').notNull().defaultNow(),
	updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const organization = pgTable('organization', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').unique(),
	logo: text('logo'),
	createdAt: timestamp('createdAt').notNull().defaultNow(),
	updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const member = pgTable('member', {
	id: text('id').primaryKey(),
	organizationId: text('organizationId')
		.notNull()
		.references(() => organization.id, { onDelete: 'cascade' }),
	userId: text('userId')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	role: text('role').$type<MemberRole>().notNull(),
	createdAt: timestamp('createdAt').notNull().defaultNow(),
	updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const invitation = pgTable('invitation', {
	id: text('id').primaryKey(),
	organizationId: text('organizationId')
		.notNull()
		.references(() => organization.id, { onDelete: 'cascade' }),
	email: text('email').notNull(),
	role: text('role').$type<'admin' | 'member'>().notNull(),
	status: text('status').notNull(),
	inviterId: text('inviterId')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	expiresAt: timestamp('expiresAt').notNull(),
	createdAt: timestamp('createdAt').notNull().defaultNow(),
	updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

/** DDL to materialize the member schema in a fresh pglite database. */
export const MEMBERS_DDL = `
CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE,
  logo text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE member (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE invitation (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  "inviterId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
`

export type User = typeof user.$inferSelect
export type Organization = typeof organization.$inferSelect
export type Member = typeof member.$inferSelect
export type Invitation = typeof invitation.$inferSelect
