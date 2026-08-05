import {
	type ApplyMeta,
	applyOp,
	type FlagSpec,
	newSpecSystem,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import type { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePglite } from '../testing/pglite-fixture.ts'
import { FLAGS_DDL } from './schema.ts'
import {
	assertCanManageFlags,
	canManageFlags,
	FlagPermissionError,
	FlagService,
} from './service.ts'

type Db = ReturnType<typeof drizzle>

let db: Db

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: 'human',
	appliedAt: '2026-01-01',
})

/** A spec with one declared flag, gating one page unless `gate` is false. */
function specWithFlag(
	over: Partial<Pick<FlagSpec, 'declaredAt' | 'targeting'>> = {},
	gate = true,
): SpecSystem {
	let spec = applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-checkout',
					name: 'Checkout',
					route: '/checkout',
					blocks: [{ id: 'blk-checkout', type: 'table' }],
				},
			},
		},
		meta(1),
	)
	spec = applyOp(
		spec,
		{
			op: 'flags.declare',
			args: {
				flag: {
					id: 'flg-checkout-v2',
					key: 'checkout-v2',
					description: 'The rebuilt checkout flow.',
					default: false,
					...(over.targeting ? { targeting: over.targeting } : {}),
					...(over.declaredAt ? { declaredAt: over.declaredAt } : {}),
				},
			},
		},
		meta(2),
	)
	if (gate)
		spec = applyOp(
			spec,
			{
				op: 'flags.gate',
				args: {
					target: { kind: 'page', id: 'pg-checkout' },
					flag: 'checkout-v2',
				},
			},
			meta(3),
		)
	return spec
}

const at = (iso: string) => () => new Date(iso)

const pg = usePglite(FLAGS_DDL)

beforeEach(() => {
	db = pg.db
})

describe('FlagService.evaluate', () => {
	it('answers from the spec alone — no query on the read path', async () => {
		const service = new FlagService({ db })
		const spec = specWithFlag({ targeting: { roles: ['admin'] } })
		expect(await service.evaluate(spec, { role: 'admin' })).toEqual({
			'checkout-v2': true,
		})
		expect(await service.evaluate(spec, { role: 'member' })).toEqual({
			'checkout-v2': false,
		})
	})

	it('coalesces evaluations into one write per flush interval', async () => {
		let clock = new Date('2026-02-01T00:00:00Z')
		const service = new FlagService({
			db,
			flushIntervalMs: 60_000,
			now: () => clock,
		})
		const spec = specWithFlag()

		for (let i = 0; i < 50; i++)
			await service.evaluate(spec, { subject: `u${i}` })
		// Nothing written yet: the interval has not elapsed, which is the whole
		// point — 50 renders must not be 50 writes.
		expect(await service.usage()).toEqual([])

		clock = new Date('2026-02-01T00:01:30Z')
		await service.evaluate(spec, { subject: 'u50' })
		const [row] = await service.usage()
		expect(row?.key).toBe('checkout-v2')
		expect(row?.evaluations).toBe(51)
		expect(row?.lastResult).toBe(false)
	})

	it('accumulates across flushes rather than overwriting the counter', async () => {
		let clock = new Date('2026-02-01T00:00:00Z')
		const service = new FlagService({ db, now: () => clock })
		const spec = specWithFlag()
		await service.evaluate(spec, { subject: 'u1' })
		await service.flush()
		clock = new Date('2026-02-01T00:05:00Z')
		await service.evaluate(spec, { subject: 'u2' })
		await service.flush()
		expect((await service.usageOf('checkout-v2'))?.evaluations).toBe(2)
	})
})

describe('FlagService.report', () => {
	it('enumerates every flag with its age and what it gates', async () => {
		const service = new FlagService({ db, now: at('2026-01-15T00:00:00Z') })
		const spec = specWithFlag()
		await service.evaluate(spec, { subject: 'u1' })
		const { all } = await service.report(spec)
		expect(all).toHaveLength(1)
		expect(all[0]).toMatchObject({
			key: 'checkout-v2',
			ageDays: 14,
			gates: 1,
			evaluations: 1,
		})
	})

	it('says nothing about a flag inside the grace window', async () => {
		// Declared 2026-01-01, reported five days later, gating nothing, never
		// evaluated — and still not reported, because a new flag has not had time.
		const service = new FlagService({ db, now: at('2026-01-06T00:00:00Z') })
		const { stale } = await service.report(specWithFlag({}, false))
		expect(stale).toEqual([])
	})

	it('reports a flag that gates nothing and was never evaluated', async () => {
		const service = new FlagService({ db, now: at('2026-03-01T00:00:00Z') })
		const { stale } = await service.report(specWithFlag({}, false))
		expect(stale.map((r) => r.key)).toEqual(['checkout-v2'])
		expect(stale[0]?.reasons).toEqual(['gates-nothing', 'never-evaluated'])
	})

	it('reports a flag nothing has evaluated recently', async () => {
		let clock = new Date('2026-01-02T00:00:00Z')
		const service = new FlagService({ db, now: () => clock })
		const spec = specWithFlag()
		await service.evaluate(spec, { subject: 'u1' })
		await service.flush()

		clock = new Date('2026-03-01T00:00:00Z')
		const { stale } = await service.report(spec)
		expect(stale[0]?.reasons).toEqual(['not-evaluated-recently'])
		expect(stale[0]?.lastEvaluatedAt?.toISOString()).toBe(
			'2026-01-02T00:00:00.000Z',
		)
	})

	it('reports a finished rollout — the most common dead flag of all', async () => {
		const service = new FlagService({ db, now: at('2026-03-01T00:00:00Z') })
		const spec = specWithFlag({ targeting: { rolloutPercent: 100 } })
		await service.evaluate(spec, { subject: 'u1' })
		const { stale } = await service.report(spec)
		expect(stale[0]?.reasons).toContain('rollout-complete')
	})

	it('counts unflushed evaluations — a flag used a second ago is not unused', async () => {
		let clock = new Date('2026-01-02T00:00:00Z')
		const service = new FlagService({ db, now: () => clock })
		const spec = specWithFlag()
		await service.evaluate(spec, { subject: 'u1' })
		// Report while the counter is still pending; the report flushes first.
		clock = new Date('2026-01-20T00:00:00Z')
		const { all, stale } = await service.report(spec)
		expect(all[0]?.evaluations).toBe(1)
		expect(stale).toEqual([])
	})

	it('is empty for a spec with no flags at all', async () => {
		const service = new FlagService({ db })
		const spec = newSpecSystem(tasklyPRD)
		expect(await service.report(spec)).toEqual({ all: [], stale: [] })
	})
})

describe('flag-management authorization', () => {
	it('allows owners and admins, and nobody else', () => {
		expect(canManageFlags({ id: 'u1', role: 'owner' })).toBe(true)
		expect(canManageFlags({ id: 'u1', role: 'admin' })).toBe(true)
		expect(canManageFlags({ id: 'u1', role: 'member' })).toBe(false)
		expect(canManageFlags({ id: 'u1' })).toBe(false)
	})

	it('is fail-closed on an absent identity — the case that matters', () => {
		expect(canManageFlags(null)).toBe(false)
		expect(canManageFlags(undefined)).toBe(false)
		expect(() => assertCanManageFlags(null)).toThrow(FlagPermissionError)
		expect(() => assertCanManageFlags({ id: 'u1', role: 'member' })).toThrow(
			/requires an owner or admin/,
		)
		expect(() =>
			assertCanManageFlags({ id: 'u1', role: 'admin' }),
		).not.toThrow()
	})
})
