/**
 * Consent schema — one append-only row per acceptance, not one row
 * per user: re-accepting a bumped `version` (new terms, a cookie-policy
 * change) writes a new row rather than overwriting the last one, so "did this
 * user accept version N" and "when did they last accept" are both answerable
 * from history, matching the audit-log's append-only shape (task 35b).
 */

import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

/** The two consent types this feature tracks. A resource could add more
 * (`marketing`, `analytics`, ...) without a schema change — `type` is `text`,
 * not an enum, on purpose. */
export type ConsentType = 'terms' | 'cookies'

export const consent = pgTable('consent', {
	id: serial('id').primaryKey(),
	userId: text('user_id').notNull(),
	type: text('type').notNull(),
	version: text('version').notNull(),
	acceptedAt: timestamp('accepted_at').notNull().defaultNow(),
})

/** Raw DDL for tests / any caller without drizzle-kit migrations wired up
 * (mirrors `preferences/schema.ts`'s idempotent copy). */
export const CONSENT_DDL = `
CREATE TABLE IF NOT EXISTS consent (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  type text NOT NULL,
  version text NOT NULL,
  accepted_at timestamp NOT NULL DEFAULT now()
);
`
