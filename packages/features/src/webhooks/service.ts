/**
 * `WebhookService` — the task-58 event bus: `emit()` fans an event out to
 * every active subscription whose `events` match, signs each payload with
 * the subscriber's own secret (Web Crypto HMAC-SHA256, no new dependency —
 * the same house style task 57 established for tokens), and retries a failed
 * delivery inline before dead-lettering it. Subscriptions are user-owned for
 * management purposes only (who may view/edit/revoke one) — delivery itself
 * is app-wide: any matching event reaches every active subscriber regardless
 * of who performed the mutation, the same way a real webhook platform's
 * subscriptions aren't scoped to "only my own actions."
 */

import { and, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import type { AuditSink } from '../audit/index.ts'
import {
	type FieldProjection,
	projectionErrors,
	projectPayload,
} from './projection.ts'
import { webhookDelivery, webhookSubscription } from './schema.ts'
import { newNonce, signatureHeaders, signBody } from './signing.ts'
import { assertPublicUrl, type SsrfPolicy, SsrfRefusedError } from './ssrf.ts'

type Db = ReturnType<typeof drizzle>
type Fetch = typeof fetch

export interface WebhookSubscriptionView {
	id: string
	userId: string
	url: string
	events: string[]
	/** What each resource's payload contains. Empty = identifier only. */
	projections: FieldProjection[]
	active: boolean
	createdAt: Date
}

export interface IssuedSubscription {
	id: string
	/** The signing secret — shown once, at subscribe/regenerate time only. */
	secret: string
}

export interface WebhookEvent {
	type: string
	resource: string
	resourceId?: string
	data?: unknown
}

export interface WebhookDeliveryView {
	id: string
	subscriptionId: string
	eventType: string
	status: 'success' | 'failed'
	attempts: number
	responseStatus: number | null
	error: string | null
	createdAt: Date
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))

/** 250ms, 500ms — short, because these attempts are inline on the worker. */
const backoffMs = (attempt: number): number =>
	Math.min(4_000, 250 * 2 ** (attempt - 1))

let counter = 0
const nextId = (prefix: string) =>
	`${prefix}-${Date.now().toString(36)}-${++counter}`

function generateSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24))
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

function toView(
	row: typeof webhookSubscription.$inferSelect,
): WebhookSubscriptionView {
	return {
		id: row.id,
		userId: row.userId,
		url: row.url,
		events: row.events,
		projections: row.projections ?? [],
		active: row.active,
		createdAt: row.createdAt,
	}
}

export class WebhookService {
	private readonly db: Db
	private readonly fetch: Fetch
	private readonly ssrf: SsrfPolicy
	private readonly audit: AuditSink | undefined

	constructor(opts: {
		db: Db
		fetch?: Fetch
		/**
		 * How subscriber URLs are validated. The default is the strict one:
		 * https-only, no credentials, no internal address. A dev composition root
		 * may loosen it to reach a local receiver; a deploy must not.
		 */
		ssrf?: SsrfPolicy
		/** Delivery attempts are audit-log entries with real provenance. */
		audit?: AuditSink
	}) {
		this.db = opts.db
		this.fetch = opts.fetch ?? fetch
		this.ssrf = opts.ssrf ?? {}
		this.audit = opts.audit
	}

	/**
	 * Create a subscription.
	 *
	 * The URL is validated **here**, at the form, so a refusal comes with a
	 * reason a person can act on — and validated *again* before every delivery,
	 * because a hostname that was public at subscribe time can be re-pointed at
	 * an internal address afterwards.
	 */
	async subscribe(input: {
		userId: string
		url: string
		events: string[]
		/** What each resource's payload contains. Default-deny; see projection.ts. */
		projections?: FieldProjection[]
	}): Promise<IssuedSubscription> {
		await assertPublicUrl(input.url, this.ssrf)
		const projectionProblems = projectionErrors(input.projections ?? [])
		if (projectionProblems.length)
			throw new Error(projectionProblems.join('; '))
		const id = nextId('whsub')
		const secret = generateSecret()
		await this.db.insert(webhookSubscription).values({
			id,
			userId: input.userId,
			url: input.url,
			secret,
			events: input.events,
			projections: input.projections ?? [],
			createdAt: new Date(),
		})
		return { id, secret }
	}

	/** Scoped to `userId` — an id from another user's subscriptions is a no-op. */
	async unsubscribe(id: string, userId: string): Promise<void> {
		await this.db
			.update(webhookSubscription)
			.set({ active: false })
			.where(
				and(
					eq(webhookSubscription.id, id),
					eq(webhookSubscription.userId, userId),
				),
			)
	}

	/** Deactivate `id` and issue a fresh secret on a new active row with the
	 * same url/events — the rotate-equivalent for a leaked secret. */
	async regenerateSecret(
		id: string,
		userId: string,
	): Promise<IssuedSubscription> {
		const [row] = await this.db
			.select()
			.from(webhookSubscription)
			.where(
				and(
					eq(webhookSubscription.id, id),
					eq(webhookSubscription.userId, userId),
				),
			)
		if (!row) throw new Error('Subscription not found')
		await this.unsubscribe(id, userId)
		return this.subscribe({
			userId,
			url: row.url,
			events: row.events,
			projections: row.projections ?? [],
		})
	}

	async listSubscriptions(userId: string): Promise<WebhookSubscriptionView[]> {
		const rows = await this.db
			.select()
			.from(webhookSubscription)
			.where(eq(webhookSubscription.userId, userId))
		return rows.map(toView)
	}

	/** Fan `event` out to every active subscription whose `events` include its
	 * type or `'*'`. Delivery failures never throw — each subscriber is
	 * independent, and a dead-lettered delivery is a logged row, not an error. */
	async emit(event: WebhookEvent): Promise<void> {
		const subs = (await this.db
			.select()
			.from(webhookSubscription)
			.where(
				eq(webhookSubscription.active, true),
			)) as (typeof webhookSubscription.$inferSelect)[]
		const matching = subs.filter(
			(s) => s.events.includes('*') || s.events.includes(event.type),
		)
		await Promise.all(matching.map((s) => this.deliver(s, event)))
	}

	/** Sign + POST `event` to `subscription.url`, retrying inline up to
	 * `maxAttempts` before recording a dead-lettered `'failed'` delivery. */
	private async deliver(
		subscription: typeof webhookSubscription.$inferSelect,
		event: WebhookEvent,
		maxAttempts = 3,
	): Promise<void> {
		// Re-checked per delivery, not just per subscription. This is the
		// DNS-rebinding case: the hostname passed at subscribe time and now points
		// at 169.254.169.254. A refusal here is permanent — retrying a request we
		// have decided not to make is just making it three times.
		try {
			await assertPublicUrl(subscription.url, this.ssrf)
		} catch (err) {
			if (err instanceof SsrfRefusedError) {
				await this.recordDelivery(
					subscription.id,
					event.type,
					{ refused: err.reason },
					'failed',
					0,
					null,
					err.message,
				)
				await this.recordAudit(subscription, event, 'refused', 0, err.message)
				return
			}
			throw err
		}

		// Default-deny field projection: a subscription receives the fields
		// it named and nothing else, so adding a column to an entity cannot widen
		// what an existing subscriber gets.
		const { data, projected } = projectPayload(
			event.resource,
			event.data,
			subscription.projections ?? undefined,
		)
		const body = JSON.stringify({
			type: event.type,
			resource: event.resource,
			resourceId: event.resourceId,
			data,
			projected,
		})
		const timestamp = Math.floor(Date.now() / 1000)
		const nonce = newNonce()
		const signature = await signBody(subscription.secret, {
			timestamp,
			nonce,
			body,
		})
		const headers = signatureHeaders({
			signature,
			timestamp,
			nonce,
			eventType: event.type,
		})

		let attempts = 0
		let lastStatus: number | null = null
		let lastError: string | null = null

		while (attempts < maxAttempts) {
			attempts++
			try {
				const response = await this.fetch(subscription.url, {
					method: 'POST',
					headers,
					body,
					// Never follow a redirect: a 302 to an internal address is the
					// cheapest way around every check above.
					redirect: 'manual',
				})
				lastStatus = response.status
				if (response.ok) {
					await this.recordDelivery(
						subscription.id,
						event.type,
						JSON.parse(body),
						'success',
						attempts,
						lastStatus,
						null,
					)
					await this.recordAudit(
						subscription,
						event,
						'delivered',
						attempts,
						null,
					)
					return
				}
				lastError = `HTTP ${response.status}`
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err)
			}
			// Exponential backoff between inline attempts, so a subscriber having a
			// bad second is not hammered three times inside one.
			if (attempts < maxAttempts) await sleep(backoffMs(attempts))
		}
		await this.recordDelivery(
			subscription.id,
			event.type,
			JSON.parse(body),
			'failed',
			attempts,
			lastStatus,
			lastError,
		)
		await this.recordAudit(subscription, event, 'failed', attempts, lastError)
	}

	/**
	 * Every delivery attempt is an audit entry.
	 *
	 * `origin: 'system'` and a `webhook:<subscription>` actor rather than the user
	 * who triggered the mutation: the delivery is the platform's action, made
	 * minutes later, possibly several times. Attributing it to whoever happened to
	 * edit the row would put a fiction in a log people read as fact.
	 */
	private async recordAudit(
		subscription: typeof webhookSubscription.$inferSelect,
		event: WebhookEvent,
		outcome: 'delivered' | 'failed' | 'refused',
		attempts: number,
		error: string | null,
	): Promise<void> {
		await this.audit?.({
			userId: `webhook:${subscription.id}`,
			action: `webhook.outbound.${outcome}`,
			resource: event.resource,
			resourceId: event.resourceId,
			origin: 'system',
			metadata: {
				subscriptionId: subscription.id,
				eventType: event.type,
				attempts,
				// The URL, not the secret. A delivery log that leaks the signing
				// secret is worse than no delivery log.
				url: subscription.url,
				error,
			},
		})
	}

	private async recordDelivery(
		subscriptionId: string,
		eventType: string,
		payload: unknown,
		status: 'success' | 'failed',
		attempts: number,
		responseStatus: number | null,
		error: string | null,
	): Promise<void> {
		await this.db.insert(webhookDelivery).values({
			id: nextId('whdel'),
			subscriptionId,
			eventType,
			payload,
			status,
			attempts,
			responseStatus,
			error,
			createdAt: new Date(),
		})
	}

	async listDeliveries(subscriptionId: string): Promise<WebhookDeliveryView[]> {
		const rows = await this.db
			.select()
			.from(webhookDelivery)
			.where(eq(webhookDelivery.subscriptionId, subscriptionId))
		return rows as WebhookDeliveryView[]
	}
}
