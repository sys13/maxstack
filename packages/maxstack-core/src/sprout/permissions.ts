/**
 * Access control. See the reference design.
 *
 * Vocabulary: 'public' | 'authenticated' | 'admin' | 'owner', or a custom
 * predicate. Owner checks match `user.id` against the conventional owner
 * columns and require a row.
 *
 * Enforcement is **open by default** — an action with no rule is allowed
 * (matches the specbase original; a deliberate, documented choice, not an
 * oversight) — *unless the app has declared otherwise*. That last clause is
 * new. The four strings above describe the **object** of a rule; they have
 * never been able to describe its **subject** beyond one hard-coded `admin`.
 * The `access` spec namespace declares roles, and {@link AccessPolicy} is how
 * that declaration reaches this module: a policy carries what an ungoverned
 * action does and what each declared role grants.
 *
 * Two properties keep the addition from being a new hole:
 *
 *   1. **It only ever widens, and only where nothing else spoke.** A role grant
 *      is consulted for exactly one case — an action with *no* rule, under a
 *      `deny` default. It cannot override a rule that denied, and it cannot
 *      loosen {@link scopeGrants} or {@link portalGrants}, both of which run
 *      first and stay closed by default.
 *   2. **It is registered, not threaded.** See {@link setAccessPolicy}. An
 *      optional per-call argument would mean any call site that forgot it fails
 *      *open* under a `deny` default — which is issue #186's finding wearing a
 *      new hat, since `/mcp` and the admin loaders reach this module by paths
 *      nobody remembers to audit.
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
	/**
	 * The single conventional role string the auth and members bundles already
	 * set. Still the input to the `admin` shortcut, and — since the `access`
	 * namespace landed — **also read as a held role key**, so a declared role
	 * whose key matches it works with no change to how an app builds its session.
	 * That is the composition answer: the identity model those bundles supply is
	 * the one this layer names, rather than a second one beside it.
	 */
	role?: string | null
	/**
	 * Additional role keys this identity holds, for the case one string cannot
	 * express. Unioned with {@link role}; order is not significant. Set from
	 * binding rows by the app, exactly as `orgId` is — this layer declares the
	 * shape of a role, never who holds one.
	 */
	roles?: string[] | null
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

/**
 * Which of the gates refused — the `rule` half of #450's refusal envelope.
 *
 * Four gates can produce an identical `403` today, and the caller's next move
 * differs for each: a key needs its scope widened, a portal link needs a
 * different one, a rule needs the row's owner, and a `deny` default needs a role
 * bound. Naming the gate is what turns "no" into "no, by *this*".
 */
export type PermissionGate =
	/** The api key's scope map does not grant this action on this resource. */
	| 'api-key-scope'
	/** The portal's narrowing does not grant it — closed by default. */
	| 'portal-scope'
	/** The resource's own declared rule for this action evaluated false. */
	| 'access-rule'
	/** No rule governs it and the app declared `deny`; no held role grants it. */
	| 'access-default'

// No parameter properties: strip-only type stripping (see operations.ts).
export class PermissionError extends Error {
	readonly resource: string
	readonly action: SproutAction
	/**
	 * Which gate said no. Optional because `operations.ts` throws this class from
	 * a dozen places that are narrowings of their own rather than one of the four
	 * gates below; those read as `access-rule`, which is what they are.
	 */
	readonly gate: PermissionGate

	constructor(
		resource: string,
		action: SproutAction,
		gate: PermissionGate = 'access-rule',
	) {
		super(`Permission denied: ${action} on ${resource}`)
		this.name = 'PermissionError'
		this.resource = resource
		this.action = action
		this.gate = gate
	}

	/**
	 * The refusal's `rule` id: what refused, named the way the spec names it.
	 *
	 * A string rather than a structure because it crosses to clients that will
	 * only ever log or display it, and because the gate and the resource are both
	 * already on the error for anything that wants to branch.
	 */
	get rule(): string {
		switch (this.gate) {
			case 'api-key-scope':
				return `api-key.scope.${this.resource}.${this.action}`
			case 'portal-scope':
				return `portal.scope.${this.resource}.${this.action}`
			case 'access-default':
				return 'access.default'
			default:
				return `access.${this.resource}.${this.action}`
		}
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

// ===========================================================================
// The declared access policy
// ===========================================================================

/**
 * What an action **no rule governs** does. Mirrors the spec's `AccessDefault`,
 * restated here rather than imported so this module keeps its property of
 * depending on nothing — see {@link setAccessPolicy}.
 */
export type AccessDefaultPosture = 'open' | 'deny'

/**
 * The declared access vocabulary, flattened for enforcement: what an ungoverned
 * action does, and what each role key grants.
 *
 * `grants` is already *expanded* — role-to-role bindings are resolved when the
 * policy is built, so a lookup here is one map read rather than a graph walk on
 * the hot path. It is also already *grounded*: resource names, not spec entity
 * ids, on the same argument `PortalIdentity` makes — a translation performed at
 * enforcement time is a second place the projection could be wrong.
 */
export interface AccessPolicy {
	default: AccessDefaultPosture
	/** role key → resource name → the actions that role grants on it. */
	grants: Record<string, Record<string, SproutAction[]>>
}

/**
 * The policy an app has before it declares one: the historical behaviour, which
 * is what every already-generated app relies on.
 */
export const OPEN_ACCESS_POLICY: AccessPolicy = { default: 'open', grants: {} }

/**
 * The registered policy.
 *
 * A module-level `let` with no initializer beyond a literal, deliberately, and
 * this module imports nothing but a type. Both are the same decision. The
 * standing posture of an access system has to be resolvable at boot, and a
 * bootstrap that participates in an import cycle is a bootstrap the cycle can
 * deny — this codebase has already shipped that failure once, as a module-level
 * const spreading a cross-package binding that died in its temporal dead zone.
 */
let registeredPolicy: AccessPolicy = OPEN_ACCESS_POLICY

/**
 * Register the app's declared access policy. Called once at boot, from the one
 * place that has the spec.
 *
 * **Registered rather than passed.** Every other narrowing in this module rides
 * on the identity, so it reaches the chokepoint no matter which of the fifteen
 * call sites got there. A policy has nothing to ride on — it is a property of
 * the app, not of the caller — and the alternative, an optional argument on
 * `authorize`, would mean any call site that forgot it fails **open** under a
 * `deny` default. That is exactly the shape of issue #186's finding: `/mcp` and
 * the admin loaders reach this module without passing anything a route arranged.
 * A global that cannot be forgotten beats a parameter that can.
 *
 * The cost is honest and worth naming: this is process-wide mutable state, so a
 * test that sets it must clear it — {@link resetAccessPolicy}.
 */
export function setAccessPolicy(policy: AccessPolicy): void {
	registeredPolicy = policy
}

/** The registered policy — {@link OPEN_ACCESS_POLICY} until one is set. */
export function getAccessPolicy(): AccessPolicy {
	return registeredPolicy
}

/** Restore the open default. For tests, and for an app tearing down a runtime. */
export function resetAccessPolicy(): void {
	registeredPolicy = OPEN_ACCESS_POLICY
}

/**
 * The role keys an identity holds: the conventional `role` string plus any
 * explicit `roles`, de-duplicated.
 *
 * Reading `role` here is what makes the namespace compose with the auth and
 * members bundles instead of competing with them — `role: 'admin'` has always
 * been a role, it just had nowhere to be declared.
 */
export function heldRoles(user: SproutUser | null | undefined): string[] {
	const held = new Set<string>()
	if (user?.role) held.add(user.role)
	for (const key of user?.roles ?? []) held.add(key)
	return [...held]
}

/**
 * Does a role this identity holds grant `action` on `resource`?
 *
 * The **grant** side of the module, and the only one. Everything else here
 * narrows; this widens, and it is consulted in exactly one place — an action
 * with no rule of its own, under a `deny` default. It can therefore never be
 * the reason a rule that said no was overridden.
 *
 * A portal identity holds no roles by construction: it is a synthetic identity
 * built for a URL, and it must not pick up authority from a `role` string an
 * app happened to stamp on it. Its own narrowing has already run and is closed
 * by default; this refuses it a second time, in the same spirit as
 * `portalGrants` refusing `delete` twice.
 */
export function policyGrants(
	user: SproutUser | null | undefined,
	resource: string,
	action: SproutAction,
	policy: AccessPolicy = registeredPolicy,
): boolean {
	if (user?.portal) return false
	for (const role of heldRoles(user)) {
		if (policy.grants[role]?.[resource]?.includes(action)) return true
	}
	return false
}

/**
 * Is an action **no rule governs** allowed for this identity?
 *
 * One function rather than the same three lines in `canPerformAction` and
 * `authorize`. Those two already duplicate the narrowing calls, and duplicating
 * the *default posture* as well would be the place the UI's read of what a
 * session may do drifts from what the server enforces.
 */
function ungovernedAllowed(
	user: SproutUser | null | undefined,
	resource: string,
	action: SproutAction,
): boolean {
	if (registeredPolicy.default === 'open') return true
	return policyGrants(user, resource, action)
}

/**
 * Resolve whether an action is allowed. Open by default: no rule → allowed
 * (but see {@link scopeGrants} and {@link portalGrants} — an api-key identity and
 * a portal identity are both closed by default; and see
 * {@link setAccessPolicy} — an app that has declared `deny` refuses an
 * ungoverned action unless a role the identity holds grants it).
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
	if (rule === undefined)
		return ungovernedAllowed(ctx.user, resourceName, action)
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
 * (also closed by default), and then the resource's own rule — open by default,
 * or, where the app declared `deny`, granted by a role the identity holds. All
 * three must pass. Every mutation and read in `operations.ts`
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
		throw new PermissionError(resourceName, action, 'api-key-scope')
	}
	if (!portalGrants(ctx.user, resourceName, action)) {
		throw new PermissionError(resourceName, action, 'portal-scope')
	}
	const rule = access?.[action]
	if (rule === undefined) {
		if (!ungovernedAllowed(ctx.user, resourceName, action))
			throw new PermissionError(resourceName, action, 'access-default')
		return
	}
	const allowed = await toRule(rule)(ctx)
	if (!allowed) throw new PermissionError(resourceName, action, 'access-rule')
}
