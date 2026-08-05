/**
 * **The webhook signature scheme** — one implementation, used by
 * both directions.
 *
 * Outbound and inbound sign and verify the *same* way on purpose. Two schemes
 * would mean two chances to get constant-time comparison wrong, two replay
 * windows to keep in step, and a subscriber who cannot reuse our own receiver
 * code to check what we sent.
 *
 * ## The signed string
 *
 * ```
 * v1:<timestamp>:<nonce>:<body>
 * ```
 *
 * signed with HMAC-SHA256 over the subscription secret, and carried as
 *
 * ```
 * X-Maxstack-Signature: v1=<hex>
 * X-Maxstack-Timestamp: <unix seconds>
 * X-Maxstack-Nonce: <random>
 * ```
 *
 * The timestamp and nonce are **inside** the signed string, not merely beside
 * it. A signature over the body alone is replayable forever: an attacker who
 * captures one valid delivery can re-send it any number of times, and every
 * check passes because the body did not change. Signing the timestamp binds the
 * message to a window; signing the nonce lets the receiver reject the exact
 * message twice inside that window.
 *
 * ## Constant-time comparison is mandatory
 *
 * `a === b` on a hex digest leaks, through timing, how many leading characters
 * of a guess were right — which turns forging a signature from a
 * 2^256 problem into a few thousand requests per character.
 * {@link timingSafeEqualHex} compares every character regardless.
 */

/** The signature scheme version. Present in the signed string so it can move. */
export const SIGNATURE_VERSION = 'v1'

export const SIGNATURE_HEADER = 'x-maxstack-signature'
export const TIMESTAMP_HEADER = 'x-maxstack-timestamp'
export const NONCE_HEADER = 'x-maxstack-nonce'
export const EVENT_HEADER = 'x-maxstack-event'

/**
 * How far a delivery's timestamp may be from the receiver's clock, in seconds.
 *
 * Five minutes is the industry convention (Stripe, GitHub, Slack all sit at or
 * near it) and it is a real trade-off rather than a magic number: shorter and
 * ordinary clock skew starts rejecting genuine deliveries; longer and a captured
 * message stays replayable for longer. It is symmetric, because a *future*
 * timestamp is as suspicious as an old one — it usually means someone is
 * pre-signing.
 */
export const REPLAY_WINDOW_SECONDS = 300

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
}

/** The exact bytes that get signed. Exported so a subscriber can reproduce it. */
export function signedPayload(input: {
	timestamp: number
	nonce: string
	body: string
}): string {
	return `${SIGNATURE_VERSION}:${input.timestamp}:${input.nonce}:${input.body}`
}

/** HMAC-SHA256 over {@link signedPayload}, hex-encoded. */
export async function signBody(
	secret: string,
	input: { timestamp: number; nonce: string; body: string },
): Promise<string> {
	const key = await hmacKey(secret)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(signedPayload(input)),
	)
	return [...new Uint8Array(signature)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

/**
 * Compare two hex digests without leaking, through timing, how much of a guess
 * was right.
 *
 * Length is compared first and the loop still runs to a fixed bound, so an
 * attacker learns at most "wrong length" — which they already know, because the
 * digest length is a published constant.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	const length = Math.max(a.length, b.length)
	let diff = a.length ^ b.length
	for (let i = 0; i < length; i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
	}
	return diff === 0
}

/** The headers a signed delivery carries. */
export function signatureHeaders(input: {
	signature: string
	timestamp: number
	nonce: string
	eventType: string
}): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		[SIGNATURE_HEADER]: `${SIGNATURE_VERSION}=${input.signature}`,
		[TIMESTAMP_HEADER]: String(input.timestamp),
		[NONCE_HEADER]: input.nonce,
		[EVENT_HEADER]: input.eventType,
	}
}

/** A random nonce. 16 bytes is far past birthday collisions inside a 5m window. */
export function newNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Why a signature check failed. Never returned to the caller verbatim — see
 * `inbound.ts` — but recorded, because "it was rejected" is not a diagnosis. */
export type VerifyFailure =
	| 'missing-signature'
	| 'missing-timestamp'
	| 'missing-nonce'
	| 'bad-version'
	| 'stale-timestamp'
	| 'replayed'
	| 'bad-signature'

export type VerifyResult =
	| { ok: true; timestamp: number; nonce: string }
	| { ok: false; failure: VerifyFailure }

/** Remembers nonces long enough to reject a replay inside the window. */
export interface NonceStore {
	/** Record `nonce`; returns `false` if it was already present (a replay). */
	claim(nonce: string, expiresAt: Date): Promise<boolean>
}

/**
 * An in-memory {@link NonceStore}. Correct for a single process and honest about
 * it: with several receiver processes, a replay can land on a process that has
 * not seen the nonce. A shared store (the `job` table's unique index, Redis, a
 * dedicated table) is the deployment answer — the interface exists so swapping
 * one in is a binding change rather than a rewrite.
 */
export function createMemoryNonceStore(): NonceStore & { size(): number } {
	const seen = new Map<string, number>()
	return {
		async claim(nonce, expiresAt) {
			const now = Date.now()
			for (const [key, expiry] of seen) if (expiry <= now) seen.delete(key)
			if (seen.has(nonce)) return false
			seen.set(nonce, expiresAt.getTime())
			return true
		},
		size: () => seen.size,
	}
}

/**
 * Verify a signed request. **Every** check is mandatory; there is no option to
 * skip one, because a receiver that can be configured to trust an unsigned
 * request is a receiver somebody will configure that way.
 */
export async function verifySignedRequest(input: {
	secret: string
	body: string
	headers: Headers | Record<string, string>
	now?: Date
	nonces?: NonceStore
	windowSeconds?: number
}): Promise<VerifyResult> {
	const read = (name: string): string | null =>
		input.headers instanceof Headers
			? input.headers.get(name)
			: (input.headers[name] ?? input.headers[name.toLowerCase()] ?? null)

	const rawSignature = read(SIGNATURE_HEADER)
	if (!rawSignature) return { ok: false, failure: 'missing-signature' }
	const rawTimestamp = read(TIMESTAMP_HEADER)
	if (!rawTimestamp) return { ok: false, failure: 'missing-timestamp' }
	const nonce = read(NONCE_HEADER)
	if (!nonce) return { ok: false, failure: 'missing-nonce' }

	const [version, provided] = rawSignature.split('=')
	if (version !== SIGNATURE_VERSION || !provided)
		return { ok: false, failure: 'bad-version' }

	const timestamp = Number(rawTimestamp)
	if (!Number.isFinite(timestamp))
		return { ok: false, failure: 'missing-timestamp' }
	const window = input.windowSeconds ?? REPLAY_WINDOW_SECONDS
	const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
	// Symmetric: a future timestamp is as suspicious as an old one.
	if (Math.abs(nowSeconds - timestamp) > window)
		return { ok: false, failure: 'stale-timestamp' }

	const expected = await signBody(input.secret, {
		timestamp,
		nonce,
		body: input.body,
	})
	// Signature BEFORE nonce: an unauthenticated caller must not be able to fill
	// the nonce store with garbage, or burn a nonce a real delivery will use.
	if (!timingSafeEqualHex(expected, provided))
		return { ok: false, failure: 'bad-signature' }

	if (input.nonces) {
		const fresh = await input.nonces.claim(
			nonce,
			new Date((timestamp + window) * 1000),
		)
		if (!fresh) return { ok: false, failure: 'replayed' }
	}

	return { ok: true, timestamp, nonce }
}
