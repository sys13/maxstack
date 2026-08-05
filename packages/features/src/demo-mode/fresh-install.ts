/**
 * Fresh-install detection — the generic half: "does this
 * project's data store have any rows at all yet?" Project-specific bits (e.g.
 * "does the viewer belong to an organization?") stay in the owned-code
 * onboarding route, since they depend on which bundles are installed; this is
 * the reusable primitive both that route and any `ResourceList` empty state
 * can share instead of re-deriving it.
 */

import type { ResourceRegistry, SproutStore } from '@maxstack/core'

/** True as soon as any registered resource has at least one row. A brand-new
 * project (no rows anywhere) reads as a fresh install. */
export async function hasAnyData(
	registry: ResourceRegistry,
	store: SproutStore,
): Promise<boolean> {
	for (const entry of registry.all()) {
		const rows = await store.list(entry.resource.name, { limit: 1 })
		if (rows.length > 0) return true
	}
	return false
}
