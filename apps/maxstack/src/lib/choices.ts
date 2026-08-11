/**
 * The lists behind the prompts (#421): every enumerable argument, read off the
 * project rather than remembered by the user.
 *
 * Kept apart from `prompt.ts` on purpose. That module knows how to ask a
 * question and nothing about maxstack; this one knows what the valid answers
 * are and nothing about terminals. The seam is what lets the asking be tested
 * against a fake prompter and the enumeration be tested against a fixture spec,
 * neither needing the other.
 *
 * One rule holds throughout: **a choice list is never a second source of
 * truth**. Entities come from the spec, routes from the route manifest, slots
 * from `slotInventory`, bundles from `describeCatalog`, presets from
 * `THEME_PRESETS` — in every case the same value the command would have
 * validated the typed argument against. A hand-kept list here would drift, and
 * would drift in the worst direction: offering the user a choice the command
 * then rejects.
 */

import { describeCatalog } from '@maxstack/features/bundle'
import type { SlotInventory } from '@maxstack/mcp'
import {
	type EntitySpec,
	type SpecSystem,
	THEME_PRESETS,
	getAcceptedOrAll,
} from '@maxstack/spec'
import type { Choice } from './prompt.ts'

/**
 * Entities, as a picker.
 *
 * `getAcceptedOrAll` rather than the raw array, matching every other read of
 * the spec: a pending proposal is not something to offer as a target for a new
 * field, because accepting the field would depend on accepting the entity.
 */
export function entityChoices(spec: SpecSystem): Choice<EntitySpec>[] {
	return getAcceptedOrAll(spec.data.entities).map((entity) => ({
		value: entity,
		// The label is the *slug*, because that is the argument the command
		// takes — pasting the label back has to be a valid invocation.
		label: entity.id.startsWith('e-') ? entity.id.slice(2) : entity.id,
		hint: `${entity.name} · ${fieldCount(entity)}`,
	}))
}

function fieldCount(entity: EntitySpec): string {
	const n = getAcceptedOrAll(entity.fields).length
	return `${n} field${n === 1 ? '' : 's'}`
}

/** Theme presets, straight off the spec package's exported list. */
export function themeChoices(): Choice<string>[] {
	return THEME_PRESETS.map((preset) => ({ value: preset, label: preset }))
}

/**
 * Installable bundles.
 *
 * Already-installed ones are dropped rather than shown disabled: `add` on an
 * installed bundle is a no-op, and a picker whose rows do nothing teaches the
 * user to distrust it. The count of what is hidden is the caller's to mention.
 */
export function bundleChoices(
	installed: Parameters<typeof describeCatalog>[0],
): Choice<string>[] {
	return describeCatalog(installed)
		.filter((entry) => !entry.installed)
		.map((entry) => ({
			value: entry.slug,
			label: entry.slug,
			hint: [
				entry.title,
				entry.requires.length ? `needs ${entry.requires.join(' + ')}` : '',
			]
				.filter(Boolean)
				.join(' · '),
		}))
}

/**
 * Block slots that can be filled.
 *
 * Filtered to `kind === 'block'` and to the unfilled, because those are the two
 * things `slots fill` refuses after the fact: a declared page slot is stubbed
 * by generation itself, and a filled slot would be clobbered. Offering either
 * and then erroring is exactly the round trip this change exists to remove.
 */
export function slotChoices(inventory: SlotInventory): Choice<string>[] {
	const choices: Choice<string>[] = []
	for (const page of inventory.pages) {
		for (const slot of page.slots) {
			if (slot.kind !== 'block' || slot.filled) continue
			choices.push({
				value: slot.id,
				label: slot.id,
				hint: `${page.route} · ${slot.description}`,
			})
		}
	}
	return choices
}

/** One row of the route manifest, as much of it as a picker needs. */
export interface RouteEntry {
	id: string
	file: string
	ownership: string
}

/**
 * Ejectable routes.
 *
 * Already-ejected entries stay in the list, dimmed by their hint rather than
 * removed: `eject` on an ejected route is a *deliberate* no-op that reports
 * "already ejected", and hiding them would make a route the user knows exists
 * appear to have vanished.
 */
export function routeChoices(entries: readonly RouteEntry[]): Choice<string>[] {
	return entries.map((entry) => ({
		value: entry.id,
		label: entry.id,
		hint: `${entry.file} · ${entry.ownership}`,
	}))
}
