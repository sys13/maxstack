/**
 * Owned-code wiring for the webhooks management page (`routes/webhooks.tsx`) —
 * task 58.
 *
 * Bar-2 territory, the same shape as `api-keys.server.ts`: hand-owned server
 * code that composes `WebhookService` (`@maxstack/features/webhooks`) into
 * the running app. The feature owns the model (subscribe/unsubscribe/
 * regenerate/emit/deliver); this module gives it a database and lists the
 * resources a subscription can be scoped to, from the live registry.
 *
 * `sprout.server.ts`'s `getAuditSink()` constructs its *own* `WebhookService`
 * instance for the event-bus emit path — independent DDL-ready flag, no
 * shared singleton — so this file can freely import from `sprout.server.ts`
 * (`getSprout`/`resolveUser`/`getContext`) without a circular dependency.
 */

import {
	checkPublicUrl,
	ReceiverRegistry,
	type SsrfPolicy,
	WEBHOOKS_DDL,
	type WebhookDeliveryView,
	WebhookService,
	type WebhookSubscriptionView,
} from '@maxstack/features/webhooks'
import {
	getAuditSink,
	getContext,
	getSprout,
	resolveUser,
} from './sprout.server'

/**
 * The SSRF policy the running app delivers under.
 *
 * `allowHttp` is gated on `NODE_ENV` rather than on a config flag: a plaintext
 * webhook to a local receiver is a reasonable dev convenience and an
 * unreasonable production posture, and a flag that expresses both is a flag
 * somebody sets in production. `resolve` uses the platform resolver so the
 * DNS-rebinding check runs against real answers.
 */
export function webhookSsrfPolicy(): SsrfPolicy {
	const dev = process.env.NODE_ENV !== 'production'
	return {
		allowHttp: dev,
		allowHosts: dev ? ['localhost', '127.0.0.1'] : [],
		resolve: async (host) => {
			const { lookup } = await import('node:dns/promises')
			const answers = await lookup(host, { all: true })
			return answers.map((a) => a.address)
		},
	}
}

/** Idempotent DDL for the webhook tables (mirrors `sprout.server.ts`'s local
 * copy — `IF NOT EXISTS`-guarded for the live db). */
// The feature's own idempotent DDL, not a local copy. It carries the
// `ADD COLUMN IF NOT EXISTS projections` step, which a hand-maintained
// second copy would silently omit — leaving every read of the new column
// failing at runtime on an existing project.
const WEBHOOKS_LIVE_DDL = WEBHOOKS_DDL

const webhooksScope = globalThis as typeof globalThis & {
	__maxstackWebhooksManageReady?: boolean
}

export async function getWebhookService(): Promise<WebhookService> {
	const { backend } = await getSprout()
	if (!webhooksScope.__maxstackWebhooksManageReady) {
		await backend.exec(WEBHOOKS_LIVE_DDL)
		webhooksScope.__maxstackWebhooksManageReady = true
	}
	return new WebhookService({
		db: backend.db,
		ssrf: webhookSsrfPolicy(),
		// Every delivery attempt is an audit entry with real provenance.
		audit: getAuditSink(),
	})
}

/**
 * Whether a subscriber URL is one this app will deliver to, with the reason if
 * not — so the form can say "that is an internal address" rather than failing
 * with a stack trace after the row is written.
 */
export async function validateSubscriberUrl(url: string) {
	return checkPublicUrl(url, webhookSsrfPolicy())
}

const receiverScope = globalThis as typeof globalThis & {
	__maxstackReceivers?: ReceiverRegistry
}

/**
 * The declared inbound receivers.
 *
 * Empty in the app template, and that is the correct default: a receiver is a
 * write endpoint with a shared secret, and shipping one preconfigured would mean
 * shipping the secret. A project declares its own here — `declare()` refuses an
 * absent or short secret at boot, so a misconfigured receiver fails on startup
 * rather than on the first delivery.
 */
export function getReceivers(): ReceiverRegistry {
	receiverScope.__maxstackReceivers ??= new ReceiverRegistry({
		audit: getAuditSink(),
	})
	return receiverScope.__maxstackReceivers
}

export interface WebhooksView {
	userId: string
	subscriptions: WebhookSubscriptionView[]
	deliveries: Record<string, WebhookDeliveryView[]>
	/** Resource names a subscription can be scoped to — the live registry, not
	 * a hand-maintained list, so it never drifts from what `/api/:resource` serves. */
	resources: string[]
}

export async function resolveWebhooks(
	request: Request,
): Promise<WebhooksView | null> {
	const user = await resolveUser(request)
	if (!user) return null
	const ctx = await getContext(request)
	const service = await getWebhookService()
	const subscriptions = await service.listSubscriptions(user.id)
	const deliveries: Record<string, WebhookDeliveryView[]> = {}
	for (const sub of subscriptions) {
		deliveries[sub.id] = await service.listDeliveries(sub.id)
	}
	return {
		userId: user.id,
		subscriptions,
		deliveries,
		resources: ctx.registry.all().map((r) => r.resource.name),
	}
}
