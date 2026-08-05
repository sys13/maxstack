/**
 * Webhooks schema (task 58) — a subscription per row plus a delivery log per
 * attempt. Unlike an API key's `tokenHash` (task 57), `secret` is stored
 * **plaintext**: an HMAC must be recomputed from it on every delivery, so a
 * hash-only store wouldn't let `deliver` sign a payload at all.
 */

import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from 'drizzle-orm/pg-core'

export const webhookSubscription = pgTable('webhook_subscription', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	url: text('url').notNull(),
	secret: text('secret').notNull(),
	/** `'*'` (all events) or explicit `resource.action` entries (e.g. `project.create`). */
	events: jsonb('events').notNull().$type<string[]>(),
	/**
	 * Per-resource field projections. Default-deny: a resource with
	 * no projection sends identifiers only, so adding a column to an entity can
	 * never widen an existing subscription without a human naming the field.
	 * Nullable because subscriptions predate the column.
	 */
	projections:
		jsonb('projections').$type<{ resource: string; fields: string[] }[]>(),
	active: boolean('active').notNull().default(true),
	createdAt: timestamp('created_at').notNull().defaultNow(),
})

/** One row per delivery attempt-set — the dead-letter/log a subscriber's
 * failures land in. */
export const webhookDelivery = pgTable('webhook_delivery', {
	id: text('id').primaryKey(),
	subscriptionId: text('subscription_id').notNull(),
	eventType: text('event_type').notNull(),
	payload: jsonb('payload').notNull(),
	status: text('status').notNull().$type<'success' | 'failed'>(),
	attempts: integer('attempts').notNull(),
	responseStatus: integer('response_status'),
	error: text('error'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
})

/**
 * Raw, **idempotent** DDL — `CREATE TABLE IF NOT EXISTS` plus `ADD COLUMN IF
 * NOT EXISTS` for the columns added after the table shipped. The platform's DDL
 * is additive-only, so a `CREATE TABLE` that only describes the fresh case
 * upgrades nobody: it no-ops on an existing table and every read of the new
 * column then fails at runtime.
 */
export const WEBHOOKS_DDL = `
CREATE TABLE IF NOT EXISTS webhook_subscription (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  url text NOT NULL,
  secret text NOT NULL,
  events jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id text PRIMARY KEY,
  subscription_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL,
  response_status integer,
  error text,
  created_at timestamp NOT NULL DEFAULT now()
);
ALTER TABLE webhook_subscription ADD COLUMN IF NOT EXISTS projections jsonb;
`
