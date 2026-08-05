import type { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAuditSink } from '../audit/index.ts'
import { usePglite } from '../testing/pglite-fixture.ts'
import { WEBHOOKS_DDL } from './schema.ts'
import { WebhookService } from './service.ts'
import {
	NONCE_HEADER,
	SIGNATURE_HEADER,
	signBody,
	TIMESTAMP_HEADER,
	verifySignedRequest,
} from './signing.ts'

type Db = ReturnType<typeof drizzle>

const pg = usePglite(WEBHOOKS_DDL)

let db: Db
let service: WebhookService

beforeEach(() => {
	db = pg.db
})

describe('subscribe / listSubscriptions', () => {
	it('returns a secret once; listSubscriptions never exposes it', async () => {
		service = new WebhookService({ db, fetch: vi.fn() })
		const issued = await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['project.create'],
		})
		expect(issued.secret).toBeTruthy()
		const [view] = await service.listSubscriptions('u1')
		expect(view).toMatchObject({
			url: 'https://example.com/hook',
			active: true,
		})
		expect(view).not.toHaveProperty('secret')
	})

	it('scopes to the given user', async () => {
		service = new WebhookService({ db, fetch: vi.fn() })
		await service.subscribe({ userId: 'u1', url: 'https://a', events: ['*'] })
		await service.subscribe({ userId: 'u2', url: 'https://b', events: ['*'] })
		expect(await service.listSubscriptions('u1')).toHaveLength(1)
		expect(await service.listSubscriptions('u2')).toHaveLength(1)
	})
})

describe('emit — signing and delivery', () => {
	it('delivers a correctly HMAC-signed payload', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		const issued = await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['project.create'],
		})

		await service.emit({
			type: 'project.create',
			resource: 'project',
			resourceId: 'p1',
		})

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://example.com/hook')
		const body = init.body as string
		const headers = init.headers as Record<string, string>
		// The signature covers the timestamp and the nonce as well as the body
		// — a signature over the body alone is replayable forever.
		const expectedSig = await signBody(issued.secret, {
			timestamp: Number(headers[TIMESTAMP_HEADER]),
			nonce: headers[NONCE_HEADER] ?? '',
			body,
		})
		expect(headers[SIGNATURE_HEADER]).toBe(`v1=${expectedSig}`)
		// …and our own verifier accepts what we sent, which is the property a
		// subscriber actually depends on.
		await expect(
			verifySignedRequest({ secret: issued.secret, body, headers }),
		).resolves.toMatchObject({ ok: true })
		expect(JSON.parse(body)).toMatchObject({
			type: 'project.create',
			resourceId: 'p1',
		})

		const [delivery] = await service.listDeliveries(issued.id)
		expect(delivery).toMatchObject({ status: 'success', attempts: 1 })
	})

	it('only reaches subscriptions whose events match the type', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		await service.subscribe({
			userId: 'u1',
			url: 'https://a',
			events: ['project.create'],
		})
		await service.subscribe({
			userId: 'u1',
			url: 'https://b',
			events: ['post.create'],
		})

		await service.emit({ type: 'project.create', resource: 'project' })

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledWith('https://a', expect.anything())
	})

	it('a wildcard subscription receives every event type', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		await service.subscribe({ userId: 'u1', url: 'https://all', events: ['*'] })

		await service.emit({ type: 'project.create', resource: 'project' })
		await service.emit({ type: 'post.delete', resource: 'post' })

		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})

describe('retries', () => {
	it('a fetch that fails once then succeeds ends in one success with attempts: 2', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		const issued = await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['*'],
		})

		await service.emit({ type: 'project.create', resource: 'project' })

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const [delivery] = await service.listDeliveries(issued.id)
		expect(delivery).toMatchObject({ status: 'success', attempts: 2 })
	})

	it('a fetch that always fails exhausts maxAttempts and dead-letters the delivery', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
		service = new WebhookService({ db, fetch: fetchMock })
		const issued = await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['*'],
		})

		await service.emit({ type: 'project.create', resource: 'project' })

		expect(fetchMock).toHaveBeenCalledTimes(3)
		const [delivery] = await service.listDeliveries(issued.id)
		expect(delivery).toMatchObject({
			status: 'failed',
			attempts: 3,
			error: 'ECONNREFUSED',
		})
	})

	it('emit never throws even when every subscriber fails', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('down'))
		service = new WebhookService({ db, fetch: fetchMock })
		await service.subscribe({
			userId: 'u1',
			url: 'https://down',
			events: ['*'],
		})
		await expect(
			service.emit({ type: 'project.create', resource: 'project' }),
		).resolves.toBeUndefined()
	})
})

describe('unsubscribe / regenerateSecret', () => {
	it('unsubscribe stops further delivery', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		const issued = await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['*'],
		})
		await service.unsubscribe(issued.id, 'u1')
		await service.emit({ type: 'project.create', resource: 'project' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('is scoped to the owning user — another user’s id is a no-op', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		const issued = await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['*'],
		})
		await service.unsubscribe(issued.id, 'someone-else')
		await service.emit({ type: 'project.create', resource: 'project' })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('regenerateSecret deactivates the old row and issues a new secret with the same url/events', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		const original = await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['project.create'],
		})
		const rotated = await service.regenerateSecret(original.id, 'u1')

		expect(rotated.id).not.toBe(original.id)
		expect(rotated.secret).not.toBe(original.secret)

		await service.emit({ type: 'project.create', resource: 'project' })
		expect(fetchMock).toHaveBeenCalledTimes(1) // only the new, active subscription fires
	})
})

// ===========================================================================
// Issue #185 — the outbound half of the gating clauses, end to end
// ===========================================================================

describe('outbound: subscriber URLs are validated', () => {
	it('refuses a subscription pointed at an internal address, at the form', async () => {
		service = new WebhookService({ db, fetch: vi.fn() })
		await expect(
			service.subscribe({
				userId: 'u1',
				url: 'https://169.254.169.254/latest/meta-data/',
				events: ['*'],
			}),
		).rejects.toThrow(/internal address/)
	})

	it('refuses to DELIVER to a name that has since been re-pointed inward', async () => {
		// The DNS-rebinding case: the URL passed at subscribe time. The delivery
		// must be refused, recorded, and NOT retried — retrying a request we have
		// decided not to make is just making it three times.
		const fetchMock = vi.fn()
		let resolvesTo = ['93.184.216.34']
		service = new WebhookService({
			db,
			fetch: fetchMock,
			ssrf: { resolve: async () => resolvesTo },
		})
		const issued = await service.subscribe({
			userId: 'u1',
			url: 'https://rebind.example.com/hook',
			events: ['*'],
		})
		resolvesTo = ['10.0.0.7']

		await service.emit({ type: 'project.create', resource: 'project' })

		expect(fetchMock).not.toHaveBeenCalled()
		const [delivery] = await service.listDeliveries(issued.id)
		expect(delivery).toMatchObject({ status: 'failed', attempts: 0 })
		expect(delivery?.error).toMatch(/internal address 10\.0\.0\.7/)
	})

	it('never follows a redirect', async () => {
		// A 302 to an internal address is the cheapest way around every check.
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['*'],
		})
		await service.emit({ type: 'project.create', resource: 'project' })
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(init.redirect).toBe('manual')
	})
})

describe('outbound: payloads are scoped by declared projection', () => {
	it('sends only the declared fields, and identifiers when nothing is declared', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock })
		await service.subscribe({
			userId: 'u1',
			url: 'https://declared.example.com/h',
			events: ['*'],
			projections: [{ resource: 'invoice', fields: ['id', 'total'] }],
		})
		await service.subscribe({
			userId: 'u1',
			url: 'https://bare.example.com/h',
			events: ['*'],
		})

		await service.emit({
			type: 'invoice.update',
			resource: 'invoice',
			resourceId: 'inv_1',
			data: { id: 'inv_1', total: 100, internalNotes: 'do not send' },
		})

		const bodies = Object.fromEntries(
			fetchMock.mock.calls.map(([url, init]) => [
				String(url),
				JSON.parse((init as RequestInit).body as string),
			]),
		)
		expect(bodies['https://declared.example.com/h'].data).toEqual({
			id: 'inv_1',
			total: 100,
		})
		expect(bodies['https://bare.example.com/h'].data).toEqual({ id: 'inv_1' })
		// No payload anywhere carries the undeclared field.
		for (const body of Object.values(bodies))
			expect(JSON.stringify(body)).not.toContain('do not send')
	})

	it('refuses a projection that names a never-sent field', async () => {
		service = new WebhookService({ db, fetch: vi.fn() })
		await expect(
			service.subscribe({
				userId: 'u1',
				url: 'https://example.com/h',
				events: ['*'],
				projections: [{ resource: 'user', fields: ['id', 'passwordHash'] }],
			}),
		).rejects.toThrow(/never sent to a third party/)
	})
})

describe('outbound: delivery attempts are audit entries', () => {
	it('records the outcome, the subscription and the url — but never the secret', async () => {
		const audit = createMemoryAuditSink()
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }))
		service = new WebhookService({ db, fetch: fetchMock, audit })
		const issued = await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['*'],
		})
		await service.emit({
			type: 'project.create',
			resource: 'project',
			resourceId: 'p1',
		})

		const [entry] = audit.entries
		expect(entry).toMatchObject({
			action: 'webhook.outbound.delivered',
			resource: 'project',
			resourceId: 'p1',
			// The platform's action, minutes later, possibly several times — not
			// the action of whoever happened to edit the row.
			origin: 'system',
			userId: `webhook:${issued.id}`,
		})
		// A delivery log that leaks the signing secret is worse than no log.
		expect(JSON.stringify(audit.entries)).not.toContain(issued.secret)
	})

	it('records a failure after the retries are exhausted', async () => {
		const audit = createMemoryAuditSink()
		service = new WebhookService({
			db,
			audit,
			fetch: vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
		})
		await service.subscribe({
			userId: 'u1',
			url: 'https://example.com/hook',
			events: ['*'],
		})
		await service.emit({ type: 'project.create', resource: 'project' })
		expect(audit.entries.at(-1)).toMatchObject({
			action: 'webhook.outbound.failed',
		})
	})
})
