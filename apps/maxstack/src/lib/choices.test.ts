/**
 * The choice lists (#421).
 *
 * The rule these exist to hold: **a menu never offers a value the command then
 * refuses.** Every list is derived from the same source the typed argument is
 * validated against, and the filters are not cosmetic — each one corresponds to
 * a specific after-the-fact rejection that the picker is supposed to make
 * unreachable.
 */

import {
	type EntitySpec,
	minimalPRD,
	newSpecSystem,
	type SpecSystem,
	THEME_PRESETS,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import {
	bundleChoices,
	entityChoices,
	routeChoices,
	slotChoices,
	themeChoices,
} from './choices.ts'

const accepted = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}
const pending = { ...accepted, isAccepted: false, isSuggested: true }

function entity(id: string, provenance = accepted): EntitySpec {
	return {
		id: id as EntitySpec['id'],
		name: id.replace(/^e-/, ''),
		provenance,
		fields: [
			{
				id: `fld-${id}-title`,
				name: 'title',
				type: 'string',
				required: true,
				provenance: accepted,
			},
		],
	} as EntitySpec
}

function specWith(...entities: EntitySpec[]): SpecSystem {
	const spec = newSpecSystem(
		minimalPRD({
			title: 'Fixture',
			tldr: 'a fixture',
			problem: 'testing',
			northStar: 'green',
			persona: 'the maintainer',
			differentiation: 'none',
		}),
	)
	spec.data.entities.push(...entities)
	return spec
}

describe('entityChoices', () => {
	it('labels each entity with the slug the command actually takes', () => {
		// The label doubles as a pasteable answer (`select` accepts it), so it has
		// to be the argument spelling — not the display name, not the `e-` id.
		const choices = entityChoices(specWith(entity('e-task')))
		expect(choices.map((c) => c.label)).toEqual(['task'])
		expect(choices[0]?.value.id).toBe('e-task')
	})

	it('omits an entity that is still only proposed', () => {
		// Accepting a field on a pending entity would make the field's fate depend
		// on the entity's. `getAcceptedOrAll` is the same read every other command
		// makes; this pins that the picker uses it too.
		const choices = entityChoices(specWith(entity('e-task'), entity('e-draft', pending)))
		expect(choices.map((c) => c.label)).toEqual(['task'])
	})

	it('falls back to everything when nothing has been accepted yet', () => {
		// `getAcceptedOrAll`'s other half: a project mid-review is not a project
		// with no entities.
		const choices = entityChoices(specWith(entity('e-draft', pending)))
		expect(choices.map((c) => c.label)).toEqual(['draft'])
	})
})

describe('themeChoices', () => {
	it('offers exactly the presets the op validates against', () => {
		expect(themeChoices().map((c) => c.value)).toEqual([...THEME_PRESETS])
	})
})

describe('bundleChoices', () => {
	it('hides what is already installed, since installing it again is a no-op', () => {
		const all = bundleChoices([]).map((c) => c.value)
		expect(all.length).toBeGreaterThan(0)

		const [first] = all
		const remaining = bundleChoices([
			{ slug: first as string, version: '1.0.0' },
		]).map((c) => c.value)
		expect(remaining).not.toContain(first)
		expect(remaining.length).toBe(all.length - 1)
	})

	it('says what a bundle drags in with it', () => {
		// Prerequisites are shown before the install writes anything, which is the
		// existing `previewInstall` promise. The picker should not be the one place
		// that hides them.
		const withPrereqs = bundleChoices([]).filter((c) => c.hint?.includes('needs'))
		expect(withPrereqs.length).toBeGreaterThan(0)
	})
})

describe('slotChoices', () => {
	const inventory = {
		rolesVersion: 1,
		idEscaping: '',
		roles: [],
		pages: [
			{
				route: '/tasks',
				resource: 'task',
				slots: [
					{ id: 'TaskRow', kind: 'block', description: 'a row', filled: false },
					{ id: 'TaskCell', kind: 'block', description: 'a cell', filled: true },
					{ id: 'Sidebar', kind: 'declared', description: 'a slot', filled: false },
				],
			},
		],
	} as unknown as Parameters<typeof slotChoices>[0]

	it('offers only unfilled block slots — the two things `fill` refuses', () => {
		// A filled slot would be clobbered; a declared slot is stubbed by
		// generation itself and `slots fill` errors on it. Both rejections are
		// unreachable from the menu.
		expect(slotChoices(inventory).map((c) => c.value)).toEqual(['TaskRow'])
	})

	it('shows where the slot lives, since the id alone does not say', () => {
		expect(slotChoices(inventory)[0]?.hint).toContain('/tasks')
	})
})

describe('routeChoices', () => {
	it('keeps ejected routes listed, marked by their ownership', () => {
		// Unlike a filled slot, an already-ejected route is a *deliberate* no-op
		// that reports itself. Hiding it would make a route the user knows exists
		// appear to have vanished.
		const choices = routeChoices([
			{ id: 'task', file: 'app/task.tsx', ownership: 'generated' },
			{ id: 'note', file: 'app/note.tsx', ownership: 'ejected' },
		])
		expect(choices.map((c) => c.value)).toEqual(['task', 'note'])
		expect(choices[1]?.hint).toContain('ejected')
	})
})
