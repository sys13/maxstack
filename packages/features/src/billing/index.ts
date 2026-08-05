/**
 * Billing & entitlements feature (task 28). Two layers, deliberately split:
 *   - `entitlements.ts` — the framework-owned `hasEntitlement` primitive: plans
 *     grant capability keys, a subscription says which plan a subject is on, and
 *     the check turns that into a boolean the app gates on. No payment API.
 *   - `provider.ts` — the **buy** side (decision `d-billing-buy`): a thin adapter
 *     over Stripe's hosted checkout/portal + normalized webhook events, so the
 *     platform never handles card data or builds billing UI.
 *
 * Installed into a project as the `billing` bundle (see the catalog), which
 * materializes the `subscription` mirror the store-backed source reads.
 */

export {
	ACTIVE_STATUSES,
	createMemoryEntitlementSource,
	createStoreEntitlementSource,
	EntitlementError,
	type EntitlementSource,
	hasEntitlement,
	PLANS,
	type Plan,
	planEntitlements,
	requireEntitlement,
	type SubscriptionRow,
	type SubscriptionStore,
} from './entitlements.ts'
export {
	createMemoryUsageStore,
	createStoreUsageReader,
	METERS,
	type Meter,
	MeterService,
	type MeterServiceOptions,
	planLimit,
	QuotaError,
	type UsageEvent,
	type UsageListStore,
	type UsageStatus,
	type UsageStore,
} from './metering.ts'
export {
	type BillingEvent,
	type BillingProvider,
	type CheckoutRequest,
	type HostedSession,
	memoryBillingProvider,
	type PortalRequest,
	parseStripeEvent,
	type RecordedCall,
	type StripeOptions,
	stripeBillingProvider,
} from './provider.ts'
