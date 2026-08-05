/**
 * Flag telemetry — one row per declared flag key, recording when
 * it was last evaluated and how often.
 *
 * This table is deliberately *not* where a flag's value lives. The declaration
 * and its targeting are spec data (`@maxstack/spec`'s `FlagSpec`), reviewed and
 * diffed like everything else; making the value a database row is how flag
 * systems end up with per-environment drift nobody can reproduce. What the
 * database is good for is the thing the spec cannot know: whether anyone is
 * still asking.
 *
 * The write pattern matters as much as the shape. A row per evaluation would
 * turn every page render into an insert — the exact performance trap #187 names
 * for preferences, and just as real here. `FlagService` accumulates counters in
 * memory and upserts at most once per flush interval, so a flag evaluated ten
 * thousand times a minute costs one write.
 */

import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const flagEvaluation = pgTable('flag_evaluation', {
	/** The flag's spec `key`, not its branded id: the key is what survives a
	 * flag being removed and re-declared, and what telemetry reads. */
	key: text('key').primaryKey(),
	lastEvaluatedAt: timestamp('last_evaluated_at').notNull().defaultNow(),
	/** The most recent answer — enough to tell "nobody has it on" from
	 * "everybody does" without a second table. */
	lastResult: boolean('last_result').notNull(),
	/** Total evaluations since the flag was first seen. `bigint` because this is
	 * a per-request counter and 2³¹ is about three weeks of modest traffic. */
	evaluations: bigint('evaluations', { mode: 'number' }).notNull().default(0),
})

/** Idempotent DDL, safe to run on every boot (the composition-root pattern). */
export const FLAGS_DDL = `
CREATE TABLE IF NOT EXISTS flag_evaluation (
  key text PRIMARY KEY,
  last_evaluated_at timestamp NOT NULL DEFAULT now(),
  last_result boolean NOT NULL DEFAULT false,
  evaluations bigint NOT NULL DEFAULT 0
);
`
