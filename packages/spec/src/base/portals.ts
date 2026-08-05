/**
 * Public and token-scoped surfaces — "portals". The declared
 * *outside* of an app whose every other derived surface is an authenticated
 * admin.
 *
 * Two corpus asks fix the shape: blog's *"a themed public micro-site per
 * author"* and invoicer's *"a client portal to view … invoices online"*. Both
 * were frozen as `eject`, and both are the same missing idea — the platform had
 * no notion of a page over its own data that is reachable by somebody who is not
 * a member of the app.
 *
 * ## Where enforcement lives, and why it is not the route
 *
 * **Nothing in this layer is enforced by a route, and a design where "the public
 * route only selects these columns" is wrong.** Issue #186 established the
 * reason mechanically rather than as a matter of taste: `/mcp` and the admin
 * loaders reach the data layer *without passing any route-level gate at all*.
 * That is why api-key scoping lives inside `canPerformAction` rather than in the
 * REST handlers, and public exposure has to live at the same depth or deeper —
 * inside the permission layer (`portalGrants`) and inside the read/write ops
 * (`projectForPortal`, the forced portal filter). A route that filtered columns
 * would be a second, weaker copy of the rule, and the second copy is the one
 * that gets skipped.
 *
 * The rendered portal route (`/p/:key`) therefore contains **no filtering, no
 * column selection and no access check**. It builds a {@link PortalSpec}-derived
 * identity from whatever credential arrived and calls the ordinary ops. A test
 * asserts the route module does not import the store.
 *
 * ## The four refusals this layer is built out of
 *
 * 1. **Projection is opt-in per field, and there is no "all except."** An
 *    exclusion list silently exposes every field added *after* it was written,
 *    which is exactly the failure this layer exists to prevent: somebody adds
 *    `internalNotes` in six months and it is public the moment it is declared.
 *    {@link PortalSpec.readFields} is therefore a required, non-empty allowlist,
 *    and there is deliberately no spelling of "everything".
 * 2. **A collection portal is never unbounded.** {@link PortalSpec.filter} is
 *    required for `collection` scope. "The outside can list this table" is not a
 *    feature anybody means to ship; "the outside can list the *published* posts
 *    of *this* author" is.
 * 3. **Anonymous `update` is unspellable.** A `public` portal may declare
 *    `create` (a comment, a contact form) under a required hourly budget, but
 *    `update` is refused outright: anonymous update means anyone on the internet
 *    may edit a row that already exists, and there is no honest product reason to
 *    spell that as a declaration. Paying an invoice is a `token` portal, because
 *    the client has a link that only they were sent.
 * 4. **A portal token always expires.** {@link PortalTokenPolicy.ttlHours} is
 *    required and bounded; there is no non-expiring portal token, and no default
 *    that would produce one by omission.
 *
 * ## What a portal deliberately is not
 *
 * **Not a second serializer.** The fields a portal exposes are the entity's own
 * columns, read through the same ops the admin uses. Nothing here describes how
 * a value is formatted; that is the field's declared type, as everywhere else.
 *
 * **Not a theme.** {@link PortalSpec.layout} picks one of #127's existing block
 * variants and nothing more. A micro-site's *look* is `theme.set`, so a portal
 * is a themed derived page rather than an ejected one — which is the whole of
 * what the blog ask was reaching for.
 *
 * **Not an auth system.** A `role` portal is an ordinary session whose role the
 * portal names. A `token` portal is a credential minted, hashed, expired and
 * revoked by the api-keys bundle, which already owns every one of those verbs.
 * This layer stores no secret and mints nothing.
 *
 * **Not a delete path.** `delete` is not a grantable action for a portal
 * identity — not a declaration, not a spelling, no path. See `portalGrants`.
 */

import type { EntityId, FieldId, ISODate, PortalId } from './ids.ts'
import type { Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

// ===========================================================================
// The declaration
// ===========================================================================

/**
 * Who is on the other side of a portal.
 *
 * - `public` — nobody. No credential of any kind; the URL is the whole of it.
 * - `token` — one holder of one minted, expiring, revocable link. The client a
 *   freelancer sent an invoice to.
 * - `role` — an ordinary signed-in session whose role matches. Not an outside at
 *   all, strictly, but the same declaration answers "which columns may a
 *   support agent see", and having one vocabulary for that is better than
 *   having two.
 */
export type PortalAudience = 'public' | 'token' | 'role'

/** Runtime guard for {@link PortalAudience} — ops arrive as JSON. */
export const PORTAL_AUDIENCES = [
	'public',
	'token',
	'role',
] as const satisfies readonly PortalAudience[]

/**
 * How much of the entity a portal reaches.
 *
 * - `row` — exactly one row, named by the token that opened it.
 * - `collection` — the rows a declared filter admits, and no others.
 */
export type PortalScope = 'row' | 'collection'

/** Runtime guard for {@link PortalScope}. */
export const PORTAL_SCOPES = [
	'row',
	'collection',
] as const satisfies readonly PortalScope[]

/**
 * How the portal renders. Presentation only, drawn from issue #127's existing
 * block-variant vocabulary — **it never affects what is exposed.** Two portals
 * with the same `readFields` and different layouts leak exactly the same data,
 * which is why the exposure report does not mention it.
 */
export type PortalLayout = 'detail' | 'cards' | 'feed' | 'table'

/** Runtime guard for {@link PortalLayout}. */
export const PORTAL_LAYOUTS = [
	'detail',
	'cards',
	'feed',
	'table',
] as const satisfies readonly PortalLayout[]

/**
 * A write the outside may perform, opt-in per field.
 *
 * `fieldIds` is an allowlist for the same reason `readFields` is, sharpened: a
 * write list with an exclusion in it would let a field added later be *set* from
 * the internet. There is no "all", and a payload naming a field outside this
 * list is **refused rather than silently stripped** — a caller who thinks their
 * value landed and finds it did not is worse off than one who got an error.
 */
export interface PortalWrite {
	action: 'create' | 'update'
	/** Opt-in per field. No "all", no "all except". At least one. */
	fieldIds: FieldId[]
	/**
	 * Writes from the outside are always budgeted. **Required, never defaulted**
	 * — an unbudgeted anonymous write path is a free row generator, and the
	 * decision about how many an hour is acceptable belongs to whoever owns the
	 * table rather than to whoever wrote the default.
	 *
	 * Enforced at the op, not at the route: `opCreate`/`opUpdate` under a portal
	 * identity **refuse outright when no limiter is wired**, so a host that
	 * forgot to configure one gets no writes rather than unlimited ones.
	 *
	 * **This number is per deployment when the store is Postgres, and per process
	 * otherwise**. It used to be per process unconditionally: the limiter held
	 * its buckets in one process's memory, so two instances behind a load
	 * balancer served this portal at twice the declared budget and three at three
	 * times — silently, because each instance was individually obeying it.
	 * Buckets now live in the shared coordinator, which is Postgres
	 * `maxstack_rate_bucket` on a Postgres backend and this process's memory on
	 * pglite, where a second instance cannot exist at all. So the honest reading
	 * of this field is "per hour" on the deployment shape that can scale out, and
	 * the mode is logged at boot rather than left to be inferred.
	 *
	 * The bucket a caller lands in is a separate question, and one with a real
	 * answer: see `clientIdOf` in `apps/web/app/portals.server.ts`. An anonymous
	 * caller's bucket is derived from a forwarding header only when the operator
	 * has declared how many proxies to trust, because an unverified header is
	 * caller-controlled and trusting it lets one caller mint unlimited buckets.
	 */
	rateLimitPerHour: number
}

/** Runtime guard for the actions a portal write may name. */
export const PORTAL_WRITE_ACTIONS = ['create', 'update'] as const

/**
 * The lifetime of a portal token. Required whenever
 * {@link PortalSpec.audience} is `token`.
 *
 * There is no non-expiring portal token, and no default — a link somebody
 * emailed a client in 2024 is a credential that has been sitting in a mail
 * archive ever since, and the only thing that reliably closes it is an expiry
 * declared at mint time.
 */
export interface PortalTokenPolicy {
	/** Required. There is no non-expiring portal token. 1..{@link MAX_PORTAL_TOKEN_TTL_HOURS}. */
	ttlHours: number
	/**
	 * Optional hard use cap; `null` = unlimited uses within the TTL.
	 *
	 * Nullable rather than optional for `upsertFieldId`'s reason: `null` is a
	 * recorded decision that this link may be opened any number of times before
	 * it expires, and an absent value would be an author who has not decided.
	 */
	maxUses: number | null
}

/**
 * A declared portal.
 *
 * **Several portals per entity are allowed and expected.** A public archive and
 * a client portal are two different outsides on one table, with different
 * audiences, different projections and different write surfaces — the same
 * cardinality a document template has, and for the same reason: the declaration
 * describes an *audience*, and a table can face more than one.
 */
export interface PortalSpec extends Provenanced {
	id: PortalId
	/**
	 * The URL segment (`/p/<key>`), and the string every audit entry and every
	 * rate-limit bucket is keyed on. Separate from {@link id} for the reason a
	 * source's or an importer's key is: it is what a person types and a support
	 * ticket quotes.
	 */
	key: string
	/**
	 * What this portal is for, in one line. Rendered in the exposure report, in
	 * `maxstack validate`'s table and in the workbench — a portal nobody can
	 * explain is a portal nobody can decide to pause.
	 */
	description: string
	entityId: EntityId
	audience: PortalAudience
	/** Required iff `audience === 'role'`; refused otherwise. */
	role?: string
	/** Required iff `audience === 'token'`; refused otherwise. */
	token?: PortalTokenPolicy
	scope: PortalScope
	/**
	 * Opt-in field projection. At least one field, at most
	 * {@link MAX_PORTAL_FIELDS}.
	 *
	 * There is deliberately no "expose everything" spelling and no exclusion
	 * list — an "all except" list silently exposes every field added after it was
	 * written, which is the exact failure this layer exists to prevent. The
	 * runtime rebuilds each row from this list plus the primary key and drops
	 * every other key, including derived values that were not
	 * declared, the soft-delete column and the tenant column.
	 */
	readFields: FieldId[]
	/**
	 * Required for `collection` scope, refused for `row` scope: the bound on
	 * which rows the outside can enumerate. **A collection portal is never
	 * unbounded.**
	 *
	 * It is forced *after* any caller-supplied filter, exactly as the tenant and
	 * soft-delete scopes are, so nothing a caller sends can widen it. On a
	 * `create` the filter column is **server-stamped**, so a portal cannot create
	 * a row outside its own bound — which is what keeps a public comment form
	 * from being a way to write rows nobody's portal can see.
	 */
	filter?: { fieldId: FieldId; equals: string | number | boolean }
	/** Opt-in writes. An empty array is read-only, and that is the common case. */
	writes: PortalWrite[]
	/**
	 * Presentation only, from issue #127's vocabulary. **Never affects what is
	 * exposed.** A `row` portal is a `detail`; a `collection` portal is one of the
	 * three list shapes.
	 */
	layout: PortalLayout
	/**
	 * Whether the portal is reachable. **Required, never defaulted** — on the same
	 * posture `SourceSpec.paused` and `ImporterSpec.paused` take, and here it is
	 * the strongest instance: this is the flag somebody flips at 3am, and it must
	 * not require removing anything. `portals.pause` keeps the declaration, the
	 * projection and the minted tokens; it simply stops answering.
	 */
	paused: boolean
	/** The day the portal was declared, stamped by `applyOp` from `appliedAt`. */
	declaredAt: ISODate
}

export interface PortalsSpec {
	portals: PortalSpec[]
}

// ===========================================================================
// Shapes and bounds
// ===========================================================================

/** A portal key: the same shape as an importer's or an index's, for the same reasons. */
export const PORTAL_KEY_RE = /^[a-z][a-z0-9-]*$/

/**
 * How long a portal key may be. It is a URL segment, an audit label and a
 * rate-limit bucket name; 48 matches the importer and search-index bounds.
 */
export const MAX_PORTAL_KEY_LENGTH = 48

/**
 * How many fields one portal may expose.
 *
 * A bound rather than a limit anybody will meet: past this the projection is no
 * longer something a reviewer reads before approving, and an exposure report
 * nobody reads is the same as no exposure report. Thirty-two is comfortably
 * wider than any real public surface and narrow enough to print.
 */
export const MAX_PORTAL_FIELDS = 32

/**
 * The ceiling on {@link PortalTokenPolicy.ttlHours} — one year.
 *
 * Not "as long as you like." A year is already a long time for a link in a mail
 * archive, and a bound that can be stated is a bound the exposure report can
 * show. Beyond a year the honest answer is an account, not a link.
 */
export const MAX_PORTAL_TOKEN_TTL_HOURS = 8760

/**
 * The most an **unauthenticated** write path may declare per hour.
 *
 * Ten a minute is a comment form or a contact form. It is not an ingestion
 * endpoint, and the difference matters because the budget is the only thing
 * standing between a public `create` and an unbounded row generator: everything
 * else about the write (validation, tenancy, per-value caps) constrains *what*
 * is written rather than *how much*.
 */
export const MAX_PUBLIC_WRITE_RATE = 600

/** The ceiling on any portal write's hourly budget, public or not. */
export const MAX_PORTAL_WRITE_RATE = 100_000

/**
 * The field types a portal may expose or accept, and every exclusion is a way
 * something leaves the app that nobody declared:
 *
 * - `file` — refused for `public` and `token` audiences. A file column holds a
 *   **storage key**, and a storage key is an object path: publishing it hands
 *   out a URL into the bucket rather than a value. Serving a portal's images is
 *   a real capability and it is not this one.
 * - a reference to `e-user` — refused for `public` and `token` audiences. It is
 *   an identity-table primary key, and the one thing a public surface must never
 *   become is a way to enumerate the people who have accounts.
 *
 * `json` is allowed to be read but is a poor idea and reads as itself; there is
 * no traversal, so exposing one exposes the whole document, which the report
 * says plainly.
 */
export const portalFilterFieldTypes: readonly string[] = [
	'string',
	'number',
	'boolean',
	'enum',
]

// ===========================================================================
// Reading the layer
// ===========================================================================

/** Every declared portal, or `[]` for a spec that has never declared one. */
export function listPortals(spec: Pick<SpecSystem, 'portals'>): PortalSpec[] {
	return spec.portals?.portals ?? []
}

/**
 * The portals a runtime will actually answer on: **accepted only**, minus the
 * paused ones.
 *
 * This is a deliberate departure from `activeImporters`/`activeSources`, which
 * use `getAcceptedOrAll` — accepted rows, *falling back to every row when none
 * is accepted*. That fallback is a convenience everywhere else: it lets a fresh,
 * entirely-suggested spec still generate something to look at, and the worst
 * case is an admin page nobody asked for.
 *
 * Here the worst case is a public surface nobody reviewed. An agent that
 * proposes `portals.declare` on a spec with no other portal would, under
 * accepted-else-all, have put somebody's table on the internet by suggesting it
 * — which is default-*open*, and default deny is the first non-negotiable of the
 * issue this layer closes. Consistency with a helper is not worth that, so the
 * fallback is dropped and the asymmetry is recorded here rather than discovered
 * later.
 *
 * `manual()` provenance carries `isAccepted: true`, so a portal a person wrote
 * by hand is live immediately; only an unreviewed *suggestion* is not.
 */
export function activePortals(spec: Pick<SpecSystem, 'portals'>): PortalSpec[] {
	return listPortals(spec).filter(
		(p) => p.provenance.isAccepted === true && !p.paused,
	)
}

/** The declared portal with this key, if any. Keys are unique spec-wide. */
export function findPortal(
	spec: Pick<SpecSystem, 'portals'>,
	key: string,
): PortalSpec | undefined {
	return listPortals(spec).find((p) => p.key === key)
}

/** Every declared portal over one entity. */
export function portalsFor(
	spec: Pick<SpecSystem, 'portals'>,
	entityId: EntityId,
): PortalSpec[] {
	return listPortals(spec).filter((p) => p.entityId === entityId)
}

/**
 * One line of prose for a portal — the diff summary, the admin caption, the
 * workbench row.
 *
 * It always names the **audience** and the **field count**, because those are
 * the two facts a reviewer needs before this reaches the internet and the two
 * they are least likely to reconstruct from an id.
 */
export function describePortal(portal: PortalSpec): string {
	const writes =
		portal.writes.length === 0
			? 'read-only'
			: portal.writes.map((w) => w.action).join('+')
	const paused = portal.paused ? ', paused' : ''
	return `${portal.audience} ${portal.scope} over ${portal.entityId}, ${portal.readFields.length} field(s), ${writes}${paused}`
}

// ===========================================================================
// The exposure report — the review artifact
// ===========================================================================

/**
 * One field, reachable by one audience, one way.
 *
 * A row per (portal, field, access) rather than per portal, because the question
 * a reviewer is actually asking is "**can the internet see `salary`?**" and that
 * question is answered by grepping a flat list, not by reading a nested
 * structure.
 */
export interface ExposedField {
	portalId: PortalId
	portalKey: string
	audience: PortalAudience
	entityId: EntityId
	fieldId: FieldId
	access: 'read' | 'create' | 'update'
}

/**
 * Every field every declared portal exposes, flattened and sorted.
 *
 * **It reads only from the declarations**, which is what makes it incapable of
 * drifting from what the runtime enforces: the runtime grounds the same
 * `readFields`/`writes` arrays into column names and enforces exactly those. A
 * report assembled by walking the runtime would be a second implementation of
 * the projection, and two implementations of a security boundary is one more
 * than is safe. The property is pinned by an **agreement test** that builds a
 * portal, runs the ops, and asserts the keys of a returned row equal exactly the
 * fields this report lists as `read`.
 *
 * Paused portals are included and are *not* marked here: a paused portal is one
 * op away from being reachable, and a report that hid it would answer "what
 * could be exposed" with "what is exposed today". The renderers show the pause
 * state alongside.
 *
 * Deterministic order — portal key, then access, then field id — so a diff of
 * two reports is a diff of the exposure and not of the iteration.
 */
export function portalExposureReport(
	spec: Pick<SpecSystem, 'portals'>,
): ExposedField[] {
	const out: ExposedField[] = []
	for (const portal of listPortals(spec)) {
		const base = {
			portalId: portal.id,
			portalKey: portal.key,
			audience: portal.audience,
			entityId: portal.entityId,
		}
		for (const fieldId of portal.readFields)
			out.push({ ...base, fieldId, access: 'read' })
		for (const write of portal.writes)
			for (const fieldId of write.fieldIds)
				out.push({ ...base, fieldId, access: write.action })
	}
	const rank = { read: 0, create: 1, update: 2 }
	return out.sort(
		(a, b) =>
			a.portalKey.localeCompare(b.portalKey) ||
			rank[a.access] - rank[b.access] ||
			a.fieldId.localeCompare(b.fieldId),
	)
}

/**
 * The reviewable paragraph — what `maxstack validate` prints above its table and
 * what the workbench pane prints above its.
 *
 * It leads with the number of **unauthenticated** fields, because that is the
 * number somebody skimming a CI log needs to see, and it says "no portals" in
 * words rather than printing an empty table: an empty exposure report and a
 * missing exposure report look identical and mean opposite things.
 */
export function summarizeExposure(report: readonly ExposedField[]): string {
	if (report.length === 0)
		return 'No portals declared — nothing in this spec is reachable without a session.'
	const portals = new Set(report.map((r) => r.portalKey))
	const publicFields = report.filter(
		(r) => r.audience === 'public' && r.access === 'read',
	).length
	const publicWrites = report.filter(
		(r) => r.audience === 'public' && r.access !== 'read',
	).length
	const tokenFields = report.filter(
		(r) => r.audience === 'token' && r.access === 'read',
	).length
	const entities = new Set(report.map((r) => r.entityId))
	return (
		`${portals.size} portal(s) over ${entities.size} entit(y/ies): ` +
		`${publicFields} field(s) readable with no credential at all, ` +
		`${tokenFields} readable with a link, ` +
		`${publicWrites} writable with no credential.`
	)
}
