/**
 * The single implementation of authorized, validated CRUD. REST handlers
 * (api.ts) and the MCP executor (mcp.ts) both wrap these — so the "enforce at
 * every layer" invariant has exactly one implementation to keep
 * correct.
 *
 * Each op resolves the resource, authorizes (with the row for row-level owner
 * checks on get/update/delete), validates create/update input against the
 * generated Zod schema, then calls the store. Failures surface as typed errors.
 */

import {
	compileDocument,
	type DocumentBlock,
	type DocumentData,
	type DocumentLayout,
	type DocumentPlan,
	MAX_DOCUMENT_TABLE_ROWS,
} from './documents.ts'
import { builtinParser, type ImportParser } from './import-parse.ts'
import {
	type ImportPlan,
	type ImportResult,
	type ImportRowPlan,
	readCell,
} from './imports.ts'
import {
	authorize,
	createAccessContext,
	type IdentityOrigin,
	PermissionError,
	type SproutAction,
	type SproutUser,
} from './permissions.ts'
import type { RegisteredResource, ResourceRegistry } from './registry.ts'
import { normalizeSearchQuery, type SearchHit } from './search.ts'
import type {
	AggregateBucket,
	AggregateQuery,
	ListOptions,
	Row,
	SproutStore,
} from './store.ts'
import { validateData } from './validation.ts'

// No constructor parameter properties in this package: the CLI runs these
// files directly under Node's strip-only type stripping, which rejects them.
export class UnknownResourceError extends Error {
	readonly resource: string

	constructor(resource: string) {
		super(`Unknown resource: ${resource}`)
		this.name = 'UnknownResourceError'
		this.resource = resource
	}
}

export class NotFoundError extends Error {
	readonly resource: string
	readonly id: string

	constructor(resource: string, id: string) {
		super(`Not found: ${resource} ${id}`)
		this.name = 'NotFoundError'
		this.resource = resource
		this.id = id
	}
}

/**
 * An operation the resource has not opted into — `opRestore` on a resource
 * without `softDelete`, say. Distinct from `NotFoundError`: the resource and
 * the row exist, the *capability* does not, and a caller that gets a 404 here
 * spends its time re-checking the id. Rendered as 422 by the REST layer.
 */
export class UnsupportedOperationError extends Error {
	readonly resource: string
	readonly operation: string

	constructor(resource: string, operation: string, reason: string) {
		super(`Cannot ${operation} ${resource}: ${reason}`)
		this.name = 'UnsupportedOperationError'
		this.resource = resource
		this.operation = operation
	}
}

/**
 * A write refused because it would push a column past its declared per-value cap
 * — a Kanban WIP limit.
 *
 * It is thrown from `opCreate`/`opUpdate` rather than from any surface, which is
 * the whole design: a limit enforced by the board is a limit an agent driving
 * REST or MCP never meets. Rendered as 422 with `fieldErrors` on the capped
 * column, so a form, a board drag and a raw API call all get the refusal in the
 * shape they already know how to display.
 */
export class LimitExceededError extends Error {
	readonly resource: string
	readonly field: string
	readonly value: string
	readonly limit: number
	readonly current: number

	constructor(
		resource: string,
		field: string,
		value: string,
		limit: number,
		current: number,
	) {
		super(
			`"${value}" is full: ${field} allows ${limit} and already holds ${current}`,
		)
		this.name = 'LimitExceededError'
		this.resource = resource
		this.field = field
		this.value = value
		this.limit = limit
		this.current = current
	}

	/** The refusal in the shape every write surface already renders. */
	get fieldErrors(): Record<string, string[]> {
		return { [this.field]: [this.message] }
	}
}

/**
 * A request refused because it exceeded a declared portal's hourly write budget
 *.
 *
 * Its own error, and thrown from `opCreate`/`opUpdate` rather than from a route,
 * for `LimitExceededError`'s reason turned outward: a budget enforced by the
 * portal route is a budget the REST and MCP surfaces never meet, and the whole
 * point of a public write path being *declared* is that every caller shares the
 * declaration. Rendered as 429.
 */
export class RateLimitedError extends Error {
	readonly resource: string
	readonly portalKey: string
	readonly limitPerHour: number

	constructor(resource: string, portalKey: string, limitPerHour: number) {
		super(
			`Too many requests: portal "${portalKey}" allows ${limitPerHour} write(s) per hour`,
		)
		this.name = 'RateLimitedError'
		this.resource = resource
		this.portalKey = portalKey
		this.limitPerHour = limitPerHour
	}
}

export class ValidationError extends Error {
	readonly fieldErrors: Record<string, string[]>
	/**
	 * The accepted contract of each rejected field, and a one-line summary
	 *. Optional because a hand-thrown refusal (a portal field the
	 * caller may not write) has field errors but no column contract behind them.
	 *
	 * These ride on the error rather than being re-derived at the REST boundary
	 * so that every surface — REST, MCP, a form post — refuses with the same
	 * words. A caller told different things by different doors learns nothing
	 * from either.
	 */
	readonly fields?: Record<string, unknown>

	constructor(
		fieldErrors: Record<string, string[]>,
		detail?: { fields?: Record<string, unknown>; summary?: string },
	) {
		// The message is the summary when there is one: an agent that only logs
		// `e.message` still gets something it can act on.
		super(detail?.summary ?? 'Validation failed')
		this.name = 'ValidationError'
		this.fieldErrors = fieldErrors
		this.fields = detail?.fields
	}
}

/** A mutation the audit sink records. Structurally the subset of
 * `@maxstack/features`'s `AuditEntry` that an op can supply — kept local so core
 * stays free of a features dependency (features depends on core, not the
 * reverse). A features `AuditSink` is assignable to `OpAuditSink`. */
export interface OpAuditEntry {
	userId: string
	action: SproutAction
	resource: string
	resourceId?: string
	/**
	 * How the identity reached us. A bare `userId` cannot tell a
	 * person clicking in the admin UI apart from a cron job running under their
	 * credentials or an agent driving MCP as them — and those are the three
	 * things you most want to separate when a row changed unexpectedly.
	 * Defaulted to `'session'` rather than left optional at the sink, so an
	 * un-stamped entry is never silently indistinguishable from a human one.
	 */
	origin: IdentityOrigin
	/** The key that made the call, when `origin` is `'api-key'` — a specific
	 * credential to revoke, not just the account that holds it. */
	apiKeyId?: string
	/**
	 * The org the write happened in, when the identity had one.
	 *
	 * Stamped so background work triggered *by* a write can inherit the tenant it
	 * happened in: the trigger fires from the audit entry, after the commit, in a
	 * process that no longer has the request the org was resolved from. Without
	 * it, work a person's own write kicks off cannot reach the rows that write
	 * just touched.
	 */
	orgId?: string
	/**
	 * The declared source whose run performed this write, when one
	 * did. Carried off {@link SproutUser.sourceKey} — see that field for why the
	 * enrichment loop guard reads this rather than `origin`.
	 */
	sourceKey?: string
	metadata?: Record<string, unknown>
}

/** Where a successful mutation is recorded. Optional on the context; when absent
 * mutations proceed unlogged (parity with the pre-audit behavior). */
export type OpAuditSink = (entry: OpAuditEntry) => void | Promise<void>

/**
 * Attaches a resource's spec-declared derived values — computed fields and
 * rollups — to rows leaving a read op. Returns the rows with the
 * derived accessors populated; a resource that declares none returns them
 * unchanged.
 *
 * It hangs off the context rather than being computed inside core because a
 * rollup is a SQL aggregate over the *child* table, and only the host knows how
 * to run raw SQL against its backend. Core owns *when* derived values are
 * attached — on the way out of every read op, so REST, MCP and the admin UI
 * cannot disagree about whether a card has a total on it — and the host owns
 * how they are computed.
 */
export type OpDerivedResolver = (
	resource: string,
	rows: readonly Row[],
) => Promise<Row[]>

/**
 * Spends one unit of a portal's declared hourly write budget,
 * returning whether the write may proceed.
 *
 * It hangs off the context for `OpDerivedResolver`'s reason — the limiter lives
 * in `@maxstack/features` and features depends on core, not the reverse — but
 * the *consequence* of it being absent is the opposite of `derived`'s. A missing
 * derived resolver means rows come back without rollups; a missing limiter means
 * **portal writes are refused outright**. That asymmetry is the design: a host
 * that forgot to wire a limiter must get no anonymous writes rather than
 * unlimited ones, and the way to guarantee that is to make the absence a
 * refusal rather than a default.
 *
 * **Asynchronous since issue #228.** A budget every instance shares is a row in
 * the database, so the answer cannot be returned synchronously. The cost lands
 * here rather than at the surfaces: `assertPortalBudget` awaits it, which puts
 * one round trip on the portal-write path and none anywhere else.
 */
export type OpRateLimiter = (
	/** Bucket key: portal key + the identity, so one caller cannot drain another's. */
	key: string,
	/** The declared budget, per hour. */
	perHour: number,
) => boolean | Promise<boolean>

/**
 * Announces that one row changed, so declared live channels can
 * fan it out to whoever is watching.
 *
 * It hangs off the context in exactly the shape `audit` and `derived` do, and
 * for the same reason: the channel registry lives in the host (one process, one
 * subscriber table) and core has no way to reach it. **A host that wires none
 * behaves exactly as it did before this layer existed** — the writes land, and
 * nothing is pushed.
 *
 * Failure is swallowed, like `audit`'s and unlike `rateLimit`'s. The asymmetry
 * is the design: a missing limiter must refuse a portal write, because the
 * absence would otherwise *grant* something. A failed fan-out grants nothing —
 * it means somebody's board is stale until they poll — and letting it surface
 * would mean a subscriber's broken socket could fail a committed write.
 */
export type OpLivePublisher = (
	resource: string,
	id: string,
) => void | Promise<void>

export interface OpContext {
	registry: ResourceRegistry
	store: SproutStore
	user: SproutUser | null
	/** Records create/update/delete after they commit. Best-effort: a throwing
	 * sink never fails the mutation. */
	audit?: OpAuditSink
	/** Populates computed fields and rollups on read. Optional:
	 * a host that wires none reads stored columns only, exactly as before. */
	derived?: OpDerivedResolver
	/**
	 * Spends a declared portal's write budget. Optional on the type
	 * and **mandatory in effect**: a portal write with no limiter wired is
	 * refused, so omitting it costs anonymous writes rather than granting them.
	 */
	rateLimit?: OpRateLimiter
	/**
	 * Announces a committed row change to the host's live channels.
	 * Optional and best-effort, on `audit`'s terms: a host that wires none pushes
	 * nothing and behaves exactly as before.
	 */
	live?: OpLivePublisher
}

/** Attach derived values to a read op's result, if the host wired a resolver.
 * Rows are returned untouched when it is absent or the page is empty. */
async function withDerived(
	ctx: OpContext,
	resource: string,
	rows: readonly Row[],
): Promise<Row[]> {
	if (!ctx.derived || rows.length === 0) return [...rows]
	return ctx.derived(resource, rows)
}

/** Emit an audit entry, swallowing sink failures so logging can never break a
 * committed mutation. */
async function record(
	ctx: OpContext,
	entry: Omit<
		OpAuditEntry,
		'userId' | 'origin' | 'apiKeyId' | 'orgId' | 'sourceKey'
	>,
): Promise<void> {
	if (!ctx.audit) return
	try {
		await ctx.audit({
			userId: ctx.user?.id ?? 'anonymous',
			origin: ctx.user?.origin ?? 'session',
			...(ctx.user?.apiKeyId ? { apiKeyId: ctx.user.apiKeyId } : {}),
			// The tenant the write happened in and the source run that performed it
			//. Both come off the identity rather than off the op,
			// because both are answers to "who wrote this" — and a trigger that fires
			// from this entry, in a process with no request and no call stack, has
			// nothing else to read them from.
			...(typeof ctx.user?.orgId === 'string' && ctx.user.orgId
				? { orgId: ctx.user.orgId }
				: {}),
			...(ctx.user?.sourceKey ? { sourceKey: ctx.user.sourceKey } : {}),
			...entry,
		})
	} catch {
		// Auditing is observational; a sink error must not surface to the caller.
	}
}

/**
 * Announce a committed change to the host's live channels, swallowing failures
 * so a fan-out can never break a committed mutation.
 *
 * Deliberately a line-for-line mirror of {@link record}: called **after** the
 * store write, `await`ed, and wrapped in a swallowing `catch`. A fan-out failure
 * — a broken socket, a subscriber whose gate now throws — must never surface to
 * the writer, who has already committed and has no way to act on it.
 *
 * **Awaiting it is safe, and that is a property of the channel rather than a
 * hope.** The fan-out is in-process and bounded by the channel's declared
 * `maxSubscribers`, and a subscriber over `maxMessagesPerMinute` is **shed
 * rather than buffered** — disconnected with a reason, on the next message. So
 * there is no queue to grow, no slow reader to wait on, and no path by which one
 * struggling client becomes a slow write: the worst case is a bounded number of
 * authorized reads, and a client that cannot keep up is dropped rather than
 * accumulated. That is the argument; if the shedding posture ever changes, this
 * call has to be reconsidered with it.
 */
async function publish(
	ctx: OpContext,
	resource: string,
	id: string,
): Promise<void> {
	if (!ctx.live) return
	try {
		await ctx.live(resource, id)
	} catch {
		// A fan-out is observational; a publisher error must not surface to the
		// caller, whose write has already committed.
	}
}

function resolve(registry: ResourceRegistry, resource: string) {
	const entry = registry.get(resource)
	if (!entry) throw new UnknownResourceError(resource)
	return entry
}

/**
 * Tenancy (d-tenancy-model): a resource with `config.tenantField` is org-scoped.
 * Resolves the active org for the request, or throws when a scoped resource is
 * touched without one — strict for every role, so a missing org context can
 * never widen into a cross-tenant read. Returns `null` for unscoped resources.
 *
 * Exported for `query.ts`, which pre-flights the tenant precondition
 * on every resource in a traversal before it reads a row. It calls *this*
 * function rather than re-reading `config.tenantField`: `tenantField` is a
 * registry fact only owned code sets, and a second reading of it is a second
 * place for the scoping rule to drift from the one the read ops enforce.
 */
export function tenantOf(
	entry: RegisteredResource,
	user: SproutUser | null,
	resource: string,
	action: SproutAction,
): { field: string; orgId: string } | null {
	const field = entry.config.tenantField
	if (!field) return null
	const orgId = user?.orgId
	if (typeof orgId !== 'string' || orgId === '')
		throw new PermissionError(resource, action)
	return { field, orgId }
}

/** Row-level tenant check for get/update/delete: a row from another org reads
 * as absent (404), never as forbidden — resource existence must not leak. */
/**
 * Refuse an id the store could never hold, as a miss rather than as a failure.
 *
 * A key that *cannot* exist and a key that *does not* exist are the same answer
 * to the caller — but they were not the same event: against Postgres a
 * malformed literal for a `uuid` primary key is rejected inside the driver, so
 * `GET /api/book/nonsense` was a 500 while `GET /api/book/<absent uuid>` was a
 * 404 (#354). #336 stopped that 500 republishing the statement; it was still a
 * 500, and a 500 tells a client to come back later about a URL that will never
 * work. So a key that cannot exist now takes the `NotFoundError` path these ops
 * already have, before any query runs.
 *
 * The *classification* is asked of the store rather than decided here, because
 * "malformed" is a fact about the schema and not about the operation: `'r1'` is
 * impossible against a `uuid` column, ordinary against a `text` one, and
 * meaningless to a store with no columns at all. `acceptsId` is optional and its
 * absence means yes, so `=== false` is load-bearing — a store that has not
 * implemented it refuses nothing, which keeps every hand-written test id and
 * every non-Postgres store working exactly as before.
 *
 * It runs before `authorize()`, deliberately: what it can distinguish is "that
 * is not the shape of a key", which is a property of the URL the caller already
 * has, and it reveals nothing about which rows exist.
 */
function assertIdCouldExist(
	store: SproutStore,
	resource: string,
	id: string,
): void {
	if (store.acceptsId?.(resource, id) === false)
		throw new NotFoundError(resource, id)
}

function assertRowInTenant(
	tenant: { field: string; orgId: string } | null,
	row: Row,
	resource: string,
	id: string,
): void {
	if (tenant && row[tenant.field] !== tenant.orgId)
		throw new NotFoundError(resource, id)
}

/** Soft delete: the fixed column name a `softDelete: true`
 * resource is expected to carry — a nullable timestamp, `null` while live.
 * Fixed (not configurable) to match `tenantField`'s "one flag, one
 * convention" shape without adding a second config knob. */
const SOFT_DELETE_FIELD = 'deletedAt'

/** Returns the soft-delete column name for a `softDelete: true` resource, or
 * `null` for a resource that hard-deletes (today's behavior, unchanged). */
function softDeleteFieldOf(entry: RegisteredResource): string | null {
	return entry.config.softDelete ? SOFT_DELETE_FIELD : null
}

/** Row-level soft-delete check for get/update: a soft-deleted row reads as
 * absent (404) unless the caller explicitly asked to see deleted rows — same
 * "existence must not leak" shape as the tenant check. */
function assertRowNotDeleted(
	softField: string | null,
	row: Row,
	resource: string,
	id: string,
	includeDeleted: boolean,
): void {
	if (softField && !includeDeleted && row[softField] != null)
		throw new NotFoundError(resource, id)
}

/**
 * Enforce the resource's declared per-value caps for one write.
 *
 * Called after validation and immediately before the store write, for creates
 * and for updates alike. Only a write that *moves* a row into a capped value is
 * checked: editing the title of a card already sitting in a full column has to
 * keep working, or a full column becomes a read-only column.
 *
 * The count is taken through the same tenant and soft-delete scoping the read
 * ops use, so a cap means "three of *your org's* rows", and a soft-deleted card
 * does not hold a slot it is no longer visibly in.
 *
 * **This is a check-then-write, not a database constraint.** Two writers racing
 * into the last slot of a column can both observe `current = limit - 1` and both
 * commit; the column ends up one over. That window is real and is documented
 * rather than papered over (`docs/board-views.md`) — closing it needs either a
 * serializable transaction around the count or a partial unique index per slot,
 * and neither is expressible in the additive DDL the spec vocabulary emits. The
 * failure mode is a column one card over its limit, which the board shows and a
 * person can fix by moving a card; it is not corruption.
 */
async function assertWithinLimits(
	ctx: OpContext,
	entry: RegisteredResource,
	resource: string,
	data: Row,
	existing: Row | null,
	tenant: { field: string; orgId: string } | null,
	softField: string | null,
): Promise<void> {
	for (const column of entry.resource.columns) {
		const limits = column.meta.valueLimits
		if (!limits) continue
		const next = data[column.name]
		// Absent from the payload = not being moved. `null` is a move *out* of
		// every capped value, which nothing caps.
		if (next === undefined || next === null) continue
		// An update that leaves the value where it is cannot fill anything.
		if (existing && existing[column.name] === next) continue
		const limit = limits[String(next)]
		if (limit === undefined) continue

		let filter: NonNullable<ListOptions['filter']> = {
			[column.name]: next as string | number | boolean,
		}
		if (softField) filter = { ...filter, [softField]: null }
		if (tenant) filter = { ...filter, [tenant.field]: tenant.orgId }
		const current = await ctx.store.count(resource, { filter })
		if (current >= limit)
			throw new LimitExceededError(
				resource,
				column.name,
				String(next),
				limit,
				current,
			)
	}
}

// ===========================================================================
// Portals — the outside, enforced at the same depth as everything
// else.
// ===========================================================================

/**
 * Rebuild each row from **only** the portal's declared columns, plus the
 * primary key.
 *
 * Applied on the way out of every read op, at the same chokepoint `withDerived`
 * uses — so REST, MCP, the admin loaders and the portal route cannot disagree
 * about what a row is. That placement is the entire security argument: a
 * projection performed in the route would be a projection three of the four
 * callers skip.
 *
 * **The primary key is always included, and that is a considered exception
 * rather than a leak.** A collection portal that returned rows with no id could
 * not link to anything, could not key a list, and could not be paginated by
 * anything but offset. Spec entities carry a `uuid` primary key (`from-spec.ts`
 * emits `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`), which encodes no
 * ordering, no timestamp and no count — so publishing one tells a reader nothing
 * except that the row exists, which the row's own presence already told them.
 * A row portal is a different case again: the reader already has the id, because
 * their token names it.
 *
 * Everything else is dropped, and the list of what "everything else" includes is
 * the part worth stating: undeclared columns, **derived values that
 * were not declared**, the soft-delete column, and the tenant column. Derived
 * values matter most because they arrive *after* the store — a rollup computed
 * over a child table is exactly the kind of value nobody remembers to think of
 * as exposed.
 */
export function projectForPortal(
	user: SproutUser | null,
	entry: RegisteredResource,
	rows: readonly Row[],
): Row[] {
	const portal = user?.portal
	if (!portal) return [...rows]
	const pk = entry.resource.primaryKey
	const allowed = new Set([pk, ...portal.readFields])
	return rows.map((row) => {
		const out: Row = {}
		for (const key of allowed) if (key in row) out[key] = row[key]
		return out
	})
}

/**
 * Refuse a read whose ordering or filtering names a column the portal does not
 * expose.
 *
 * **This is a real attack, not a tidiness rule.** `ORDER BY salary` over a
 * bounded public collection leaks the hidden column one bit at a time: the
 * caller never sees a value, but the *permutation* of the rows they can see is a
 * comparison oracle, and a few dozen requests with different page offsets
 * reconstruct the ordering exactly. An equality filter on a hidden column is the
 * blunter version of the same thing — it answers "is this row's `status` equal to
 * `flagged`?" one guess at a time.
 *
 * So both are refused rather than ignored. Ignoring an unknown `orderBy` is what
 * `store.list` does for a stale filter, and it is the right behaviour there;
 * here it would mean the leak simply stops working *silently*, which is
 * indistinguishable from it working for anybody probing.
 */
function assertPortalReadShape(
	user: SproutUser | null,
	resource: string,
	entry: RegisteredResource,
	opts: { orderBy?: string; filter?: ListOptions['filter'] },
): void {
	const portal = user?.portal
	if (!portal) return
	const visible = new Set(portal.readFields)
	if (portal.filter) visible.add(portal.filter.field)
	// The primary key is visible, because `projectForPortal` deliberately returns
	// it on every row (see its comment: a uuid encodes no ordering, no timestamp
	// and no count). Treating it as hidden here was an inconsistency between the
	// two halves of the same rule rather than a protection — filtering or
	// ordering by a value the caller is already handed back is not an oracle over
	// anything, and `opGet` already lets a portal fetch one row by id under the
	// same bound. Issue #179 needs it because the live push path resolves one
	// changed row through `opList` rather than through a second query.
	visible.add(entry.resource.primaryKey)
	if (opts.orderBy !== undefined && !visible.has(opts.orderBy))
		throw new PermissionError(resource, 'read')
	for (const key of Object.keys(opts.filter ?? {}))
		if (!visible.has(key)) throw new PermissionError(resource, 'read')
}

/**
 * The bound a portal read is forced to run under.
 *
 * Spread **last**, over any caller-supplied filter, exactly as the tenant and
 * soft-delete scopes are and for the identical reason: a caller who names the
 * bound column must not get to choose its value.
 */
function portalScope(
	user: SproutUser | null,
): Record<string, string | number | boolean> {
	const filter = user?.portal?.filter
	return filter ? { [filter.field]: filter.equals } : {}
}

/**
 * Refuse ranked search entirely for a portal identity, and this is a decision
 * rather than an omission.
 *
 * Projection cannot make search safe here. A search index is
 * declared over the field set that makes the *admin's* search useful — title at
 * weight A, body at B — and the portal's projection is a different, usually
 * narrower list. Two things then leak that no amount of row-filtering fixes:
 *
 *  - **The match predicate.** `to_tsquery` matches against the whole tsvector,
 *    so a portal could ask "which of the rows I am allowed to see contain the
 *    word `terminated` *anywhere*, including in the column I am not allowed to
 *    read", and get an answer. That is a full-text oracle over a hidden column.
 *  - **The rank.** `ts_rank` scores against the same whole tsvector, so even
 *    with the rows projected, the ORDER of the results is a function of hidden
 *    text — the same comparison-oracle shape `assertPortalReadShape` refuses for
 *    `orderBy`, arriving through a different door.
 *
 * Making it safe would need a *second* index per portal, over the projection —
 * a second declaration of the same fields, which is a second thing to drift, on
 * the one surface where drift is a disclosure. So a portal gets `opList` with
 * its ordinary substring `search` option and no ranking, and this refuses. The
 * refusal is a `PermissionError` rather than an empty result, for `opSearch`'s
 * own stated reason: "you may not" and "nothing matched" are different facts.
 */
function assertPortalMayNotSearch(
	user: SproutUser | null,
	resource: string,
): void {
	if (user?.portal) throw new PermissionError(resource, 'read')
}

/**
 * Refuse a list-shaped read under a `row`-scoped portal.
 *
 * A token minted for one invoice reaches one invoice. There is no bound that
 * would make listing correct for it — the token names a row, not a predicate —
 * so `opList`/`opGetMany` are refused entirely rather than being given an
 * `id = rowId` filter, which would work and would also be a second, quieter
 * spelling of the same capability for anybody to find later.
 */
function assertPortalMayEnumerate(
	user: SproutUser | null,
	resource: string,
): void {
	if (user?.portal?.scope === 'row') throw new PermissionError(resource, 'read')
}

/**
 * The write allowlist, applied on the way **in**.
 *
 * A payload naming a field the portal did not declare is **refused, not
 * stripped**. Silent stripping is the worse failure by a distance: the caller
 * gets a 200, believes their value landed, and finds out weeks later that it
 * never did — and an attacker probing for a privilege field learns nothing
 * either way, which sounds like a feature until you notice it means the honest
 * caller learns nothing either.
 *
 * The tenant and soft-delete columns need no mention here: `opCreate` stamps
 * both server-side after this runs, and `opUpdate` strips both unconditionally.
 * A portal cannot reach either, and it cannot reach the collection bound — the
 * spec validator refuses a write that names the filter field, and `opCreate`
 * stamps it.
 */
function assertPortalWriteShape(
	user: SproutUser | null,
	resource: string,
	action: 'create' | 'update',
	data: Row,
): void {
	const portal = user?.portal
	if (!portal) return
	const write = portal.writes.find((w) => w.action === action)
	// `portalGrants` already refused an undeclared action; this is the belt.
	if (!write) throw new PermissionError(resource, action)
	const allowed = new Set(write.fields)
	for (const key of Object.keys(data))
		if (!allowed.has(key))
			throw new ValidationError({
				[key]: [
					`"${key}" is not one of the fields this portal accepts (${write.fields.join(', ')})`,
				],
			})
}

/**
 * Spend one unit of the portal's declared hourly budget, or refuse.
 *
 * Called from `opCreate`/`opUpdate` — where the write is — rather than from any
 * surface, so a portal write path that bypasses the limiter is structurally
 * impossible: there is no other way to reach the store.
 *
 * **No limiter wired ⇒ the write is refused.** See {@link OpRateLimiter}.
 */
async function assertPortalBudget(
	ctx: OpContext,
	resource: string,
	action: 'create' | 'update',
): Promise<void> {
	const portal = ctx.user?.portal
	if (!portal) return
	const write = portal.writes.find((w) => w.action === action)
	if (!write) throw new PermissionError(resource, action)
	if (!ctx.rateLimit)
		throw new UnsupportedOperationError(
			resource,
			action,
			'this deployment has no rate limiter wired, and a declared portal write is always budgeted — refusing rather than writing unbudgeted (see OpContext.rateLimit)',
		)
	const bucket = `portal:${portal.portalKey}:${action}:${ctx.user?.id ?? 'anonymous'}`
	if (!(await ctx.rateLimit(bucket, write.rateLimitPerHour)))
		throw new RateLimitedError(
			resource,
			portal.portalKey,
			write.rateLimitPerHour,
		)
}

export async function opList(
	ctx: OpContext,
	resource: string,
	opts: ListOptions = {},
): Promise<Row[]> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	await authorize(
		resource,
		entry.config.access,
		'read',
		createAccessContext(user),
	)
	// A row-scoped portal reaches one row named by its token; listing is not a
	// narrower version of that, it is a different capability.
	assertPortalMayEnumerate(user, resource)
	// An orderBy or filter naming a column the portal does not expose is a
	// comparison oracle over a hidden column — refused, never ignored.
	assertPortalReadShape(user, resource, entry, opts)
	const tenant = tenantOf(entry, user, resource, 'read')
	const softField = softDeleteFieldOf(entry)
	// Tenant scope, the soft-delete default scope and the portal's declared bound
	// are all forced last, over any client-supplied filter — so a hostile filter
	// can never widen any of them.
	let filter = opts.filter
	if (softField && !opts.includeDeleted)
		filter = { ...filter, [softField]: null }
	if (tenant) filter = { ...filter, [tenant.field]: tenant.orgId }
	filter = { ...filter, ...portalScope(user) }
	const rows = await store.list(resource, {
		limit: opts.limit ?? 50,
		offset: opts.offset ?? 0,
		orderBy: opts.orderBy,
		orderDir: opts.orderDir,
		filter,
		range: opts.range,
		// A two-column window. It narrows like every other predicate
		// here and cannot widen: the scoping filters above are AND-ed separately.
		overlaps: opts.overlaps,
		search: opts.search,
		searchFields: opts.searchFields,
	})
	// Derived values are attached after the scoping filters, never before: a
	// rollup must aggregate over the page the caller is actually allowed to see.
	// The portal projection runs after THAT, so an undeclared rollup is dropped
	// on the way out rather than never computed — the gate is one place, and it
	// is the last one.
	return projectForPortal(user, entry, await withDerived(ctx, resource, rows))
}

/**
 * One declared `GROUP BY` over a resource — the read behind an `aggregate`
 * block (#299).
 *
 * It lives here, beside `opList`, and that placement is the entire
 * access-control argument: **an aggregate is a read of many rows.** A count is
 * a fact derived from every row the predicate matched, so a count computed
 * without the tenant scope is a cross-tenant read that happens to return a
 * number instead of rows — the leak shape that looks like a feature, and the
 * one `opSearchCount` states the same reasoning about. So this runs the
 * *identical* gate to `opList`, in the same order, with the forced scopes
 * spread **last** so nothing the caller supplies can widen them:
 *
 *  1. `authorize(..., 'read')`, so a denial is a throw rather than an empty
 *     chart a caller could tell apart by squinting.
 *  2. `assertPortalMayEnumerate` — an aggregate is enumeration with the rows
 *     summed. A row-scoped portal that could not list may not count either.
 *  3. `assertPortalReadShape` over the group, measure and filter columns: a
 *     `GROUP BY` on a hidden column is a comparison oracle over its values,
 *     and a sharper one than an `orderBy`, because it names them.
 *  4. Soft-delete, tenant and portal scopes, forced over any caller filter.
 *
 * **The group and measure columns must exist, or this throws.** That breaks the
 * `filter` rule one line above it, deliberately: an ignored filter widens a read
 * toward a cap that already applied, while an ignored `GROUP BY` returns one
 * bucket where the caller asked for twelve — a wrong number that renders
 * perfectly. There is no safe degradation of an aggregate, so there is none.
 *
 * Nothing here is request-shaped. `query` is resolved from the page's spec
 * declaration by the caller; the store turns the names into column *objects*
 * and the bucket into a bound parameter, so no client string is ever a
 * candidate for the identifier position in the SQL.
 */
export async function opAggregate(
	ctx: OpContext,
	resource: string,
	query: AggregateQuery,
	opts: ListOptions = {},
): Promise<AggregateBucket[]> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	await authorize(
		resource,
		entry.config.access,
		'read',
		createAccessContext(user),
	)
	assertPortalMayEnumerate(user, resource)
	// `orderBy` carries the grouped column through the portal's visibility check:
	// grouping by a column is at least as revealing as ordering by it.
	assertPortalReadShape(user, resource, entry, {
		orderBy: query.groupColumn,
		filter: opts.filter,
	})
	if (query.measureColumn !== undefined)
		assertPortalReadShape(user, resource, entry, {
			orderBy: query.measureColumn,
		})
	if (!store.aggregate)
		throw new UnsupportedOperationError(
			resource,
			'aggregate',
			'this store cannot group rows — refusing rather than listing a capped page and summing it, which would answer "how many" with "how many of the first 50"',
		)
	const known = new Set(entry.resource.columns.map((c) => c.name))
	for (const [label, name] of [
		['group', query.groupColumn],
		['measure', query.measureColumn],
	] as const) {
		if (name === undefined) continue
		if (!known.has(name))
			throw new ValidationError({
				[name]: [
					`"${name}" is not a column of "${resource}", so there is no ${label} to aggregate — refusing rather than dropping it, because an aggregate missing its ${label} returns a number that looks right and is not`,
				],
			})
	}
	const tenant = tenantOf(entry, user, resource, 'read')
	const softField = softDeleteFieldOf(entry)
	let filter = opts.filter
	if (softField && !opts.includeDeleted)
		filter = { ...filter, [softField]: null }
	if (tenant) filter = { ...filter, [tenant.field]: tenant.orgId }
	filter = { ...filter, ...portalScope(user) }
	return store.aggregate(resource, query, {
		filter,
		range: opts.range,
		search: opts.search,
		searchFields: opts.searchFields,
	})
}

/**
 * Ranked full-text search over one resource's declared index.
 *
 * It lives here, beside `opList`, and that placement is the whole
 * access-control argument. Search returns rows the caller never named, which is
 * exactly the shape of a leak that looks like a feature — so it passes the
 * *same* gate a list does, in the same order, with the same forced scopes:
 *
 *  1. `authorize(..., 'read')` — the api-key scope and the resource's own rule.
 *     Denied is a throw, never an empty result, so a caller cannot tell "you may
 *     not read this" from "nothing matched" by counting.
 *  2. The tenant and soft-delete scopes are forced **after** any caller filter,
 *     so nothing in the search half can widen them.
 *
 * A resource with an `owner`-shortcut read rule is therefore refused wholesale
 * here, exactly as `opList` refuses it: a row-less rule reads as denied. That is
 * deliberately not "quietly return the caller's own rows" — inventing a
 * row-filter semantics for search that list does not have would make search the
 * one read path with its own access model, which is how the two drift.
 *
 * `rank` is per-row: `ts_rank` scores a row against the query using only that
 * row's own text, so nothing about it is derived from rows the caller cannot
 * see. The count is computed under the identical predicates, so it cannot report
 * a total that includes them either.
 */
export async function opSearch(
	ctx: OpContext,
	resource: string,
	query: string,
	opts: {
		limit?: number
		offset?: number
		includeDeleted?: boolean
		/** Caller-supplied equality filters — the resource's facets, still live
		 * while a search term is set. Narrowed by, never able to widen, the forced
		 * scopes below. */
		filter?: ListOptions['filter']
		range?: ListOptions['range']
	} = {},
): Promise<SearchHit[]> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	await authorize(
		resource,
		entry.config.access,
		'read',
		createAccessContext(user),
	)
	assertPortalMayNotSearch(user, resource)
	const plan = entry.config.search
	if (!plan)
		throw new UnsupportedOperationError(
			resource,
			'search',
			'no search index is declared for this resource — declare one with search.declare',
		)
	if (!store.search)
		throw new UnsupportedOperationError(
			resource,
			'search',
			'this store cannot run ranked queries',
		)
	const normalized = normalizeSearchQuery(query)
	if (normalized === null) return []
	const hits = await store.search(resource, plan, normalized, {
		limit: opts.limit ?? 50,
		offset: opts.offset ?? 0,
		// The forced scopes spread **last**, over any caller filter — the same
		// ordering rule `opList` states, and for the same reason: a caller who
		// names the tenant column must not be able to choose its value.
		filter: {
			...opts.filter,
			...searchScope(entry, user, resource, opts.includeDeleted ?? false),
		},
		range: opts.range,
	})
	// Derived values attach after the scoping predicates, for `opList`'s reason:
	// a rollup must aggregate over the rows the caller is actually allowed to see.
	const rows = await withDerived(
		ctx,
		resource,
		hits.map((h) => h.row),
	)
	return hits.map((hit, i) => ({ row: rows[i] ?? hit.row, rank: hit.rank }))
}

/** Matching-row count for a search, under exactly {@link opSearch}'s gate and scopes. */
export async function opSearchCount(
	ctx: OpContext,
	resource: string,
	query: string,
	opts: {
		includeDeleted?: boolean
		filter?: ListOptions['filter']
		range?: ListOptions['range']
	} = {},
): Promise<number> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	await authorize(
		resource,
		entry.config.access,
		'read',
		createAccessContext(user),
	)
	assertPortalMayNotSearch(user, resource)
	const plan = entry.config.search
	if (!plan)
		throw new UnsupportedOperationError(
			resource,
			'search',
			'no search index is declared for this resource — declare one with search.declare',
		)
	if (!store.searchCount)
		throw new UnsupportedOperationError(
			resource,
			'search',
			'this store cannot run ranked queries',
		)
	const normalized = normalizeSearchQuery(query)
	if (normalized === null) return 0
	return store.searchCount(resource, plan, normalized, {
		filter: {
			...opts.filter,
			...searchScope(entry, user, resource, opts.includeDeleted ?? false),
		},
		range: opts.range,
	})
}

/**
 * The scopes a search is forced to run under — tenant, then soft-delete.
 *
 * Factored out so `opSearch` and `opSearchCount` cannot drift: a count that
 * counted rows the list half excludes would report a total the caller can never
 * page to, and in the tenant case it would be a cross-tenant row count, which is
 * a leak whether or not the rows themselves come back.
 */
function searchScope(
	entry: RegisteredResource,
	user: SproutUser | null,
	resource: string,
	includeDeleted: boolean,
): Record<string, string | number | boolean | null> {
	const scope: Record<string, string | number | boolean | null> = {}
	const softField = softDeleteFieldOf(entry)
	if (softField && !includeDeleted) scope[softField] = null
	// Throws when a tenant-scoped resource is reached without an active org —
	// the same strictness `opList` applies, so a missing org context can never
	// widen a search into a cross-tenant read.
	const tenant = tenantOf(entry, user, resource, 'read')
	if (tenant) scope[tenant.field] = tenant.orgId
	return scope
}

export async function opCount(
	{ registry, store, user }: OpContext,
	resource: string,
	opts: ListOptions = {},
): Promise<number> {
	const entry = resolve(registry, resource)
	await authorize(
		resource,
		entry.config.access,
		'read',
		createAccessContext(user),
	)
	assertPortalMayEnumerate(user, resource)
	assertPortalReadShape(user, resource, entry, opts)
	const tenant = tenantOf(entry, user, resource, 'read')
	const softField = softDeleteFieldOf(entry)
	let filter = opts.filter
	if (softField && !opts.includeDeleted)
		filter = { ...filter, [softField]: null }
	if (tenant) filter = { ...filter, [tenant.field]: tenant.orgId }
	// A count under a portal counts only what that portal could have listed —
	// otherwise it reports a total the caller can never page to, which is a
	// cross-bound row count and therefore a leak whether or not the rows come back.
	filter = { ...filter, ...portalScope(user) }
	return store.count(resource, {
		filter,
		range: opts.range,
		search: opts.search,
		searchFields: opts.searchFields,
	})
}

export async function opGetMany(
	ctx: OpContext,
	resource: string,
	ids: readonly string[],
	opts: { includeDeleted?: boolean } = {},
): Promise<Row[]> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	await authorize(
		resource,
		entry.config.access,
		'read',
		createAccessContext(user),
	)
	assertPortalMayEnumerate(user, resource)
	const tenant = tenantOf(entry, user, resource, 'read')
	const softField = softDeleteFieldOf(entry)
	const bound = user?.portal?.filter
	// A batch drops the impossible ids rather than refusing the whole call — the
	// same "cannot exist == does not exist" rule `assertIdCouldExist` applies to
	// a single read, in the shape `getMany` already has: it answers with the rows
	// it found and says nothing about the ids it did not. One malformed id in a
	// `<ReferenceField>`'s batch previously failed the entire round-trip, so a
	// single bad FK value blanked every reference on the page.
	const accepts = store.acceptsId?.bind(store)
	const reachable = accepts ? ids.filter((id) => accepts(resource, id)) : ids
	const rows = await store.getMany(resource, reachable)
	const visible = rows.filter((row) => {
		if (tenant && row[tenant.field] !== tenant.orgId) return false
		if (softField && !opts.includeDeleted && row[softField] != null)
			return false
		// The portal's bound applies row-wise here, because `getMany` takes ids
		// rather than a predicate. A row outside the bound reads as ABSENT rather
		// than forbidden — the same "existence must not leak" shape the tenant
		// check uses, and here it matters more: a portal that distinguished
		// "outside your bound" from "does not exist" would be an existence oracle
		// over the whole table for anybody with a list of uuids.
		if (bound && row[bound.field] !== bound.equals) return false
		return true
	})
	return projectForPortal(
		user,
		entry,
		await withDerived(ctx, resource, visible),
	)
}

export async function opGet(
	ctx: OpContext,
	resource: string,
	id: string,
	opts: { includeDeleted?: boolean } = {},
): Promise<Row> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	// A row-scoped portal reaches exactly the row its token names. Any other id
	// is a 404 rather than a 403 — telling a token holder that some other invoice
	// exists is a fact they were never given.
	const portal = user?.portal
	if (portal?.scope === 'row' && portal.rowId !== id)
		throw new NotFoundError(resource, id)
	const tenant = tenantOf(entry, user, resource, 'read')
	const softField = softDeleteFieldOf(entry)
	assertIdCouldExist(store, resource, id)
	const row = await store.get(resource, id)
	if (!row) throw new NotFoundError(resource, id)
	assertRowInTenant(tenant, row, resource, id)
	// A collection portal's bound applies to a single-row read too, or the bound
	// would be a property of the list page rather than of the portal: fetching by
	// id would reach every row in the table.
	if (portal?.filter && row[portal.filter.field] !== portal.filter.equals)
		throw new NotFoundError(resource, id)
	assertRowNotDeleted(
		softField,
		row,
		resource,
		id,
		opts.includeDeleted ?? false,
	)
	// Derived last, and only after the row-level read check passes: a rollup is
	// a query the caller would not otherwise be allowed to run.
	await authorize(resource, entry.config.access, 'read', { user, row })
	const derived = (await withDerived(ctx, resource, [row]))[0] ?? row
	return projectForPortal(user, entry, [derived])[0] ?? derived
}

/**
 * Render a declared document template for one row.
 *
 * **Every access decision here is one that already existed.** The row comes from
 * `opGet` and each `table` section's rows come from `opList` — not from
 * lookalike queries, and not from the store directly. That is the answer to the
 * issue's RBAC criterion ("rendering a document is a read of the underlying row
 * and obeys the same access rules, including for a stored or emailed copy") and
 * it is structural rather than a matter of remembering: this function cannot
 * reach a row without going through a gate, because it has no other way to fetch
 * one.
 *
 * Three consequences follow, and all three are the behaviour you want:
 *
 *  - A caller who may not read the row gets the *same* error a `GET` would give
 *    them. A denial is a throw, never a blank document — a document with the
 *    line items silently missing is worse than no document.
 *  - A caller who may read the invoice but not the line items gets the line
 *    items' refusal, not an invoice with the table quietly missing. That is the
 *    same argument `opSearch` makes about denial-versus-zero-results, and here
 *    it is sharper: a document that silently omits billable lines is worse than
 *    no document, because it looks complete. The template does not get to
 *    overrule the child's rule in either direction.
 *  - Tenant and soft-delete scoping apply to the related rows exactly as they do
 *    everywhere else, so a document can never print another org's rows.
 *
 * It returns a {@link DocumentLayout} rather than bytes: the HTML and PDF
 * backends are pure functions of that layout, so the gate and the serialization
 * have no reason to know about each other. The delivery paths in
 * `@maxstack/features` render from the same layout, which is what makes a stored
 * or emailed copy provably the same document as the downloaded one.
 *
 * ## `via` — which delivery is asking
 *
 * `delivery.download` says whether a template may be served over HTTP, and until
 * #222 that flag reached the runtime not at all: the document route served every
 * declared template, so turning `download` off retired a template from the
 * exposure report and from nothing else. A template delivered only by email kept
 * a working public URL that the declaration said it did not have.
 *
 * The check is here rather than in the route, on issue #186's finding — a
 * route-level gate is a gate the other callers skip, and there is now more than
 * one caller (the route, the admin UI's link, the MCP tool). `via` **defaults to
 * `'download'`**, the checked value, so a caller that has not thought about it
 * gets the strict answer; a delivery path that legitimately renders a
 * non-downloadable template says `via: 'store'` or `via: 'email'` out loud.
 */
export async function opRenderDocument(
	ctx: OpContext,
	key: string,
	id: string,
	opts: {
		/** Slot fills, by slot name. Supplied by the app, never fetched here. */
		slots?: Record<string, DocumentBlock[]>
		includeDeleted?: boolean
		/** Which declared delivery is rendering this. Defaults to `'download'`,
		 * the one that is gated — see above. */
		via?: 'download' | 'store' | 'email'
	} = {},
): Promise<{ plan: DocumentPlan; row: Row; layout: DocumentLayout }> {
	const found = ctx.registry.findDocument(key)
	if (!found) throw new UnknownResourceError(`document template "${key}"`)
	const { entry, plan } = found
	if ((opts.via ?? 'download') === 'download' && !plan.download)
		throw new UnsupportedOperationError(
			entry.resource.name,
			'render document',
			`the "${key}" template does not declare delivery.download, so it has no download URL — set it with documents.setDelivery, or render it through the delivery that is declared`,
		)
	// A document is a whole-row rendering composed from field metadata, with no
	// notion of a projection — so a portal identity is refused outright rather
	// than being handed a document that happens to be right today.
	// The template names its own fields, and nothing reconciles those with the
	// portal's declared list.
	if (ctx.user?.portal) throw new PermissionError(entry.resource.name, 'read')

	// The row, through the ordinary read gate — including the row-level `owner`
	// check, which is why this is `opGet` and not `store.get`.
	const row = await opGet(ctx, entry.resource.name, id, {
		includeDeleted: opts.includeDeleted,
	})

	const related: DocumentData['related'] = {}
	for (const [index, section] of plan.sections.entries()) {
		if (section.kind !== 'table') continue
		// One bounded, ordered, gated list per table section. `limit` is
		// `MAX_DOCUMENT_TABLE_ROWS + 1` so the renderer can tell "exactly the
		// maximum" from "more than the maximum" and print the truncation note
		// rather than silently omitting billable lines.
		related[index] = await opList(ctx, section.resource, {
			filter: { [section.via]: id },
			orderBy: section.orderBy,
			orderDir: section.direction,
			limit: MAX_DOCUMENT_TABLE_ROWS + 1,
			offset: 0,
		})
	}

	return {
		plan,
		row,
		layout: compileDocument(plan, { row, related, slots: opts.slots }),
	}
}

// ===========================================================================
// Imports — plan, then apply. In that order, structurally.
// ===========================================================================

/**
 * Dry-run a declared importer over a stream of bytes, producing the plan a
 * person confirms.
 *
 * **This is the only way to obtain an {@link ImportPlan}**, and
 * {@link opApplyImport} takes nothing else. That is the mandatory dry-run made
 * structural: there is no shape the call can take that skips it, so it cannot be
 * skipped under deadline by somebody who is sure the data is fine.
 *
 * What it does, and every step is a gate that already existed:
 *
 *  1. **Authorizes `create` up front, and `update` too when the importer
 *     declares an upsert key.** Discovering at apply time that a plan full of
 *     updates cannot be applied is discovering it too late — the person has
 *     already read a report promising changes the platform will then refuse.
 *  2. **Parses incrementally.** The reader is an async generator over chunks, so
 *     memory is one record; the *plan* is bounded by the importer's declared
 *     `maxRows`, and exceeding that fails the whole run rather than truncating.
 *  3. **Validates every row with the exact `validateData` the forms use** — not
 *     a lookalike. An import must not be a way to get invalid data past the
 *     rules, and the way to guarantee that is to call the same function rather
 *     than to assert that two functions agree.
 *  4. **Resolves upsert matches through `opList`**, so the lookup is gated,
 *     tenant-scoped and soft-delete-scoped. An importer can never overwrite a row
 *     in another org, and — because the lookup is a gated read rather than a
 *     store query — can never *discover* one either.
 *
 * A `format: 'custom'` importer with no parser supplied throws loudly, naming the
 * module that is missing. It never returns an empty plan: an empty plan reads as
 * "your file had no rows", which is a different and much more confusing problem
 * than "the parser for this importer has not been written".
 */
export async function planImport(
	ctx: OpContext,
	key: string,
	source: AsyncIterable<Uint8Array> | AsyncIterable<string>,
	opts: { parser?: ImportParser } = {},
): Promise<ImportPlan> {
	const found = ctx.registry.findImporter(key)
	if (!found) throw new UnknownResourceError(`importer "${key}"`)
	const { entry, plan: importer } = found
	const resource = entry.resource.name
	// An importer maps a whole file onto a whole entity and its dry-run reads
	// existing rows to resolve upsert matches. Neither has any relationship to a
	// portal's declared projection, so a portal is refused here rather than
	// relying on the write allowlist to make a bulk write coincidentally safe.
	if (ctx.user?.portal) throw new PermissionError(resource, 'create')

	if (importer.paused)
		throw new UnsupportedOperationError(
			resource,
			'import',
			`importer "${key}" is paused — resume it with imports.pause {paused: false}`,
		)

	await authorize(
		resource,
		entry.config.access,
		'create',
		createAccessContext(ctx.user),
	)
	// The update check happens HERE, not at apply time, precisely because a plan
	// for an upserting importer will contain updates: a report that promises them
	// and an apply that refuses them is the worst ordering of the same two facts.
	if (importer.upsertColumn)
		await authorize(
			resource,
			entry.config.access,
			'update',
			createAccessContext(ctx.user),
		)

	const parser = opts.parser ?? builtinParser(importer.format)
	if (!parser)
		throw new UnsupportedOperationError(
			resource,
			'import',
			`importer "${key}" declares format "custom" and no parser was supplied — write imports/${key.replace(/[^a-z0-9]+/gi, '-')}.parse.ts and register it. The platform does not know how to read this file, and guessing would be worse than saying so`,
		)

	const rows: ImportRowPlan[] = []
	const counts = { create: 0, update: 0, invalid: 0 }
	let line = 0

	for await (const record of parser(source as AsyncIterable<Uint8Array>)) {
		line++
		if (line > importer.maxRows)
			throw new UnsupportedOperationError(
				resource,
				'import',
				`the file has more than the declared maximum of ${importer.maxRows} rows. Nothing was written: a truncated import is indistinguishable from a successful one, so the whole run fails instead. Split the file, or raise maxRows with imports.declare`,
			)

		const raw: Record<string, string> = {}
		const data: Row = {}
		const errors: Record<string, string[]> = {}
		for (const column of importer.columns) {
			const cell = record[column.column] ?? ''
			raw[column.column] = cell
			const read = readCell(cell, column.type)
			if ('error' in read) {
				errors[column.field] = [read.error]
				continue
			}
			if (read.present) data[column.field] = read.value
		}

		// The upsert lookup, through the ordinary gated list. `limit: 2` so an
		// ambiguous key is *detected* rather than resolved by taking the first
		// match — overwriting one of several rows that share a key is the failure
		// this importer would never be able to explain afterwards.
		let matchedId: string | undefined
		if (importer.upsertColumn && Object.keys(errors).length === 0) {
			const keyValue = data[importer.upsertColumn]
			if (keyValue === undefined) {
				errors[importer.upsertColumn] = [
					'the upsert key is blank on this row — without it there is no way to tell a new row from an existing one',
				]
			} else {
				const matches = await opList(ctx, resource, {
					filter: {
						[importer.upsertColumn]: keyValue as string | number | boolean,
					},
					limit: 2,
					offset: 0,
				})
				if (matches.length > 1)
					errors[importer.upsertColumn] = [
						`matches ${matches.length} existing rows — an ambiguous key would overwrite one of them arbitrarily`,
					]
				else if (matches[0])
					matchedId = String(matches[0][entry.resource.primaryKey])
			}
		}

		if (Object.keys(errors).length > 0) {
			counts.invalid++
			rows.push({ line, action: 'invalid', errors, raw })
			continue
		}

		// The forms' validator, called rather than mirrored. An update validates in
		// `update` mode, so a partial file row does not fail on a required column
		// the existing row already carries.
		const mode = matchedId ? 'update' : 'create'
		const validated = validateData(entry.resource, data, mode)
		if (!validated.success) {
			counts.invalid++
			rows.push({
				line,
				action: 'invalid',
				errors: validated.fieldErrors ?? {},
				raw,
			})
			continue
		}
		if (matchedId) {
			counts.update++
			rows.push({
				line,
				action: 'update',
				data: validated.data as Row,
				matchedId,
				raw,
			})
		} else {
			counts.create++
			rows.push({ line, action: 'create', data: validated.data as Row, raw })
		}
	}

	return { importer, key, resource, rows, counts, truncated: false }
}

/**
 * Apply a planned import.
 *
 * It takes a plan and **nothing else** — see {@link planImport} and the module
 * comment in `imports.ts`. Every write goes through `opCreate`/`opUpdate` and
 * there is no other path out of this function, so tenancy stamping, soft-delete
 * scoping, the per-value caps of issue #172, the `customValidation` hook and the
 * audit attribution of #186/#141 are all **inherited** rather than
 * re-implemented. An import performed by an agent is attributed exactly like any
 * other write, because it *is* any other write.
 *
 * **Per row, never all-or-nothing.** A row that fails here failed for a reason
 * that did not exist when the plan was built — a racing writer took the last
 * slot in a WIP-limited column, a unique index rejected a duplicate — and the
 * rows that landed are correct. Rolling them back would mean deleting rows this
 * module just created, which is the delete path it deliberately does not have.
 * The failure is reported per line instead, and the returned counts reconcile
 * exactly with the plan.
 *
 * A row the plan marked `invalid` is **never attempted**. That is what makes the
 * report somebody read the thing that actually governs the write.
 */
export async function opApplyImport(
	ctx: OpContext,
	plan: ImportPlan,
): Promise<ImportResult> {
	const result: ImportResult = {
		created: 0,
		updated: 0,
		skipped: 0,
		failed: [],
	}
	for (const row of plan.rows) {
		if (row.action === 'invalid' || !row.data) {
			result.skipped++
			continue
		}
		try {
			if (row.action === 'update' && row.matchedId) {
				await opUpdate(ctx, plan.resource, row.matchedId, row.data)
				result.updated++
			} else {
				await opCreate(ctx, plan.resource, row.data)
				result.created++
			}
		} catch (error) {
			result.failed.push({
				line: row.line,
				reason: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return result
}

export async function opCreate(
	ctx: OpContext,
	resource: string,
	data: Row,
): Promise<Row> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	await authorize(resource, entry.config.access, 'create', { user, row: data })
	// A portal write names only the fields it declared — anything else is a
	// refusal, never a silent strip — and spends its declared budget
	// before anything is written.
	assertPortalWriteShape(user, resource, 'create', data)
	await assertPortalBudget(ctx, resource, 'create')
	// The tenant column is server-stamped from the active org — a client-sent
	// value is overwritten, so rows can only ever be created in the caller's org.
	const tenant = tenantOf(entry, user, resource, 'create')
	const softField = softDeleteFieldOf(entry)
	// The soft-delete column is server-stamped too: a row is always created
	// live, never pre-deleted by a client-sent value.
	const input = {
		...data,
		...(tenant ? { [tenant.field]: tenant.orgId } : {}),
		...(softField ? { [softField]: null } : {}),
		// And the portal's bound is server-stamped, on exactly the tenant column's
		// argument: a public comment form must not be able to create a row outside
		// the collection its own portal can see. The spec validator already refuses
		// a write that NAMES the bound column; this is what makes the row land
		// inside it.
		...portalScope(user),
	}
	const validated = validateData(entry.resource, input, 'create')
	if (!validated.success)
		throw new ValidationError(validated.fieldErrors ?? {}, {
			fields: validated.fields,
			summary: validated.summary,
		})
	entry.config.customValidation?.(validated.data as Row, 'create')
	// Declared per-value caps. A create is a move into a column too.
	await assertWithinLimits(
		ctx,
		entry,
		resource,
		validated.data as Row,
		null,
		tenant,
		softField,
	)
	const created = await store.create(resource, validated.data as Row)
	const createdId = String(created[entry.resource.primaryKey])
	await record(ctx, { action: 'create', resource, resourceId: createdId })
	// After the commit, never before: a channel must not announce a row that a
	// later validation error would have prevented from existing.
	await publish(ctx, resource, createdId)
	return created
}

export async function opUpdate(
	ctx: OpContext,
	resource: string,
	id: string,
	data: Row,
): Promise<Row> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	const tenant = tenantOf(entry, user, resource, 'update')
	const softField = softDeleteFieldOf(entry)
	// The portal's row bound, before anything is read back to the caller: a
	// token for one invoice updates one invoice, and a collection portal cannot
	// update a row outside its own filter. Both read as 404 rather than 403.
	const portal = user?.portal
	if (portal?.scope === 'row' && portal.rowId !== id)
		throw new NotFoundError(resource, id)
	assertIdCouldExist(store, resource, id)
	const existing = await store.get(resource, id)
	if (!existing) throw new NotFoundError(resource, id)
	assertRowInTenant(tenant, existing, resource, id)
	if (portal?.filter && existing[portal.filter.field] !== portal.filter.equals)
		throw new NotFoundError(resource, id)
	// A soft-deleted row is not editable — restore it first (opRestore).
	assertRowNotDeleted(softField, existing, resource, id, false)
	await authorize(resource, entry.config.access, 'update', {
		user,
		row: existing,
	})
	assertPortalWriteShape(user, resource, 'update', data)
	await assertPortalBudget(ctx, resource, 'update')
	// The tenant column is immutable through update — strip it so a payload can
	// never re-home a row into another org. The soft-delete column is likewise
	// off-limits through the generic update path — only `opDelete`/`opRestore`
	// may write it, so a client can't self-delete/self-restore by field name.
	const stripped = new Set(
		[tenant?.field, softField].filter((f): f is string => f != null),
	)
	const input =
		stripped.size > 0
			? Object.fromEntries(
					Object.entries(data).filter(([key]) => !stripped.has(key)),
				)
			: data
	const validated = validateData(entry.resource, input, 'update')
	if (!validated.success)
		throw new ValidationError(validated.fieldErrors ?? {}, {
			fields: validated.fields,
			summary: validated.summary,
		})
	entry.config.customValidation?.(validated.data as Row, 'update')
	// Declared per-value caps — checked against `existing` so an edit
	// that does not change the capped column is never refused by a full column.
	await assertWithinLimits(
		ctx,
		entry,
		resource,
		validated.data as Row,
		existing,
		tenant,
		softField,
	)
	const updated = await store.update(resource, id, validated.data as Row)
	if (!updated) throw new NotFoundError(resource, id)
	// Record the fields the update actually changed — the diff a history feed shows.
	await record(ctx, {
		action: 'update',
		resource,
		resourceId: id,
		metadata: { fields: Object.keys(validated.data as Row) },
	})
	await publish(ctx, resource, id)
	return updated
}

export async function opDelete(
	ctx: OpContext,
	resource: string,
	id: string,
): Promise<boolean> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	const tenant = tenantOf(entry, user, resource, 'delete')
	const softField = softDeleteFieldOf(entry)
	assertIdCouldExist(store, resource, id)
	const existing = await store.get(resource, id)
	if (!existing) throw new NotFoundError(resource, id)
	assertRowInTenant(tenant, existing, resource, id)
	// Deleting an already-deleted row 404s — same "existence must not leak"
	// shape as everywhere else, and it keeps delete idempotent-looking from the
	// caller's side (a second delete can't silently re-stamp the timestamp).
	assertRowNotDeleted(softField, existing, resource, id, false)
	await authorize(resource, entry.config.access, 'delete', {
		user,
		row: existing,
	})
	if (softField) {
		const updated = await store.update(resource, id, {
			[softField]: new Date(),
		})
		if (updated) {
			await record(ctx, { action: 'delete', resource, resourceId: id })
			// A delete announces the same way a create does, and the channel decides
			// what it means: `liveRead` finds the row gone (or soft-delete-scoped
			// out) and sends a `remove` rather than a row. Nothing here has to know
			// that — which is what keeps "a soft-deleted row pushes a removal, never
			// a row" a property of the read path rather than of every write site.
			await publish(ctx, resource, id)
		}
		return updated != null
	}
	const deleted = await store.delete(resource, id)
	if (deleted) {
		await record(ctx, { action: 'delete', resource, resourceId: id })
		await publish(ctx, resource, id)
	}
	return deleted
}

/**
 * Restore a soft-deleted row, clearing `deletedAt` — the undo for
 * `opDelete` on a `softDelete: true` resource, and the "recoverable within a
 * window" half of the retention story (the purge job in
 * `@maxstack/features/compliance` is the other half). Reuses the resource's
 * `update` access rule: restoring is, mechanically, an update. Throws for a
 * resource that isn't soft-deletable, or a row that isn't currently deleted.
 */
export async function opRestore(
	ctx: OpContext,
	resource: string,
	id: string,
): Promise<Row> {
	const { registry, store, user } = ctx
	const entry = resolve(registry, resource)
	// Restoring is mechanically an update, which is exactly why a portal must be
	// refused here explicitly: a portal that declared `update` would
	// otherwise be able to un-delete rows, and "bring back the row somebody
	// deleted" is not a capability any declaration in this vocabulary asks for.
	// Checked FIRST, before the soft-delete capability check, so the answer does
	// not depend on how the resource happens to be configured.
	if (user?.portal) throw new PermissionError(resource, 'update')
	const softField = softDeleteFieldOf(entry)
	if (!softField) {
		throw new UnsupportedOperationError(
			resource,
			'restore',
			'it does not declare soft delete, so a deleted row is already gone',
		)
	}
	const tenant = tenantOf(entry, user, resource, 'update')
	assertIdCouldExist(store, resource, id)
	const existing = await store.get(resource, id)
	if (!existing) throw new NotFoundError(resource, id)
	assertRowInTenant(tenant, existing, resource, id)
	if (existing[softField] == null) throw new NotFoundError(resource, id)
	await authorize(resource, entry.config.access, 'update', {
		user,
		row: existing,
	})
	const updated = await store.update(resource, id, { [softField]: null })
	if (!updated) throw new NotFoundError(resource, id)
	await record(ctx, {
		action: 'update',
		resource,
		resourceId: id,
		metadata: { restored: true },
	})
	// A restore is a row BECOMING visible, which is the direction a live surface
	// most needs and would otherwise silently miss: the delete pushed a removal,
	// so without this the row would stay gone from every open board until
	// somebody reloaded.
	await publish(ctx, resource, id)
	return updated
}
