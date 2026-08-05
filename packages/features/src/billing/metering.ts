/**
 * Usage metering & quota enforcement — the metered-billing primitive (task 53).
 *
 * Entitlements (`entitlements.ts`) answer a *boolean* question: does the subject's
 * plan grant a capability? Metering answers a *numeric* one: how much of a metered
 * dimension has the subject consumed this period, and does their plan's allowance
 * still cover it? The two compose — a plan is both a grant of capability keys and a
 * map of per-meter allowances (`Plan.limits`).
 *
 * The model mirrors entitlements deliberately, so the same shapes and test doubles
 * carry over:
 *   - A **meter** (`METERS`) names a metered dimension (`api-calls`, …).
 *   - A **plan** caps each meter through `Plan.limits` — a meter absent from the map
 *     is unlimited, an explicit `0` blocks it. Caps are code, not rows, so a plan's
 *     allowance is versioned and reviewable in a diff.
 *   - A **usage event** (`usage_event` mirror, materialized by the billing bundle)
 *     records `quantity` consumed of a `meter` by a `subject` at a time. The store
 *     totals a subject's events per meter for the current period.
 *   - {@link MeterService} joins the two: it resolves the subject's active plan
 *     through an injected {@link EntitlementSource}, reads their usage through an
 *     injected {@link UsageStore}, and turns that into a {@link UsageStatus} (used /
 *     limit / remaining / exceeded) the UI renders and the quota check gates on.
 *
 * Both sides are injected, so the same service runs over in-memory doubles (tests /
 * previews) or a Sprout-backed store without knowing which — the exact discipline
 * `hasEntitlement` follows. `enforce` is the write-side gate: it records the usage
 * only when the plan's allowance covers it and throws a typed {@link QuotaError}
 * (⇒ 402 + upgrade prompt) when it would not.
 */

import {
	ACTIVE_STATUSES,
	type EntitlementSource,
	PLANS,
} from './entitlements.ts'

/** A metered dimension — a thing the app counts and bills/limits by. */
export interface Meter {
	key: string
	name: string
	description: string
	/** The unit shown next to a count (`calls`, `seats`, `GB`). */
	unit: string
}

/**
 * The meter catalog. Like `PLANS`, meters are code so a plan's `limits` keys and
 * the dimensions they cap stay in lockstep and reviewable in a diff.
 */
export const METERS: Record<string, Meter> = {
	'api-calls': {
		key: 'api-calls',
		name: 'API calls',
		description: 'Requests to the metered API this billing period.',
		unit: 'calls',
	},
}

/**
 * The allowance a plan grants for `meter`, or `null` for *unlimited* (the meter is
 * absent from the plan's `limits` map). An unknown/absent plan falls through to the
 * free tier's allowance, so an unsubscribed subject is metered as free rather than
 * unlimited — the safe default. An explicit `0` is a real cap (blocks the meter).
 */
export function planLimit(
	planId: string | null | undefined,
	meter: string,
): number | null {
	const limits = PLANS[planId ?? '']?.limits ?? PLANS.free?.limits
	if (!limits) return null
	const value = limits[meter]
	return value === undefined ? null : value
}

/** One recorded consumption of a meter by a subject. */
export interface UsageEvent {
	subject: string
	meter: string
	/** Units consumed (defaults to 1 at the call sites). */
	quantity: number
	/** When it was consumed — ISO string, so it serializes across the wire. */
	at: string
}

/**
 * Where usage is written and totalled. `total` returns the subject's consumption of
 * `meter` for the *current billing period*; the store owns the period window (the
 * demo store totals all-time, a production store filters to `>= periodStart`).
 */
export interface UsageStore {
	record(event: UsageEvent): Promise<void>
	total(subject: string, meter: string): Promise<number>
}

/** The metering read-model for one subject × meter — what the UI renders. */
export interface UsageStatus {
	meter: string
	/** The plan the allowance came from (`free` when the subject has no active one). */
	plan: string
	used: number
	/** The plan's allowance, or `null` when the meter is unlimited on this plan. */
	limit: number | null
	/** `limit - used` clamped at 0, or `null` when unlimited. */
	remaining: number | null
	unlimited: boolean
	/** Already at or over the allowance — the next unit hits the quota wall. */
	exceeded: boolean
}

/**
 * Thrown by {@link MeterService.enforce} when recording would exceed the subject's
 * allowance. Typed like {@link import('./entitlements.ts').EntitlementError} so the
 * app maps `code` to a 402 and surfaces an upgrade prompt (the quota wall).
 */
export class QuotaError extends Error {
	readonly code = 'QUOTA_EXCEEDED' as const
	readonly meter: string
	readonly subject: string
	readonly limit: number
	readonly used: number
	constructor(subject: string, meter: string, limit: number, used: number) {
		super(
			`Subject "${subject}" has reached its "${meter}" quota (${used}/${limit}). ` +
				'Upgrade to a plan with a higher allowance.',
		)
		this.name = 'QuotaError'
		this.meter = meter
		this.subject = subject
		this.limit = limit
		this.used = used
	}
}

export interface MeterServiceOptions {
	/** Resolves a subject's active plan — the same source `hasEntitlement` uses. */
	plans: EntitlementSource
	usage: UsageStore
}

/**
 * The metering service: joins a subject's plan (allowance) to their usage. Given a
 * {@link EntitlementSource} and a {@link UsageStore}, it reports {@link UsageStatus}
 * and gates writes with {@link MeterService.enforce}. Framework-owned and
 * store-agnostic — never touches a payment API (that's `provider.ts`).
 */
export class MeterService {
	private readonly plans: EntitlementSource
	private readonly usage: UsageStore

	constructor(opts: MeterServiceOptions) {
		this.plans = opts.plans
		this.usage = opts.usage
	}

	/** The subject's active plan id, or `'free'` when they have no active one. */
	async planOf(subject: string): Promise<string> {
		return (await this.plans.activePlan(subject)) ?? 'free'
	}

	/** Read-only status of `subject`'s consumption of `meter` this period. */
	async status(subject: string, meter: string): Promise<UsageStatus> {
		const plan = await this.planOf(subject)
		const limit = planLimit(plan, meter)
		const used = await this.usage.total(subject, meter)
		return toStatus(meter, plan, used, limit)
	}

	/**
	 * Record `quantity` units of `meter` for `subject` unconditionally, returning
	 * the resulting status. Use for observed/after-the-fact usage where the work
	 * already happened; use {@link enforce} to gate work *before* it runs.
	 */
	async record(
		subject: string,
		meter: string,
		quantity = 1,
	): Promise<UsageStatus> {
		await this.usage.record({ subject, meter, quantity, at: nowIso() })
		return this.status(subject, meter)
	}

	/**
	 * The quota gate: record `quantity` units of `meter` **only if** the plan's
	 * allowance still covers them, else throw {@link QuotaError} and record nothing.
	 * Returns the post-record status on success. This is the "record usage → compare
	 * to plan limits → block/upgrade" path: call it before doing metered work and
	 * map the throw to a 402 + upgrade prompt.
	 */
	async enforce(
		subject: string,
		meter: string,
		quantity = 1,
	): Promise<UsageStatus> {
		const plan = await this.planOf(subject)
		const limit = planLimit(plan, meter)
		if (limit !== null) {
			const used = await this.usage.total(subject, meter)
			if (used + quantity > limit) {
				throw new QuotaError(subject, meter, limit, used)
			}
		}
		return this.record(subject, meter, quantity)
	}
}

/** Derive a {@link UsageStatus} from raw numbers — shared by `status`/`record`. */
function toStatus(
	meter: string,
	plan: string,
	used: number,
	limit: number | null,
): UsageStatus {
	const unlimited = limit === null
	return {
		meter,
		plan,
		used,
		limit,
		remaining: unlimited ? null : Math.max(0, (limit as number) - used),
		unlimited,
		exceeded: !unlimited && used >= (limit as number),
	}
}

function nowIso(): string {
	return new Date().toISOString()
}

/**
 * An in-memory usage store over an event array — the test double and preview
 * stand-in. `total` sums the current process's events (all-time; the demo has no
 * period boundary). `events` is exposed for assertions.
 */
export function createMemoryUsageStore(): UsageStore & {
	events: UsageEvent[]
} {
	const events: UsageEvent[] = []
	return {
		events,
		async record(event) {
			events.push(event)
		},
		async total(subject, meter) {
			return events
				.filter((e) => e.subject === subject && e.meter === meter)
				.reduce((sum, e) => sum + e.quantity, 0)
		},
	}
}

/** The store surface the Sprout-backed usage source reads — a `list` subset. */
export interface UsageListStore {
	list(resource: string, opts?: { limit?: number }): Promise<unknown[]>
}

/**
 * A read-only {@link UsageStore} over a Sprout store's `usage_event` resource —
 * the mirror the billing bundle materializes. Totals the subject's rows per meter.
 * `record` is intentionally unsupported: writes go through the app's own store
 * insert at the composition root (where ids/tenancy are minted), same split as the
 * entitlement source. Db-agnostic — the store hides pglite vs Postgres.
 */
export function createStoreUsageReader(
	store: UsageListStore,
	resource = 'usage_event',
): Pick<UsageStore, 'total'> {
	return {
		async total(subject, meter) {
			const rows = (await store.list(resource, { limit: 5000 })) as
				| UsageEvent[]
				| undefined
			return (rows ?? [])
				.filter((r) => r.subject === subject && r.meter === meter)
				.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0)
		},
	}
}

/** Re-exported for the composition root that upserts the subscription mirror. */
export { ACTIVE_STATUSES }
