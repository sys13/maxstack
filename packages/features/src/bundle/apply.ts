/**
 * Bundle applier — turn a {@link Bundle}'s runtime into the project's spec.
 *
 * The whole point (bundle/types.ts): adding a bundle uses the *exact same*
 * validated spec-op path an agent's `apply_spec_change` does — never a bespoke
 * mutation. `bundleToOps` lowers the bundle's declarative runtime into an
 * ordered `SpecOp[]` (entities before the pages that reference them); `applyBundle`
 * folds them through `applyOp`, so every install is validated, immutable, and
 * lands in the op log. Installed rows enter as {@link manual} provenance:
 * accepted (no review step for a deliberate install) and regen-protected (a spec
 * regeneration must never drop a bundle's schema).
 *
 * IDs are minted deterministically from the bundle's unprefixed keys
 * (`e-<key>`, `fld-<key>-<name>`, `pg-<key>`, `blk-<key>-<type>`); `validateOp`
 * rejects any collision, so a double-install fails loudly rather than duplicating.
 */

import {
	type ApplyMeta,
	applyOp,
	type BlockSpec,
	type EntityId,
	type EntitySpec,
	type FieldSpec,
	manual,
	type OpId,
	type PageId,
	type PageSpec,
	type SpecOp,
	type SpecSystem,
	validateOp,
} from '@maxstack/spec'
import { BUNDLES } from './catalog.ts'
import { footprintCollisions } from './contract.ts'
import type { Bundle, BundleEntity, BundlePage } from './types.ts'

/** The default block set for a bundle page that declares none. */
const DEFAULT_BLOCKS = ['table'] as const

const entityId = (key: string): EntityId => `e-${key}`
const pageId = (key: string): PageId => `pg-${key}`

// The page/UX priority set is wider than provenance's — 'low' maps to 'medium'
// (provenance only distinguishes 'high' from the default).
const provenancePriority = (
	p?: 'high' | 'medium' | 'low',
): 'high' | 'medium' => (p === 'high' ? 'high' : 'medium')

function entityOp(entity: BundleEntity): SpecOp {
	const fields: FieldSpec[] = entity.fields.map((f) => ({
		id: `fld-${entity.key}-${f.name}`,
		name: f.name,
		type: f.type,
		required: f.required ?? false,
		// A declared FK. Omitted rather than set to `undefined` so a
		// non-reference field serializes exactly as it did before.
		...(f.reference ? { reference: f.reference } : {}),
		// An open reference: the candidates, for a project to narrow.
		// Omitted rather than set to `undefined`, on the line above's reasoning.
		//
		// Sorted, and that is load-bearing rather than tidy: `data.setFieldOpenReference`
		// sorts too, so an upgraded project (which gets its candidates from a
		// codemod running that op) and a fresh install (which gets them from here)
		// produce the same bytes. The upgrade gate compares exactly that, and an
		// unsorted list here would fail it for a difference that means nothing.
		...(f.openReference
			? { openReference: [...new Set(f.openReference)].sort() }
			: {}),
		provenance: manual(),
	}))
	const spec: EntitySpec = {
		id: entityId(entity.key),
		name: entity.name,
		description: entity.description,
		fields,
		provenance: manual(),
	}
	return { op: 'data.addEntity', args: { entity: spec } }
}

function pageOp(page: BundlePage): SpecOp {
	const blocks: BlockSpec[] = (page.blocks ?? DEFAULT_BLOCKS).map((type) => ({
		id: `blk-${page.key}-${type}`,
		type,
		provenance: manual(),
	}))
	const spec: PageSpec = {
		id: pageId(page.key),
		name: page.name,
		route: page.route,
		entityId: entityId(page.entityKey),
		blocks,
		e2eTests: page.e2eTests,
		provenance: manual({ priority: provenancePriority(page.priority) }),
	}
	return { op: 'page.addPage', args: { page: spec } }
}

/**
 * Lower a bundle's runtime into an ordered op list. Entities come first: a page
 * op's `entityId` must resolve, and `validateOp` runs against the accumulating
 * system inside `applyBundle`.
 */
export function bundleToOps(bundle: Bundle): SpecOp[] {
	return [
		...bundle.runtime.entities.map(entityOp),
		...bundle.runtime.pages.map(pageOp),
	]
}

/**
 * Fold a bundle's runtime into a spec. Pure — returns a new system, never
 * mutating `spec`. Throws (via `applyOp`) on the first invalid op, so an id
 * collision with an already-installed bundle fails the whole install.
 */
export function applyBundle(
	spec: SpecSystem,
	bundle: Bundle,
	meta: { appliedAt: ApplyMeta['appliedAt'] } = { appliedAt: today() },
): SpecSystem {
	return bundleToOps(bundle).reduce((system, op, i) => {
		const applyMeta: ApplyMeta = {
			id: `op-bundle-${bundle.slug}-${i + 1}` as OpId,
			// A bundle install is a human act (`maxstack add <slug>`) whichever
			// author typed it, and the rows land `manual()` to match. The `bundle`
			// surface plus the slug is what makes it reviewable as one unit rather
			// than as N unexplained hand-authored entities.
			origin: 'human',
			appliedAt: meta.appliedAt,
			actor: {
				surface: 'bundle',
				agent: bundle.slug,
				path: 'bundle-install',
			},
		}
		return applyOp(system, op, applyMeta)
	}, spec)
}

/**
 * Pre-flight a bundle install against a spec + the set of already-installed
 * bundle slugs. Returns human-readable errors (empty ⇒ safe to apply): unmet
 * prerequisites, ownership-footprint collisions with an installed bundle, and id
 * collisions with the current spec.
 *
 * The footprint check (bundle contract v2, requirement 7) is what
 * catches the collisions the spec cannot see: two bundles claiming the same
 * `ddl` table or the same route own the same thing at runtime while every
 * spec-op validates cleanly.
 */
export function validateBundleApply(
	spec: SpecSystem,
	bundle: Bundle,
	installed: readonly string[],
	catalog: Record<string, Bundle> = BUNDLES,
): string[] {
	const errors: string[] = []
	const have = new Set(installed)
	for (const prereq of bundle.prerequisites) {
		if (!have.has(prereq)) {
			errors.push(
				`bundle "${bundle.slug}" requires "${prereq}", which is not installed`,
			)
		}
	}

	const installedBundles = installed
		.map((slug) => catalog[slug])
		.filter((b): b is Bundle => !!b)
	errors.push(...footprintCollisions(bundle, installedBundles))
	// Structural collisions: run each op through validateOp against the growing
	// system so we surface *all* problems, not just the first `applyOp` would throw.
	let system = spec
	for (const op of bundleToOps(bundle)) {
		const opErrors = validateOp(system, op)
		if (opErrors.length) {
			errors.push(...opErrors.map((e) => `bundle "${bundle.slug}": ${e}`))
			// Can't advance the system past an invalid op; stop structural checks.
			break
		}
		// A pre-flight, not a write: `system` is local and discarded when this
		// function returns its error list. Pinned by the invariant suite — a
		// validate that mutated the caller's spec would be the exact class of bug
		// #200 exists to make impossible.
		system = applyOp(system, op, {
			id: 'op-validate' as OpId,
			origin: 'human',
			appliedAt: today(),
			actor: { surface: 'bundle', path: 'bundle-install-preflight' },
		})
	}
	return errors
}

/**
 * Resolve the install order for `slug` given the catalog and the set of
 * already-installed slugs: a topological walk of `prerequisites` returning the
 * not-yet-installed bundles in dependency order (a prerequisite before the
 * bundle that needs it), `slug` last. Throws on an unknown slug or a
 * prerequisite cycle.
 */
export function resolveInstallOrder(
	slug: string,
	catalog: Record<string, Bundle>,
	installed: readonly string[],
): Bundle[] {
	const have = new Set(installed)
	const order: Bundle[] = []
	const added = new Set<string>()
	const onStack = new Set<string>()

	const visit = (s: string): void => {
		if (have.has(s) || added.has(s)) return
		const bundle = catalog[s]
		if (!bundle) throw new Error(`unknown bundle "${s}"`)
		if (onStack.has(s)) {
			throw new Error(`prerequisite cycle through "${s}"`)
		}
		onStack.add(s)
		for (const prereq of bundle.prerequisites) visit(prereq)
		onStack.delete(s)
		order.push(bundle)
		added.add(s)
	}

	visit(slug)
	return order
}

/** Today's date as an ISO `YYYY-MM-DD` — the op-log stamp for an install. */
function today(): ApplyMeta['appliedAt'] {
	return new Date().toISOString().slice(0, 10) as ApplyMeta['appliedAt']
}
