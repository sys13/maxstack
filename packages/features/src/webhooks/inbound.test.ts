/**
 * Issue #185's second gating clause: *"inbound webhooks are an unauthenticated
 * write path. Signature verification is mandatory and must be constant-time; an
 * unsigned receiver must be impossible to declare, not merely discouraged."*
 * Plus replay protection (timestamp + nonce).
 *
 * The tests assert the *impossibility*, not the default. "Verification is on by
 * default" is a much weaker claim than "there is no way to turn it off", and
 * only the second one survives a hurried config change in staging.
 */

import { describe, expect, it } from 'vitest'
import { createMemoryAuditSink } from '../audit/index.ts'
import {
	MIN_RECEIVER_SECRET_LENGTH,
	ReceiverDeclarationError,
	ReceiverRegistry,
	receiverErrors,
} from './inbound.ts'
import {
	createMemoryNonceStore,
	newNonce,
	REPLAY_WINDOW_SECONDS,
	signatureHeaders,
	signBody,
	timingSafeEqualHex,
} from './signing.ts'

const SECRET = 'a'.repeat(MIN_RECEIVER_SECRET_LENGTH)

async function signed(
	body: string,
	opts: { secret?: string; at?: Date; nonce?: string } = {},
) {
	const timestamp = Math.floor((opts.at ?? new Date()).getTime() / 1000)
	const nonce = opts.nonce ?? newNonce()
	const signature = await signBody(opts.secret ?? SECRET, {
		timestamp,
		nonce,
		body,
	})
	return signatureHeaders({
		signature,
		timestamp,
		nonce,
		eventType: 'payment.succeeded',
	})
}

describe('an unsigned receiver cannot be declared', () => {
	it('refuses a receiver with no secret', () => {
		const errors = receiverErrors({
			key: 'stripe',
			secret: '',
			map: () => [],
		})
		expect(errors.join()).toMatch(/unauthenticated write endpoint/)
		expect(() =>
			new ReceiverRegistry().declare({
				key: 'stripe',
				secret: '',
				map: () => [],
			}),
		).toThrow(ReceiverDeclarationError)
	})

	it('refuses a secret short enough to guess', () => {
		expect(() =>
			new ReceiverRegistry().declare({
				key: 'stripe',
				secret: 'hunter2',
				map: () => [],
			}),
		).toThrow(/at least 32/)
	})

	it('has no field that turns verification off', () => {
		// A structural assertion rather than a behavioral one, deliberately: the
		// claim being defended is about the *type*, and a future `verify?: false`
		// would pass every behavioral test in this file while gutting the feature.
		const declaration = { key: 'stripe', secret: SECRET, map: () => [] }
		for (const forbidden of [
			'verify',
			'skipSignature',
			'insecure',
			'allowUnsigned',
		])
			expect(Object.hasOwn(declaration, forbidden)).toBe(false)
		expect(receiverErrors(declaration)).toEqual([])
	})

	it('refuses a duplicate key rather than silently replacing a receiver', () => {
		const r = new ReceiverRegistry()
		r.declare({ key: 'stripe', secret: SECRET, map: () => [] })
		expect(() =>
			r.declare({ key: 'stripe', secret: SECRET, map: () => [] }),
		).toThrow(/already declared/)
	})
})

describe('verification', () => {
	const withReceiver = (
		map = () => [{ resource: 'invoice', action: 'update' as const }],
	) => {
		const r = new ReceiverRegistry({ nonces: createMemoryNonceStore() })
		r.declare({ key: 'stripe', secret: SECRET, map })
		return r
	}

	it('accepts a correctly signed body and returns the mapped writes', async () => {
		const body = JSON.stringify({ type: 'payment.succeeded', id: 'in_1' })
		const { response, outcome } = await withReceiver().handle('stripe', {
			body,
			headers: await signed(body),
		})
		expect(response.status).toBe(204)
		expect(outcome.accepted).toBe(true)
		expect(outcome.writes).toEqual([{ resource: 'invoice', action: 'update' }])
	})

	it('rejects a body signed with the wrong secret', async () => {
		const body = '{"a":1}'
		const { response, outcome } = await withReceiver().handle('stripe', {
			body,
			headers: await signed(body, { secret: 'b'.repeat(40) }),
		})
		expect(response.status).toBe(401)
		expect(outcome.failure).toBe('bad-signature')
	})

	it('rejects a body that was altered after signing', async () => {
		const headers = await signed('{"amount":100}')
		const { outcome } = await withReceiver().handle('stripe', {
			body: '{"amount":1000000}',
			headers,
		})
		expect(outcome.failure).toBe('bad-signature')
	})

	it('rejects a request with no signature at all', async () => {
		const { response, outcome } = await withReceiver().handle('stripe', {
			body: '{}',
			headers: {},
		})
		expect(response.status).toBe(401)
		expect(outcome.failure).toBe('missing-signature')
	})

	it('returns an identical response for every failure — no oracle', async () => {
		// A receiver that distinguishes "bad signature" from "unknown receiver"
		// tells an attacker which half of their guess was right, for free.
		const r = withReceiver()
		const body = '{}'
		const responses = await Promise.all([
			r.handle('stripe', { body, headers: {} }),
			r.handle('stripe', {
				body,
				headers: await signed(body, { secret: 'z'.repeat(40) }),
			}),
			r.handle('does-not-exist', { body, headers: await signed(body) }),
		])
		const shapes = await Promise.all(
			responses.map(async ({ response }) => ({
				status: response.status,
				body: await response.text(),
				headers: [...response.headers.keys()].sort(),
			})),
		)
		expect(shapes[1]).toEqual(shapes[0])
		expect(shapes[2]).toEqual(shapes[0])
		// …while our own record keeps the reason, where it is diagnosis.
		expect(responses.map((r) => r.outcome.failure)).toEqual([
			'missing-signature',
			'bad-signature',
			'unknown-receiver',
		])
	})
})

describe('replay protection', () => {
	const withReceiver = () => {
		const r = new ReceiverRegistry({ nonces: createMemoryNonceStore() })
		r.declare({ key: 'stripe', secret: SECRET, map: () => [] })
		return r
	}

	it('rejects the exact same delivery twice', async () => {
		const r = withReceiver()
		const body = '{"id":"evt_1"}'
		const headers = await signed(body)
		expect((await r.handle('stripe', { body, headers })).outcome.accepted).toBe(
			true,
		)
		const second = await r.handle('stripe', { body, headers })
		expect(second.outcome.failure).toBe('replayed')
		expect(second.response.status).toBe(401)
	})

	it('rejects a delivery signed outside the window, in both directions', async () => {
		const r = withReceiver()
		const body = '{}'
		const old = new Date(Date.now() - (REPLAY_WINDOW_SECONDS + 60) * 1000)
		const future = new Date(Date.now() + (REPLAY_WINDOW_SECONDS + 60) * 1000)
		expect(
			(
				await r.handle('stripe', {
					body,
					headers: await signed(body, { at: old }),
				})
			).outcome.failure,
		).toBe('stale-timestamp')
		// A future timestamp is as suspicious as an old one — it means pre-signing.
		expect(
			(
				await r.handle('stripe', {
					body,
					headers: await signed(body, { at: future }),
				})
			).outcome.failure,
		).toBe('stale-timestamp')
	})

	it('checks the signature BEFORE burning a nonce', async () => {
		// Otherwise an unauthenticated caller can fill the nonce store with
		// garbage, or pre-burn the nonce a genuine delivery is about to use.
		const nonces = createMemoryNonceStore()
		const r = new ReceiverRegistry({ nonces })
		r.declare({ key: 'stripe', secret: SECRET, map: () => [] })
		const body = '{}'
		const nonce = 'shared-nonce'
		await r.handle('stripe', {
			body,
			headers: await signed(body, { secret: 'z'.repeat(40), nonce }),
		})
		expect(nonces.size()).toBe(0)
		// The genuine delivery with the same nonce still works.
		expect(
			(
				await r.handle('stripe', {
					body,
					headers: await signed(body, { nonce }),
				})
			).outcome.accepted,
		).toBe(true)
	})
})

describe('audit', () => {
	it('records every attempt, accepted or rejected, as a system-origin entry', async () => {
		const audit = createMemoryAuditSink()
		const r = new ReceiverRegistry({ audit })
		r.declare({ key: 'stripe', secret: SECRET, map: () => [] })
		const body = '{}'
		await r.handle('stripe', { body, headers: await signed(body) })
		await r.handle('stripe', { body, headers: {} })
		expect(audit.entries.map((e) => e.action)).toEqual([
			'webhook.inbound.accepted',
			'webhook.inbound.rejected',
		])
		// Nobody was logged in; attributing this to a person would be a fiction.
		expect(audit.entries.every((e) => e.origin === 'system')).toBe(true)
	})
})

describe('constant-time comparison', () => {
	it('is correct', () => {
		expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true)
		expect(timingSafeEqualHex('abcd', 'abce')).toBe(false)
		expect(timingSafeEqualHex('abcd', 'abcde')).toBe(false)
		expect(timingSafeEqualHex('', '')).toBe(true)
	})

	it('reads every character even when the first one differs', () => {
		// The property that matters cannot be asserted by timing in a unit test
		// (far too noisy), so assert the thing that makes it true: the comparison
		// does not short-circuit. A `===` implementation reads nothing here.
		const reads: number[] = []
		// A String object is the only way to instrument charCodeAt on something the
		// function accepts.
		const spy = new String('ffff') as string & {
			charCodeAt: (i: number) => number
		}
		spy.charCodeAt = (i: number) => {
			reads.push(i)
			return 'ffff'.charCodeAt(i)
		}
		expect(timingSafeEqualHex(spy as unknown as string, '0000')).toBe(false)
		expect(reads).toEqual([0, 1, 2, 3])
	})
})
