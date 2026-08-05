/**
 * Preference storage (task 55, generalized in issue #187) — one row per *set*
 * value, per scope.
 *
 * The original table was one row per user with a column per preference
 * (`email_notifications`, `product_updates`, …). That shape makes adding a
 * preference a migration, makes an organization-level default impossible
 * without a parallel table, and cannot express the difference between "the user
 * chose false" and "the user has not chosen" — which is exactly the distinction
 * an org default needs. Key/value per scope expresses all three, and the type
 * safety the column shape bought is recovered from the declarations in
 * `definitions.ts`, where it is enforced on read *and* write.
 *
 * `value` is `jsonb` rather than `text` so a stored `false` survives the round
 * trip as a boolean instead of the string `"false"` — the classic settings bug
 * where every preference reads as truthy.
 */

import {
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from 'drizzle-orm/pg-core'

export const userPreference = pgTable(
	'user_preference',
	{
		userId: text('user_id').notNull(),
		key: text('key').notNull(),
		value: jsonb('value').notNull(),
		updatedAt: timestamp('updated_at').notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.key] })],
)

export const organizationPreference = pgTable(
	'organization_preference',
	{
		organizationId: text('organization_id').notNull(),
		key: text('key').notNull(),
		value: jsonb('value').notNull(),
		updatedAt: timestamp('updated_at').notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.key] })],
)

/**
 * Idempotent DDL for both scopes, one statement each. Kept as separate
 * statements because the migration below replays them through a runner that
 * may only accept one at a time (pglite's `query` refuses a multi-statement
 * string); {@link PREFERENCES_DDL} is the joined form for `exec`.
 */
export const PREFERENCES_DDL_STATEMENTS: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS user_preference (
  user_id text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
)`,
	`CREATE TABLE IF NOT EXISTS organization_preference (
  organization_id text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
)`,
]

/** Idempotent DDL for both scopes. Safe to run on every boot. */
export const PREFERENCES_DDL = `${PREFERENCES_DDL_STATEMENTS.join(';\n')};\n`

/**
 * The column-per-preference table this replaces, and the key each column maps
 * to. Ordered so the migration below reads like the old table did.
 */
const LEGACY_COLUMNS: readonly (readonly [column: string, key: string])[] = [
	['email_notifications', 'email-notifications'],
	['in_app_notifications', 'in-app-notifications'],
	['product_updates', 'product-updates'],
]

/**
 * The minimal query surface the migration needs, satisfied by a pglite client
 * (`{ rows }`) or the platform's `backend.query` (a bare array). Structural on
 * purpose so this module needs no driver dependency; {@link rowsOf} normalizes
 * the two return shapes. One statement per call — pglite's `query` refuses a
 * multi-statement string.
 */
export type PreferenceSqlRunner = (
	query: string,
) => Promise<
	{ rows?: Record<string, unknown>[] } | Record<string, unknown>[] | unknown
>

/** The rows of either accepted result shape. */
function rowsOf(result: unknown): Record<string, unknown>[] {
	if (Array.isArray(result)) return result as Record<string, unknown>[]
	const rows = (result as { rows?: unknown })?.rows
	return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/**
 * Migrate a pre-#187 `user_preference` table: rename it aside, create the
 * key/value shape, copy each boolean column across as a row, drop the old one.
 *
 * Why this exists rather than a new table name: the old and new shapes claim
 * the same table, so `CREATE TABLE IF NOT EXISTS` would silently leave a live
 * database on the old shape and every read would fail on a missing `key`
 * column. Why it is TypeScript rather than SQL inside {@link PREFERENCES_DDL}:
 * the work is conditional on what the database already has, and expressing that
 * in SQL means a `DO $$` block — i.e. depending on plpgsql being installed.
 *
 * Every statement is a fixed string; the only data that moves does so inside
 * `INSERT … SELECT`, so no value is ever interpolated into SQL. Idempotent:
 * after the first pass the legacy table is gone and this does nothing.
 */
export async function migrateLegacyUserPreferences(
	run: PreferenceSqlRunner,
): Promise<{ copiedKeys: string[] }> {
	const columns = new Set(
		rowsOf(
			await run(
				`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_preference'`,
			),
		).map((r) => String(r.column_name ?? '')),
	)
	// Nothing to do: no table yet (the DDL will create the new shape), or the
	// table is already key/value.
	if (!columns.has('user_id') || columns.has('key')) return { copiedKeys: [] }

	const present = LEGACY_COLUMNS.filter(([column]) => columns.has(column))
	await run(`ALTER TABLE user_preference RENAME TO user_preference_legacy`)
	for (const statement of PREFERENCES_DDL_STATEMENTS) await run(statement)
	for (const [column, key] of present) {
		// `to_jsonb` keeps a boolean a boolean. `DO NOTHING` because a value the
		// user has already set under the new shape outranks a column copy — which
		// cannot happen on a first run, and is the right answer if this is a retry.
		await run(
			`INSERT INTO user_preference (user_id, key, value)
			 SELECT user_id, '${key}', to_jsonb("${column}") FROM user_preference_legacy
			 ON CONFLICT (user_id, key) DO NOTHING`,
		)
	}
	await run(`DROP TABLE user_preference_legacy`)
	return { copiedKeys: present.map(([, key]) => key) }
}
