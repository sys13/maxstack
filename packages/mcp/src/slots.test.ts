import type { SpecSystem } from '@maxstack/spec'
import { minimalPRD, newSpecSystem, suggested } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { orphanedSlots, slotInventory } from './slots.ts'

/**
 * Slot discovery + the orphaned-slot gate.
 *
 * The two properties worth pinning: a maintainer can *find* every place bespoke
 * code may go without reading the renderer's source, and a slot they already
 * filled cannot stop being called without the gate saying so.
 */

function specWith(fields: string[], blockFields?: string[]): SpecSystem {
	const spec = newSpecSystem(
		minimalPRD({
			title: 'Gymlog',
			tldr: 'Log every set.',
			problem: 'Lifters track sets in a notes app.',
			northStar: 'Weeks with three logged workouts',
			persona: 'Recreational lifter',
			differentiation: 'A fast log-a-set loop.',
		}),
	)
	return {
		...spec,
		data: {
			entities: [
				{
					id: 'e-exercise',
					name: 'Exercise',
					provenance: suggested(),
					fields: fields.map((name) => ({
						id: `fld-${name}`,
						name,
						type: 'string' as const,
						required: false,
						provenance: suggested(),
					})),
				},
			],
		},
		pages: {
			pages: [
				{
					id: 'pg-exercises',
					name: 'Exercises',
					route: '/exercises',
					entityId: 'e-exercise',
					provenance: suggested(),
					blocks: [
						{
							id: 'blk-table',
							type: 'table',
							fields: blockFields,
							provenance: suggested(),
						},
						{
							id: 'blk-notes',
							type: 'slot:coachNotes',
							provenance: suggested(),
						},
					],
				},
			],
		},
	}
}

describe('slotInventory', () => {
	it('lists declared and derived block slots together, with their typed props', () => {
		const inventory = slotInventory(specWith(['name', 'formCue']))
		const page = inventory.pages[0]
		expect(page?.slots.map((s) => s.id)).toEqual([
			'coachNotes',
			'exercise__header',
			'exercise__list',
			'exercise__row',
			'exercise__field__name',
			'exercise__field__formCue',
			'exercise__empty',
		])
		expect(page?.slots.find((s) => s.id === 'exercise__row')?.props).toBe(
			'RowSlotProps',
		)
		expect(inventory.rolesVersion).toBe(1)
	})

	/** A field slot is only offered for a field that is actually on screen. */
	it('follows the spec field selection when the block declares one', () => {
		const inventory = slotInventory(specWith(['name', 'formCue'], ['formCue']))
		const ids = inventory.pages[0]?.slots.map((s) => s.id) ?? []
		expect(ids).toContain('exercise__field__formCue')
		expect(ids).not.toContain('exercise__field__name')
	})

	it('reports fill state as unknown, not empty, when the caller cannot see disk', () => {
		const inventory = slotInventory(specWith(['name']))
		expect(inventory.pages[0]?.slots.every((s) => s.filled === undefined)).toBe(
			true,
		)
	})

	it('marks a slot filled when the resource slot file exports its id', () => {
		const inventory = slotInventory(specWith(['name']), {
			exercise: ['exercise__row'],
		})
		const slots = inventory.pages[0]?.slots ?? []
		expect(slots.find((s) => s.id === 'exercise__row')?.filled).toBe(true)
		expect(slots.find((s) => s.id === 'exercise__list')?.filled).toBe(false)
	})
})

describe('orphanedSlots', () => {
	it('is quiet while the host block is still there', () => {
		expect(
			orphanedSlots(specWith(['name', 'formCue']), {
				exercise: ['exercise__row', 'exercise__field__formCue'],
			}),
		).toEqual([])
	})

	/**
	 * The failure this gate exists for: dropping a field from the page's
	 * selection stops calling a slot that is still implemented, and nothing
	 * else in the app would say so.
	 */
	it('catches a field slot whose field left the page', () => {
		const orphans = orphanedSlots(specWith(['name', 'formCue'], ['name']), {
			exercise: ['exercise__field__formCue'],
		})
		expect(orphans).toHaveLength(1)
		expect(orphans[0]?.id).toBe('exercise__field__formCue')
		expect(orphans[0]?.reason).toMatch(/no longer|any more/)
	})

	it('catches every block slot when the page itself is gone', () => {
		const spec = specWith(['name'])
		const pageless = { ...spec, pages: { pages: [] } }
		const orphans = orphanedSlots(pageless, { exercise: ['exercise__row'] })
		expect(orphans[0]?.reason).toMatch(/page is gone/)
	})

	/**
	 * A slot file is the user's own module. Gating every export would make it
	 * unusable as a file — helpers, sub-components and constants all live there.
	 */
	it('ignores exports that are not block-slot ids', () => {
		expect(
			orphanedSlots(specWith(['name']), {
				exercise: ['formatWeight', 'DemoBadge', 'coachNotes'],
			}),
		).toEqual([])
	})
})
