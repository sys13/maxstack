/**
 * Jobs schema — one row per background job. `status` moves
 * `pending → running → succeeded | failed`; a failed attempt that still has
 * budget (`attempts < maxAttempts`) goes back to `pending` with `availableAt`
 * pushed out by backoff (`JobQueue`'s retry loop), so the same row is its own
 * retry history instead of spawning new rows per attempt.
 *
 * Issue #181 added the five columns that make this a durable runtime rather
 * than a queue:
 *
 *  - `idempotency_key` (**unique**) — the claim. A caller that wants
 *    at-most-one-job-for-this-thing passes a key and the database, not the
 *    application, decides who won. This is what makes a scheduler safe to run
 *    in more than one process and safe to restart mid-tick.
 *  - `run_as` — whose authority the run carries. Recorded on the row rather
 *    than resolved at handler time, so the run history answers "who did this"
 *    without re-deriving it from a schedule that may since have been edited.
 *  - `schedule_key` / `scheduled_for` — which declared schedule this run is an
 *    occurrence of, and which occurrence. Together they *are* the run history:
 *    no second table, so a job and its schedule can never disagree.
 *  - `dead_lettered_at` — when the retry budget ran out. Distinct from
 *    `status = 'failed'` so "needs a human" is a column rather than a predicate
 *    someone has to remember.
 */

import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from 'drizzle-orm/pg-core'

export const job = pgTable(
	'job',
	{
		id: text('id').primaryKey(),
		type: text('type').notNull(),
		payload: jsonb('payload').notNull(),
		status: text('status')
			.notNull()
			.$type<'pending' | 'running' | 'succeeded' | 'failed'>(),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(3),
		/** Set on success — a handler's return value (e.g. exported CSV text). */
		result: jsonb('result'),
		/** The most recent failure's message, kept even after a successful retry
		 * clears it — read on the row while it's still `pending`/`failed`. */
		error: text('error'),
		/**
		 * The at-most-one-job claim. Unique, so two writers racing on the same
		 * occurrence resolve in the database: exactly one insert wins and the loser
		 * reads the winner's row back.
		 */
		idempotencyKey: text('idempotency_key'),
		/** Whose authority the run carries (a `ScheduleRunAs`). */
		runAs: jsonb('run_as'),
		/** The declared schedule this run belongs to, if any. */
		scheduleKey: text('schedule_key'),
		/** Which occurrence of that schedule — the fire instant, not the run time. */
		scheduledFor: timestamp('scheduled_for'),
		/** When the retry budget ran out and a human became responsible. */
		deadLetteredAt: timestamp('dead_lettered_at'),
		/** A claim (`JobStore.claimNext`) only picks up rows due now — the
		 * backoff delay lives here, not in a separate scheduler table. */
		availableAt: timestamp('available_at').notNull().defaultNow(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex('job_idempotency_key_idx').on(t.idempotencyKey),
		index('job_schedule_idx').on(t.scheduleKey, t.scheduledFor),
	],
)

/**
 * Raw, **idempotent** DDL for tests and for any caller without drizzle-kit
 * migrations wired up.
 *
 * Every statement is `IF NOT EXISTS`, including the `ALTER TABLE` steps that
 * add the #181 columns. That is not stylistic: the platform's DDL is
 * additive-only and this table already exists in projects created before those
 * columns did, so a `CREATE TABLE IF NOT EXISTS` that only describes the fresh
 * case upgrades nobody — it silently no-ops and every read of a new column then
 * fails at runtime. (The same trap #184 hit. It is spelled out here so the next
 * person adding a column to a shipped table copies the right shape.)
 */
export const JOBS_DDL = `
CREATE TABLE IF NOT EXISTS job (
  id text PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  result jsonb,
  error text,
  available_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
ALTER TABLE job ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE job ADD COLUMN IF NOT EXISTS run_as jsonb;
ALTER TABLE job ADD COLUMN IF NOT EXISTS schedule_key text;
ALTER TABLE job ADD COLUMN IF NOT EXISTS scheduled_for timestamp;
ALTER TABLE job ADD COLUMN IF NOT EXISTS dead_lettered_at timestamp;
CREATE UNIQUE INDEX IF NOT EXISTS job_idempotency_key_idx ON job (idempotency_key);
CREATE INDEX IF NOT EXISTS job_schedule_idx ON job (schedule_key, scheduled_for);
`
