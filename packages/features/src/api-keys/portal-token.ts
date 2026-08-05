/**
 * Portal tokens — the credential behind a `token`-audience portal:
 * the link a freelancer emails a client so they can see one invoice.
 *
 * ## Why this lives in the `api-keys` bundle and not in a new one
 *
 * Two reasons, and the first is a hard constraint. The bundle catalog is at its
 * **16-bundle cap**, and this feature needs no new bundle to exist.
 *
 * The second is that the fit is genuine rather than convenient. A portal token
 * **is** a scoped, expiring, revocable credential, which is the whole of what
 * this bundle already models: it owns the SHA-256-only storage discipline, the
 * "shown once, never re-displayed" issue path, `expiresAt` checked at verify
 * time, `revokedAt` for revocation, `lastUsedAt` for the audit trail, and the
 * per-credential rate-limit budget. Putting a portal token in `auth` — the other
 * candidate — would have meant re-implementing all six beside a session store
 * that models none of them, because a session is a thing you *have* while signed
 * in and a portal token is a thing you were *sent*.
 *
 * What it does not share with an api key is the *scope*: a key carries a
 * `Record<resource, actions[]>` and a portal token carries a **portal key** plus
 * optionally **one row id**. That difference is why it is a second table rather
 * than three nullable columns on `api_key` — a nullable-scope key row would make
 * `verifyKey` able to return a credential with no scope, and the permission
 * layer reads an absent scope as "unrestricted session". A separate table cannot
 * be confused for a key by anything.
 *
 * ## What the token is not allowed to decide
 *
 * Nothing. It resolves to a portal key and a row id; **what that portal may see
 * is read from the declaration**, never from the token. A token that carried its
 * own field list would be a second copy of the projection, mintable by whoever
 * called `mint`, and the exposure report would stop being able to tell you what
 * is exposed.
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import { portalToken } from './schema.ts'

type Db = ReturnType<typeof drizzle>

/** A minted token, returned once. Only its hash is ever persisted. */
export interface MintedPortalToken {
	id: string
	/**
	 * The plaintext token — the thing that goes in the link, shown once at mint
	 * time only. There is no path that returns it again, here or anywhere.
	 */
	token: string
	expiresAt: Date
}

/**
 * What a verified token resolves to.
 *
 * Deliberately three facts and no more: which portal, which row (if any), and
 * which credential row to revoke. Everything a request is then allowed to do is
 * read from the *declaration* for `portalKey` — see the module comment.
 */
export interface VerifiedPortalToken {
	tokenId: string
	portalKey: string
	/** The one row this token opens, for a `row`-scoped portal. */
	rowId: string | null
}

let counter = 0
const nextId = () => `ptk-${Date.now().toString(36)}-${++counter}`

async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input)
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

/**
 * 32 bytes of CSPRNG output, url-safe.
 *
 * Wider than an api key's 24 because this one travels in a URL that ends up in
 * mail archives, browser history and referrer headers, and unlike a key it is
 * frequently the *only* thing standing between a stranger and a row. 256 bits
 * is not guessable and costs nothing.
 */
function generateToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

/** What the service records when a token is minted or revoked. */
export type PortalTokenAudit = (entry: {
	userId: string
	action: 'create' | 'delete'
	resource: string
	resourceId?: string
	origin: 'session' | 'api-key' | 'mcp' | 'system' | 'portal'
	metadata?: Record<string, unknown>
}) => void | Promise<void>

export class PortalTokenService {
	private readonly db: Db
	private readonly audit?: PortalTokenAudit

	constructor(opts: { db: Db; audit?: PortalTokenAudit }) {
		this.db = opts.db
		this.audit = opts.audit
	}

	/**
	 * Mint a token for one portal, optionally bound to one row.
	 *
	 * `ttlHours` and `maxUses` come from the **declaration**, not from the
	 * caller's imagination: `portals.declare` requires a `ttlHours` and refuses a
	 * missing `maxUses`, so there is no shape of this call that produces a
	 * non-expiring link. The expiry is computed here rather than stored as a
	 * duration so that shortening a portal's declared TTL does not retroactively
	 * extend or shorten links already in somebody's inbox — a live token's expiry
	 * is a fact about the token.
	 *
	 * Minting is audited, because "who sent this link" is the first question
	 * anybody asks about a leaked one.
	 */
	async mint(input: {
		portalKey: string
		/** The row a `row`-scoped portal's token opens. `null` for a collection. */
		rowId?: string | null
		/** From the declaration. Required — there is no non-expiring token. */
		ttlHours: number
		/** From the declaration. `null` = unlimited opens within the TTL. */
		maxUses: number | null
		/** Who minted it, for the audit entry. */
		issuedBy: string
	}): Promise<MintedPortalToken> {
		if (!Number.isInteger(input.ttlHours) || input.ttlHours < 1)
			throw new Error('ttlHours must be a positive integer')
		if (
			input.maxUses !== null &&
			(!Number.isInteger(input.maxUses) || input.maxUses < 1)
		)
			throw new Error('maxUses must be null or a positive integer')
		const token = generateToken()
		const id = nextId()
		const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000)
		await this.db.insert(portalToken).values({
			id,
			portalKey: input.portalKey,
			rowId: input.rowId ?? null,
			tokenHash: await sha256Hex(token),
			maxUses: input.maxUses,
			uses: 0,
			createdAt: new Date(),
			expiresAt,
		})
		await this.record({
			userId: input.issuedBy,
			action: 'create',
			resource: 'portal_token',
			resourceId: id,
			origin: 'session',
			metadata: {
				portalKey: input.portalKey,
				rowId: input.rowId ?? null,
				expiresAt: expiresAt.toISOString(),
				maxUses: input.maxUses,
			},
		})
		return { id, token, expiresAt }
	}

	/**
	 * Verify a presented token, spending one use.
	 *
	 * Three refusals, all checked on every call and all against the row rather
	 * than against anything cached:
	 *
	 *  - **revoked** — `revokedAt` set. Revocation has to take effect on the next
	 *    request, and any cache in front of this is a window in which a link
	 *    somebody has just killed still works. `ApiKeyService.verifyKey` makes the
	 *    same trade for the same reason.
	 *  - **expired** — `expiresAt` in the past. Compared with `<=`, so a token
	 *    expires *at* its expiry rather than one millisecond later.
	 *  - **used up** — `uses >= maxUses`, when a cap was declared. Incremented on
	 *    every successful verify, so the counter measures opens rather than
	 *    renders.
	 *
	 * Returns `null` for all three, indistinguishably, and for an unknown hash
	 * too. A verifier that distinguished "expired" from "never existed" is an
	 * oracle — the same argument `webhooks/inbound.ts` makes about its uniform
	 * 401.
	 */
	async verify(token: string): Promise<VerifiedPortalToken | null> {
		const tokenHash = await sha256Hex(token)
		const [row] = await this.db
			.select()
			.from(portalToken)
			.where(eq(portalToken.tokenHash, tokenHash))
		if (!row || row.revokedAt) return null
		if (row.expiresAt.getTime() <= Date.now()) return null
		if (row.maxUses !== null && row.uses >= row.maxUses) return null
		await this.db
			.update(portalToken)
			.set({ uses: row.uses + 1, lastUsedAt: new Date() })
			.where(eq(portalToken.id, row.id))
		return {
			tokenId: row.id,
			portalKey: row.portalKey,
			rowId: row.rowId,
		}
	}

	/** Every live token for one portal — what a "revoke this link" UI lists. */
	async list(portalKey: string) {
		return this.db
			.select()
			.from(portalToken)
			.where(eq(portalToken.portalKey, portalKey))
	}

	/** Revoke one token. Idempotent: revoking an already-revoked token is a no-op. */
	async revoke(id: string, revokedBy: string): Promise<void> {
		await this.db
			.update(portalToken)
			.set({ revokedAt: new Date() })
			.where(and(eq(portalToken.id, id), isNull(portalToken.revokedAt)))
		await this.record({
			userId: revokedBy,
			action: 'delete',
			resource: 'portal_token',
			resourceId: id,
			origin: 'session',
		})
	}

	/**
	 * Revoke every live token for a portal — the companion to `portals.pause`.
	 *
	 * Pausing stops the surface answering; this stops the links working even
	 * after it comes back. They are separate because they answer separate
	 * questions ("is this surface up?" versus "is this particular link still
	 * good?"), and conflating them would mean a pause silently invalidated every
	 * link a business had sent out.
	 */
	async revokeAllFor(portalKey: string, revokedBy: string): Promise<number> {
		const live = await this.db
			.select()
			.from(portalToken)
			.where(
				and(
					eq(portalToken.portalKey, portalKey),
					isNull(portalToken.revokedAt),
				),
			)
		for (const row of live) await this.revoke(row.id, revokedBy)
		return live.length
	}

	private async record(entry: Parameters<PortalTokenAudit>[0]): Promise<void> {
		if (!this.audit) return
		try {
			await this.audit(entry)
		} catch {
			// Auditing is observational; a sink error must not fail a mint or a
			// revoke — least of all a revoke.
		}
	}
}
