/**
 * Portals at the runtime layer — the grounded shape of a declared
 * public surface, and the one function that turns it into an identity.
 *
 * The spec layer (`@maxstack/spec`'s `portals.ts`) owns *what may be declared*.
 * This module owns the projection from field ids to column names, and nothing
 * else: the enforcement lives in `permissions.ts` (`portalGrants`) and in
 * `operations.ts` (`projectForPortal`, the forced bound, the write allowlist),
 * because those are the layers every caller reaches — REST, MCP, the admin
 * loaders and the portal route alike.
 *
 * **There is deliberately no `enforcePortal(request)` here, and no helper a
 * route could call to "check the portal".** Issue #186's finding was that a
 * route-level gate is a gate the other callers skip; offering one from this
 * module would be an invitation to re-create exactly that. What a route gets is
 * {@link portalIdentity}, which *narrows* the caller — and a narrowing is safe to
 * forget in a way a gate is not, because forgetting it produces an ordinary
 * authenticated call rather than an unchecked public one.
 */

import type { PortalIdentity, SproutUser } from './permissions.ts'

// `@maxstack/core` does not depend on `@maxstack/spec` (see `from-spec.ts`), so
// the three presentation-free unions the spec layer defines are restated here.
// They are string literals with no behaviour, and the pair is pinned by the
// grounding layer in `apps/web/app/spec-sprout.ts`, which assigns one to the
// other and would not compile if they drifted.
export type PortalAudience = 'public' | 'token' | 'role'
export type PortalScope = 'row' | 'collection'
export type PortalLayout = 'detail' | 'cards' | 'feed' | 'table'

/**
 * A declared portal with the spec's field ids already resolved to column names.
 *
 * Rides on `ResourceConfig` exactly as `search`, `documents` and `importers` do,
 * which is what puts it at the depth `authorize()` runs at.
 */
export interface PortalPlan {
	key: string
	description: string
	/** The Sprout resource this portal faces outward. */
	resource: string
	audience: PortalAudience
	/** Present iff `audience === 'role'`. */
	role?: string
	/** Present iff `audience === 'token'`. */
	token?: { ttlHours: number; maxUses: number | null }
	scope: PortalScope
	/** Column names, in declaration order. */
	readFields: string[]
	/**
	 * The exposed column whose value titles a row page — `pickTitleField`'s pick
	 * (name > title > first plain string, never a foreign key, #43), **restricted
	 * to {@link readFields}**.
	 *
	 * The restriction is the point rather than an optimization. Picking over the
	 * entity's full field list would let a column the portal deliberately does not
	 * expose appear in a `<title>` and an OG card, which is a projection leak
	 * through the one surface that gets scraped, cached and archived by strangers.
	 * The projection is an allowlist everywhere else in this layer; it is one here
	 * too.
	 *
	 * Absent when the portal exposes no plain string column, in which case a row
	 * page falls back to the portal's own label.
	 */
	titleField?: string
	writes: {
		action: 'create' | 'update'
		fields: string[]
		rateLimitPerHour: number
	}[]
	/** Present iff `scope === 'collection'` — the grounded bound. */
	filter?: { field: string; equals: string | number | boolean }
	layout: PortalLayout
	paused: boolean
}

/**
 * The credential a request presented, as the portal route understood it.
 *
 * A route hands this in; it never decides anything with it. `rowId` and
 * `tokenId` come from a *verified* token (the api-keys bundle's
 * `PortalTokenService.verify`), never from the URL — which is what makes "this
 * token reaches one invoice" a property of the credential rather than of the
 * link somebody pasted.
 */
export interface PortalCredential {
	/** The verified token's row id, when one was presented. */
	tokenId?: string
	/** The row the verified token was minted for (row-scoped portals). */
	rowId?: string
	/** A stable, coarse identifier for the caller — the rate-limit bucket key. */
	clientId: string
	/** The signed-in session, when the portal's audience is `role`. */
	session?: SproutUser | null
}

/**
 * Turn a grounded portal plus a verified credential into the `SproutUser` the
 * ops layer narrows on.
 *
 * Returns `null` when the credential does not satisfy the portal's audience —
 * no token for a token portal, no matching role for a role portal. That is a
 * *refusal to build an identity*, not an access check: the caller ends up with
 * no identity at all rather than with a weaker one, which is the failure mode
 * you want when somebody forgets to handle the return value.
 *
 * The identity's `id` is the audit and rate-limit subject. It is deliberately
 * derived from the portal key plus the credential rather than from anything the
 * client sent: an audit line reading `portal:client-invoice/tok-…` names the
 * exact credential to revoke, which is the whole point of `origin` existing
 *.
 */
export function portalIdentity(
	plan: PortalPlan,
	credential: PortalCredential,
): SproutUser | null {
	if (plan.paused) return null

	let id: string
	let rowId: string | undefined
	switch (plan.audience) {
		case 'public':
			// No credential of any kind. The identity is anonymous and the bucket is
			// per client, so one abusive caller cannot spend the whole budget.
			id = `portal:${plan.key}:${credential.clientId}`
			break
		case 'token': {
			if (!credential.tokenId) return null
			// Row scope takes its row from the TOKEN, never from the URL. A token
			// that names no row cannot open a row portal — it would otherwise open
			// whichever row the URL happened to carry.
			if (plan.scope === 'row') {
				if (!credential.rowId) return null
				rowId = credential.rowId
			}
			id = `portal:${plan.key}:${credential.tokenId}`
			break
		}
		case 'role': {
			const session = credential.session
			if (!session || session.role !== plan.role) return null
			// A role portal IS the session, narrowed. Keeping the real user id is
			// what makes a support agent's read attributable to the agent.
			id = session.id
			break
		}
		default: {
			const exhaustive: never = plan.audience
			throw new Error(`Unknown portal audience: ${String(exhaustive)}`)
		}
	}

	const identity: PortalIdentity = {
		portalKey: plan.key,
		resource: plan.resource,
		audience: plan.audience,
		readFields: plan.readFields,
		writes: plan.writes.map((w) => ({
			action: w.action,
			fields: w.fields,
			rateLimitPerHour: w.rateLimitPerHour,
		})),
		scope: plan.scope,
		...(rowId ? { rowId } : {}),
		...(plan.filter ? { filter: plan.filter } : {}),
	}

	return {
		id,
		// A portal identity carries no role of its own even when it came from a
		// session: the role gated *entry*, and letting it through to the ops layer
		// would let an `admin`-shortcut rule read as satisfied on a resource the
		// portal never named.
		role: null,
		// Never an org. A portal reaches no tenant-scoped resource, because the
		// only honest source of an active org is a session or an api key, and a
		// public URL is neither. `tenantOf` throws for a tenant-scoped resource
		// with no org, which is the refusal we want.
		orgId: null,
		origin: 'portal',
		portal: identity,
	}
}
