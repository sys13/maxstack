/**
 * Admin metrics aggregations — the slice `metrics.ts` deferred to a reference
 * spec (`docs/reference-specs/metrics.md`) in task 5, now reimplemented against
 * the canonical stack. The original was sqlite-specific and hard-wired to a
 * `~/utils/db.server` singleton; this is a db-agnostic set of count/trend queries
 * over the tables the auth + audit bundles materialize:
 *
 *   - `"user"`      — better-auth's identity table (snake_case columns:
 *                     `created_at`, `email_verified`, `role`).
 *   - `"session"`   — better-auth sessions (`user_id`, `created_at`).
 *   - `"audit_log"` — the audit bundle's from-spec table (quoted camelCase
 *                     columns: `"createdAt"`, `"userId"`, …).
 *
 * Invariants preserved from the reference spec: trends grouped by calendar day
 * ascending via `date_trunc('day', …)` (NOT the original's sqlite
 * `date(createdAt/1000,'unixepoch')`); active-today = distinct session user-ids
 * in the last 24h; windows week=7d / month=30d / day=24h; count queries guard the
 * empty result. Runs on Postgres and pglite unchanged (same wire protocol).
 *
 * Deferred (documented in the design as build-vs-deferred): a charts/trends
 * visual dashboard — the `/metrics` route renders these numbers as a plain table.
 */

/** The minimal query surface both pglite (`client.query`) and a postgres adapter
 * satisfy: run a SQL string, get typed rows back. */
export interface MetricsDb {
	query(sql: string): Promise<{ rows: Record<string, unknown>[] }>
}

export interface UserMetrics {
	total: number
	newThisWeek: number
	newThisMonth: number
	verified: number
	admins: number
	activeToday: number
}

export interface SystemMetrics {
	auditLogCount: number
	sessionCount: number
}

export interface ActivityTrend {
	/** Calendar day, `YYYY-MM-DD`. */
	day: string
	count: number
}

/** Coerce a `count(*)::int` cell to a number, guarding null/empty (`?.count ?? 0`). */
function count(rows: Record<string, unknown>[]): number {
	const value = rows[0]?.count
	return value == null ? 0 : Number(value)
}

async function scalar(db: MetricsDb, sql: string): Promise<number> {
	const { rows } = await db.query(sql)
	return count(rows)
}

/** User counts: total, new-this-week/month, verified, admins, active-today. */
export async function getUserMetrics(db: MetricsDb): Promise<UserMetrics> {
	const [total, newThisWeek, newThisMonth, verified, admins, activeToday] =
		await Promise.all([
			scalar(db, `SELECT count(*)::int AS count FROM "user"`),
			scalar(
				db,
				`SELECT count(*)::int AS count FROM "user" WHERE "created_at" >= now() - interval '7 days'`,
			),
			scalar(
				db,
				`SELECT count(*)::int AS count FROM "user" WHERE "created_at" >= now() - interval '30 days'`,
			),
			scalar(
				db,
				`SELECT count(*)::int AS count FROM "user" WHERE "email_verified" = true`,
			),
			scalar(
				db,
				`SELECT count(*)::int AS count FROM "user" WHERE "role" = 'admin'`,
			),
			scalar(
				db,
				`SELECT count(DISTINCT "user_id")::int AS count FROM "session" WHERE "created_at" >= now() - interval '24 hours'`,
			),
		])
	return { total, newThisWeek, newThisMonth, verified, admins, activeToday }
}

/** System counts over the audit + session tables. */
export async function getSystemMetrics(db: MetricsDb): Promise<SystemMetrics> {
	const [auditLogCount, sessionCount] = await Promise.all([
		scalar(db, `SELECT count(*)::int AS count FROM "audit_log"`),
		scalar(db, `SELECT count(*)::int AS count FROM "session"`),
	])
	return { auditLogCount, sessionCount }
}

/** User registrations grouped by calendar day, ascending. */
export async function getUserRegistrationTrends(
	db: MetricsDb,
): Promise<ActivityTrend[]> {
	const { rows } = await db.query(
		`SELECT to_char(date_trunc('day', "created_at"), 'YYYY-MM-DD') AS day, count(*)::int AS count
		 FROM "user"
		 GROUP BY 1
		 ORDER BY 1 ASC`,
	)
	return rows.map((r) => ({ day: String(r.day), count: Number(r.count) }))
}

/** The most recent audit-log entries, newest first. */
export async function getRecentAuditLogs(
	db: MetricsDb,
	limit = 20,
): Promise<Record<string, unknown>[]> {
	const n = Math.max(1, Math.min(200, Math.floor(limit)))
	const { rows } = await db.query(
		`SELECT * FROM "audit_log" ORDER BY "createdAt" DESC LIMIT ${n}`,
	)
	return rows
}
