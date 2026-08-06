/**
 * Access control. See the reference design.
 *
 * Vocabulary: 'public' | 'authenticated' | 'admin' | 'owner', or a custom
 * predicate. Enforcement is **open by default** — an action with no rule is
 * allowed (matches the specbase original; a deliberate, documented choice, not
 * an oversight). Owner checks match `user.id` against the conventional owner
 * columns and require a row.
 */

import type { PortalAudience } from './portals.ts'

export type SproutAction = 'read' | 'create' | 'update' | 'delete'

/**
 * Where the identity on this request came from. Stamped on audit entries so key
 * use is distinguishable from a human session and from an agent's MCP session
 * — three very different things to see in a log, and previously
 * all recorded as the same bare `userId`.
 */
export type IdentityOrigin =
	| 'session'
	| 'api-key'
	| 'mcp'
	| 'system'
	/**
	 * A declared public/token/role-scoped surface. Its own origin
	 * because "a row was created by somebody who has never signed in" is a very
	 * different fact from any of the four above, and previously there was no way
	 * to record it at all. The identity's `id` names the portal and the
	 * credential, so an audit line points at the exact link to revoke.
	 */
	| 'portal'

/**
 * What an api key is allowed to do: resource name → the actions granted on it.
 * A resource absent from the map is a resource the key cannot touch at all.
 *
 * This is a *restriction* on the holder, never a grant. See {@link scopeGrants}.
 */
export type ApiKeyScope = Record<string, SproutAction[]>

/**
 * What a declared portal lets one request do — the *narrowing* an
 * outside identity carries with it.
 *
 * Deliberately modelled on {@link ApiKeyScope}, and for exactly the same reason:
 * enforcement has to live at a depth every caller reaches. Issue #186 found that
 * `/mcp` and the admin loaders reach the data layer without passing any
 * route-level gate, which is why a key's scope moved into `canPerformAction`.
 * Public exposure is the same problem with a worse blast radius, so it lives in
 * the same place — see {@link portalGrants}.
 *
 * Everything on it is already *grounded*: column names rather than field ids,
 * because the spec's ids mean nothing to the store and a translation performed
 * at enforcement time would be a second place the projection could be wrong.
 */
export interface PortalIdentity {
	/** The declared portal's key — the URL segment, the audit label, the bucket. */
	portalKey: string
	/** The single resource this identity may reach. Anything else is denied. */
	resource: string
	audience: PortalAudience
	/** Column names the outside may READ. Everything else is dropped from a row. */
	readFields: string[]
	/**
	 * Per-action write allowlists, with the declared hourly budget.
	 *
	 * The budget rides on the identity rather than being looked up at write time
	 * because the write op is where it must be spent, and the write op has no way
	 * to reach the spec. A portal write with no limiter wired is **refused**, not
	 * allowed — see `opCreate`.
	 */
	writes: {
		action: 'create' | 'update'
		fields: string[]
		rateLimitPerHour: number
	}[]
	scope: 'row' | 'collection'
	/** For `row` scope: the ONE row id this identity may reach. */
	rowId?: string
	/** For `collection` scope: the grounded bound, forced after any caller filter. */
	filter?: { field: string; equals: string | number | boolean }
}

export interface SproutUser {
	id: string
	role?: string | null
	/** Active organization for tenant-scoped resources (d-tenancy-model). Set
	 * per-request by the app (org switcher + membership check), never by the
	 * client directly. */
	orgId?: string | null
	/**
	 * Present only on an api-key identity. The permission layer intersects every
	 * check with it, so a key can only ever do *less* than the person who issued
	 * it — see {@link scopeGrants}.
	 */
	apiKeyScope?: ApiKeyScope
	/** The key's row id, for rate-limit bucketing and audit attribution. */
	apiKeyId?: string
	/**
	 * Present only on a portal identity. The permission layer
	 * intersects every check with it and the read/write ops project every row
	 * through it, so a portal can only ever do *less* than the declaration allows
	 * — and, unlike everything else in this module, is **closed by default**. See
	 * {@link portalGrants}.
	 */
	portal?: PortalIdentity
	origin?: IdentityOrigin
	/**
	 * Set **only** by a declared source's run, to the source's key.
	 *
	 * It grants nothing — the permission layer never reads it. It exists so that
	 * "this write came from a source run" is a fact an identity carries and the
	 * ops stamp onto the audit entry, rather than something a reader infers from
	 * `origin === 'system'`. The enrichment trigger needs exactly that fact: an
	 * enrichment's own write is a write on the entity it enriches, so without a
	 * way to recognize it, a source with an `update` trigger enriches its own
	 * output forever. Inferring it from `origin` made the loop guard a property
	 * of a one-word convention that any other background writer could break by
	 * adopting the same origin for its own good reasons.
	 */
	sourceKey?: string
	[key: string]: unknown
}

export interface AccessContext {
	user: SproutUser | null
	row?: Record<string, unknown>
}

export type AccessShortcut = 'public' | 'authenticated' | 'admin' | 'owner'
export type AccessRule = (ctx: AccessContext) => boolean | Promise<boolean>
export type Access = AccessShortcut | AccessRule

export type ResourceAccess = Partial<Record<SproutAction, Access>>

/** Conventional owner columns, in priority order. Exported so
 * anything that needs to find "this user's rows" on an arbitrary resource
 * can reuse the exact convention `owner`
 * access checks use, instead of re-declaring it. */
export const OWNER_FIELDS = ['userId', 'authorId', 'owner', 'ownerId'] as const

// No parameter properties: strip-only type stripping (see operations.ts).
export class PermissionError extends Error {
	readonly resource: string
	readonly action: SproutAction

	constructor(resource: string, action: SproutAction) {
		super(`Permission denied: ${action} on ${resource}`)
		this.name = 'PermissionError'
		this.resource = resource
		this.action = action
	}
}

export function createAccessContext(
	user: SproutUser | null,
	row?: Record<string, unknown>,
): AccessContext {
	return { user, row }
}

export function expandShortcut(shortcut: AccessShortcut): AccessRule {
	switch (shortcut) {
		case 'public':
			return () => true
		case 'authenticated':
			// A PORTAL identity is not a session. This is the one place
			// the distinction has to be spelled out, and getting it wrong here would
			// be the quietest possible hole: a synthetic user object built for a
			// public URL is truthy, so `!!user` would have read every anonymous
			// portal visitor as authenticated, and every rule anybody has ever
			// written as "authenticated" would have admitted them. Nobody writing
			// that word ever meant "or anybody who followed a link". A `role` portal
			// IS a real session — the role gated entry — so it stays authenticated.
			return ({ user }) =>
				!!user && (user.portal === undefined || user.portal.audience === 'role')
		case 'admin':
			return ({ user }) => user?.role === 'admin'
		case 'owner':
			return ({ user, row }) => {
				if (!user || !row) return false
				for (const field of OWNER_FIELDS) {
					if (field in row) return row[field] === user.id
				}
				return false
			}
		default: {
			const exhaustive: never = shortcut
			throw new Error(`Unknown access shortcut: ${String(exhaustive)}`)
		}
	}
}

function toRule(access: Access): AccessRule {
	return typeof access === 'function' ? access : expandShortcut(access)
}

/**
 * The public spelling of {@link toRule} — an `Access` (shortcut or predicate) as
 * a callable rule.
 *
 * Exported for `accessWithPortals` in `from-spec.ts`, which has to *wrap* an
 * existing rule rather than replace it, and must not re-implement the shortcut
 * expansion to do so. Two expansions of `'authenticated'` is one more than is
 * safe now that the word excludes portal identities.
 */
export function toAccessRule(access: Access): AccessRule {
	return toRule(access)
}

/**
 * Does this identity's api-key scope permit `action` on `resource`?
 *
 * Three properties, in order of how easy they are to get wrong:
 *
 *   1. **A session is unaffected.** No `apiKeyScope` ⇒ `true`, so this composes
 *      as a pure narrowing on top of the resource's own rule.
 *   2. **It is a filter, never a grant.** Callers evaluate the resource's own
 *      `Access` rule *as well*; a scope entry cannot make a denied action
 *      allowed. This is what makes a key structurally incapable of escalating
 *      past the person who issued it — the scope only ever removes.
 *   3. **It is closed by default.** An api-key identity is denied on any
 *      resource the scope does not name, *including* resources with no access
 *      rule at all. Everything else in this module is open-by-default; keys are
 *      the deliberate exception, because "the resource had no rule yet" must not
 *      be how a scoped credential reaches a new table.
 */
export function scopeGrants(
	user: SproutUser | null | undefined,
	resource: string,
	action: SproutAction,
): boolean {
	const scope = user?.apiKeyScope
	if (!scope) return true
	return scope[resource]?.includes(action) === true
}

/**
 * Does this identity's portal permit `action` on `resource`?
 *
 * Beside {@link scopeGrants}, wired into `canPerformAction` and `authorize`
 * *before* the resource's own rule, and with the same three properties — stated
 * in the order they are easy to get wrong:
 *
 *   1. **A non-portal identity is unaffected.** No `user.portal` ⇒ `true`, so
 *      this composes as a pure narrowing on top of everything else. A session, an
 *      api key and an MCP call all behave exactly as they did before this layer
 *      existed.
 *   2. **It is a filter, never a grant.** Callers evaluate the resource's own
 *      `Access` rule *as well*, so a portal cannot reach something the resource
 *      denies. The *grant* — the thing that makes a public read legal at all —
 *      is produced by `from-spec.ts` from the declaration, where it is visible in
 *      the exposure report. Keeping the two separate is what stops this function
 *      from ever being the reason something became reachable.
 *   3. **It is closed by default, and this is the whole point.** A portal
 *      identity is denied on any resource other than its own, and on any action
 *      its portal did not declare — *including resources with no access rule at
 *      all.* Everything else in this module is open-by-default; portals, like api
 *      keys, are the deliberate exception, because "the entity had no rule yet"
 *      must never be how the internet reaches a new table. A new entity added
 *      next month is unreachable by every existing portal, with nobody having to
 *      remember anything.
 *
 * And one property api keys do not have: **`delete` is never grantable.** Not a
 * declaration, not a spelling, no path. The spec vocabulary has no `delete`
 * write action, and this function refuses it a second time — so adding one to
 * the vocabulary later would still not make it reachable without deliberately
 * removing this line.
 */
export function portalGrants(
	user: SproutUser | null | undefined,
	resource: string,
	action: SproutAction,
): boolean {
	const portal = user?.portal
	if (!portal) return true
	if (action === 'delete') return false
	if (resource !== portal.resource) return false
	if (action === 'read') return true
	return portal.writes.some((w) => w.action === action)
}

/**
 * Resolve whether an action is allowed. Open by default: no rule → allowed
 * (but see {@link scopeGrants} and {@link portalGrants} — an api-key identity and
 * a portal identity are both closed by default).
 *
 * `resourceName` is required rather than optional precisely because the scope
 * gate lives here: an optional argument would make forgetting it fail *open*.
 */
export async function canPerformAction(
	resourceName: string,
	access: ResourceAccess | undefined,
	action: SproutAction,
	ctx: AccessContext,
): Promise<boolean> {
	if (!scopeGrants(ctx.user, resourceName, action)) return false
	if (!portalGrants(ctx.user, resourceName, action)) return false
	const rule = access?.[action]
	if (rule === undefined) return true
	try {
		return await toRule(rule)(ctx)
	} catch {
		// A throwing rule denies (used for UI gating); authorize() surfaces it.
		return false
	}
}

/** Per-action allow flags for one resource — the UI's read of what a session may
 * do. `read` gates whether the resource is listed/shown at all; `create`/
 * `update`/`delete` gate the corresponding affordances (New button, edit link,
 * delete/bulk-delete). Computed with the same rules the server enforces, so the
 * UI stops offering exactly what `authorize()` would reject. */
export interface ResourceCapabilities {
	read: boolean
	create: boolean
	update: boolean
	delete: boolean
}

/** Resolve every action's allow flag for a resource in one pass. Pass a `row` in
 * the context to evaluate row-level (`owner`) rules against a specific record;
 * omit it for list-level capabilities (an `owner` rule then reads as denied,
 * matching a row-less list where ownership can't be known). */
export async function resourceCapabilities(
	resourceName: string,
	access: ResourceAccess | undefined,
	ctx: AccessContext,
): Promise<ResourceCapabilities> {
	const [read, create, update, del] = await Promise.all([
		canPerformAction(resourceName, access, 'read', ctx),
		canPerformAction(resourceName, access, 'create', ctx),
		canPerformAction(resourceName, access, 'update', ctx),
		canPerformAction(resourceName, access, 'delete', ctx),
	])
	return { read, create, update, delete: del }
}

/**
 * Enforce an action, throwing `PermissionError` when denied.
 *
 * Three gates, and the order matters only for which one you see in the message:
 * the api-key scope (a narrowing, closed by default), the portal narrowing
 * (also closed by default), and then the resource's own rule (open
 * by default). All three must pass. Every mutation and read in `operations.ts`
 * funnels through here, which is why both narrowings live at this depth rather
 * than in the REST routes that used to own the first one — the MCP endpoint and
 * the admin loaders reach `operations.ts` without passing any route-level gate
 * at all.
 */
export async function authorize(
	resourceName: string,
	access: ResourceAccess | undefined,
	action: SproutAction,
	ctx: AccessContext,
): Promise<void> {
	if (!scopeGrants(ctx.user, resourceName, action)) {
		throw new PermissionError(resourceName, action)
	}
	if (!portalGrants(ctx.user, resourceName, action)) {
		throw new PermissionError(resourceName, action)
	}
	const rule = access?.[action]
	if (rule === undefined) return
	const allowed = await toRule(rule)(ctx)
	if (!allowed) throw new PermissionError(resourceName, action)
}
