/**
 * **Slot discovery** — the spec → "what can I write into?" fold.
 *
 * A slot nobody can find does not lower any cost. Block-level slots are
 * *derived*, never declared, so unlike a `slot:<name>` block there is nothing in
 * the spec file to read and nothing in the generated route module to grep: the
 * id exists because the resource and the role exist. That makes discovery a
 * first-class requirement rather than a nicety, and this module is the single
 * fold behind all three surfaces that answer it — `maxstack slots`, `query_spec
 * {section:"slots"}`, and the workbench's slots pane.
 *
 * Fill state is a *disk* fact (which names the user's `*.slots.tsx` exports), so
 * it arrives as an argument. Callers with a filesystem pass it; the MCP tool,
 * which has only a spec store, leaves it undefined and reports availability
 * alone.
 */

import {
	BLOCK_SLOT_ROLES,
	BLOCK_SLOT_ROLES_VERSION,
	type BlockSlotDescriptor,
	blockSlotsForResource,
	isBlockSlotId,
	isSlotBlockType,
	slotBlockName,
} from '@maxstack/core/ownership'
import {
	getAcceptedOrAll,
	type PageSpec,
	type SpecSystem,
} from '@maxstack/spec'

/** One slot a maintainer could write into. */
export interface SlotInfo {
	/** The export name in the resource's `*.slots.tsx` — the stable public id. */
	id: string
	/**
	 * `declared` = a `slot:<name>` block someone put in the spec (page-level);
	 * `block` = a derived block-level slot that exists because the role does.
	 */
	kind: 'declared' | 'block'
	/** The block role, for `block` slots. */
	role?: BlockSlotDescriptor['role']
	/** The field a parameterized role names. */
	field?: string
	/** The `@maxstack/ui` props type the component receives, for `block` slots. */
	props?: string
	description: string
	/**
	 * Whether the resource's slot file exports this id. `undefined` when the
	 * caller could not see the filesystem — which is *not* the same as `false`,
	 * and is reported as "unknown" rather than "empty".
	 */
	filled?: boolean
	/** A declared slot with `mode: "replace"` renders instead of the list. */
	replacesList?: boolean
}

export interface PageSlots {
	pageId: string
	name: string
	route: string
	/** The Sprout resource, or `null` for an entity-less page (which has no
	 * derived block slots — there is no resource to key them by). */
	resource: string | null
	slots: SlotInfo[]
}

export interface SlotInventory {
	/** The version of the slot-bearing role list this inventory was built from. */
	rolesVersion: number
	roles: typeof BLOCK_SLOT_ROLES
	pages: PageSlots[]
}

/** `e-reading-item` → `reading-item` — the derivation the data bridge shares. */
const resourceOf = (page: PageSpec): string | null =>
	page.entityId ? page.entityId.replace(/^e-/, '') : null

/**
 * The fields a page's list actually renders — the block's `fields` selection
 * when the spec declares one (`page.setBlockFields`), else the entity's fields.
 *
 * Only rendered fields get a `field` slot. A slot for a field nobody renders
 * would be an id with no host block behind it, which is precisely the dangling
 * case the gate exists to catch — so it is never offered in the first place.
 */
function renderedFields(spec: SpecSystem, page: PageSpec): string[] {
	const table = getAcceptedOrAll(page.blocks).find((b) => b.type === 'table')
	if (table?.fields && table.fields.length > 0) return table.fields
	const entity = spec.data.entities.find((e) => e.id === page.entityId)
	return entity ? entity.fields.map((f) => f.name) : []
}

/**
 * Every slot the project exposes, page by page.
 *
 * `filledByResource` maps a resource id to the names its slot file exports (as
 * read by `exportedSlotNames`). Omit it when the caller cannot see disk.
 */
export function slotInventory(
	spec: SpecSystem,
	filledByResource?: Record<string, readonly string[]>,
): SlotInventory {
	const pages: PageSlots[] = []
	for (const page of getAcceptedOrAll(spec.pages.pages)) {
		const resource = resourceOf(page)
		const exported = resource ? filledByResource?.[resource] : undefined
		const filledOf = (id: string): boolean | undefined =>
			filledByResource === undefined ? undefined : (exported ?? []).includes(id)

		const slots: SlotInfo[] = []
		for (const block of getAcceptedOrAll(page.blocks)) {
			if (!isSlotBlockType(block.type)) continue
			const id = slotBlockName(block.type)
			slots.push({
				id,
				kind: 'declared',
				description: `Declared extension slot on ${page.name}${
					block.mode === 'replace' ? ' (renders instead of the list)' : ''
				}.`,
				filled: filledOf(id),
				replacesList: block.mode === 'replace',
			})
		}
		if (resource) {
			for (const slot of blockSlotsForResource(
				resource,
				renderedFields(spec, page),
			)) {
				slots.push({
					id: slot.id,
					kind: 'block',
					role: slot.role,
					field: slot.field,
					props: slot.props,
					description: slot.description,
					filled: filledOf(slot.id),
				})
			}
		}
		pages.push({
			pageId: page.id,
			name: page.name,
			route: page.route,
			resource,
			slots,
		})
	}
	return {
		rolesVersion: BLOCK_SLOT_ROLES_VERSION,
		roles: BLOCK_SLOT_ROLES,
		pages,
	}
}

/**
 * Slot ids a resource's slot file exports that the spec no longer offers — the
 * "no dangling slots" gate at block granularity.
 *
 * The page-level gate catches a generated `render={slots.X}` with no export
 * behind it: a *reference* with no implementation. This is the mirror image and
 * the one block slots make possible: an *implementation* with no host block. It
 * happens when the field a `field` slot names is renamed or dropped from the
 * page's selection, or when the page itself goes away — and it is silent
 * without a check, because the export simply stops being called and the bespoke
 * UI quietly disappears from a working app.
 */
export function orphanedSlots(
	spec: SpecSystem,
	filledByResource: Record<string, readonly string[]>,
): { resource: string; id: string; reason: string }[] {
	const inventory = slotInventory(spec, filledByResource)
	const availableByResource = new Map<string, Set<string>>()
	for (const page of inventory.pages) {
		if (!page.resource) continue
		const set = availableByResource.get(page.resource) ?? new Set<string>()
		for (const slot of page.slots) set.add(slot.id)
		availableByResource.set(page.resource, set)
	}
	const out: { resource: string; id: string; reason: string }[] = []
	for (const [resource, exported] of Object.entries(filledByResource)) {
		const available = availableByResource.get(resource)
		for (const id of exported) {
			// Only block-slot-shaped ids are gated. A slot file is a user's own
			// module: it may export helpers, sub-components and constants, and a
			// check that demanded every export match a slot would make the file
			// unusable as a file. A page-level `slot:<name>` export is likewise
			// left alone — the generator scaffolds those, so an unmatched one is
			// the user's own naming, not a broken contract.
			if (!isBlockSlotId(id)) continue
			if (available?.has(id)) continue
			out.push({
				resource,
				id,
				reason: available
					? `no block or declared slot on the ${resource} page offers "${id}" any more`
					: `the ${resource} page is gone, so nothing renders "${id}"`,
			})
		}
	}
	return out
}
