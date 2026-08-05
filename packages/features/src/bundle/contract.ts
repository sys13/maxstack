/**
 * **Bundle contract v2** — the seven requirements every catalog
 * entry satisfies, checked mechanically rather than reviewed by eye.
 *
 * The catalog is about to grow from 8 entries to ~16. The contract
 * exists so that scaling the catalog does not scale the maintenance surface by
 * the same factor, and because the contract *is* the differentiation from a SaaS
 * starter kit: a kit hands you auth + billing + teams wired on day one, and so
 * do we — the difference is that ours installs through the validated spec-op
 * path and can be upgraded afterwards. A bundle without a codemod path is a
 * starter kit with worse ergonomics, so that requirement is a hard gate.
 *
 * The seven:
 *
 *   1. **Honest prerequisites** — declared truthfully, resolvable in the
 *      catalog, acyclic. (Also verified end-to-end in `contract.test.ts` by
 *      installing every bundle alone into a bare project.)
 *   2. **A versioned upgrade codemod path** — the registered codemods form an
 *      unbroken chain from `initialVersion` to `version`, so a project installed
 *      at any point in the bundle's life can walk forward.
 *   3. **Its own eval artifacts** — at least one PRD fragment and at least one
 *      honestly-sourced change ask, so a promoted capability cannot skip
 *      measurement.
 *   4. **Idempotent install** — asserted in `contract.test.ts`: a second install
 *      is refused structurally, never a silent duplicate or a clobber.
 *   5. **Uninstall, or a documented reason there isn't one.**
 *   6. **Generated reference docs** — `docs/bundle-reference.md`, drift-checked
 *      in the validate gate; the fields it renders must be present and non-empty.
 *   7. **A declared ownership footprint** — tables and routes, cross-checked
 *      against the runtime and against every other catalog entry. Routes come in
 *      two kinds: page routes, which must match the runtime exactly, and
 *      `ownedRoutes`, which owned code in the app template mounts and which
 *      nothing can derive — declared so they are still collision-checked.
 *
 * Everything here is pure and returns human-readable violation strings (empty ⇒
 * conformant), so the same functions back the CI test and the install-time
 * collision check in `apply.ts`.
 */

import { virtualEntity } from '@maxstack/spec'
import type { BundleCodemod } from './codemods.ts'
import { compareSemver } from './codemods.ts'
import type { Bundle, BundleAskSource } from './types.ts'

const SEMVER = /^\d+\.\d+\.\d+$/

/** The sources an eval ask may claim. `invented` is deliberately absent. */
const ASK_SOURCES: readonly BundleAskSource[] = [
	'real-product',
	'dogfood',
	'user-report',
	'issue-report',
	'external-corpus',
]

/**
 * The concrete surface a bundle claims. `tables` / `routes` come from the
 * bundle's declaration (they include things no op reveals, like `ddl` tables);
 * `specIds` are derived from the runtime with the exact same id minting
 * `bundleToOps` uses, so the footprint and the install can never disagree.
 */
export interface BundleFootprint {
	slug: string
	tables: string[]
	routes: string[]
	specIds: string[]
}

/** Every spec id a bundle's install would mint, in mint order. */
export function bundleSpecIds(bundle: Bundle): string[] {
	const ids: string[] = []
	for (const entity of bundle.runtime.entities) {
		ids.push(`e-${entity.key}`)
		for (const field of entity.fields) {
			ids.push(`fld-${entity.key}-${field.name}`)
		}
	}
	for (const page of bundle.runtime.pages) {
		ids.push(`pg-${page.key}`)
		for (const type of page.blocks ?? ['table']) {
			ids.push(`blk-${page.key}-${type}`)
		}
	}
	return ids
}

/** The declared-plus-derived footprint used for collision detection. */
export function bundleFootprint(bundle: Bundle): BundleFootprint {
	return {
		slug: bundle.slug,
		tables: [...bundle.ownership.tables],
		// Page routes and owned-code routes collide with each other just as
		// readily, so collision detection sees one flat list.
		routes: [
			...bundle.ownership.routes,
			...(bundle.ownership.ownedRoutes ?? []),
		],
		specIds: bundleSpecIds(bundle),
	}
}

/** Table names a raw `ddl` block creates (`CREATE TABLE IF NOT EXISTS "x"`). */
function ddlTables(ddl: string | undefined): Set<string> {
	if (!ddl) return new Set()
	const names = new Set<string>()
	const re =
		/create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi
	for (const match of ddl.matchAll(re)) {
		const name = match[1]
		if (name) names.add(name)
	}
	return names
}

function duplicates(values: readonly string[]): string[] {
	const seen = new Set<string>()
	const dupes = new Set<string>()
	for (const v of values) {
		if (seen.has(v)) dupes.add(v)
		seen.add(v)
	}
	return [...dupes]
}

/**
 * Requirement 2 — walk the registered codemods for `bundle` and report any way
 * the upgrade path is broken: a bad version pair, a gap in the chain, a step
 * that goes backwards, or a step that lands past the catalog version.
 *
 * A bundle still at its `initialVersion` needs no codemods; a bundle that has
 * moved needs an unbroken chain, because the project on disk may have been
 * installed at *any* released version, not just the previous one.
 */
export function checkCodemodChain(
	bundle: Bundle,
	codemods: readonly BundleCodemod[],
): string[] {
	const errors: string[] = []
	const steps = codemods
		.filter((c) => c.slug === bundle.slug)
		.sort((a, b) => compareSemver(a.to, b.to))

	for (const step of steps) {
		if (!SEMVER.test(step.from) || !SEMVER.test(step.to)) {
			errors.push(`codemod ${step.from} → ${step.to} has a non-semver version`)
			continue
		}
		if (compareSemver(step.from, step.to) >= 0) {
			errors.push(`codemod ${step.from} → ${step.to} does not move forward`)
		}
		if (compareSemver(step.to, bundle.version) > 0) {
			errors.push(
				`codemod ${step.from} → ${step.to} lands past the catalog version ${bundle.version}`,
			)
		}
		if (!step.description.trim()) {
			errors.push(`codemod ${step.from} → ${step.to} has no description`)
		}
	}

	if (compareSemver(bundle.initialVersion, bundle.version) > 0) {
		errors.push(
			`initialVersion ${bundle.initialVersion} is newer than version ${bundle.version}`,
		)
		return errors
	}
	if (compareSemver(bundle.initialVersion, bundle.version) === 0) {
		if (steps.length > 0) {
			errors.push(
				`is still at ${bundle.version} but registers ${steps.length} codemod(s)`,
			)
		}
		return errors
	}

	// The bundle has moved: the chain must be unbroken from initialVersion up.
	let at = bundle.initialVersion
	for (const step of steps) {
		if (compareSemver(step.from, at) !== 0) {
			errors.push(
				`upgrade chain breaks at ${at}: the next codemod starts from ${step.from} ` +
					`(a project installed at ${at} cannot upgrade)`,
			)
			return errors
		}
		at = step.to
	}
	if (compareSemver(at, bundle.version) !== 0) {
		errors.push(
			`upgrade chain stops at ${at} but the catalog is at ${bundle.version} — ` +
				'every version bump needs a codemod or a documented no-op step',
		)
	}
	return errors
}

/**
 * Check one bundle against the contract, in isolation. `catalog` is used only to
 * resolve prerequisites; `codemods` only for the upgrade chain.
 */
export function checkBundleContract(
	bundle: Bundle,
	catalog: Record<string, Bundle>,
	codemods: readonly BundleCodemod[],
): string[] {
	const errors: string[] = []
	const fail = (msg: string) => errors.push(`bundle "${bundle.slug}": ${msg}`)

	// 0 — identity
	if (!/^[a-z][a-z0-9-]*$/.test(bundle.slug)) fail('slug is not kebab-case')
	if (!SEMVER.test(bundle.version))
		fail(`version "${bundle.version}" is not semver`)
	if (!SEMVER.test(bundle.initialVersion)) {
		fail(`initialVersion "${bundle.initialVersion}" is not semver`)
	}

	// 1 — honest prerequisites
	for (const prereq of bundle.prerequisites) {
		if (prereq === bundle.slug) fail('lists itself as a prerequisite')
		else if (!catalog[prereq]) {
			fail(`declares unknown prerequisite "${prereq}"`)
		}
	}
	for (const dupe of duplicates(bundle.prerequisites)) {
		fail(`declares prerequisite "${dupe}" twice`)
	}

	// 2 — a versioned upgrade codemod path
	for (const msg of checkCodemodChain(bundle, codemods)) fail(msg)

	// 3 — its own eval artifacts
	if (!bundle.artifacts.some((a) => a.type === 'prd' && a.md.trim())) {
		fail('carries no PRD artifact')
	}
	if (bundle.evalAsks.length === 0) {
		fail(
			'declares no eval asks — a bundle whose cost nobody measures is a ' +
				'maintenance liability with a marketing benefit',
		)
	}
	for (const ask of bundle.evalAsks) {
		if (!ask.id.startsWith(`ask-${bundle.slug}-`)) {
			fail(`eval ask "${ask.id}" is not prefixed ask-${bundle.slug}-`)
		}
		if (!ask.ask.trim()) fail(`eval ask "${ask.id}" has no ask text`)
		if (!ASK_SOURCES.includes(ask.source)) {
			fail(
				`eval ask "${ask.id}" has source "${ask.source}", which is not allowed`,
			)
		}
		if (!ask.sourceRef.trim()) {
			fail(
				`eval ask "${ask.id}" has no sourceRef — "it seemed realistic" is not an origin`,
			)
		}
	}

	// 5 — uninstall, or a documented reason there isn't one
	if (!bundle.uninstall.supported && !bundle.uninstall.reason.trim()) {
		fail('declares uninstall unsupported without a reason')
	}

	// 6 — the fields the generated reference renders
	if (!bundle.title.trim()) fail('has no title')
	if (bundle.description.trim().length < 40) {
		fail('has no usable description (the generated reference renders it)')
	}

	// 7 — a declared ownership footprint that matches the runtime
	const entityKeys = bundle.runtime.entities.map((e) => e.key)
	const declaredTables = new Set(bundle.ownership.tables)
	for (const dupe of duplicates(bundle.ownership.tables)) {
		fail(`declares table "${dupe}" twice`)
	}
	for (const key of entityKeys) {
		if (!declaredTables.has(key)) {
			fail(`materializes entity "${key}" but does not declare the table`)
		}
	}
	const fromDdl = ddlTables(bundle.runtime.ddl)
	for (const table of declaredTables) {
		if (!entityKeys.includes(table) && !fromDdl.has(table)) {
			fail(
				`declares table "${table}" that neither an entity nor its ddl creates`,
			)
		}
	}
	for (const table of fromDdl) {
		if (!declaredTables.has(table)) {
			fail(`ddl creates table "${table}" that the footprint does not claim`)
		}
	}

	const pageRoutes = bundle.runtime.pages.map((p) => p.route)
	const declaredRoutes = new Set(bundle.ownership.routes)
	const ownedRoutes = bundle.ownership.ownedRoutes ?? []
	for (const dupe of duplicates([...bundle.ownership.routes, ...ownedRoutes])) {
		fail(`declares route "${dupe}" twice`)
	}
	for (const route of pageRoutes) {
		if (!declaredRoutes.has(route)) {
			fail(`mounts page route "${route}" but does not declare it`)
		}
	}
	for (const route of declaredRoutes) {
		if (!pageRoutes.includes(route)) {
			// `routes` is the derivable half and must match the runtime exactly. A
			// route mounted by owned code belongs in `ownedRoutes`, where it reads as
			// the unverifiable claim it is.
			fail(
				`declares route "${route}" that no page mounts (an owned-code route belongs in ownership.ownedRoutes)`,
			)
		}
	}
	for (const route of ownedRoutes) {
		if (pageRoutes.includes(route)) {
			fail(
				`declares owned route "${route}" that a page already mounts — it belongs in ownership.routes`,
			)
		}
		if (!route.startsWith('/')) {
			fail(`declares owned route "${route}" that is not rooted at "/"`)
		}
	}

	// Pages must reference an entity this bundle (or a prerequisite) contributes;
	// a dangling entityKey is caught by validateOp at install, but catching it in
	// the catalog is a red test instead of a broken install.
	const known = new Set(entityKeys)
	for (const prereq of bundle.prerequisites) {
		for (const e of catalog[prereq]?.runtime.entities ?? []) known.add(e.key)
	}
	for (const page of bundle.runtime.pages) {
		if (!known.has(page.entityKey)) {
			fail(
				`page "${page.key}" targets entity "${page.entityKey}", which neither it ` +
					'nor a declared prerequisite contributes',
			)
		}
	}

	// An open reference's candidates are checked against the WHOLE
	// catalog, not against this bundle's prerequisites. That is the point of the
	// mechanism: billing's subject is open over `e-user` and `e-organization`,
	// and a per-seat app installs the first and not the second, so requiring the
	// candidates to be installed would force billing to depend on members —
	// exactly the coupling this exists to avoid. What is worth catching is a
	// *typo*, and a typo is a candidate no bundle anywhere declares.
	const catalogEntities = new Set<string>(
		Object.values(catalog).flatMap((b) =>
			(b?.runtime.entities ?? []).map((e) => `e-${e.key}`),
		),
	)
	for (const entity of bundle.runtime.entities) {
		for (const field of entity.fields) {
			if (field.reference && field.openReference) {
				fail(
					`field "${entity.key}.${field.name}" declares both a reference and an open reference — a field either points somewhere or asks the project where`,
				)
			}
			if (field.openReference && field.openReference.length < 2) {
				fail(
					`field "${entity.key}.${field.name}" declares ${field.openReference.length} open-reference candidate(s), which is not an ambiguity — declare a plain reference instead`,
				)
			}
			for (const candidate of field.openReference ?? []) {
				// A virtual entity (`e-user`) is a legitimate candidate and belongs to
				// no bundle's `entities` — see `virtual-entities.ts`.
				if (virtualEntity(candidate)) continue
				if (!catalogEntities.has(candidate)) {
					fail(
						`field "${entity.key}.${field.name}" is open over "${candidate}", which no bundle in the catalog declares`,
					)
				}
			}
		}
	}

	return errors
}

/**
 * Check the whole catalog: every entry against the contract, plus the
 * cross-entry checks a single bundle cannot make — footprint collisions (two
 * bundles claiming the same table, route, or spec id), duplicate eval-ask ids,
 * and codemods registered for a slug the catalog does not have.
 */
export function checkCatalogContract(
	catalog: Record<string, Bundle>,
	codemods: readonly BundleCodemod[],
): string[] {
	const errors: string[] = []
	const bundles = Object.values(catalog)

	for (const [slug, bundle] of Object.entries(catalog)) {
		if (slug !== bundle.slug) {
			errors.push(
				`catalog key "${slug}" does not match its bundle slug "${bundle.slug}"`,
			)
		}
		errors.push(...checkBundleContract(bundle, catalog, codemods))
	}

	for (const codemod of codemods) {
		if (!catalog[codemod.slug]) {
			errors.push(
				`codemod ${codemod.slug} ${codemod.from} → ${codemod.to} targets a bundle ` +
					'that is not in the catalog',
			)
		}
	}

	// Footprint collisions — the whole point of requirement 7. Sixteen bundles is
	// where "we'll notice at install" stops being true.
	const claims: { kind: string; key: string; slug: string }[] = []
	for (const bundle of bundles) {
		const fp = bundleFootprint(bundle)
		for (const t of fp.tables)
			claims.push({ kind: 'table', key: t, slug: bundle.slug })
		for (const r of fp.routes)
			claims.push({ kind: 'route', key: r, slug: bundle.slug })
		for (const i of fp.specIds) {
			claims.push({ kind: 'spec id', key: i, slug: bundle.slug })
		}
	}
	const byKey = new Map<string, string[]>()
	for (const claim of claims) {
		const k = `${claim.kind} ${claim.key}`
		byKey.set(k, [...(byKey.get(k) ?? []), claim.slug])
	}
	for (const [key, slugs] of byKey) {
		if (slugs.length > 1) {
			errors.push(
				`${key} is claimed by more than one bundle: ${slugs.join(', ')}`,
			)
		}
	}

	const askIds = bundles.flatMap((b) => b.evalAsks.map((a) => a.id))
	for (const dupe of duplicates(askIds)) {
		errors.push(`eval ask id "${dupe}" is used by more than one bundle`)
	}

	return errors
}

/**
 * Footprint collisions between a bundle about to be installed and the bundles
 * already installed. Cheap and exact: the catalog is contract-checked in CI, so
 * at install time we only need the *pairwise* question.
 */
export function footprintCollisions(
	bundle: Bundle,
	installed: readonly Bundle[],
): string[] {
	const errors: string[] = []
	const mine = bundleFootprint(bundle)
	for (const other of installed) {
		if (other.slug === bundle.slug) continue
		const theirs = bundleFootprint(other)
		const pairs: [string, string[], string[]][] = [
			['table', mine.tables, theirs.tables],
			['route', mine.routes, theirs.routes],
			['spec id', mine.specIds, theirs.specIds],
		]
		for (const [kind, a, b] of pairs) {
			const shared = new Set(b)
			for (const key of a) {
				if (shared.has(key)) {
					errors.push(
						`bundle "${bundle.slug}" claims ${kind} "${key}", already owned by ` +
							`installed bundle "${other.slug}"`,
					)
				}
			}
		}
	}
	return errors
}
