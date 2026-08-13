/**
 * The spec → **Sprout entity shapes** fold, shared by every non-web surface.
 *
 * `@maxstack/core`'s spec→SQL bridge deliberately takes a structural
 * `SpecEntityShape` rather than a `SpecSystem`, so core carries no dependency on
 * `@maxstack/spec`. Somebody has to do the fold, and this is the layer that can:
 * `@maxstack/mcp` may import both.
 *
 * It lives here rather than in the CLI because two surfaces need it — the view
 * scaffolder (`maxstack view`) and the API contract `query_spec {section:"api"}`
 * answers — and a contract derived from a *second* fold would be a
 * description of a slightly different API than the one the runtime serves. The
 * whole value of publishing the contract is that it cannot drift from the thing
 * it describes.
 *
 * The web host keeps its own richer `groundedEntityShapes` (search, documents,
 * portals, live), which this is a subset of: everything that reaches a *column*
 * is here, and everything that does not is the web host's business.
 */

import type { SpecEntityShape } from '@maxstack/core'
import {
	getAcceptedOrAll,
	type SpecSystem,
	virtualEntity,
} from '@maxstack/spec'

/** `e-reading-item` → `reading-item` — the derivation every surface shares. */
export const resourceName = (entityId: string): string =>
	entityId.replace(/^e-/, '')

/** A spec's accepted data layer as the structural shapes core introspects. */
export function groundedEntityShapes(spec: SpecSystem): SpecEntityShape[] {
	const entities = getAcceptedOrAll(spec.data.entities)
	// A reference names a spec entity, or a well-known virtual entity (`e-user`
	// → the auth bundle's text-id user table); spec entities shadow.
	const target = (reference: string) => {
		const virtual = entities.some((e) => e.id === reference)
			? undefined
			: virtualEntity(reference)
		return virtual
			? { table: virtual.table, column: virtual.column, idType: virtual.idType }
			: { table: resourceName(reference), column: 'id' }
	}
	return entities.map((entity) => ({
		name: resourceName(entity.id),
		description: entity.description,
		fields: getAcceptedOrAll(entity.fields).map((field) => ({
			name: field.name,
			type: field.type,
			required: field.required,
			options: field.options,
			// Issue #172 — a rank key is hidden from the introspected resource for
			// the same reason here as everywhere: it is a column the runtime
			// maintains, not one anybody is invited to write.
			rank: field.rank,
			limits: field.limits,
			// A number field's declared presentation and scale (#345). It
			// reaches a *column* (as `meta.format`/`min`/`max`/`step`), so by this
			// module's own rule it belongs in the shared subset, not only in the web
			// host's richer fold.
			display: field.display,
			// A field's declared filter control (#414), on the same rule: it
			// reaches a *column* (as `meta.filterable`/`meta.filterOperators`), so it
			// belongs in the shared subset rather than only in the web host's fold.
			filter: field.filter,
			reference: field.reference ? target(field.reference) : undefined,
		})),
	}))
}
