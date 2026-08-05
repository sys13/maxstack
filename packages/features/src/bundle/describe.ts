/**
 * **Catalog discovery and install preview** — the one derivation
 * every surface renders.
 *
 * The issue's constraint is explicit: *"discovery output must be generated from
 * `bundle/catalog.ts`, never a hand-maintained list that can drift"*, and *"the
 * picker must be reachable from CLI, MCP, and the workbench"*. Those
 * two together mean this module, rather than three renderers each reading the
 * catalog their own way: a hand-maintained list is not the only way to drift.
 * Three independently-derived lists drift too, just more slowly and with better
 * excuses.
 *
 * So `describeCatalog` is the data, and each surface is a renderer over it.
 *
 * ## Preview before install is a hard requirement, not a nicety
 *
 * Installing a bundle mutates the spec. Every other spec mutation in this
 * product is reviewable before it lands — `propose_spec_change` returns a diff,
 * the workbench queue shows one, `eject --dry-run` prints the file. A bundle
 * install being the exception would mean the one mutation that adds *several*
 * entities and pages at once is also the one nobody sees first.
 *
 * {@link previewInstall} runs the real install — `validateBundleApply` →
 * `applyBundle`, the same path `maxstack add` takes — against a copy, and
 * returns the ops it produced and the diffs they made. Nothing is written. The
 * preview cannot disagree with the install because it *is* the install; the only
 * difference is where the result goes.
 */

import type { SpecSystem } from '@maxstack/spec'
import {
	applyBundle,
	resolveInstallOrder,
	validateBundleApply,
} from './apply.ts'
import { BUNDLES, getBundle, listUserFacingBundles } from './catalog.ts'
import { BUNDLE_CODEMODS, compareSemver } from './codemods.ts'
import type { Bundle, InstalledBundle } from './types.ts'

/** One catalog entry, as any surface renders it. */
export interface BundleSummary {
	slug: string
	title: string
	/** The full description — a picker shows it, a list truncates it. */
	description: string
	version: string
	/** Directly declared prerequisites. */
	prerequisites: string[]
	/**
	 * Every prerequisite, transitively, in install order and excluding the bundle
	 * itself. This is the list a picker must *show before writing anything*:
	 * "billing needs auth" is the honest prompt, and `billing` actually pulls in
	 * `auth` alone, while `admin` pulls in `auth` **and** `audit`.
	 */
	requires: string[]
	/** One line per thing it contributes — entities, pages, tables, routes. */
	contributes: string[]
	/** Entitlement key gating it at runtime, if any. */
	entitlement?: string
	uninstallable: boolean
	/** Present when this bundle is installed in the project being described. */
	installed?: {
		version: string
		/** The catalog version, when it is newer than the installed one. */
		upgradeTo?: string
		/** Descriptions of the codemods an upgrade would run. */
		upgradeSteps?: string[]
	}
}

/** A human-readable list of what a bundle contributes, derived from its runtime. */
export function bundleContributions(bundle: Bundle): string[] {
	const out: string[] = []
	for (const entity of bundle.runtime.entities)
		out.push(`entity ${entity.key} (${entity.fields.length} fields)`)
	for (const page of bundle.runtime.pages)
		out.push(`page ${page.name} at ${page.route}`)
	for (const table of bundle.ownership.tables)
		if (!bundle.runtime.entities.some((e) => e.key === table))
			out.push(`table ${table}`)
	for (const route of bundle.ownership.ownedRoutes ?? [])
		out.push(`route ${route} (owned code)`)
	for (const binding of bundle.runtime.diBindings ?? [])
		out.push(`DI binding ${binding}`)
	if (bundle.runtime.seeds?.length) out.push('demo seed rows')
	return out
}

/**
 * The upgrade a project would get for `bundle`, or `undefined` when it is
 * current. The steps are the registered codemods' own descriptions — a project
 * is told what an upgrade *does*, not only that one exists.
 */
export function availableUpgrade(
	bundle: Bundle,
	installedVersion: string,
): { upgradeTo: string; upgradeSteps: string[] } | undefined {
	if (compareSemver(installedVersion, bundle.version) >= 0) return undefined
	const steps = BUNDLE_CODEMODS.filter(
		(c) =>
			c.slug === bundle.slug &&
			compareSemver(c.from, installedVersion) >= 0 &&
			compareSemver(c.to, bundle.version) <= 0,
	)
		.sort((a, b) => compareSemver(a.to, b.to))
		.map((c) => `${c.from} → ${c.to}: ${c.description}`)
	return { upgradeTo: bundle.version, upgradeSteps: steps }
}

/**
 * The user-facing catalog, optionally annotated with what a project already has.
 *
 * Plumbing (`di`, `db-plugins`) is excluded: it is in the catalog because
 * install records drive composition-root wiring, not because anybody shops for
 * it, and a picker that offers it is a picker asking a question with no
 * meaningful answer.
 */
export function describeCatalog(
	installed: readonly InstalledBundle[] = [],
): BundleSummary[] {
	const byslug = new Map(installed.map((b) => [b.slug, b]))
	return listUserFacingBundles().map((bundle) => {
		const record = byslug.get(bundle.slug)
		const requires = resolveInstallOrder(bundle.slug, BUNDLES, [])
			.map((b) => b.slug)
			.filter((slug) => slug !== bundle.slug)
		return {
			slug: bundle.slug,
			title: bundle.title,
			description: bundle.description,
			version: bundle.version,
			prerequisites: [...bundle.prerequisites],
			requires,
			contributes: bundleContributions(bundle),
			...(bundle.entitlement ? { entitlement: bundle.entitlement } : {}),
			uninstallable: bundle.uninstall.supported,
			...(record
				? {
						installed: {
							version: record.version,
							...(availableUpgrade(bundle, record.version) ?? {}),
						},
					}
				: {}),
		}
	})
}

// ===========================================================================
// Preview
// ===========================================================================

/** One op a preview would apply, with the diff it would make. */
export interface PreviewedOp {
	bundle: string
	op: string
	layer: string
	change: string
	targetId: string
	summary: string
}

export interface InstallPreview {
	/** The slugs that would be installed, in order — prerequisites first. */
	order: string[]
	/** Prerequisites being pulled in that the caller did not ask for. */
	pulledIn: string[]
	/** Slugs already installed, so nothing happens for them. */
	alreadyInstalled: string[]
	/** Every op, in order, with its diff. Empty for a no-op install. */
	ops: PreviewedOp[]
	/** Counts a summary line renders. */
	totals: { entities: number; pages: number; tables: number; routes: number }
	/** DI bindings the composition root would then owe. */
	diBindings: string[]
	/**
	 * Why the install would be refused, if it would be. Non-empty means the
	 * preview is a *rejection* preview — which is the most useful kind, because
	 * it arrives before anything is written rather than halfway through.
	 */
	errors: string[]
}

/**
 * What installing `slugs` into `spec` would do — without doing it.
 *
 * Runs the real path against a structured clone. `applyBundle` is pure
 * (`applyOp` never mutates its input), so this is a preview by construction
 * rather than by a parallel implementation somebody has to keep in step.
 */
export function previewInstall(
	spec: SpecSystem,
	slugs: readonly string[],
	installed: readonly string[] = [],
): InstallPreview {
	const requested = new Set(slugs)
	const alreadyInstalled = slugs.filter((slug) => installed.includes(slug))

	// Resolve each requested bundle in turn, accumulating what the previous ones
	// installed — the same walk `addCommand` performs for a single slug, which is
	// what makes "select several at init" equal to "add them one at a time".
	const running = [...installed]
	const order: Bundle[] = []
	const errors: string[] = []
	for (const slug of slugs) {
		if (!getBundle(slug)) {
			errors.push(`unknown bundle "${slug}"`)
			continue
		}
		for (const bundle of resolveInstallOrder(slug, BUNDLES, running)) {
			order.push(bundle)
			running.push(bundle.slug)
		}
	}

	const ops: PreviewedOp[] = []
	const totals = { entities: 0, pages: 0, tables: 0, routes: 0 }
	const diBindings = new Set<string>()
	let next = structuredClone(spec)
	const applied: string[] = [...installed]
	for (const bundle of order) {
		const problems = validateBundleApply(next, bundle, applied)
		if (problems.length) {
			errors.push(...problems.map((p) => `${bundle.slug}: ${p}`))
			// Stop at the first refusal: everything after it would be a preview of
			// a state the install can never reach.
			break
		}
		const before = next.opLog.length
		next = applyBundle(next, bundle)
		applied.push(bundle.slug)
		for (const entry of next.opLog.slice(before)) {
			ops.push({
				bundle: bundle.slug,
				op: entry.diff.op,
				layer: entry.diff.layer,
				change: entry.diff.change,
				targetId: entry.diff.targetId,
				summary: entry.diff.summary,
			})
		}
		totals.entities += bundle.runtime.entities.length
		totals.pages += bundle.runtime.pages.length
		totals.tables += bundle.ownership.tables.length
		totals.routes +=
			bundle.ownership.routes.length +
			(bundle.ownership.ownedRoutes?.length ?? 0)
		for (const binding of bundle.runtime.diBindings ?? [])
			diBindings.add(binding)
	}

	return {
		order: order.map((b) => b.slug),
		pulledIn: order.map((b) => b.slug).filter((slug) => !requested.has(slug)),
		alreadyInstalled,
		ops,
		totals,
		diBindings: [...diBindings],
		errors,
	}
}
