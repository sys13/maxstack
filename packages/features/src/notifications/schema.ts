/**
 * Notification schema — one row per *delivery*, plus one row per *digest
 * window*.
 *
 * Two things changed in issue #184, both for the same reason: delivery is
 * at-least-once, so every write here has to be a claim somebody can lose the
 * race for.
 *
 * - `notification` is now the delivery record rather than the inbox row. It is
 *   written even when the recipient has the inbox off (`in_app = false`), so a
 *   redelivery has something to collide with; `(user_id, dedupe_key)` is unique,
 *   which is what makes "a duplicate must never produce a duplicate email" a
 *   constraint rather than an intention. `emailed` distinguishes a claim that
 *   has been mailed from one that has not, so a retry of a run that died before
 *   sending still sends.
 * - `notification_digest` claims one (user, window) pair before a digest is
 *   rendered. Two workers that pick up the same digest job both try to insert;
 *   one wins and mails, the other sees the claim and stops.
 *
 * `subject_resource` / `subject_id` name the row a notification is *about*, so
 * delivery can re-check that the recipient may still read it — the content-leak
 * gate. They are nullable: a notification about nothing in particular ("your
 * export is ready") claims no row and is never filtered.
 */

import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const notification = pgTable('notification', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	type: text('type').notNull(),
	title: text('title').notNull(),
	body: text('body').notNull(),
	url: text('url'),
	/** How the *email* for this delivery is routed. `none` means no email at
	 * all for this recipient — the in-app row still exists. */
	category: text('category').notNull().$type<'immediate' | 'digest' | 'none'>(),
	/** Whether this delivery is visible in the inbox. */
	inApp: boolean('in_app').notNull().default(true),
	read: boolean('read').notNull().default(false),
	emailed: boolean('emailed').notNull().default(false),
	/** Caller-supplied idempotency key, unique per user. Defaults to the row id
	 * when the caller has none, so unrelated events never collide. */
	dedupeKey: text('dedupe_key').notNull(),
	subjectResource: text('subject_resource'),
	subjectId: text('subject_id'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
})

/** One claimed digest window per user. `sent_at` is null between claiming and
 * mailing — the state a crashed run leaves behind, and the only state in which
 * a retry is allowed to send. */
export const notificationDigest = pgTable('notification_digest', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	/** `2026-07-27` for a daily window, `2026-W30` for a weekly one. */
	windowKey: text('window_key').notNull(),
	itemCount: integer('item_count').notNull().default(0),
	claimedAt: timestamp('claimed_at').notNull().defaultNow(),
	sentAt: timestamp('sent_at'),
})

/**
 * One statement per entry (some callers can only run a single statement per
 * query); {@link NOTIFICATIONS_DDL} is the joined form for `exec`.
 *
 * Idempotent throughout, so it is safe on every boot — the same posture
 * `PREFERENCES_DDL` takes.
 *
 * **Order is load-bearing**, and this is the thing a fresh-database test cannot
 * see. A project created before issue #184 already has a `notification` table,
 * so `CREATE TABLE IF NOT EXISTS` does nothing at all and every new column is
 * still missing — the same trap #187 hit with `user_preference`. So the create
 * statements are followed by additive `ALTER`s and a backfill, and only then by
 * the unique index that needs `dedupe_key` to exist. Run in the other order (or
 * with the migration in the *caller*, as this first shipped), the index fails on
 * an old database and takes the whole page down with it.
 */
export const NOTIFICATIONS_DDL_STATEMENTS: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS notification (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  url text,
  category text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  read boolean NOT NULL DEFAULT false,
  emailed boolean NOT NULL DEFAULT false,
  dedupe_key text NOT NULL,
  subject_resource text,
  subject_id text,
  created_at timestamp NOT NULL DEFAULT now()
)`,
	`CREATE TABLE IF NOT EXISTS notification_digest (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  window_key text NOT NULL,
  item_count integer NOT NULL DEFAULT 0,
  claimed_at timestamp NOT NULL DEFAULT now(),
  sent_at timestamp
)`,
	// --- upgrade a pre-#184 table in place; no-ops on a fresh one ---
	`ALTER TABLE IF EXISTS notification ADD COLUMN IF NOT EXISTS in_app boolean NOT NULL DEFAULT true`,
	`ALTER TABLE IF EXISTS notification ADD COLUMN IF NOT EXISTS dedupe_key text`,
	`ALTER TABLE IF EXISTS notification ADD COLUMN IF NOT EXISTS subject_resource text`,
	`ALTER TABLE IF EXISTS notification ADD COLUMN IF NOT EXISTS subject_id text`,
	// An existing row's own id is a dedupe key nothing else will collide with.
	`UPDATE notification SET dedupe_key = id WHERE dedupe_key IS NULL`,
	// `transactional` was the old word for "email it now".
	`UPDATE notification SET category = 'immediate' WHERE category = 'transactional'`,
	// Backfilled, so this can be enforced now. A nullable dedupe_key would be a
	// silent hole in the constraint below: nulls do not conflict with each other.
	`ALTER TABLE notification ALTER COLUMN dedupe_key SET NOT NULL`,
	// --- the constraints, last, because they need the columns above ---
	// The duplicate-suppression constraint. Everything else in this feature is a
	// policy that can be reasoned about; this is the one line that makes a second
	// delivery attempt physically unable to become a second email.
	`CREATE UNIQUE INDEX IF NOT EXISTS notification_user_dedupe_key
  ON notification (user_id, dedupe_key)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS notification_digest_user_window
  ON notification_digest (user_id, window_key)`,
]

/** Idempotent DDL for both tables, including the in-place upgrade of a pre-#184
 * table. Safe to run on every boot, on a fresh or an existing database. */
export const NOTIFICATIONS_DDL = `${NOTIFICATIONS_DDL_STATEMENTS.join(';\n')};\n`

/**
 * The `notification` table as it stood before issue #184 — kept so the upgrade
 * path is testable rather than asserted. `NOTIFICATIONS_DDL` run over a database
 * in this shape must produce the current one.
 */
export const NOTIFICATIONS_DDL_PRE_184 = `
CREATE TABLE notification (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  url text,
  category text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  emailed boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);
`
