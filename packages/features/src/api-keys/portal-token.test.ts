/**
 * Portal tokens, against a real pglite database.
 *
 * Named after the exposures, like the rest of the portal work: the three
 * refusals a link-shaped credential has to make are revocation, expiry and the
 * use cap, and each is checked non-vacuously — the token is proved to work
 * first, then required to stop.
 */

import type { PGlite } from '@electric-sql/pglite'
import { bootPglite } from '@maxstack/core/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePglite } from '../testing/pglite-fixture.ts'
import { PortalTokenService } from './portal-token.ts'
import { PORTAL_TOKENS_DDL } from './schema.ts'

const pg = usePglite(PORTAL_TOKENS_DDL)

let client: PGlite
let service: PortalTokenService
const audited: { action: string; resourceId?: string; origin: string }[] = []

beforeEach(() => {
	client = pg.client
	audited.length = 0
	service = new PortalTokenService({
		db: pg.db,
		audit: (entry) => {
			audited.push({
				action: entry.action,
				resourceId: entry.resourceId,
				origin: entry.origin,
			})
		},
	})
})

const mint = (over: Partial<Parameters<PortalTokenService['mint']>[0]> = {}) =>
	service.mint({
		portalKey: 'client-invoice',
		rowId: 'row-1',
		ttlHours: 24,
		maxUses: null,
		issuedBy: 'u-ann',
		...over,
	})

describe('the DDL is safe to run on every boot, including an existing database', () => {
	it('is idempotent and adds columns to a table that predates them', async () => {
		// The `CREATE TABLE IF NOT EXISTS` trap, which has bitten this repo twice:
		// the CREATE does nothing on a database that already has the table, so a
		// column added later is never created. The explicit ALTERs are why running
		// this against a pre-existing narrow table works.
		const legacy = await bootPglite()
		await legacy.exec(
			'CREATE TABLE portal_token (id text PRIMARY KEY, portal_key text NOT NULL, token_hash text NOT NULL UNIQUE, created_at timestamp NOT NULL DEFAULT now());',
		)
		await legacy.exec(PORTAL_TOKENS_DDL)
		const cols = await legacy.query<{ column_name: string }>(
			"SELECT column_name FROM information_schema.columns WHERE table_name = 'portal_token'",
		)
		const names = cols.rows.map((r) => r.column_name)
		for (const column of [
			'row_id',
			'max_uses',
			'uses',
			'expires_at',
			'last_used_at',
			'revoked_at',
		])
			expect(names).toContain(column)
		// And running it a second time on the upgraded table is still a no-op.
		await legacy.exec(PORTAL_TOKENS_DDL)
		await legacy.close()
	})
})

describe('a minted link works exactly once it is minted, and not after it is killed', () => {
	it('resolves to the portal and the row it was minted for', async () => {
		const minted = await mint()
		const verified = await service.verify(minted.token)
		expect(verified).toEqual({
			tokenId: minted.id,
			portalKey: 'client-invoice',
			rowId: 'row-1',
		})
	})

	it('never stores the plaintext, anywhere in the row', async () => {
		const minted = await mint()
		const rows = await client.query<Record<string, unknown>>(
			'SELECT * FROM portal_token',
		)
		expect(JSON.stringify(rows.rows)).not.toContain(minted.token)
		// A SHA-256 hex digest, and nothing that could be reversed to the token.
		expect(String(rows.rows[0]?.token_hash)).toMatch(/^[0-9a-f]{64}$/)
	})

	it('mints an unguessable token — 256 bits, never repeated', async () => {
		const seen = new Set<string>()
		for (let i = 0; i < 20; i++) seen.add((await mint()).token)
		expect(seen.size).toBe(20)
		for (const token of seen) expect(token.length).toBeGreaterThanOrEqual(42)
	})

	it('stops working the moment it is revoked', async () => {
		const minted = await mint()
		expect(await service.verify(minted.token)).not.toBeNull()
		await service.revoke(minted.id, 'u-ann')
		expect(await service.verify(minted.token)).toBeNull()
	})

	it('stops working at its expiry, not a millisecond later', async () => {
		vi.useFakeTimers()
		try {
			const minted = await mint({ ttlHours: 1 })
			expect(await service.verify(minted.token)).not.toBeNull()
			vi.setSystemTime(new Date(minted.expiresAt.getTime()))
			expect(await service.verify(minted.token)).toBeNull()
		} finally {
			vi.useRealTimers()
		}
	})

	it('stops working after the declared number of opens', async () => {
		const minted = await mint({ maxUses: 2 })
		expect(await service.verify(minted.token)).not.toBeNull()
		expect(await service.verify(minted.token)).not.toBeNull()
		expect(await service.verify(minted.token)).toBeNull()
	})

	it('refuses a revoked, an expired, a used-up and an unknown token identically', async () => {
		// A verifier that distinguished them is an oracle: it tells a stranger
		// which links used to exist and which are merely spent.
		const revoked = await mint()
		await service.revoke(revoked.id, 'u-ann')
		const spent = await mint({ maxUses: 1 })
		await service.verify(spent.token)
		expect(await service.verify(revoked.token)).toBeNull()
		expect(await service.verify(spent.token)).toBeNull()
		expect(await service.verify('mx_not-a-real-token')).toBeNull()
	})

	it('refuses a non-expiring or zero-use mint outright', async () => {
		await expect(mint({ ttlHours: 0 })).rejects.toThrow(/positive integer/)
		await expect(mint({ maxUses: 0 })).rejects.toThrow(/positive integer/)
	})
})

describe('who sent this link is answerable afterwards', () => {
	it('audits the mint and the revoke', async () => {
		const minted = await mint()
		await service.revoke(minted.id, 'u-ann')
		expect(audited.map((a) => a.action)).toEqual(['create', 'delete'])
		expect(audited.every((a) => a.resourceId === minted.id)).toBe(true)
	})

	it('kills every live link for a portal without touching another portal’s', async () => {
		// The companion to `portals.pause`, and separate from it on purpose:
		// "is this surface up?" and "is this link still good?" are different
		// questions, and a pause that silently invalidated every link a business
		// had sent would be the wrong answer to both.
		const a = await mint({ portalKey: 'client-invoice' })
		const b = await mint({ portalKey: 'other-portal' })
		expect(await service.revokeAllFor('client-invoice', 'u-ann')).toBe(1)
		expect(await service.verify(a.token)).toBeNull()
		expect(await service.verify(b.token)).not.toBeNull()
	})
})
