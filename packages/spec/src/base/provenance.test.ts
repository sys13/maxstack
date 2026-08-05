import { describe, expect, it } from 'vitest'
import {
	accept,
	decodeProvenance,
	deriveProvenanceState,
	encodeProvenance,
	getAcceptedOrAll,
	manual,
	type Provenance,
	type Provenanced,
	partitionForRegen,
	provenanceSchema,
	reject,
	suggested,
	survivesRegen,
} from './provenance.ts'

const row = (p: Provenanced['provenance']): Provenanced => ({ provenance: p })

describe('provenance factories', () => {
	it('a suggestion is undecided unless autoAccept is on', () => {
		expect(suggested().isAccepted).toBeNull()
		expect(suggested({ autoAccept: true }).isAccepted).toBe(true)
		expect(suggested().isAddedManually).toBe(false)
		expect(suggested().isSuggested).toBe(true)
	})

	it('a manual add is accepted and protected', () => {
		const p = manual()
		expect(p.isAddedManually).toBe(true)
		expect(p.isAccepted).toBe(true)
		expect(p.isSuggested).toBe(false)
	})
})

describe('derived state (never stored)', () => {
	it('maps flags to one label', () => {
		expect(deriveProvenanceState(suggested())).toBe('suggested')
		expect(deriveProvenanceState(accept(suggested()))).toBe('accepted')
		expect(deriveProvenanceState(reject(suggested()))).toBe('rejected')
		expect(deriveProvenanceState(manual())).toBe('manual')
		// manual outranks accepted (it's the never-delete signal).
		expect(deriveProvenanceState(accept(manual()))).toBe('manual')
	})
})

describe('transitions are immutable', () => {
	it('accept/reject return new objects, leaving isSuggested alone', () => {
		const s = suggested()
		const a = accept(s)
		expect(a).not.toBe(s)
		expect(s.isAccepted).toBeNull()
		expect(a.isAccepted).toBe(true)
		expect(reject(s).isAccepted).toBe(false)
		expect(reject(s).isSuggested).toBe(true)
	})
})

describe('invariant (a): regeneration never deletes manual items', () => {
	it('keeps only manual rows, drops suggested-not-manual', () => {
		const rows = [
			row(suggested()), //                       dropped
			row(accept(suggested())), //               dropped (accepted but not manual)
			row(manual()), //                          kept
			row(reject(suggested())), //               dropped
		]
		const { kept, deleted } = partitionForRegen(rows)
		expect(kept).toHaveLength(1)
		expect(deleted).toHaveLength(3)
		expect(kept.every(survivesRegen)).toBe(true)
	})

	it('an accepted suggestion is still purgeable (only manual survives)', () => {
		expect(survivesRegen(row(accept(suggested())))).toBe(false)
		expect(survivesRegen(row(manual()))).toBe(true)
	})
})

describe('invariant (b): grounding is accepted-only-else-all', () => {
	it('returns accepted rows when any exist', () => {
		const rows = [
			row(accept(suggested())),
			row(suggested()),
			row(reject(suggested())),
		]
		expect(getAcceptedOrAll(rows)).toHaveLength(1)
	})

	it('falls back to ALL rows when zero are accepted', () => {
		const rows = [row(suggested()), row(reject(suggested()))]
		expect(getAcceptedOrAll(rows)).toHaveLength(2)
	})

	it('empty in, empty out', () => {
		expect(getAcceptedOrAll([])).toHaveLength(0)
	})
})

describe('runtime schema', () => {
	it('accepts well-formed provenance and rejects a bad priority', () => {
		expect(provenanceSchema.safeParse(suggested()).success).toBe(true)
		expect(
			provenanceSchema.safeParse({ ...suggested(), priority: 'urgent' })
				.success,
		).toBe(false)
	})
})

describe('on-disk codec', () => {
	const roundTrips = (p: Provenance) =>
		expect(decodeProvenance(encodeProvenance(p))).toEqual(p)

	it('omits the manual() default entirely (decodes back to manual)', () => {
		expect(encodeProvenance(manual())).toBeUndefined()
		expect(decodeProvenance(undefined)).toEqual(manual())
	})

	it('encodes the four canonical shapes as bare codes', () => {
		expect(encodeProvenance(suggested())).toBe('s')
		expect(encodeProvenance(accept(suggested()))).toBe('a')
		expect(encodeProvenance(reject(suggested()))).toBe('r')
		// manual is the omitted default, so it never surfaces as a bare code.
		expect(encodeProvenance(manual({ priority: 'high' }))).toEqual({
			p: 'm',
			pr: 'high',
		})
	})

	it('carries non-default priority and draft as compact extras', () => {
		const p: Provenance = {
			...suggested(),
			priority: 'high',
			suggestedDescription: 'draft text',
		}
		expect(encodeProvenance(p)).toEqual({ p: 's', pr: 'high', d: 'draft text' })
		roundTrips(p)
	})

	it('round-trips every canonical shape', () => {
		roundTrips(manual())
		roundTrips(suggested())
		roundTrips(accept(suggested()))
		roundTrips(reject(suggested()))
		roundTrips(suggested({ autoAccept: true })) // isAccepted:true → 'a'
	})

	it('falls back to the full object for a non-canonical triple', () => {
		// manual-but-rejected: not one of the four presets.
		const weird: Provenance = {
			isSuggested: false,
			isAccepted: false,
			isAddedManually: true,
			suggestedDescription: null,
			priority: 'medium',
		}
		expect(encodeProvenance(weird)).toEqual(weird)
		roundTrips(weird)
	})
})
