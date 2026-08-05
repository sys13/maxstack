import { describe, expect, it } from 'vitest'
import { createMemoryEntitlementSource } from './entitlements.ts'
import {
	createMemoryUsageStore,
	createStoreUsageReader,
	METERS,
	MeterService,
	planLimit,
	QuotaError,
	type UsageEvent,
} from './metering.ts'

describe('plan limits', () => {
	it('reads a plan’s per-meter allowance; absent meter is unlimited', () => {
		expect(planLimit('free', 'api-calls')).toBe(100)
		expect(planLimit('pro', 'api-calls')).toBe(10_000)
		// enterprise declares no api-calls cap ⇒ unlimited (null).
		expect(planLimit('enterprise', 'api-calls')).toBeNull()
		// A meter no plan caps is unlimited everywhere.
		expect(planLimit('pro', 'seats')).toBeNull()
	})

	it('an unknown/absent plan is metered as free, not unlimited', () => {
		expect(planLimit(null, 'api-calls')).toBe(100)
		expect(planLimit('nope', 'api-calls')).toBe(100)
	})

	it('every meter key a plan caps names a catalogued meter', () => {
		// The plan `limits` keys and the meter catalog must not drift.
		expect(METERS['api-calls']).toBeDefined()
	})
})

describe('MeterService.status', () => {
	it('reports used/limit/remaining against the subject’s plan', async () => {
		const usage = createMemoryUsageStore()
		usage.events.push(ev('u1', 'api-calls', 30))
		const svc = new MeterService({
			plans: createMemoryEntitlementSource({ u1: 'free' }),
			usage,
		})
		const s = await svc.status('u1', 'api-calls')
		expect(s).toMatchObject({
			plan: 'free',
			used: 30,
			limit: 100,
			remaining: 70,
			unlimited: false,
			exceeded: false,
		})
	})

	it('unlimited plans report null limit/remaining and never exceed', async () => {
		const svc = new MeterService({
			plans: createMemoryEntitlementSource({ e1: 'enterprise' }),
			usage: seeded([ev('e1', 'api-calls', 1_000_000)]),
		})
		const s = await svc.status('e1', 'api-calls')
		expect(s.unlimited).toBe(true)
		expect(s.limit).toBeNull()
		expect(s.remaining).toBeNull()
		expect(s.exceeded).toBe(false)
	})

	it('a subject with no subscription is metered as free', async () => {
		const svc = new MeterService({
			plans: createMemoryEntitlementSource({}),
			usage: createMemoryUsageStore(),
		})
		const s = await svc.status('stranger', 'api-calls')
		expect(s.plan).toBe('free')
		expect(s.limit).toBe(100)
	})
})

describe('MeterService.enforce (the quota gate)', () => {
	it('records while under the allowance and returns fresh status', async () => {
		const usage = createMemoryUsageStore()
		const svc = new MeterService({
			plans: createMemoryEntitlementSource({ u1: 'free' }),
			usage,
		})
		const s = await svc.enforce('u1', 'api-calls', 40)
		expect(s.used).toBe(40)
		expect(usage.events).toHaveLength(1)
	})

	it('throws QuotaError and records nothing when it would exceed', async () => {
		const usage = createMemoryUsageStore()
		usage.events.push(ev('u1', 'api-calls', 98))
		const svc = new MeterService({
			plans: createMemoryEntitlementSource({ u1: 'free' }),
			usage,
		})
		// 98 + 5 = 103 > 100 ⇒ blocked, no new event recorded.
		await expect(svc.enforce('u1', 'api-calls', 5)).rejects.toBeInstanceOf(
			QuotaError,
		)
		expect(usage.events).toHaveLength(1)
		try {
			await svc.enforce('u1', 'api-calls', 5)
			expect.unreachable('should have thrown')
		} catch (err) {
			expect((err as QuotaError).code).toBe('QUOTA_EXCEEDED')
			expect((err as QuotaError).limit).toBe(100)
			expect((err as QuotaError).used).toBe(98)
			expect((err as QuotaError).meter).toBe('api-calls')
		}
	})

	it('exactly hitting the limit is allowed; the next unit is not', async () => {
		const usage = createMemoryUsageStore()
		const svc = new MeterService({
			plans: createMemoryEntitlementSource({ u1: 'free' }),
			usage,
		})
		await svc.enforce('u1', 'api-calls', 100) // 0 → 100, exactly at cap: ok
		const s = await svc.status('u1', 'api-calls')
		expect(s.exceeded).toBe(true)
		expect(s.remaining).toBe(0)
		await expect(svc.enforce('u1', 'api-calls', 1)).rejects.toBeInstanceOf(
			QuotaError,
		)
	})

	it('upgrading the plan lifts the wall for the same usage', async () => {
		const usage = createMemoryUsageStore()
		usage.events.push(ev('u1', 'api-calls', 100))
		// On free the next call is blocked...
		const free = new MeterService({
			plans: createMemoryEntitlementSource({ u1: 'free' }),
			usage,
		})
		await expect(free.enforce('u1', 'api-calls', 1)).rejects.toBeInstanceOf(
			QuotaError,
		)
		// ...but on pro (10k) the same usage is well under the allowance.
		const pro = new MeterService({
			plans: createMemoryEntitlementSource({ u1: 'pro' }),
			usage,
		})
		const s = await pro.enforce('u1', 'api-calls', 1)
		expect(s.used).toBe(101)
		expect(s.exceeded).toBe(false)
	})
})

describe('store-backed usage reader', () => {
	it('totals a subject’s usage_event rows per meter', async () => {
		const rows: UsageEvent[] = [
			ev('u1', 'api-calls', 3),
			ev('u1', 'api-calls', 4),
			ev('u2', 'api-calls', 99),
			ev('u1', 'other', 5),
		]
		const reader = createStoreUsageReader({
			async list() {
				return rows
			},
		})
		expect(await reader.total('u1', 'api-calls')).toBe(7)
		expect(await reader.total('u2', 'api-calls')).toBe(99)
		expect(await reader.total('missing', 'api-calls')).toBe(0)
	})
})

function ev(subject: string, meter: string, quantity: number): UsageEvent {
	return { subject, meter, quantity, at: '2026-07-12T00:00:00.000Z' }
}

function seeded(events: UsageEvent[]) {
	const store = createMemoryUsageStore()
	store.events.push(...events)
	return store
}
