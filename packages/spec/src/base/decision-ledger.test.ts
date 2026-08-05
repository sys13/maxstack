import { describe, expect, it } from 'vitest'
import {
	assertAppendOnly,
	type DecisionLedger,
	effectiveDecisions,
	emptyLedger,
	type LedgerEntry,
	latestEntry,
	recordDecision,
	resolveDecision,
	validateLedger,
} from './decision-ledger.ts'
import type { DecisionId } from './ids.ts'

const pending = (id: DecisionId): LedgerEntry => ({
	id,
	question: `pick for ${id}?`,
	options: [
		{ id: 'a', description: 'option a', pros: ['fast'], cons: [] },
		{ id: 'b', description: 'option b', pros: [], cons: ['slow'] },
	],
	recommendedOptionId: 'a',
	chosenOptionId: null,
	rationale: 'deferred',
	status: 'pending',
	decidedAt: null,
	origin: 'ai',
	recordedAt: '2026-07-09',
})

describe('append-only recording', () => {
	it('recordDecision appends without mutating', () => {
		const l0 = emptyLedger
		const l1 = recordDecision(l0, pending('d-alpha'))
		expect(l0).toHaveLength(0)
		expect(l1).toHaveLength(1)
	})

	it('resolve appends a second entry, leaving the pending history intact', () => {
		let ledger: DecisionLedger = recordDecision(emptyLedger, pending('d-alpha'))
		ledger = resolveDecision(ledger, {
			id: 'd-alpha',
			chosenOptionId: 'b',
			rationale: 'benchmarks changed our mind',
			decidedAt: '2026-07-10',
			recordedAt: '2026-07-10',
			origin: 'human',
		})
		expect(ledger).toHaveLength(2)
		expect(ledger[0]?.status).toBe('pending')
		expect(latestEntry(ledger, 'd-alpha')?.status).toBe('resolved')
		expect(latestEntry(ledger, 'd-alpha')?.chosenOptionId).toBe('b')
	})

	it('resolve rejects an unknown option or unknown decision', () => {
		const ledger = recordDecision(emptyLedger, pending('d-alpha'))
		expect(() =>
			resolveDecision(ledger, {
				id: 'd-alpha',
				chosenOptionId: 'zzz',
				rationale: 'x',
				decidedAt: '2026-07-10',
				recordedAt: '2026-07-10',
			}),
		).toThrow(/not an option/)
		expect(() =>
			resolveDecision(ledger, {
				id: 'd-nope',
				chosenOptionId: 'a',
				rationale: 'x',
				decidedAt: '2026-07-10',
				recordedAt: '2026-07-10',
			}),
		).toThrow(/no decision/)
	})
})

describe('latest-wins reads', () => {
	it('effectiveDecisions collapses the chain to one entry per id, first-seen order', () => {
		let ledger: DecisionLedger = recordDecision(emptyLedger, pending('d-alpha'))
		ledger = recordDecision(ledger, pending('d-beta'))
		ledger = resolveDecision(ledger, {
			id: 'd-alpha',
			chosenOptionId: 'a',
			rationale: 'x',
			decidedAt: '2026-07-10',
			recordedAt: '2026-07-10',
		})
		const eff = effectiveDecisions(ledger)
		expect(eff.map((e) => e.id)).toEqual(['d-alpha', 'd-beta'])
		expect(eff[0]?.status).toBe('resolved')
		expect(eff[1]?.status).toBe('pending')
	})
})

describe('append-only guard', () => {
	it('passes for a genuine extension and throws on a rewrite or shrink', () => {
		const l1 = recordDecision(emptyLedger, pending('d-alpha'))
		const l2 = recordDecision(l1, pending('d-beta'))
		expect(() => assertAppendOnly(l1, l2)).not.toThrow()
		expect(() => assertAppendOnly(l1, emptyLedger)).toThrow(/shrank/)
		const rewritten = [pending('d-different')]
		expect(() => assertAppendOnly(l1, rewritten)).toThrow(/rewritten/)
	})

	it('compares structurally: a cloned prefix is not a rewrite', () => {
		const l1 = recordDecision(emptyLedger, pending('d-alpha'))
		const cloned = structuredClone(l1) as DecisionLedger
		const l2 = recordDecision(cloned, pending('d-beta'))
		expect(() => assertAppendOnly(l1, l2)).not.toThrow()
	})

	it('still catches a value-level rewrite inside a cloned prefix', () => {
		const l1 = recordDecision(emptyLedger, pending('d-alpha'))
		const tampered = structuredClone(l1) as LedgerEntry[]
		const first = tampered[0]
		if (!first) throw new Error('unreachable')
		first.rationale = 'history, revised'
		expect(() => assertAppendOnly(l1, tampered)).toThrow(
			/entry 0 was rewritten/,
		)
	})
})

describe('validation', () => {
	it('flags a resolved entry with no choice and a bad date', () => {
		const bad: LedgerEntry = {
			...pending('d-bad'),
			status: 'resolved',
			chosenOptionId: null,
			decidedAt: 'yesterday',
		}
		const errors = validateLedger([bad])
		expect(errors.some((e) => /no chosenOptionId/.test(e))).toBe(true)
		expect(errors.some((e) => /not YYYY-MM-DD/.test(e))).toBe(true)
	})

	it('a clean ledger has no errors', () => {
		expect(validateLedger([pending('d-ok')])).toHaveLength(0)
	})
})
