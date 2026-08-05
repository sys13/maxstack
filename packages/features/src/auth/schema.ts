/**
 * better-auth's canonical four tables (user / session / account / verification)
 * plus the `twoFactor` plugin table, as drizzle pg-core tables, with the
 * idempotent DDL that materializes them.
 *
 * The columns mirror `getAuthTables()` from `@better-auth/core` exactly (verified
 * against better-auth 1.6.x) with one platform-level addition: a `role` column on
 * `user`, declared to better-auth as a non-input `additionalField` (see
 * {@link authUserAdditionalFields}) so it is persisted but never client-settable.
 * `role` is what the Sprout permission layer reads (`admin` ⇒ admin, anything
 * else ⇒ member) — this is the bridge from auth identity to RBAC.
 *
 * The DDL is `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`, matching
 * the additive, re-runnable style of the spec→Sprout schema (`from-spec.ts`), so
 * it is safe to apply on every boot against a live pglite or Postgres database.
 */

import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** The extra `user` field better-auth must know about (persisted, not input). */
export const authUserAdditionalFields = {
	role: {
		type: 'string' as const,
		required: false,
		defaultValue: 'member',
		input: false,
	},
}

const timestamps = {
	createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
}

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('email_verified').notNull().default(false),
	image: text('image'),
	role: text('role').default('member'),
	twoFactorEnabled: boolean('two_factor_enabled').default(false),
	...timestamps,
})

export const session = pgTable('session', {
	id: text('id').primaryKey(),
	expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
	token: text('token').notNull().unique(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	...timestamps,
})

export const account = pgTable('account', {
	id: text('id').primaryKey(),
	accountId: text('account_id').notNull(),
	providerId: text('provider_id').notNull(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	idToken: text('id_token'),
	accessTokenExpiresAt: timestamp('access_token_expires_at', { mode: 'date' }),
	refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
		mode: 'date',
	}),
	scope: text('scope'),
	password: text('password'),
	...timestamps,
})

export const verification = pgTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
	...timestamps,
})

/** better-auth `twoFactor` plugin table: TOTP secret + hashed backup codes. */
export const twoFactor = pgTable('two_factor', {
	id: text('id').primaryKey(),
	secret: text('secret').notNull(),
	backupCodes: text('backup_codes').notNull(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	verified: boolean('verified').default(true),
	failedVerificationCount: integer('failed_verification_count').default(0),
	lockedUntil: timestamp('locked_until', { mode: 'date' }),
})

/**
 * The drizzle schema object handed to better-auth's drizzle adapter. The
 * adapter maps each better-auth model field onto the drizzle table property of
 * the same (camelCase) name — `emailVerified` → `user.emailVerified` — so the
 * snake_case *column* names above stay an internal detail of the tables.
 */
export const authSchema = {
	user,
	session,
	account,
	verification,
	twoFactor,
}

/** Idempotent DDL for the auth tables — safe to re-run on every boot. */
export const AUTH_DDL = `
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "role" text DEFAULT 'member',
  "two_factor_enabled" boolean DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean DEFAULT false;
CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "expires_at" timestamp NOT NULL,
  "token" text NOT NULL UNIQUE,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp,
  "refresh_token_expires_at" timestamp,
  "scope" text,
  "password" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "two_factor" (
  "id" text PRIMARY KEY,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "verified" boolean DEFAULT true,
  "failed_verification_count" integer DEFAULT 0,
  "locked_until" timestamp
);
`
