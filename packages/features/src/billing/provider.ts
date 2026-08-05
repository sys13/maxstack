/**
 * Billing provider — the **buy** side of task 28 (decision `d-billing-buy`). The
 * platform does not build a payment engine: Stripe owns checkout, the customer
 * portal, invoices, tax, and dunning. This module is the thin adapter that (a)
 * hands a subject off to a Stripe-hosted surface and (b) normalizes the webhook
 * events that tell us a subscription changed, so the local `subscription` mirror
 * (the `billing` bundle's entity) stays in sync and `hasEntitlement` has a source
 * to read.
 *
 * Keeping the surfaces hosted is the whole point of buying: no card data, no PCI
 * scope, no billing UI to maintain — the app only ever redirects to a Stripe URL
 * and reacts to webhooks. The `BillingProvider` contract is exactly what a
 * hosted provider satisfies; `stripeBillingProvider` is the real, SDK-free
 * implementation over Stripe's REST API (injectable `fetch`, so the request shape
 * is tested hermetically), and `memoryBillingProvider` is the test double / local
 * default when no key is configured.
 *
 * Deferred (documented in the design as build-vs-deferred): cryptographic webhook
 * signature verification (Stripe's `Stripe-Signature` HMAC), a price-id ↔ plan
 * catalog sync, and proration/seat logic. `parseWebhook` here trusts a
 * pre-verified JSON body; a production deploy verifies the signature at the edge
 * (or swaps in the Stripe SDK's `constructEvent`) before calling it.
 */

/** A request to start a hosted checkout for `subject` on `plan`. */
export interface CheckoutRequest {
	subject: string
	plan: string
	/** Where Stripe returns the customer after a successful/cancelled checkout. */
	successUrl: string
	cancelUrl: string
	/** The Stripe price id for the plan (buy-side catalog lives in Stripe). */
	priceId?: string
}

/** A hosted surface the app redirects the browser to. */
export interface HostedSession {
	id: string
	url: string
}

/** A request to open the Stripe customer portal for an existing customer. */
export interface PortalRequest {
	customerId: string
	returnUrl: string
}

/**
 * A normalized subscription-lifecycle event, distilled from a Stripe webhook —
 * the only shape the local mirror needs. `status` maps straight onto the
 * `subscription` row's status (`active` / `trialing` / `canceled` / …).
 */
export interface BillingEvent {
	type: 'subscription.updated' | 'subscription.deleted'
	subject: string
	plan: string
	status: string
	customerId?: string
	subscriptionId?: string
}

/** The hosted-billing contract. A provider never exposes card data. */
export interface BillingProvider {
	createCheckoutSession(req: CheckoutRequest): Promise<HostedSession>
	createPortalSession(req: PortalRequest): Promise<HostedSession>
	/** Normalize a (pre-verified) webhook payload, or `null` if it is unhandled. */
	parseWebhook(payload: unknown): BillingEvent | null
}

/** Form-encode a flat/nested params object the way Stripe's API expects. */
function formEncode(params: Record<string, string>): string {
	return Object.entries(params)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&')
}

export interface StripeOptions {
	secretKey: string
	fetchImpl?: typeof globalThis.fetch
	/** Base URL override (test seam); defaults to Stripe's live API host. */
	baseUrl?: string
}

/**
 * The real Stripe adapter over the REST API — SDK-free (one host, three shapes).
 * `createCheckoutSession` / `createPortalSession` POST form-encoded bodies to
 * Stripe and return the hosted `url` the app redirects to; `parseWebhook` reads a
 * `customer.subscription.*` event body. Injectable `fetch` keeps every request
 * shape testable without the network.
 */
export function stripeBillingProvider(opts: StripeOptions): BillingProvider {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch
	const baseUrl = opts.baseUrl ?? 'https://api.stripe.com'

	async function post(path: string, params: Record<string, string>) {
		const res = await fetchImpl(`${baseUrl}${path}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${opts.secretKey}`,
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: formEncode(params),
		})
		if (!res.ok) {
			const body = (await res.text()).slice(0, 300)
			throw new Error(`stripe: HTTP ${res.status} — ${body}`)
		}
		return (await res.json()) as { id: string; url: string }
	}

	return {
		async createCheckoutSession(req) {
			const session = await post('/v1/checkout/sessions', {
				mode: 'subscription',
				success_url: req.successUrl,
				cancel_url: req.cancelUrl,
				client_reference_id: req.subject,
				'line_items[0][price]': req.priceId ?? req.plan,
				'line_items[0][quantity]': '1',
				'metadata[subject]': req.subject,
				'metadata[plan]': req.plan,
			})
			return { id: session.id, url: session.url }
		},

		async createPortalSession(req) {
			const session = await post('/v1/billing_portal/sessions', {
				customer: req.customerId,
				return_url: req.returnUrl,
			})
			return { id: session.id, url: session.url }
		},

		parseWebhook(payload) {
			return parseStripeEvent(payload)
		},
	}
}

/**
 * Distil a Stripe `customer.subscription.*` event into a {@link BillingEvent}.
 * Reads `client_reference_id`/`metadata.subject` for the subject and
 * `metadata.plan` for the plan. Returns `null` for events we don't mirror. The
 * payload is trusted (signature verification happens upstream — see the header).
 */
export function parseStripeEvent(payload: unknown): BillingEvent | null {
	if (!payload || typeof payload !== 'object') return null
	const event = payload as {
		type?: string
		data?: { object?: Record<string, unknown> }
	}
	const object = event.data?.object
	if (!object) return null
	const metadata = (object.metadata as Record<string, string> | undefined) ?? {}
	const subject = String(
		metadata.subject ?? object.client_reference_id ?? '',
	).trim()
	const plan = String(metadata.plan ?? '').trim()
	if (!subject || !plan) return null

	const type =
		event.type === 'customer.subscription.deleted'
			? 'subscription.deleted'
			: event.type === 'customer.subscription.updated' ||
					event.type === 'customer.subscription.created'
				? 'subscription.updated'
				: null
	if (!type) return null

	return {
		type,
		subject,
		plan,
		status:
			type === 'subscription.deleted'
				? 'canceled'
				: String(object.status ?? 'active'),
		customerId: object.customer ? String(object.customer) : undefined,
		subscriptionId: object.id ? String(object.id) : undefined,
	}
}

/** A recorded call to the memory provider — for assertions in tests. */
export interface RecordedCall {
	kind: 'checkout' | 'portal'
	req: CheckoutRequest | PortalRequest
}

/**
 * An in-memory provider — the local default when no Stripe key is set and the
 * test double. `createCheckoutSession`/`createPortalSession` return deterministic
 * fake hosted URLs (counter ids, so logs/tests are stable) and record every call;
 * `parseWebhook` reuses the real {@link parseStripeEvent} so mirror-sync logic is
 * exercised without a live Stripe.
 */
export function memoryBillingProvider(): BillingProvider & {
	calls: RecordedCall[]
} {
	const calls: RecordedCall[] = []
	let n = 0
	return {
		calls,
		async createCheckoutSession(req) {
			calls.push({ kind: 'checkout', req })
			const id = `cs_test_${++n}`
			return { id, url: `https://checkout.test/${id}` }
		},
		async createPortalSession(req) {
			calls.push({ kind: 'portal', req })
			const id = `bps_test_${++n}`
			return { id, url: `https://portal.test/${id}` }
		},
		parseWebhook(payload) {
			return parseStripeEvent(payload)
		},
	}
}
