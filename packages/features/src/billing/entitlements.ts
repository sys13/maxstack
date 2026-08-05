/**
 * Entitlements — the `hasEntitlement` primitive (task 28). Billing is a **buy**
 * (decision `d-billing-buy`): Stripe owns the payment surfaces (checkout, portal,
 * invoices, dunning). What the *platform* owns is the thin, framework-level layer
 * that turns a subject's paid plan into a boolean capability the app can gate on —
 * that layer is this module, and it never touches a payment API.
 *
 * The model is deliberately small:
 *   - A **plan** grants a fixed set of entitlement keys (`PLANS`). Plans are code,
 *     not rows, so the grant map is versioned with the app and diffable in review.
 *   - A **subscription** row (materialized by the `billing` bundle's `subscription`
 *     entity, kept in sync from Stripe webhooks — see `provider.ts`) says which
 *     plan a subject is on and whether it is currently active.
 *   - `hasEntitlement(source, subject, key)` resolves the subject's *active* plan
 *     through an injected {@link EntitlementSource} and asks whether that plan
 *     grants the key.
 *
 * The source is injected so the same check runs over an in-memory map (tests /
 * previews), a Sprout store, or any future backing store without the primitive
 * knowing which. A bundle may declare `entitlement: <key>` (see the catalog) to
 * mark its features gated; the composition root enforces the gate with this
 * primitive at request time.
 */

/** A billing plan: a name-keyed grant of entitlement keys at a monthly price. */
export interface Plan {
	id: string
	name: string
	/** USD/month; 0 for the free tier. */
	priceMonthly: number
	/** The capability keys this plan grants (checked by {@link hasEntitlement}). */
	entitlements: string[]
	/**
	 * Per-meter usage caps for the metered-billing story (see `metering.ts`): a
	 * `meter key → allowance` map the quota check compares recorded usage against.
	 * A meter absent from the map is *unlimited* on this plan; an explicit `0`
	 * blocks it entirely. Like `entitlements`, limits are code (not per-customer
	 * rows) so a plan's allowance is versioned with the app and diffable in review.
	 */
	limits?: Record<string, number>
}

/**
 * The plan catalog. Grants are static so they are versioned with the app and
 * reviewable in a diff (a subscription row only names the plan; it never carries
 * its own grant list, which would let entitlements drift per-customer).
 */
export const PLANS: Record<string, Plan> = {
	free: {
		id: 'free',
		name: 'Free',
		priceMonthly: 0,
		entitlements: [],
		// A small allowance so the free tier is usable but hits a quota wall that
		// motivates an upgrade — the metered half of the exit criterion.
		limits: { 'api-calls': 100 },
	},
	pro: {
		id: 'pro',
		name: 'Pro',
		priceMonthly: 20,
		entitlements: ['analytics', 'priority-support', 'unlimited-members'],
		limits: { 'api-calls': 10_000 },
	},
	enterprise: {
		id: 'enterprise',
		name: 'Enterprise',
		priceMonthly: 200,
		entitlements: [
			'analytics',
			'priority-support',
			'unlimited-members',
			'sso',
			'audit-export',
		],
		// No `api-calls` key ⇒ unlimited on enterprise.
		limits: {},
	},
}

/** The entitlement keys a plan grants — empty for an unknown plan. */
export function planEntitlements(planId: string | null | undefined): string[] {
	if (!planId) return []
	return PLANS[planId]?.entitlements ?? []
}

/** Subscription statuses that count as an entitlement-granting subscription. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
	'active',
	'trialing',
])

/**
 * Where the current plan for a subject comes from. A subject is whatever the app
 * bills — a user id or an organization id. Returns the active plan id, or `null`
 * when the subject has no active subscription (⇒ free / no entitlements).
 */
export interface EntitlementSource {
	activePlan(subject: string): Promise<string | null>
}

/**
 * The primitive: does `subject` have `key`? Resolves the subject's active plan
 * through `source` and checks whether that plan grants the key. A subject with no
 * active subscription resolves to `null` ⇒ no entitlements ⇒ `false`.
 */
export async function hasEntitlement(
	source: EntitlementSource,
	subject: string,
	key: string,
): Promise<boolean> {
	const plan = await source.activePlan(subject)
	return planEntitlements(plan).includes(key)
}

/** Thrown by {@link requireEntitlement} when a subject lacks a required key. */
export class EntitlementError extends Error {
	readonly code = 'ENTITLEMENT_REQUIRED' as const
	readonly entitlement: string
	readonly subject: string
	constructor(subject: string, entitlement: string) {
		super(
			`Subject "${subject}" is missing the "${entitlement}" entitlement. ` +
				'Upgrade the plan that grants it.',
		)
		this.name = 'EntitlementError'
		this.entitlement = entitlement
		this.subject = subject
	}
}

/**
 * Guard form of {@link hasEntitlement}: resolve or throw. Use at the composition
 * root / access layer to gate an entitlement-marked feature — the failure is a
 * typed `EntitlementError` (`code: 'ENTITLEMENT_REQUIRED'`) the app maps to a 402.
 */
export async function requireEntitlement(
	source: EntitlementSource,
	subject: string,
	key: string,
): Promise<void> {
	if (!(await hasEntitlement(source, subject, key))) {
		throw new EntitlementError(subject, key)
	}
}

/**
 * An in-memory entitlement source over a `subject → plan id` map — the test
 * double and a stand-in for previews. Absent subjects resolve to `null`.
 */
export function createMemoryEntitlementSource(
	plans: Record<string, string> = {},
): EntitlementSource {
	return {
		async activePlan(subject) {
			return plans[subject] ?? null
		},
	}
}

/** A minimal subscription row — the shape the `billing` bundle's entity yields. */
export interface SubscriptionRow {
	subject: string
	plan: string
	status: string
}

/** The store surface the Sprout-backed source reads — a subset of `SproutStore`. */
export interface SubscriptionStore {
	list(resource: string, opts?: { limit?: number }): Promise<unknown[]>
}

/**
 * An entitlement source over a Sprout store's `subscription` resource. Reads the
 * subject's rows and returns the plan of the first *active* one (`active` /
 * `trialing`). Db-agnostic — the store hides pglite vs Postgres. Kept simple: a
 * subject is expected to have at most one active subscription (Stripe's model),
 * so the first active row wins.
 */
export function createStoreEntitlementSource(
	store: SubscriptionStore,
	resource = 'subscription',
): EntitlementSource {
	return {
		async activePlan(subject) {
			const rows = (await store.list(resource, { limit: 500 })) as
				| SubscriptionRow[]
				| undefined
			const active = (rows ?? []).find(
				(r) => r.subject === subject && ACTIVE_STATUSES.has(r.status),
			)
			return active?.plan ?? null
		},
	}
}
