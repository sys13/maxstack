/**
 * Audit-log core — the reimplemented, db-agnostic seam of mxscratchpad's
 * `metrics.ts`. The original `metrics.ts` bundled two concerns: an audit-log
 * writer (`createAuditLog`) and a family of count/trend aggregations, both
 * hard-wired to a `~/utils/db.server` singleton and the app's full schema
 * (user/session/project/task/auditLog) — glue that doesn't exist in this repo.
 *
 * Per the prime directive the metrics *aggregations* are deferred; what
 * reimplements cleanly and is needed now is the audit sink, so the member service can record
 * mutations without importing a mailer or a full app schema. `AuditSink` is the
 * narrow contract; `createDrizzleAuditSink` is the drizzle-backed core.
 */

/**
 * Where the caller came from. `userId` alone answers *who*; this
 * answers *through what*, which is the difference between "the owner edited
 * that row" and "a script holding the owner's credentials edited that row".
 * Mirrors core's `IdentityOrigin` — restated rather than imported, because
 * features depends on core and not the reverse for exactly this kind of
 * four-literal union.
 */
export type AuditOrigin =
	| 'session'
	| 'api-key'
	| 'mcp'
	| 'system'
	/**
	 * A declared portal — a write from outside the app entirely.
	 * The most important of the five to be able to see in a log, because it is
	 * the only one where the actor may never have had an account: the entry's
	 * `userId` reads `portal:<key>:<credential>`, which names the exact link to
	 * revoke.
	 */
	| 'portal'

/** A single audit entry, matching the original `createAuditLog` payload plus
 * #186's attribution fields. */
export interface AuditEntry {
	userId: string
	action: string
	resource: string
	resourceId?: string
	/** Optional on the entry so a service writing directly (rather than through
	 * an op) is not forced to invent one; the ops layer always stamps it. */
	origin?: AuditOrigin
	/** The api key that made the call, when `origin` is `'api-key'`. */
	apiKeyId?: string
	/**
	 * The organization the write happened in, when the identity had
	 * one. Mirrors core's `OpAuditEntry.orgId` for the reason {@link AuditOrigin}
	 * is restated rather than imported.
	 *
	 * Its consumer is work that the write *triggers*: a sink runs after the
	 * commit, in a process that no longer holds the request the active org was
	 * resolved from, so an entry that does not carry the tenant is an entry no
	 * background follow-up can act in.
	 */
	orgId?: string
	/**
	 * The declared source whose run performed this write, when one
	 * did — the structural form of "this write is a source's own output", which
	 * the enrichment trigger needs in order not to enrich its own output forever.
	 * Absent on every write a person, an api key, an agent or any other
	 * background writer makes.
	 */
	sourceKey?: string
	metadata?: Record<string, unknown>
	ipAddress?: string
	userAgent?: string
}

/** Where audit entries go. Injected into services so they stay db-agnostic. */
export type AuditSink = (entry: AuditEntry) => Promise<void>

/** A stored entry — an `AuditEntry` stamped with the time it was written. What a
 * reader hands back and a history feed renders. */
export interface StoredAuditEntry extends AuditEntry {
	/** ISO-8601 timestamp of when the entry was recorded. */
	createdAt: string
}

/** Narrow a stored feed to one resource / record, most-recent first. */
export interface AuditQuery {
	resource?: string
	resourceId?: string
	/** Cap the number returned (after ordering); omit for all matches. */
	limit?: number
}

/** Reads back audit entries — the dual of `AuditSink`. Powers a per-record
 * activity feed (`resource` + `resourceId`). */
export type AuditReader = (query?: AuditQuery) => Promise<StoredAuditEntry[]>

/** Pure filter+order over a stored feed: matches `resource`/`resourceId` when
 * given, orders most-recent first, applies `limit`. Extracted so it's testable
 * without a sink and reusable by any backing store. */
export function queryAuditEntries(
	entries: readonly StoredAuditEntry[],
	query: AuditQuery = {},
): StoredAuditEntry[] {
	const matched = entries.filter(
		(e) =>
			(query.resource === undefined || e.resource === query.resource) &&
			(query.resourceId === undefined || e.resourceId === query.resourceId),
	)
	// Insertion order is chronological; reverse for most-recent-first (stable even
	// when two entries share a millisecond timestamp).
	matched.reverse()
	return query.limit === undefined ? matched : matched.slice(0, query.limit)
}

/** Columns a drizzle audit-log table must expose for the sink to write to it.
 *
 * `orgId` and `sourceKey` are optional because they arrived with the `audit`
 * bundle's 0.3.0 schema: a table materialized before it has neither, and the sink
 * probes for them rather than requiring them (see {@link createDrizzleAuditSink}).
 */
export interface AuditLogTable {
	userId: unknown
	action: unknown
	resource: unknown
	resourceId: unknown
	origin: unknown
	apiKeyId: unknown
	metadata: unknown
	ipAddress: unknown
	userAgent: unknown
	createdAt: unknown
	orgId?: unknown
	sourceKey?: unknown
}

interface InsertableDb {
	insert: (table: unknown) => {
		values: (row: Record<string, unknown>) => Promise<unknown>
	}
}

/** Whether the caller's table object exposes a column of this name. A drizzle
 * table's columns are its own enumerable properties, so presence is the honest
 * question to ask — and the only one available, since this module deliberately
 * does not import drizzle to introspect a schema. */
function hasColumn(table: unknown, name: string): boolean {
	return typeof table === 'object' && table !== null && name in table
}

/**
 * A drizzle-backed audit sink. Serializes `metadata` to JSON (as the original
 * did) and stamps `createdAt`. Table/column names are the caller's — pass the
 * drizzle table object.
 *
 * ## Why `orgId` and `sourceKey` are probed rather than always written
 *
 * Both arrived after the `audit` bundle's first release,
 * so {@link AuditLogTable} is a contract with tables that already exist in
 * deployments: writing a column a caller's table does not have would turn every
 * audited mutation into a failed insert, which is why they used to be dropped
 * here outright. Dropping them was the wrong half of the trade — the two fields
 * that say *which tenant a write happened in* and *which source produced it* were
 * readable in-process and absent from the only copy that survives the process, so
 * the persisted trail could not answer either question after the fact.
 *
 * The column is included when the table has it and omitted when it does not, so a
 * pre-0.3.0 `audit_log` inserts exactly what it always did and an upgraded one
 * persists the attribution. Presence, not configuration: a flag would be a second
 * thing to keep in step with the schema, and the schema is already the answer.
 */
export function createDrizzleAuditSink(
	db: InsertableDb,
	table: unknown,
): AuditSink {
	return async (entry) => {
		await db.insert(table).values({
			userId: entry.userId,
			action: entry.action,
			resource: entry.resource,
			resourceId: entry.resourceId ?? null,
			origin: entry.origin ?? null,
			apiKeyId: entry.apiKeyId ?? null,
			metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
			ipAddress: entry.ipAddress ?? null,
			userAgent: entry.userAgent ?? null,
			...(hasColumn(table, 'orgId') ? { orgId: entry.orgId ?? null } : {}),
			...(hasColumn(table, 'sourceKey')
				? { sourceKey: entry.sourceKey ?? null }
				: {}),
			createdAt: new Date(),
		})
	}
}

/**
 * An in-memory audit sink that collects entries — useful as a test double, and
 * (as a process-lifetime singleton) enough to back a live history feed without a
 * dedicated table. It's also a reader: `query(...)` filters/orders the collected
 * entries. Each write is stamped with `createdAt` at collection time.
 */
export function createMemoryAuditSink(): AuditSink & {
	entries: StoredAuditEntry[]
	query: AuditReader
} {
	const entries: StoredAuditEntry[] = []
	const sink: AuditSink = async (entry) => {
		entries.push({ ...entry, createdAt: new Date().toISOString() })
	}
	const query: AuditReader = async (q) => queryAuditEntries(entries, q)
	return Object.assign(sink, { entries, query })
}
