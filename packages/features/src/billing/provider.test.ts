import { describe, expect, it, vi } from 'vitest'
import {
	memoryBillingProvider,
	parseStripeEvent,
	stripeBillingProvider,
} from './provider.ts'

/** A minimal `fetch` stub that captures the request and returns a Stripe-ish JSON. */
function stubFetch(body: unknown, ok = true) {
	return vi.fn(async () => ({
		ok,
		status: ok ? 200 : 402,
		async json() {
			return body
		},
		async text() {
			return JSON.stringify(body)
		},
	})) as unknown as typeof globalThis.fetch
}

describe('stripe billing provider', () => {
	it('POSTs a form-encoded checkout session and returns the hosted url', async () => {
		const fetchImpl = stubFetch({
			id: 'cs_1',
			url: 'https://checkout.stripe.com/c/cs_1',
		})
		const provider = stripeBillingProvider({
			secretKey: 'sk_test_x',
			fetchImpl,
			baseUrl: 'https://api.stripe.test',
		})
		const session = await provider.createCheckoutSession({
			subject: 'u1',
			plan: 'pro',
			priceId: 'price_123',
			successUrl: 'https://app/ok',
			cancelUrl: 'https://app/no',
		})
		expect(session).toEqual({
			id: 'cs_1',
			url: 'https://checkout.stripe.com/c/cs_1',
		})
		const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0]
		if (!call) throw new Error('expected fetch to be called')
		expect(call[0]).toBe('https://api.stripe.test/v1/checkout/sessions')
		const init = call[1] as RequestInit
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>).authorization).toBe(
			'Bearer sk_test_x',
		)
		expect((init.headers as Record<string, string>)['content-type']).toBe(
			'application/x-www-form-urlencoded',
		)
		const params = new URLSearchParams(init.body as string)
		expect(params.get('mode')).toBe('subscription')
		expect(params.get('client_reference_id')).toBe('u1')
		expect(params.get('line_items[0][price]')).toBe('price_123')
		expect(params.get('metadata[plan]')).toBe('pro')
	})

	it('creates a customer portal session', async () => {
		const fetchImpl = stubFetch({
			id: 'bps_1',
			url: 'https://billing.stripe.com/p/bps_1',
		})
		const provider = stripeBillingProvider({ secretKey: 'sk', fetchImpl })
		const session = await provider.createPortalSession({
			customerId: 'cus_1',
			returnUrl: 'https://app/account',
		})
		expect(session.url).toBe('https://billing.stripe.com/p/bps_1')
		const portalCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0]
		if (!portalCall) throw new Error('expected fetch to be called')
		const init = portalCall[1] as RequestInit
		const params = new URLSearchParams(init.body as string)
		expect(params.get('customer')).toBe('cus_1')
		expect(params.get('return_url')).toBe('https://app/account')
	})

	it('throws with the response body on a non-2xx', async () => {
		const fetchImpl = stubFetch({ error: 'no such price' }, false)
		const provider = stripeBillingProvider({ secretKey: 'sk', fetchImpl })
		await expect(
			provider.createCheckoutSession({
				subject: 'u1',
				plan: 'pro',
				successUrl: 'a',
				cancelUrl: 'b',
			}),
		).rejects.toThrow(/stripe: HTTP 402/)
	})
})

describe('webhook normalization', () => {
	it('maps a subscription.updated event to a mirror update', () => {
		const event = parseStripeEvent({
			type: 'customer.subscription.updated',
			data: {
				object: {
					id: 'sub_1',
					status: 'active',
					customer: 'cus_1',
					metadata: { subject: 'u1', plan: 'pro' },
				},
			},
		})
		expect(event).toEqual({
			type: 'subscription.updated',
			subject: 'u1',
			plan: 'pro',
			status: 'active',
			customerId: 'cus_1',
			subscriptionId: 'sub_1',
		})
	})

	it('created maps to updated (upsert), deleted forces canceled', () => {
		const created = parseStripeEvent({
			type: 'customer.subscription.created',
			data: {
				object: { status: 'trialing', metadata: { subject: 'u', plan: 'pro' } },
			},
		})
		expect(created?.type).toBe('subscription.updated')
		expect(created?.status).toBe('trialing')

		const deleted = parseStripeEvent({
			type: 'customer.subscription.deleted',
			data: {
				object: { status: 'active', metadata: { subject: 'u', plan: 'pro' } },
			},
		})
		expect(deleted?.type).toBe('subscription.deleted')
		expect(deleted?.status).toBe('canceled')
	})

	it('falls back to client_reference_id for the subject', () => {
		const event = parseStripeEvent({
			type: 'customer.subscription.updated',
			data: {
				object: {
					status: 'active',
					client_reference_id: 'org_9',
					metadata: { plan: 'enterprise' },
				},
			},
		})
		expect(event?.subject).toBe('org_9')
		expect(event?.plan).toBe('enterprise')
	})

	it('returns null for unhandled events and malformed payloads', () => {
		expect(
			parseStripeEvent({ type: 'invoice.paid', data: { object: {} } }),
		).toBeNull()
		expect(
			parseStripeEvent({
				type: 'customer.subscription.updated',
				data: { object: { status: 'active', metadata: {} } },
			}),
		).toBeNull() // no subject/plan
		expect(parseStripeEvent(null)).toBeNull()
		expect(parseStripeEvent('nope')).toBeNull()
	})
})

describe('memory billing provider', () => {
	it('returns deterministic hosted urls and records calls', async () => {
		const provider = memoryBillingProvider()
		const checkout = await provider.createCheckoutSession({
			subject: 'u1',
			plan: 'pro',
			successUrl: 'a',
			cancelUrl: 'b',
		})
		expect(checkout).toEqual({
			id: 'cs_test_1',
			url: 'https://checkout.test/cs_test_1',
		})
		const portal = await provider.createPortalSession({
			customerId: 'cus_1',
			returnUrl: 'r',
		})
		expect(portal.id).toBe('bps_test_2')
		expect(provider.calls.map((c) => c.kind)).toEqual(['checkout', 'portal'])
	})

	it('reuses the real webhook parser', () => {
		const provider = memoryBillingProvider()
		const event = provider.parseWebhook({
			type: 'customer.subscription.deleted',
			data: { object: { metadata: { subject: 'u1', plan: 'pro' } } },
		})
		expect(event?.type).toBe('subscription.deleted')
	})
})
