import { describe, expect, it } from 'vitest'
import {
	ACTIVE_STATUSES,
	createMemoryEntitlementSource,
	createStoreEntitlementSource,
	EntitlementError,
	hasEntitlement,
	PLANS,
	planEntitlements,
	requireEntitlement,
	type SubscriptionRow,
} from './entitlements.ts'

describe('entitlements', () => {
	it('resolves plan grants; unknown plans grant nothing', () => {
		expect(planEntitlements('pro')).toContain('analytics')
		expect(planEntitlements('free')).toEqual([])
		expect(planEntitlements('nope')).toEqual([])
		expect(planEntitlements(null)).toEqual([])
	})

	it('hasEntitlement checks the subject’s active plan grants', async () => {
		const source = createMemoryEntitlementSource({ u1: 'pro', u2: 'free' })
		expect(await hasEntitlement(source, 'u1', 'analytics')).toBe(true)
		expect(await hasEntitlement(source, 'u1', 'sso')).toBe(false)
		expect(await hasEntitlement(source, 'u2', 'analytics')).toBe(false)
		// A subject with no subscription → null plan → no entitlements.
		expect(await hasEntitlement(source, 'stranger', 'analytics')).toBe(false)
	})

	it('enterprise is a superset covering sso + audit-export', async () => {
		const source = createMemoryEntitlementSource({ e1: 'enterprise' })
		expect(await hasEntitlement(source, 'e1', 'sso')).toBe(true)
		expect(await hasEntitlement(source, 'e1', 'audit-export')).toBe(true)
		expect(await hasEntitlement(source, 'e1', 'analytics')).toBe(true)
	})

	it('requireEntitlement throws a typed EntitlementError when missing', async () => {
		const source = createMemoryEntitlementSource({ u1: 'free' })
		await expect(
			requireEntitlement(source, 'u1', 'analytics'),
		).rejects.toBeInstanceOf(EntitlementError)
		await requireEntitlement(
			createMemoryEntitlementSource({ u1: 'pro' }),
			'u1',
			'analytics',
		) // resolves — no throw
		try {
			await requireEntitlement(source, 'u1', 'sso')
			expect.unreachable('should have thrown')
		} catch (err) {
			expect(err).toBeInstanceOf(EntitlementError)
			expect((err as EntitlementError).code).toBe('ENTITLEMENT_REQUIRED')
			expect((err as EntitlementError).entitlement).toBe('sso')
			expect((err as EntitlementError).subject).toBe('u1')
		}
	})

	it('every plan grant references a coherent, non-empty key set', () => {
		for (const plan of Object.values(PLANS)) {
			for (const key of plan.entitlements) {
				expect(key).toMatch(/^[a-z][a-z-]*$/)
			}
		}
		// The free tier grants nothing (the whole point of paid entitlements).
		expect(PLANS.free?.entitlements).toEqual([])
	})
})

describe('store-backed entitlement source', () => {
	const rows: SubscriptionRow[] = [
		{ subject: 'u1', plan: 'pro', status: 'active' },
		{ subject: 'u2', plan: 'pro', status: 'canceled' },
		{ subject: 'u3', plan: 'enterprise', status: 'trialing' },
	]
	const store = {
		async list() {
			return rows
		},
	}

	it('reads the plan of the first active/trialing subscription', async () => {
		const source = createStoreEntitlementSource(store)
		expect(await source.activePlan('u1')).toBe('pro')
		expect(await source.activePlan('u3')).toBe('enterprise') // trialing counts
		// Canceled does not grant.
		expect(await source.activePlan('u2')).toBeNull()
		expect(await source.activePlan('missing')).toBeNull()
	})

	it('trialing is in the active-status set; canceled is not', () => {
		expect(ACTIVE_STATUSES.has('active')).toBe(true)
		expect(ACTIVE_STATUSES.has('trialing')).toBe(true)
		expect(ACTIVE_STATUSES.has('canceled')).toBe(false)
	})

	it('composes with hasEntitlement end-to-end', async () => {
		const source = createStoreEntitlementSource(store)
		expect(await hasEntitlement(source, 'u1', 'analytics')).toBe(true)
		expect(await hasEntitlement(source, 'u2', 'analytics')).toBe(false)
	})
})
