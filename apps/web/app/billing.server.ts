/**
 * Owned-code wiring for the billing page (`routes/billing.tsx`) — task 53.
 *
 * Bar-2 territory, the same shape as `members.server.ts`: hand-owned server code
 * that composes the extracted billing feature (`@maxstack/features/billing`) into
 * the running app. The feature owns the model — plans + entitlements, the Stripe
 * hosted-checkout adapter, and the usage-metering / quota primitive; this module
 * gives it a database, resolves the billing subject, mirrors a completed checkout
 * into the local `subscription` row, and totals `usage_event` rows for the meter.
 *
 * Two feature-owned tables live in the same backend as app data + auth (one pglite
 * file / one Postgres schema), materialized here with idempotent DDL so the page
 * works without the `billing` bundle installed:
 *   - `subscription` — the Stripe mirror `hasEntitlement` reads (one active row per
 *     subject, Stripe's model).
 *   - `usage_event` — the metered ledger `MeterService` totals against a plan's
 *     allowance.
 *
 * The demo has no live Stripe round-trip (redirect → hosted checkout → async
 * webhook), so `startCheckout` still calls the provider to *create* the hosted
 * session — exercising the real buy adapter and recording the call — then applies
 * the very `customer.subscription.updated` event Stripe would post afterwards
 * through the provider's own `parseWebhook`, so the mirror-sync path is the
 * production one. With a real `STRIPE_SECRET_KEY` set, the same code drives live
 * Stripe and the browser is redirected to the returned hosted URL instead.
 */

import type { SproutUser } from '@maxstack/core'
import {
	ACTIVE_STATUSES,
	type BillingProvider,
	createStoreEntitlementSource,
	type EntitlementSource,
	METERS,
	MeterService,
	memoryBillingProvider,
	PLANS,
	stripeBillingProvider,
	type UsageStatus,
	type UsageStore,
} from '@maxstack/features/billing'
import { and, desc, eq } from 'drizzle-orm'
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { resolveViewerFlags } from './flags.server'
import { getSprout, resolveUser } from './sprout.server'

type Db = Awaited<ReturnType<typeof getSprout>>['backend']['db']

/** The Stripe subscription mirror — one active row per subject. Column names are
 * camelCase (identical to the `billing` bundle's field names) so this resolves
 * against the same physical columns whether the table was materialized by the
 * bundle's from-spec DDL or the owned-code fallback below. */
export const subscription = pgTable('subscription', {
	id: text('id').primaryKey(),
	subject: text('subject').notNull(),
	plan: text('plan').notNull(),
	status: text('status').notNull(),
	stripeCustomerId: text('stripeCustomerId'),
	stripeSubscriptionId: text('stripeSubscriptionId'),
	currentPeriodEnd: timestamp('currentPeriodEnd'),
	createdAt: timestamp('createdAt').notNull().defaultNow(),
	updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

/** The metered usage ledger — `MeterService` totals a subject's rows per meter. */
export const usageEvent = pgTable('usage_event', {
	id: text('id').primaryKey(),
	subject: text('subject').notNull(),
	meter: text('meter').notNull(),
	quantity: integer('quantity').notNull().default(1),
	at: timestamp('at').notNull().defaultNow(),
})

/**
 * The billing page's "Export usage CSV" action is gated on both the `analytics`
 * entitlement (Pro/Enterprise) *and* the `usage-csv-export` flag, so it is
 * hidden for a Free subject regardless of the flag, and hidden for everyone
 * until the flag is declared and rolled out.
 *
 * That flag used to be a code-owned registry in this file, next to `PLANS`
 * (task 54). Issue #187 moved it into the spec: a flag hidden in application
 * code is invisible to the workbench, invisible to the stale-flag report, and
 * changeable only by editing a source file — which is precisely the failure the
 * flag layer exists to fix. `PLANS` stays code-owned because a plan is a
 * contract, not a rollout.
 */
export const USAGE_CSV_FLAG = 'usage-csv-export'

const BILLING_DDL = `
CREATE TABLE IF NOT EXISTS subscription (
  id text PRIMARY KEY,
  subject text NOT NULL,
  plan text NOT NULL,
  status text NOT NULL,
  "stripeCustomerId" text,
  "stripeSubscriptionId" text,
  "currentPeriodEnd" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_event (
  id text PRIMARY KEY,
  subject text NOT NULL,
  meter text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  at timestamp NOT NULL DEFAULT now()
);
`

// One DDL run per process (IF NOT EXISTS makes a repeat harmless); the memory
// provider is a singleton so its recorded calls survive HMR. Both on globalThis.
const billingScope = globalThis as typeof globalThis & {
	__maxstackBillingReady?: boolean
	__maxstackBillingProvider?: BillingProvider
}

async function ensureReady(): Promise<Db> {
	const { backend } = await getSprout()
	if (!billingScope.__maxstackBillingReady) {
		await backend.exec(BILLING_DDL)
		billingScope.__maxstackBillingReady = true
	}
	return backend.db
}

/** Whether a live Stripe key is configured (vs. the local memory provider). */
export function isLiveStripe(): boolean {
	return !!process.env.STRIPE_SECRET_KEY
}

/**
 * The hosted-billing provider. A real `STRIPE_SECRET_KEY` selects the live Stripe
 * adapter; otherwise the in-memory provider — the local default that returns
 * deterministic fake hosted URLs and records every call (same posture as the
 * `billing` bundle's DI default).
 */
export function getBillingProvider(): BillingProvider {
	const secretKey = process.env.STRIPE_SECRET_KEY
	if (secretKey) {
		return stripeBillingProvider({ secretKey })
	}
	billingScope.__maxstackBillingProvider ??= memoryBillingProvider()
	return billingScope.__maxstackBillingProvider
}

/** A store-`list` shim over the drizzle handle, for the feature's read sources. */
function listShim(db: Db) {
	return {
		async list(resource: string) {
			if (resource === 'subscription')
				return db.select().from(subscription) as Promise<unknown[]>
			if (resource === 'usage_event')
				return db.select().from(usageEvent) as Promise<unknown[]>
			return []
		},
	}
}

/** The entitlement source over the `subscription` mirror (first active row wins). */
export function entitlementSource(db: Db): EntitlementSource {
	return createStoreEntitlementSource(listShim(db))
}

/**
 * A full read/write {@link UsageStore} over the `usage_event` table. Reads total a
 * subject's rows per meter (the feature ships a read-only store reader; writes are
 * the composition root's job — that's here, where the row id is minted).
 */
export function usageStore(db: Db): UsageStore {
	return {
		async record(event) {
			await db.insert(usageEvent).values({
				id: crypto.randomUUID(),
				subject: event.subject,
				meter: event.meter,
				quantity: event.quantity,
				at: new Date(event.at),
			})
		},
		async total(subject, meter) {
			const rows = (await db
				.select()
				.from(usageEvent)
				.where(
					and(eq(usageEvent.subject, subject), eq(usageEvent.meter, meter)),
				)) as Array<{ quantity: number }>
			return rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0)
		},
	}
}

/** The metering service bound to the app's plan source + usage ledger. */
export function meterService(db: Db): MeterService {
	return new MeterService({
		plans: entitlementSource(db),
		usage: usageStore(db),
	})
}

/** The billing subject: the signed-in user's id (subjects are auth users). */
export async function resolveBillingSubject(
	request: Request,
): Promise<{ user: SproutUser; subject: string } | null> {
	const user = await resolveUser(request)
	if (!user) return null
	return { user, subject: user.id }
}

/** The subject's current mirror row (the latest by update), or `null` for free. */
async function subscriptionOf(db: Db, subject: string) {
	const [row] = await db
		.select()
		.from(subscription)
		.where(eq(subscription.subject, subject))
		.orderBy(desc(subscription.updatedAt))
		.limit(1)
	return row ?? null
}

/** How many days of trial a demo checkout grants (mirrors Stripe's `trial_period`). */
const TRIAL_DAYS = 14

/**
 * Mirror a completed checkout into the local `subscription` row — the exact write
 * a verified Stripe webhook performs. Replaces any prior row for the subject (one
 * active row per subject) and starts a trial, so the page shows trial state. In
 * production this is driven by the async webhook; here `startCheckout` calls it
 * directly after creating the hosted session.
 */
async function applyCheckout(
	db: Db,
	subject: string,
	plan: string,
	stripe: { customerId?: string; subscriptionId?: string },
): Promise<void> {
	await db.delete(subscription).where(eq(subscription.subject, subject))
	const now = new Date()
	const periodEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
	await db.insert(subscription).values({
		id: crypto.randomUUID(),
		subject,
		plan,
		status: 'trialing',
		stripeCustomerId: stripe.customerId ?? null,
		stripeSubscriptionId: stripe.subscriptionId ?? null,
		currentPeriodEnd: periodEnd,
		createdAt: now,
		updatedAt: now,
	})
}

/**
 * Start a hosted checkout for `subject` on `plan`. Always creates the hosted
 * session through the provider (exercises the buy adapter + records the call) and
 * returns its URL. In demo mode we then synthesize the `customer.subscription.*`
 * event Stripe posts after a completed checkout and run it through the provider's
 * own `parseWebhook` before mirroring it — so the sync path is the production one.
 * Returns the hosted URL and whether the mirror was applied locally (demo) vs. left
 * for the live webhook.
 */
export async function startCheckout(
	request: Request,
	subject: string,
	plan: string,
): Promise<{ url: string; appliedLocally: boolean }> {
	const db = await ensureReady()
	const provider = getBillingProvider()
	const origin = new URL(request.url).origin
	const session = await provider.createCheckoutSession({
		subject,
		plan,
		successUrl: `${origin}/billing?checkout=success`,
		cancelUrl: `${origin}/billing?checkout=cancel`,
		priceId: PLANS[plan]?.id,
	})

	if (isLiveStripe()) {
		// Live: the browser goes to Stripe; the async webhook updates the mirror.
		return { url: session.url, appliedLocally: false }
	}

	// Demo: replay the post-checkout webhook through the provider's parser, then
	// mirror it — the same code a real deploy runs from the webhook route.
	const event = provider.parseWebhook({
		type: 'customer.subscription.updated',
		data: {
			object: {
				id: `sub_demo_${subject}`,
				status: 'trialing',
				customer: `cus_demo_${subject}`,
				metadata: { subject, plan },
			},
		},
	})
	if (event) {
		await applyCheckout(db, event.subject, event.plan, {
			customerId: event.customerId,
			subscriptionId: event.subscriptionId,
		})
	}
	return { url: session.url, appliedLocally: true }
}

/** Open the Stripe customer portal for the subject's mirrored customer. */
export async function openPortal(
	request: Request,
	subject: string,
): Promise<{ url: string }> {
	const db = await ensureReady()
	const row = await subscriptionOf(db, subject)
	const origin = new URL(request.url).origin
	const session = await getBillingProvider().createPortalSession({
		customerId: row?.stripeCustomerId ?? `cus_demo_${subject}`,
		returnUrl: `${origin}/billing`,
	})
	return { url: session.url }
}

/**
 * Build a CSV of the subject's per-meter usage — the task-54 demo action, gated
 * client-side by `<IfEntitled feature="analytics"><IfFlag flag="usage-csv-export">`
 * so it's reachable only for a Pro/Enterprise subject with the flag rolled out.
 */
export async function exportUsageCsv(subject: string): Promise<string> {
	const db = await ensureReady()
	const rows = await Promise.all(
		Object.keys(METERS).map((key) => meterService(db).status(subject, key)),
	)
	const header = 'meter,used,limit,unlimited'
	const lines = rows.map(
		(r) => `${r.meter},${r.used},${r.limit ?? ''},${r.unlimited}`,
	)
	return [header, ...lines].join('\n')
}

/** Record metered usage, enforcing the plan's quota. Throws `QuotaError` at the wall. */
export async function recordUsage(
	subject: string,
	meter: string,
	quantity: number,
): Promise<UsageStatus> {
	const db = await ensureReady()
	return meterService(db).enforce(subject, meter, quantity)
}

/** Reset the subject's demo state: drop the subscription + clear usage (→ free). */
export async function resetBilling(subject: string): Promise<void> {
	const db = await ensureReady()
	await db.delete(subscription).where(eq(subscription.subject, subject))
	await db.delete(usageEvent).where(eq(usageEvent.subject, subject))
}

/** A plan rendered as a pricing card. */
export interface PlanCard {
	id: string
	name: string
	priceMonthly: number
	entitlements: string[]
	limits: Record<string, number>
	isCurrent: boolean
}

/** The current plan/trial state for the account-settings header. */
export interface PlanState {
	planId: string
	planName: string
	status: string
	/** On a Stripe trial — the page shows the trial banner + end date. */
	trialing: boolean
	/** ISO date the current period / trial ends, if known. */
	currentPeriodEnd: string | null
	hasSubscription: boolean
}

export interface BillingView {
	user: SproutUser
	subject: string
	plan: PlanState
	meters: UsageStatus[]
	plans: PlanCard[]
	/** Whether a live Stripe key is configured (affects portal/checkout redirects). */
	liveStripe: boolean
	/** Resolved feature-flag values for `subject` (task 54) — seeds `<EntitlementProvider>`. */
	flags: Record<string, boolean>
}

/**
 * Load the subject's billing view: current plan + trial state, per-meter usage
 * status, and the pricing catalog with the current plan marked. Returns `null`
 * only when there is no user at all (strict anonymous), which the route turns into
 * a sign-in prompt.
 */
export async function resolveBilling(
	request: Request,
): Promise<BillingView | null> {
	const resolved = await resolveBillingSubject(request)
	if (!resolved) return null
	const { user, subject } = resolved
	const db = await ensureReady()

	const row = await subscriptionOf(db, subject)
	const active = row && ACTIVE_STATUSES.has(row.status)
	const planId = active ? row.plan : 'free'
	const plan: PlanState = {
		planId,
		planName: PLANS[planId]?.name ?? planId,
		status: row?.status ?? 'none',
		trialing: row?.status === 'trialing',
		currentPeriodEnd: row?.currentPeriodEnd
			? new Date(row.currentPeriodEnd).toISOString()
			: null,
		hasSubscription: !!active,
	}

	const meters = await Promise.all(
		Object.keys(METERS).map((key) => meterService(db).status(subject, key)),
	)

	const plans: PlanCard[] = Object.values(PLANS).map((p) => ({
		id: p.id,
		name: p.name,
		priceMonthly: p.priceMonthly,
		entitlements: p.entitlements,
		limits: p.limits ?? {},
		isCurrent: p.id === planId,
	}))

	// Declared flags, evaluated for this viewer. An app that has
	// never declared `usage-csv-export` gets `{}`, and `<IfFlag>` reads an absent
	// flag as off — so the action stays hidden exactly as it did when the flag
	// was a 0%-rollout entry in this file.
	const flags = await resolveViewerFlags(request)

	return {
		user,
		subject,
		plan,
		meters,
		plans,
		liveStripe: isLiveStripe(),
		flags,
	}
}
