/**
 * Blueprint → spec-ops — the bridge between the description
 * compiler in `@maxstack/spec-derive` (`describe-app.ts`) and the op vocabulary.
 *
 * The point of keeping this a *bridge* rather than a generator: `maxstack start`
 * authors nothing that `maxstack add-entity --with-page` couldn't. It compiles
 * through the same {@link buildEntity}/{@link buildPage} builders, so the field
 * grammar, the id conventions and — crucially — the provenance stamping have
 * exactly one implementation. A starting spec that landed through a private
 * path would be a starting spec whose review surface behaved differently from
 * every subsequent change.
 */

import type { AppBlueprint } from '@maxstack/spec-derive'
import type { SpecOp } from '@maxstack/spec'
import { buildEntity, buildPage } from './field-dsl.ts'
import type { OpOrigin } from './origin.ts'

/** One entity's ops: the entity, then its default list page. */
export interface BlueprintOps {
	ops: SpecOp[]
	/** Route per entity, in blueprint order — what `start` prints as "go here". */
	routes: { name: string; route: string }[]
}

/**
 * Compile a blueprint into the ordered op batch `landOps` applies in one shot.
 *
 * Entity-then-page per entity, in blueprint order, because a `page.addPage`
 * validates against the entity it names: interleaving is what lets a later
 * entity's reference field resolve against an earlier one without a second
 * pass. `landOps` validates each op against the spec the previous one
 * produced, so an ordering mistake here fails loudly at land time rather than
 * producing a dangling spec.
 */
export function blueprintToOps(
	blueprint: AppBlueprint,
	origin: OpOrigin,
): BlueprintOps {
	const ops: SpecOp[] = []
	const routes: { name: string; route: string }[] = []

	for (const entity of blueprint.entities) {
		const built = buildEntity(entity.slug, entity.name, entity.fields, origin)
		ops.push({ op: 'data.addEntity', args: { entity: built } })

		// Every entity gets a page. An entity with no page is data the user cannot
		// see, and "populated and clickable" is the entire exit criterion here.
		const page = buildPage(entity.slug, { name: entity.name }, origin)
		ops.push({ op: 'page.addPage', args: { page } })
		routes.push({ name: page.name, route: page.route })
	}

	return { ops, routes }
}
