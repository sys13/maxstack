/**
 * Cross-resource reads over **declared** references.
 *
 * ## The question this exists to answer
 *
 * The generated MCP surface can list, get, search, create, update and delete one
 * resource at a time. "Customers with an active campaign whose health score is
 * below 50" is not one of those: an agent has to list customers, list campaigns,
 * list health scores and join them in its own context window. At 134 entities
 * that is a pagination exercise that burns the context and silently truncates —
 * and the join it performs there is unreviewable, because it happened inside a
 * model rather than inside the gate.
 *
 * `opQuery` walks the graph the spec already validated: a root resource, an
 * equality/range filter over its own columns, and traversals across the
 * relations `introspectTable` derived from declared references. **Not SQL.** The
 * client names an *edge*, never a table join, never a predicate this module
 * pastes into a statement — see "Why it is not SQL" below.
 *
 * ## It is built out of the read ops, not beside them
 *
 * Every row this returns came out of `opList`, `opGet`… — the same functions
 * REST and the other MCP tools call. There is no second read path, which is what
 * makes the following true *structurally* rather than by remembering:
 *
 *  - **Authorization holds at every hop.** Each hop calls a read op, which calls
 *    `authorize(resource, access, 'read', …)` for the resource it is touching.
 *    A join can therefore never be a permission-laundering path: reaching
 *    `payment` through `invoice` runs `payment`'s own rule, exactly as a direct
 *    `list_records` on `payment` would. An `owner`-shortcut rule reads as denied
 *    row-lessly here, as it does for `opList` and `opSearch`.
 *  - **Tenancy holds on every table in the traversal, not just the root.** Each
 *    hop's `opList`/`opGetMany` calls the same `tenantOf`, which forces the
 *    active org into the filter *after* any caller filter and throws when a
 *    scoped resource is reached with no org. A cross-tenant child cannot appear
 *    under an in-tenant parent, and a scoped child cannot be reached at all by an
 *    identity with no org — including an admin.
 *  - **Portal identities are refused outright.** A portal declares a projection
 *    over one resource; it declares nothing at all about what may be reached
 *    *through* that resource. `opRenderDocument` and `planImport` refuse a portal
 *    for the same reason, and this is the sharper case, because a traversal is a
 *    read of a table the portal never named.
 *
 * ## The permission pre-flight, and why it runs before any row is fetched
 *
 * {@link assertTraversalReadable} authorizes every resource in the traversal tree
 * up front, row-lessly. The hops would refuse anyway — this makes the refusal
 * *deterministic*: without it, a caller who may not read the joined entity gets a
 * refusal only when some root row happens to have a related id, and an empty
 * result the rest of the time. "You may not" and "there is nothing" are different
 * facts, and a query whose answer depends on which one you'd have got is an
 * oracle. It also means the denial is one error rather than a partial result with
 * a hole in it — `opRenderDocument`'s stated posture: a document with the line
 * items silently missing is worse than no document.
 *
 * ## Why it is not SQL, and why it is not string-built either
 *
 * The client supplies: a resource name (looked up in the registry), edge names
 * (looked up in the derived relation graph), column names (checked against the
 * resource's own declared columns) and scalar values (passed as parameters to the
 * store, never spliced). There is no branch in this file that concatenates a
 * client string into a statement, because there is no statement in this file at
 * all — it composes `opList`/`opGetMany` calls, whose filters the store
 * parameterizes. An unknown column is refused rather than ignored: the store
 * drops an unknown filter key (a stale view must not 500), and silently dropping
 * a *join* predicate would widen the answer rather than narrow it.
 *
 * ## Bounds
 *
 * One call must not become an unbounded scan, and the failure mode of an
 * unbounded one is invisible: a truncated join looks like a complete answer. So
 * every dimension is capped and the result says when a cap bit
 * ({@link QueryResult.truncated}) — depth, edges per query, root rows scanned,
 * rows returned, related rows per parent, and total store reads. See
 * {@link QUERY_LIMITS}.
 */

import {
	assertDeclaredFilterShape,
	type OpContext,
	opGetMany,
	opList,
	tenantOf,
	UnknownResourceError,
	ValidationError,
} from './operations.ts'
import {
	authorize,
	createAccessContext,
	PermissionError,
} from './permissions.ts'
import { inverseReferences, parseIdArray } from './references.ts'
import type { RegisteredResource, ResourceRegistry } from './registry.ts'
import type { RangeBound, Row } from './store.ts'

/**
 * The caps one `opQuery` call runs under.
 *
 * Chosen so the worst case is a few hundred bounded, gated reads rather than a
 * table scan, and stated as one object so the tool description, the tests and
 * the enforcement quote the same numbers.
 */
export const QUERY_LIMITS = {
	/** Nesting depth of `traverse`. 1 = the root's own neighbours. */
	maxDepth: 2,
	/** Edges in the whole traversal tree, at every depth combined. */
	maxEdges: 6,
	/** Root rows returned. */
	maxLimit: 50,
	/** Root rows returned when the caller names none. */
	defaultLimit: 25,
	/** Root rows *examined* — larger than `maxLimit` because a `required` edge
	 * filters after the read, so filling a page costs more rows than it returns. */
	maxRootScan: 200,
	/** Related rows kept per parent row per edge. */
	maxRelatedPerRow: 25,
	/** Store reads (`opList`/`opGetMany` calls) across the whole query. The
	 * backstop that holds when every other cap is at its maximum. */
	maxStoreReads: 300,
} as const

/** An equality predicate's value. Scalars only — an object or an array here
 * would be a shape the store's filter has no meaning for. */
export type QueryScalar = string | number | boolean | null

/** One hop across a declared reference. */
export interface QueryTraversal {
	/** The edge to walk, named exactly as `describe_resources` reports it. */
	edge: string
	/** Equality predicates over the joined resource's own declared columns. */
	where?: Record<string, QueryScalar>
	/** Inclusive `>=`/`<=` bounds over the joined resource's own columns. */
	range?: Record<string, RangeBound>
	/**
	 * Drop parent rows with no surviving related row — an inner join.
	 *
	 * This is the half that makes a *joined question* answerable rather than
	 * merely expanded: "customers with an active campaign" is `required: true` on
	 * the campaign edge with `where: { status: 'active' }`.
	 */
	required?: boolean
	/** Further hops from the joined resource. Bounded by `QUERY_LIMITS.maxDepth`. */
	traverse?: QueryTraversal[]
}

export interface QuerySpec {
	resource: string
	where?: Record<string, QueryScalar>
	range?: Record<string, RangeBound>
	traverse?: QueryTraversal[]
	limit?: number
	offset?: number
	orderBy?: string
	orderDir?: 'asc' | 'desc'
}

/** One root row and whatever the declared edges reached from it. */
export interface QueryRow {
	/** The root row, exactly as `list_records` would have returned it. */
	record: Row
	/**
	 * Related rows by edge name. Kept out of `record` on purpose: an edge named
	 * `author` and a column named `author` are both plausible, and merging them
	 * would make the answer depend on which one the spec happened to declare.
	 */
	related?: Record<string, QueryRelated>
}

/** A `many-to-one` edge yields one row or none; the other kinds yield a list. */
export type QueryRelated = QueryRow | null | QueryRow[]

export interface QueryResult {
	resource: string
	rows: QueryRow[]
	/** Root rows examined to produce `rows` — larger than `rows.length` when a
	 * `required` edge filtered some out. */
	scanned: number
	/**
	 * A cap bit before the query ran out of matching rows, so this answer is a
	 * prefix rather than the whole of it. Reported rather than inferred: a
	 * truncated join is indistinguishable from a complete one from the outside,
	 * which is the failure this whole surface exists to avoid.
	 */
	truncated: boolean
	/** Which cap bit, when one did. */
	truncatedBy?: 'rootScan' | 'storeReads' | 'relatedPerRow'
}

/**
 * One traversable edge of the declared graph.
 *
 * Derived from `SproutResource.relations` — which `introspectTable` builds from
 * the columns, so it covers both a drizzle inline FK and the `meta.reference` a
 * spec entity's declaration arrives as — plus the reverse direction, which no
 * single resource carries because the FK lives on the child.
 */
export interface QueryEdge {
	name: string
	kind: 'many-to-one' | 'many-to-many' | 'one-to-many'
	/** The resource on the far side. */
	resource: string
	/**
	 * The column holding the id(s): on the *near* side for `many-to-one` and
	 * `many-to-many`, on the *far* side for `one-to-many`.
	 */
	column: string
	/** The column those ids point at, on the other side of `column`. */
	targetColumn: string
	/** The declared label of the far side, for `describe_resources`. */
	label: string
}

/**
 * Every declared edge out of `entry`, in both directions.
 *
 * Forward edges come from the resource's own relation graph. Reverse edges come
 * from {@link inverseReferences} — the same backwards walk over grounded FK
 * columns the related-records panel renders, reused rather than
 * re-derived so a traversal and a detail page cannot disagree about which
 * relations exist. They are spelled `<child>_via_<column>` because a resource may
 * point at the same parent twice (`invoice.billToId`, `invoice.shipToId`) and
 * two edges called `invoice` would be a coin flip. A self-reference is a real
 * edge in both directions (`task.parentId` is "parent" forward and "subtasks"
 * back), and `inverseReferences` includes it for that reason.
 *
 * An edge to a resource that is not registered is omitted: there is nothing to
 * authorize it against, and offering a name that always refuses would be a
 * discovery surface for the registry's shape.
 */
export function queryEdges(
	registry: ResourceRegistry,
	entry: RegisteredResource,
): QueryEdge[] {
	const edges: QueryEdge[] = []
	const taken = new Set<string>()
	const claim = (preferred: string, fallback: string): string => {
		if (!taken.has(preferred)) {
			taken.add(preferred)
			return preferred
		}
		let name = fallback
		let n = 2
		while (taken.has(name)) name = `${fallback}_${n++}`
		taken.add(name)
		return name
	}
	for (const relation of entry.resource.relations) {
		const target = registry.get(relation.references.table)
		if (!target) continue
		edges.push({
			name: claim(relation.name, relation.column),
			kind: relation.type,
			resource: target.resource.name,
			column: relation.column,
			targetColumn: relation.references.column,
			label: target.label,
		})
	}
	const all = registry.all()
	for (const inverse of inverseReferences(
		all.map((e) => e.resource),
		entry.resource.name,
	)) {
		const child = registry.get(inverse.resource)
		if (!child) continue
		edges.push({
			name: claim(
				`${inverse.resource}_via_${inverse.column}`,
				`${inverse.resource}_${inverse.column}`,
			),
			kind: 'one-to-many',
			resource: inverse.resource,
			column: inverse.column,
			targetColumn: inverse.targetColumn,
			label: child.label,
		})
	}
	return edges
}

function resolveEntry(
	registry: ResourceRegistry,
	name: string,
): RegisteredResource {
	const entry = registry.get(name)
	if (!entry) throw new UnknownResourceError(name)
	return entry
}

/**
 * Refuse a predicate naming a column the resource does not declare.
 *
 * The store *ignores* an unknown filter key, which is right for a stale saved
 * view and wrong here: ignoring a join predicate **widens** the answer, and the
 * caller reads the widened answer as the one they asked for.
 */
function assertPredicateColumns(
	entry: RegisteredResource,
	where: Record<string, unknown> | undefined,
	range: Record<string, unknown> | undefined,
): void {
	const known = new Set(entry.resource.columns.map((c) => c.name))
	for (const key of [...Object.keys(where ?? {}), ...Object.keys(range ?? {})])
		if (!known.has(key))
			throw new ValidationError({
				[key]: [
					`"${key}" is not a column of ${entry.resource.name} — describe_resources { resource } lists them. Refused rather than ignored: a dropped predicate would widen this answer, not narrow it.`,
				],
			})
	for (const [key, value] of Object.entries(where ?? {}))
		if (value !== null && typeof value === 'object')
			throw new ValidationError({
				[key]: [
					'this filter takes a scalar (string, number, boolean or null) — use `range` for a bound',
				],
			})
	// A predicate the spec declared this column does not offer (#414). Checked on
	// every hop, not only the root: a declaration an agent can walk around by
	// asking through a join is a declaration that holds only for the surfaces
	// that happened to remember it.
	assertDeclaredFilterShape(entry.resource.name, entry, {
		filter: where,
		range,
	})
}

/**
 * Authorize every resource the traversal tree touches, row-lessly, before any
 * row is read, and check the tenant precondition on each. See the module header
 * for why this runs up front rather than being left to the hops.
 *
 * Also where the structural caps are enforced: depth, and the edge budget across
 * the whole tree.
 */
async function assertTraversalReadable(
	ctx: OpContext,
	entry: RegisteredResource,
	traversals: QueryTraversal[] | undefined,
	depth: number,
	budget: { edges: number },
): Promise<void> {
	if (!traversals || traversals.length === 0) return
	if (depth > QUERY_LIMITS.maxDepth)
		throw new ValidationError({
			traverse: [
				`traversals nest at most ${QUERY_LIMITS.maxDepth} deep — a deeper walk is a query with no bound on the work it does`,
			],
		})
	const edges = queryEdges(ctx.registry, entry)
	for (const traversal of traversals) {
		budget.edges += 1
		if (budget.edges > QUERY_LIMITS.maxEdges)
			throw new ValidationError({
				traverse: [
					`at most ${QUERY_LIMITS.maxEdges} edges per query, counting every depth`,
				],
			})
		const edge = edges.find((e) => e.name === traversal.edge)
		if (!edge)
			throw new ValidationError({
				edge: [
					`"${traversal.edge}" is not a declared reference of ${entry.resource.name}. Traversals walk the graph the spec declared — describe_resources { resource } lists the edges. There is no arbitrary-join form, deliberately.`,
				],
			})
		const target = resolveEntry(ctx.registry, edge.resource)
		// The joined resource's own read rule, run exactly as `opList` would run
		// it — this is the hop that must not become a permission-laundering path.
		await authorize(
			target.resource.name,
			target.config.access,
			'read',
			createAccessContext(ctx.user),
		)
		// And the tenant precondition, through the same function every read op
		// uses: a scoped resource reached with no active org throws here rather
		// than returning nothing.
		tenantOf(target, ctx.user ?? null, target.resource.name, 'read')
		assertPredicateColumns(target, traversal.where, traversal.range)
		await assertTraversalReadable(
			ctx,
			target,
			traversal.traverse,
			depth + 1,
			budget,
		)
	}
}

/** Compare a stored value against a bound, or `null` when the two are not
 * comparable — an incomparable value fails the bound rather than passing it. */
function compare(value: unknown, bound: string | number): number | null {
	if (value === null || value === undefined) return null
	if (value instanceof Date) {
		const t = typeof bound === 'number' ? bound : Date.parse(bound)
		return Number.isNaN(t) ? null : value.getTime() - t
	}
	if (typeof value === 'number') {
		const n = typeof bound === 'number' ? bound : Number(bound)
		return Number.isNaN(n) ? null : value - n
	}
	const a = String(value)
	const b = String(bound)
	return a < b ? -1 : a > b ? 1 : 0
}

/** Loose equality across the shapes a driver returns (a `date` column arrives
 * as a `Date`, a `uuid` as a string, a numeric as either). */
function equals(value: unknown, expected: QueryScalar): boolean {
	if (expected === null) return value === null || value === undefined
	if (value === null || value === undefined) return false
	if (value instanceof Date) return compare(value, String(expected)) === 0
	if (typeof value === typeof expected) return value === expected
	return String(value) === String(expected)
}

/**
 * The predicate, evaluated in memory over rows that already came through a gate.
 *
 * Applied on the `getMany` paths, where the ids are known but the predicate
 * cannot ride along, and applied *again* on the `list` path where the store
 * already enforced it. Re-applying is deliberate: it costs nothing and it means
 * the two paths cannot answer the same traversal differently. It can only ever
 * narrow — no branch here adds a row.
 */
function matches(
	row: Row,
	where: Record<string, QueryScalar> | undefined,
	range: Record<string, RangeBound> | undefined,
): boolean {
	for (const [key, expected] of Object.entries(where ?? {}))
		if (!equals(row[key], expected)) return false
	for (const [key, bound] of Object.entries(range ?? {})) {
		if (bound.gte !== undefined) {
			const c = compare(row[key], bound.gte)
			if (c === null || c < 0) return false
		}
		if (bound.lte !== undefined) {
			const c = compare(row[key], bound.lte)
			if (c === null || c > 0) return false
		}
	}
	return true
}

/** The mutable run state one `opQuery` call shares across every hop. */
interface QueryRun {
	ctx: OpContext
	reads: number
	truncated: boolean
	truncatedBy?: QueryResult['truncatedBy']
}

/** Spend one store read, or report that the budget is gone. */
function spendRead(run: QueryRun): boolean {
	if (run.reads >= QUERY_LIMITS.maxStoreReads) {
		run.truncated = true
		run.truncatedBy ??= 'storeReads'
		return false
	}
	run.reads += 1
	return true
}

/**
 * Walk one edge from one parent row.
 *
 * Every branch fetches through a read op, so the joined resource's access rule,
 * tenant scope, soft-delete scope and derived values all apply — this function
 * has no way to reach a row that skips them.
 */
async function walk(
	run: QueryRun,
	edge: QueryEdge,
	traversal: QueryTraversal,
	parent: Row,
	depth: number,
): Promise<QueryRelated> {
	const cap = QUERY_LIMITS.maxRelatedPerRow
	if (edge.kind === 'one-to-many') {
		const parentId = parent[edge.targetColumn]
		if (parentId === null || parentId === undefined) return []
		if (!spendRead(run)) return []
		const rows = await opList(run.ctx, edge.resource, {
			// The join key and the caller's predicate, both as parameterized store
			// filters. `opList` spreads the tenant and soft-delete scopes over this
			// *afterwards*, so nothing here can widen either.
			filter: { ...traversal.where, [edge.column]: parentId as QueryScalar },
			range: traversal.range,
			limit: cap + 1,
			offset: 0,
		})
		if (rows.length > cap) {
			run.truncated = true
			run.truncatedBy ??= 'relatedPerRow'
		}
		return expand(
			run,
			traversal,
			edge,
			rows
				.slice(0, cap)
				.filter((row) => matches(row, traversal.where, traversal.range)),
			depth,
		)
	}
	const ids =
		edge.kind === 'many-to-many'
			? parseIdArray(parent[edge.column]).slice(0, cap)
			: parent[edge.column] === null || parent[edge.column] === undefined
				? []
				: [String(parent[edge.column])]
	if (ids.length === 0) return edge.kind === 'many-to-one' ? null : []
	const target = resolveEntry(run.ctx.registry, edge.resource)
	let rows: Row[]
	if (edge.targetColumn === target.resource.primaryKey) {
		if (!spendRead(run)) return edge.kind === 'many-to-one' ? null : []
		rows = await opGetMany(run.ctx, edge.resource, ids)
	} else {
		// A reference that points at something other than the primary key. Rare,
		// and served by the same gated list rather than by a second lookup path.
		rows = []
		for (const id of ids) {
			if (!spendRead(run)) break
			rows.push(
				...(await opList(run.ctx, edge.resource, {
					filter: { [edge.targetColumn]: id },
					limit: 1,
					offset: 0,
				})),
			)
		}
	}
	const kept = rows.filter((row) =>
		matches(row, traversal.where, traversal.range),
	)
	const expanded = await expand(run, traversal, edge, kept, depth)
	if (edge.kind === 'many-to-one')
		return Array.isArray(expanded) ? (expanded[0] ?? null) : expanded
	return expanded
}

/** Attach the next depth's edges to a set of related rows. */
async function expand(
	run: QueryRun,
	traversal: QueryTraversal,
	edge: QueryEdge,
	rows: Row[],
	depth: number,
): Promise<QueryRow[]> {
	if (!traversal.traverse || traversal.traverse.length === 0)
		return rows.map((record) => ({ record }))
	const target = resolveEntry(run.ctx.registry, edge.resource)
	const out: QueryRow[] = []
	for (const record of rows)
		out.push(await hydrate(run, target, record, traversal.traverse, depth + 1))
	return out
}

/** One row plus every edge asked for at this depth. Returns `undefined` for
 * `related` when a `required` edge came back empty — the inner-join drop. */
async function hydrate(
	run: QueryRun,
	entry: RegisteredResource,
	record: Row,
	traversals: QueryTraversal[],
	depth: number,
): Promise<QueryRow> {
	const edges = queryEdges(run.ctx.registry, entry)
	const related: Record<string, QueryRelated> = {}
	for (const traversal of traversals) {
		const edge = edges.find((e) => e.name === traversal.edge)
		// Pre-flighted in `assertTraversalReadable`; unreachable in practice.
		if (!edge) continue
		related[traversal.edge] = await walk(run, edge, traversal, record, depth)
	}
	return { record, related }
}

/** Did every `required` edge at this level find something? */
function satisfiesRequired(
	row: QueryRow,
	traversals: QueryTraversal[] | undefined,
): boolean {
	for (const traversal of traversals ?? []) {
		if (!traversal.required) continue
		const value = row.related?.[traversal.edge]
		if (value === null || value === undefined) return false
		if (Array.isArray(value) && value.length === 0) return false
		// A deeper `required` edge filters its own level: a parent kept only
		// because of a child whose own required edge came back empty would be a
		// join that stops being an inner join halfway down.
		const kept = Array.isArray(value)
			? value.filter((v) => satisfiesRequired(v, traversal.traverse))
			: satisfiesRequired(value, traversal.traverse)
				? [value]
				: []
		if (kept.length === 0) return false
		if (row.related)
			row.related[traversal.edge] = Array.isArray(value)
				? kept
				: (kept[0] ?? null)
	}
	return true
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	if (value === null || value === undefined) return undefined
	if (typeof value !== 'object' || Array.isArray(value)) return undefined
	return value as Record<string, unknown>
}

function parseWhere(
	value: unknown,
	where: string,
): Record<string, QueryScalar> | undefined {
	const obj = plainObject(value)
	if (value !== undefined && value !== null && !obj)
		throw new ValidationError({
			[where]: ['expected an object of column → value'],
		})
	if (!obj) return undefined
	const out: Record<string, QueryScalar> = {}
	for (const [key, raw] of Object.entries(obj)) {
		if (raw === undefined) continue
		if (
			raw !== null &&
			typeof raw !== 'string' &&
			typeof raw !== 'number' &&
			typeof raw !== 'boolean'
		)
			throw new ValidationError({
				[`${where}.${key}`]: [
					'expected a string, number, boolean or null — use `range` for a bound',
				],
			})
		out[key] = raw
	}
	return out
}

function parseRange(
	value: unknown,
	where: string,
): Record<string, RangeBound> | undefined {
	const obj = plainObject(value)
	if (value !== undefined && value !== null && !obj)
		throw new ValidationError({
			[where]: ['expected an object of column → { gte?, lte? }'],
		})
	if (!obj) return undefined
	const out: Record<string, RangeBound> = {}
	for (const [key, raw] of Object.entries(obj)) {
		const bound = plainObject(raw)
		if (!bound)
			throw new ValidationError({
				[`${where}.${key}`]: ['expected { gte?, lte? }'],
			})
		const next: RangeBound = {}
		for (const side of ['gte', 'lte'] as const) {
			const v = bound[side]
			if (v === undefined || v === null) continue
			if (typeof v !== 'string' && typeof v !== 'number')
				throw new ValidationError({
					[`${where}.${key}.${side}`]: ['expected a number or an ISO string'],
				})
			next[side] = v
		}
		out[key] = next
	}
	return out
}

function parseTraversals(
	value: unknown,
	where: string,
): QueryTraversal[] | undefined {
	if (value === undefined || value === null) return undefined
	if (!Array.isArray(value))
		throw new ValidationError({
			[where]: [
				'expected an array of { edge, where?, range?, required?, traverse? }',
			],
		})
	return value.map((raw, i) => {
		const obj = plainObject(raw)
		if (!obj || typeof obj.edge !== 'string' || obj.edge === '')
			throw new ValidationError({
				[`${where}[${i}]`]: ['expected { edge: "<declared relation>" , … }'],
			})
		return {
			edge: obj.edge,
			where: parseWhere(obj.where, `${where}[${i}].where`),
			range: parseRange(obj.range, `${where}[${i}].range`),
			required: obj.required === true,
			traverse: parseTraversals(obj.traverse, `${where}[${i}].traverse`),
		}
	})
}

/**
 * The wire shape → a {@link QuerySpec}, refusing anything that is not what it
 * claims to be.
 *
 * It lives here rather than in `mcp.ts` so the *only* thing a surface has to do
 * to expose this safely is hand over its arguments: a route or a second protocol
 * that parsed its own would be a second place for "a scalar filter" to mean
 * something slightly different.
 */
export function parseQuerySpec(args: Record<string, unknown>): QuerySpec {
	if (typeof args.resource !== 'string' || args.resource === '')
		throw new ValidationError({
			resource: ['a resource name is required — describe_resources lists them'],
		})
	const orderDir = args.orderDir === 'desc' ? 'desc' : undefined
	return {
		resource: args.resource,
		where: parseWhere(args.where, 'where'),
		range: parseRange(args.range, 'range'),
		traverse: parseTraversals(args.traverse, 'traverse'),
		limit: typeof args.limit === 'number' ? args.limit : undefined,
		offset: typeof args.offset === 'number' ? args.offset : undefined,
		orderBy: typeof args.orderBy === 'string' ? args.orderBy : undefined,
		...(orderDir ? { orderDir } : {}),
	}
}

/**
 * Run one bounded, gated, cross-resource read.
 *
 * See the module header for the authorization, tenancy and "not SQL" arguments;
 * see {@link QUERY_LIMITS} for the caps.
 */
export async function opQuery(
	ctx: OpContext,
	spec: QuerySpec,
): Promise<QueryResult> {
	const entry = resolveEntry(ctx.registry, spec.resource)
	// A portal declares a projection over one resource and declares nothing about
	// what may be reached through it. Refused before anything is read, on
	// `opRenderDocument`'s and `planImport`'s reasoning.
	if (ctx.user?.portal) throw new PermissionError(spec.resource, 'read')
	// The root's own gate first, so an unreadable root refuses with the same error
	// `list_records` would give — before the traversal tree discloses anything
	// about which edges exist.
	await authorize(
		entry.resource.name,
		entry.config.access,
		'read',
		createAccessContext(ctx.user),
	)
	tenantOf(entry, ctx.user ?? null, entry.resource.name, 'read')
	assertPredicateColumns(entry, spec.where, spec.range)
	if (spec.orderBy !== undefined)
		assertPredicateColumns(entry, { [spec.orderBy]: null }, undefined)
	await assertTraversalReadable(ctx, entry, spec.traverse, 1, { edges: 0 })

	const limit = Math.min(
		Math.max(1, Math.trunc(spec.limit ?? QUERY_LIMITS.defaultLimit)),
		QUERY_LIMITS.maxLimit,
	)
	const offset = Math.max(0, Math.trunc(spec.offset ?? 0))
	const run: QueryRun = { ctx, reads: 0, truncated: false }
	const rows: QueryRow[] = []
	let scanned = 0
	// The root is read in pages, and a `required` edge filters *after* the read —
	// so filling one page of answers can cost several pages of candidates. The
	// scan is capped rather than repeated until it fills, because "keep reading
	// until the page is full" is the unbounded scan this tool must not become.
	const page = Math.min(QUERY_LIMITS.maxRootScan, Math.max(limit, 50))
	while (rows.length < limit && scanned < QUERY_LIMITS.maxRootScan) {
		if (!spendRead(run)) break
		const batch = await opList(ctx, spec.resource, {
			filter: spec.where ?? undefined,
			range: spec.range,
			orderBy: spec.orderBy,
			orderDir: spec.orderDir,
			limit: Math.min(page, QUERY_LIMITS.maxRootScan - scanned),
			offset: offset + scanned,
		})
		if (batch.length === 0) break
		scanned += batch.length
		for (const record of batch) {
			if (rows.length >= limit) break
			const row = spec.traverse?.length
				? await hydrate(run, entry, record, spec.traverse, 1)
				: { record }
			if (!satisfiesRequired(row, spec.traverse)) continue
			rows.push(row)
		}
		if (batch.length < page) break
		if (run.truncatedBy === 'storeReads') break
	}
	if (rows.length < limit && scanned >= QUERY_LIMITS.maxRootScan) {
		run.truncated = true
		run.truncatedBy ??= 'rootScan'
	}
	return {
		resource: spec.resource,
		rows,
		scanned,
		truncated: run.truncated,
		...(run.truncatedBy ? { truncatedBy: run.truncatedBy } : {}),
	}
}
