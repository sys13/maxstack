/**
 * **Unsubscribe links** — a signed, stateless token that turns one
 * click in an email into a preference write, with no session required.
 *
 * Why signed rather than a row: the person clicking is in their mail client, not
 * in the app. Requiring a login to stop email is the pattern that gets a sender
 * reported as spam, and a bare `?user=u_18f&type=digest` URL lets anyone
 * unsubscribe anyone by editing the query string. An HMAC over the payload is
 * the smallest thing that is neither.
 *
 * The token deliberately does **not** expire. An unsubscribe link in a two-year
 * old email must still work — CAN-SPAM requires the mechanism to stay live for
 * at least 30 days after sending, and every mailbox provider treats a dead
 * unsubscribe as a spam signal. What it *can* do is nothing else: the payload
 * carries a user id and a scope, so the worst a leaked token achieves is
 * silencing mail the holder was already receiving.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** What a token unsubscribes from: one declared type, or all optional email. */
export type UnsubscribeScope = { kind: 'all' } | { kind: 'type'; type: string }

export interface UnsubscribePayload {
	userId: string
	scope: UnsubscribeScope
}

/**
 * How a service mints links. `baseUrl` is the route that handles the click; the
 * token is appended as `?token=`.
 */
export interface UnsubscribeConfig {
	/** HMAC key. Rotating it invalidates outstanding links — see the module doc
	 * on why that is a bigger deal than it sounds. */
	secret: string
	/** Absolute URL of the unsubscribe route, e.g. `https://app.example/unsubscribe`. */
	baseUrl: string
}

function b64url(input: Buffer | string): string {
	return Buffer.from(input)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

function fromB64url(input: string): Buffer {
	return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function sign(secret: string, body: string): string {
	return b64url(createHmac('sha256', secret).update(body).digest())
}

/** Serialize + sign an unsubscribe payload. */
export function mintUnsubscribeToken(
	secret: string,
	payload: UnsubscribePayload,
): string {
	const body = b64url(JSON.stringify(payload))
	return `${body}.${sign(secret, body)}`
}

/**
 * Verify a token and return its payload, or `null` for anything that does not
 * verify — a wrong signature, a truncated link, a mangled payload. Never throws:
 * the caller is a route handling whatever arrived in a URL.
 */
export function verifyUnsubscribeToken(
	secret: string,
	token: string,
): UnsubscribePayload | null {
	const [body, signature] = token.split('.')
	if (!body || !signature) return null
	const expected = sign(secret, body)
	// Constant-time compare on equal-length buffers; a length mismatch is
	// already a mismatch and short-circuits without leaking anything useful.
	const a = Buffer.from(signature)
	const b = Buffer.from(expected)
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null
	try {
		const parsed = JSON.parse(fromB64url(body).toString('utf8')) as unknown
		if (!parsed || typeof parsed !== 'object') return null
		const { userId, scope } = parsed as UnsubscribePayload
		if (typeof userId !== 'string' || !userId) return null
		if (!scope || typeof scope !== 'object') return null
		if (scope.kind === 'all') return { userId, scope: { kind: 'all' } }
		if (scope.kind === 'type' && typeof scope.type === 'string' && scope.type)
			return { userId, scope: { kind: 'type', type: scope.type } }
		return null
	} catch {
		return null
	}
}

/** The link an email carries. */
export function unsubscribeUrl(
	config: UnsubscribeConfig,
	payload: UnsubscribePayload,
): string {
	const token = mintUnsubscribeToken(config.secret, payload)
	const joiner = config.baseUrl.includes('?') ? '&' : '?'
	return `${config.baseUrl}${joiner}token=${encodeURIComponent(token)}`
}
