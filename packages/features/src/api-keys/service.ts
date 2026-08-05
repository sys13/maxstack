/**
 * `ApiKeyService` — issue/verify/list/revoke/rotate personal access tokens
 * (task 57; hardened and promoted to a bundle in issue #186). Tokens are
 * generated and hashed with Web Crypto (the same global `crypto`
 * `billing.server.ts` already uses bare, no import) — only the hash is ever
 * persisted, so a leaked database doesn't leak usable credentials.
 *
 * What this service is deliberately *not* responsible for: deciding whether a
 * scope is allowed to do something. A scope is a **restriction**, applied by
 * the permission layer (`scopeGrants` in `@maxstack/core`) on top of the
 * holder's own access rules, so a key can never reach past the person who
 * issued it. Validating a scope against the holder's permissions at issue time
 * would be the wrong place for it twice over: permissions change after a key is
 * minted, and an issue-time check would be advisory rather than enforcing. What
 * *is* validated here is the scope's shape — an unparseable scope must not
 * reach the evaluator, where an unrecognized action would read as "no rule".
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/pglite'
import { apiKey } from './schema.ts'

type Db = ReturnType<typeof drizzle>

/** The action vocabulary a scope may name — `SproutAction`, restated so this
 * module does not depend on core for four string literals. */
const ACTIONS = ['read', 'create', 'update', 'delete'] as const
export type ApiKeyAction = (typeof ACTIONS)[number]

/** Resource name → the actions the key may perform on it. */
export type ApiKeyScope = Record<string, ApiKeyAction[]>

export interface ApiKeyView {
	id: string
	userId: string
	name: string
	prefix: string
	scope: ApiKeyScope
	organizationId: string | null
	rateLimitPerMinute: number | null
	createdAt: Date
	expiresAt: Date | null
	lastUsedAt: Date | null
	revokedAt: Date | null
}

export interface IssuedKey {
	id: string
	/** The plaintext token — shown once, at issue/rotate time only. Never
	 * retrievable again; only its hash is stored. */
	key: string
	prefix: string
}

/**
 * What a verified token resolves to. The caller turns this into a `SproutUser`;
 * everything on it is read from the key row, never from the request, which is
 * what keeps a key from claiming an org it was not issued for.
 */
export interface VerifiedKey {
	keyId: string
	userId: string
	scope: ApiKeyScope
	organizationId: string | null
	rateLimitPerMinute: number | null
}

let counter = 0
const nextId = () => `key-${Date.now().toString(36)}-${++counter}`

async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input)
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

function generateToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24))
	const body = btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
	return `mx_${body}`
}

/**
 * Reject a scope the evaluator could not read correctly, and normalize the rest
 * (dedup, drop empty resources). Throws rather than silently repairing: a
 * caller who asked for `"write"` meant something, and quietly storing `{}` for
 * it would mint a key that fails at every call for no visible reason.
 */
export function normalizeScope(scope: ApiKeyScope): ApiKeyScope {
	const out: ApiKeyScope = {}
	for (const [resource, actions] of Object.entries(scope ?? {})) {
		if (!resource.trim()) throw new Error('Scope names an empty resource')
		if (!Array.isArray(actions)) {
			throw new Error(`Scope for "${resource}" is not a list of actions`)
		}
		const seen = new Set<ApiKeyAction>()
		for (const action of actions) {
			if (!ACTIONS.includes(action as ApiKeyAction)) {
				throw new Error(
					`Scope for "${resource}" names unknown action "${String(action)}" ` +
						`(expected one of ${ACTIONS.join(', ')})`,
				)
			}
			seen.add(action as ApiKeyAction)
		}
		// A resource with no actions grants nothing; keeping it would be a
		// confusing entry in the UI that reads as access.
		if (seen.size > 0) out[resource] = [...seen]
	}
	if (Object.keys(out).length === 0) {
		throw new Error('A key must be scoped to at least one resource + action')
	}
	return out
}

function toView(row: typeof apiKey.$inferSelect): ApiKeyView {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		prefix: row.prefix,
		scope: row.scope as ApiKeyScope,
		organizationId: row.organizationId,
		rateLimitPerMinute: row.rateLimitPerMinute,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		lastUsedAt: row.lastUsedAt,
		revokedAt: row.revokedAt,
	}
}

export class ApiKeyService {
	private readonly db: Db

	constructor(opts: { db: Db }) {
		this.db = opts.db
	}

	async issueKey(input: {
		userId: string
		name: string
		scope: ApiKeyScope
		/** Pins the key to one org. A key without one reaches no tenant-scoped
		 * resource, because a key identity has no other source of an active org. */
		organizationId?: string | null
		/** Per-key request budget; null/omitted uses the deployment default. */
		rateLimitPerMinute?: number | null
		expiresAt?: Date | null
	}): Promise<IssuedKey> {
		const scope = normalizeScope(input.scope)
		const limit = input.rateLimitPerMinute
		if (limit !== undefined && limit !== null) {
			if (!Number.isInteger(limit) || limit <= 0) {
				throw new Error('rateLimitPerMinute must be a positive integer')
			}
		}
		const key = generateToken()
		const prefix = key.slice(0, 11) // `mx_` + 8 chars — enough to disambiguate in a list.
		const tokenHash = await sha256Hex(key)
		const id = nextId()
		await this.db.insert(apiKey).values({
			id,
			userId: input.userId,
			name: input.name,
			prefix,
			tokenHash,
			scope,
			organizationId: input.organizationId ?? null,
			rateLimitPerMinute: limit ?? null,
			createdAt: new Date(),
			expiresAt: input.expiresAt ?? null,
		})
		return { id, key, prefix }
	}

	/**
	 * Verify a presented token. Rejects a revoked or expired key; stamps
	 * `lastUsedAt` on success.
	 *
	 * Every call reads the row. That is a deliberate cost: revocation has to take
	 * effect on the *next* request, and any cache in front of this — even a
	 * one-second one — is a window in which a key the user has just revoked still
	 * works. At one indexed lookup on a unique hash column, a cache would be
	 * buying very little for what it gives up.
	 */
	async verifyKey(token: string): Promise<VerifiedKey | null> {
		const tokenHash = await sha256Hex(token)
		const [row] = await this.db
			.select()
			.from(apiKey)
			.where(eq(apiKey.tokenHash, tokenHash))
		if (!row || row.revokedAt) return null
		if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
		await this.db
			.update(apiKey)
			.set({ lastUsedAt: new Date() })
			.where(eq(apiKey.id, row.id))
		return {
			keyId: row.id,
			userId: row.userId,
			scope: row.scope as ApiKeyScope,
			organizationId: row.organizationId,
			rateLimitPerMinute: row.rateLimitPerMinute,
		}
	}

	async listKeys(userId: string): Promise<ApiKeyView[]> {
		const rows = await this.db
			.select()
			.from(apiKey)
			.where(eq(apiKey.userId, userId))
		return rows.map(toView)
	}

	/** Scoped to `userId` — an id from another user's keys is a no-op, not an error. */
	async revokeKey(id: string, userId: string): Promise<void> {
		await this.db
			.update(apiKey)
			.set({ revokedAt: new Date() })
			.where(
				and(
					eq(apiKey.id, id),
					eq(apiKey.userId, userId),
					isNull(apiKey.revokedAt),
				),
			)
	}

	/** Revoke `id` and issue a fresh key with the same name/scope/org/budget.
	 * No-op-safe: throws if `id` doesn't belong to `userId`. */
	async rotateKey(id: string, userId: string): Promise<IssuedKey> {
		const [row] = await this.db
			.select()
			.from(apiKey)
			.where(and(eq(apiKey.id, id), eq(apiKey.userId, userId)))
		if (!row) throw new Error('Key not found')
		await this.revokeKey(id, userId)
		return this.issueKey({
			userId,
			name: row.name,
			scope: row.scope as ApiKeyScope,
			organizationId: row.organizationId,
			rateLimitPerMinute: row.rateLimitPerMinute,
			expiresAt: row.expiresAt,
		})
	}
}
