/**
 * Read-side access control for stored files.
 *
 * The rule the issue sets is that a file attached to a row the caller cannot
 * see must not be fetchable, *including via a guessable URL*. Two mechanisms
 * together get there, and neither is sufficient alone:
 *
 *  1. **Every read goes through the app's `/files/:key` gateway.** Not "local
 *     disk goes through the app and S3 hands out a presigned URL" — that would
 *     make the dev and deploy drivers differ on the one axis that matters most.
 *     The gateway is where the authorization decision happens, for every driver.
 *
 *  2. **The gateway URL is bound to a viewer.** The token is an HMAC over
 *     `key + subject + expiry`, so it is not guessable (an attacker cannot mint
 *     one without the secret) *and* not transferable (a link copied out of one
 *     person's page is rejected for everyone else, because the subject is in
 *     the MAC and re-checked against the session).
 *
 * The row-level half is the caller's: a gateway URL is only minted by a loader
 * that has already read the owning row through the access-controlled read path,
 * so possessing a token is itself evidence that the row was visible. What this
 * module supplies is the part that must not be re-implemented per app —
 * constant-time verification, expiry, and viewer binding.
 *
 * **The residual window, stated plainly.** A token stays valid until it
 * expires, so a viewer who loses access to a row keeps a working link for at
 * most {@link DEFAULT_READ_TTL_SECONDS}. Closing that would mean checking the
 * row on every byte-range request, which is the reason to keep the TTL short
 * rather than a reason to pretend the window is not there.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** How long a minted read token stays valid. Short on purpose — see the
 * "residual window" note above. */
export const DEFAULT_READ_TTL_SECONDS = 15 * 60

/** The subject recorded for an unauthenticated viewer. A real user id can never
 * collide with it: this contains a character ids do not. */
export const ANONYMOUS_SUBJECT = '@anonymous'

/** Why a read was refused. Distinguished so the gateway can answer 403 vs 404
 * correctly and so tests assert on a reason rather than a boolean. */
export type FileReadDenial =
	| 'malformed'
	| 'expired'
	| 'bad-signature'
	| 'wrong-subject'

export type FileReadVerdict =
	| { ok: true; key: string; subject: string }
	| { ok: false; reason: FileReadDenial }

/** The token payload, exactly as it is MAC'd. Order is fixed and the separator
 * cannot appear in a storage key (keys are uuid + a known extension), so no two
 * distinct payloads can serialize to the same string. */
function payload(key: string, subject: string, expiresAt: number): string {
	return `v1|${key}|${subject}|${expiresAt}`
}

function mac(secret: string, key: string, subject: string, expiresAt: number) {
	return createHmac('sha256', secret)
		.update(payload(key, subject, expiresAt))
		.digest('hex')
}

/** Constant-time hex compare that does not leak length via an early return
 * path an attacker can time differently from a mismatch. */
function sameMac(expected: string, provided: string): boolean {
	const a = Buffer.from(expected, 'hex')
	const b = Buffer.from(provided, 'hex')
	if (a.length === 0 || a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

export interface MintReadTokenInput {
	secret: string
	key: string
	/** The viewer this URL is for; `undefined` mints an anonymous-bound token. */
	subject?: string | null
	expiresInSeconds?: number
	/** Test seam: the clock. Defaults to `Date.now`. */
	now?: () => number
}

export interface ReadToken {
	exp: number
	sig: string
	subject: string
}

/** Mint a viewer-bound, expiring read token for one storage key. */
export function mintReadToken(input: MintReadTokenInput): ReadToken {
	const now = input.now?.() ?? Date.now()
	const subject = input.subject || ANONYMOUS_SUBJECT
	const exp = now + (input.expiresInSeconds ?? DEFAULT_READ_TTL_SECONDS) * 1000
	return { exp, sig: mac(input.secret, input.key, subject, exp), subject }
}

/**
 * Build the gateway URL a page renders: `<prefix>/<key>?exp=…&sig=…`.
 *
 * The subject is deliberately **not** in the query string. It is bound into the
 * MAC and re-derived from the caller's session at verification time, so the URL
 * carries no claim about who you are — it only works if you already are that
 * person. Putting it in the URL would invite exactly the substitution attack
 * the binding exists to prevent.
 */
export function fileGatewayUrl(
	input: MintReadTokenInput & { prefix?: string },
): string {
	const { exp, sig } = mintReadToken(input)
	const prefix = (input.prefix ?? '/files').replace(/\/$/, '')
	return `${prefix}/${encodeURIComponent(input.key)}?exp=${exp}&sig=${sig}`
}

export interface VerifyReadTokenInput {
	secret: string
	key: string
	/** The viewer making *this* request, from the session — never from the URL. */
	subject?: string | null
	exp: string | number | null | undefined
	sig: string | null | undefined
	now?: () => number
}

/**
 * Verify a gateway request. Fails closed on every unclear case, and reports
 * `wrong-subject` distinctly from `bad-signature` only because the caller
 * already knows both values — the distinction is for logs and tests, and both
 * are refusals.
 */
export function verifyReadToken(input: VerifyReadTokenInput): FileReadVerdict {
	const { secret, key } = input
	if (
		!secret ||
		!key ||
		!input.sig ||
		input.exp === null ||
		input.exp === undefined
	) {
		return { ok: false, reason: 'malformed' }
	}
	const exp = typeof input.exp === 'number' ? input.exp : Number(input.exp)
	if (!Number.isFinite(exp) || !Number.isInteger(exp)) {
		return { ok: false, reason: 'malformed' }
	}
	if (exp <= (input.now?.() ?? Date.now())) {
		return { ok: false, reason: 'expired' }
	}

	const subject = input.subject || ANONYMOUS_SUBJECT
	if (sameMac(mac(secret, key, subject, exp), input.sig)) {
		return { ok: true, key, subject }
	}
	// A token that verifies for *nobody* is a forgery; one that would have
	// verified for the anonymous subject but not this user is a transferred
	// link. Both are refused; the reason only sharpens the log line.
	const anonymous = sameMac(mac(secret, key, ANONYMOUS_SUBJECT, exp), input.sig)
	return {
		ok: false,
		reason:
			anonymous && subject !== ANONYMOUS_SUBJECT
				? 'wrong-subject'
				: 'bad-signature',
	}
}
