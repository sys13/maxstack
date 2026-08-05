/**
 * Slot inventory for the workbench pane.
 *
 * Fill state is read from the running app's own owned-code manifest
 * (`OWNED_SLOTS`, regenerated on every build/dev boot) rather than by scanning
 * for `*.slots.tsx` files. What the bundle actually imports is the honest
 * answer to "is this filled": a slot file that exists but is not registered in
 * the manifest does not render, and a pane that scanned the directory would
 * report it as filled while the page showed nothing.
 */

import { type SlotInventory, slotInventory } from '@maxstack/mcp'
import { OWNED_SLOTS } from '~/owned.generated'
import { getPlatform } from '~/sprout.server'

export async function loadSlotInventory(): Promise<SlotInventory> {
	const spec = await getPlatform().spec.load()
	const filled: Record<string, string[]> = {}
	for (const [resource, module] of Object.entries(OWNED_SLOTS)) {
		filled[resource] = Object.keys(module)
	}
	return slotInventory(spec, filled)
}
