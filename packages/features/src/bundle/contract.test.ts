/**
 * The bundle contract, enforced. This file is the CI check the
 * issue asks for: "mechanically verified — not a checklist in a PR
 * description". Every catalog entry, present and future, is run through all
 * seven requirements here, plus the two that can only be shown by *doing* the
 * install (prerequisite honesty and idempotence).
 */

import {
	collectSpecSystemErrors,
	minimalPRD,
	newSpecSystem,
	type SpecSystem,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import {
	applyBundle,
	resolveInstallOrder,
	validateBundleApply,
} from './apply.ts'
import {
	BUNDLES,
	listBundles,
	listUserFacingBundles,
	USER_FACING_CATALOG_CAP,
} from './catalog.ts'
import { BUNDLE_CODEMODS } from './codemods.ts'
import {
	bundleFootprint,
	checkBundleContract,
	checkCatalogContract,
	checkCodemodChain,
	footprintCollisions,
} from './contract.ts'
import type { Bundle } from './types.ts'

const base = (): SpecSystem =>
	newSpecSystem(
		minimalPRD({
			title: 'Contract',
			tldr: 'bundle contract v2',
			problem: 'every catalog entry satisfies the seven requirements',
			northStar: 'green',
			persona: 'maintainer',
			differentiation: 'none',
		}),
	)

/** Install `bundle` and its prerequisites into a bare project. */
function installAlone(bundle: Bundle): {
	spec: SpecSystem
	installed: string[]
} {
	let spec = base()
	const installed: string[] = []
	for (const b of resolveInstallOrder(bundle.slug, BUNDLES, [])) {
		const errors = validateBundleApply(spec, b, installed)
		expect(errors, `${bundle.slug} → installing ${b.slug}`).toEqual([])
		spec = applyBundle(spec, b)
		installed.push(b.slug)
	}
	return { spec, installed }
}

describe('bundle contract v2', () => {
	it('the whole catalog satisfies the contract', () => {
		expect(checkCatalogContract(BUNDLES, BUNDLE_CODEMODS)).toEqual([])
	})

	it('every entry satisfies it individually', () => {
		for (const bundle of listBundles()) {
			expect(
				checkBundleContract(bundle, BUNDLES, BUNDLE_CODEMODS),
				bundle.slug,
			).toEqual([])
		}
	})

	// Requirement 1 — honest prerequisites. The only proof that a `prerequisites`
	// list is complete is installing the bundle with nothing else present.
	it('every bundle installs alone into a bare project, with its declared prereqs only', () => {
		for (const bundle of listBundles()) {
			const { spec } = installAlone(bundle)
			expect(collectSpecSystemErrors(spec), bundle.slug).toEqual([])
		}
	})

	it('a bundle that leans on another without declaring it goes red', () => {
		// A page over an entity this bundle does not contribute only works when the
		// bundle that owns it happens to be installed — the exact bug requirement 1
		// exists to catch. Declared as a prerequisite it is fine; undeclared it is a
		// contract violation, not a lucky install.
		const leaning: Bundle = {
			...(BUNDLES.audit as Bundle),
			slug: 'audit-leaning',
			// A fresh slug has no codemods registered against it, so it has to sit at
			// its own initialVersion or requirement 2 fires and masks what this test
			// is about.
			version: '0.1.0',
			initialVersion: '0.1.0',
			runtime: {
				...(BUNDLES.audit as Bundle).runtime,
				pages: [
					{
						key: 'org_audit',
						name: 'Org audit',
						route: '/org-audit',
						entityKey: 'organization', // owned by `members`
					},
				],
			},
			ownership: { tables: ['audit_log'], routes: ['/org-audit'] },
			evalAsks: [
				{
					id: 'ask-audit-leaning-org-scope',
					ask: 'Scope the audit log to one organization.',
					source: 'real-product',
					sourceRef: 'GitHub organization audit log, scoped per org.',
				},
			],
		}
		expect(
			checkBundleContract(leaning, BUNDLES, BUNDLE_CODEMODS).join('\n'),
		).toContain('nor a declared prerequisite contributes')

		// Declaring the dependency truthfully clears it.
		expect(
			checkBundleContract(
				{ ...leaning, prerequisites: ['members'] },
				BUNDLES,
				BUNDLE_CODEMODS,
			),
		).toEqual([])
	})

	it('a different bundle claiming an installed bundle’s table is refused by name', () => {
		const { spec, installed } = installAlone(BUNDLES.members as Bundle)
		const squatter: Bundle = {
			...(BUNDLES.email as Bundle),
			slug: 'squatter',
			prerequisites: [],
			ownership: { tables: ['organization'], routes: [] },
		}
		const errors = validateBundleApply(spec, squatter, installed, {
			...BUNDLES,
			squatter,
		})
		expect(errors.join('\n')).toContain(
			'claims table "organization", already owned by installed bundle "members"',
		)
	})

	// Requirement 2 — a versioned upgrade codemod path.
	it('every bundle has an unbroken codemod chain from initialVersion to version', () => {
		for (const bundle of listBundles()) {
			expect(checkCodemodChain(bundle, BUNDLE_CODEMODS), bundle.slug).toEqual(
				[],
			)
		}
	})

	it('a version bump with no codemod covering the gap is a contract violation', () => {
		// `email` ships at 0.1.0 with no codemods; bumping it leaves a gap nothing
		// can walk. (`audit` is a real 0.1.0 → 0.2.0 chain since issue #186, so it
		// no longer demonstrates the failure.)
		const bumped: Bundle = { ...(BUNDLES.email as Bundle), version: '0.2.0' }
		expect(checkCodemodChain(bumped, BUNDLE_CODEMODS).join('\n')).toContain(
			'upgrade chain stops at 0.1.0',
		)
	})

	it('a gap in the middle of the chain is caught', () => {
		// billing 0.1.0 → 0.3.0 with the 0.1.0 → 0.2.0 step missing: a project
		// installed at 0.1.0 could not walk forward.
		const gapped = BUNDLE_CODEMODS.filter((c) => c.to !== '0.2.0')
		expect(
			checkCodemodChain(BUNDLES.billing as Bundle, gapped).join('\n'),
		).toContain('upgrade chain breaks at 0.1.0')
	})

	// Requirement 3 — its own eval artifacts.
	it('every bundle carries at least one honestly-sourced eval ask', () => {
		for (const bundle of listBundles()) {
			expect(bundle.evalAsks.length, bundle.slug).toBeGreaterThan(0)
			for (const ask of bundle.evalAsks) {
				expect(ask.sourceRef.length, ask.id).toBeGreaterThan(10)
			}
		}
	})

	it('rejects an ask with no origin', () => {
		const cheating: Bundle = {
			...(BUNDLES.audit as Bundle),
			evalAsks: [
				{
					id: 'ask-audit-x',
					ask: 'do a thing',
					source: 'real-product',
					sourceRef: '   ',
				},
			],
		}
		expect(
			checkBundleContract(cheating, BUNDLES, BUNDLE_CODEMODS).join('\n'),
		).toContain('not an origin')
	})

	// Requirement 4 — idempotent install: a second install is refused
	// structurally, never a silent duplicate and never a clobber.
	it('re-installing a bundle is refused, not duplicated', () => {
		for (const bundle of listBundles()) {
			const { spec, installed } = installAlone(bundle)
			const before = JSON.stringify(spec)

			// The CLI path: nothing left to do.
			expect(
				resolveInstallOrder(bundle.slug, BUNDLES, installed),
				bundle.slug,
			).toEqual([])

			// And forcing it anyway fails validation instead of writing twice —
			// for the schema bundles, which have something to collide.
			if (bundleFootprint(bundle).specIds.length > 0) {
				expect(
					validateBundleApply(spec, bundle, installed).length,
					bundle.slug,
				).toBeGreaterThan(0)
			}
			expect(JSON.stringify(spec), bundle.slug).toEqual(before)
		}
	})

	// Requirement 5 — uninstall, or a documented reason there isn't one.
	it('every bundle states its uninstall posture', () => {
		for (const bundle of listBundles()) {
			if (bundle.uninstall.supported) {
				expect(bundle.uninstall.notes, bundle.slug).toBeTruthy()
			} else {
				expect(bundle.uninstall.reason.length, bundle.slug).toBeGreaterThan(40)
			}
		}
	})

	// Requirement 7 — a declared ownership footprint, collision-checked.
	it('no two bundles claim the same table, route, or spec id', () => {
		const bundles = listBundles()
		for (const bundle of bundles) {
			expect(
				footprintCollisions(
					bundle,
					bundles.filter((b) => b.slug !== bundle.slug),
				),
				bundle.slug,
			).toEqual([])
		}
	})

	it('the declared footprint tracks the runtime — an undeclared entity goes red', () => {
		const drifted: Bundle = {
			...(BUNDLES.audit as Bundle),
			runtime: {
				...(BUNDLES.audit as Bundle).runtime,
				entities: [
					...(BUNDLES.audit as Bundle).runtime.entities,
					{ key: 'audit_export', name: 'Audit export', fields: [] },
				],
			},
		}
		expect(
			checkBundleContract(drifted, BUNDLES, BUNDLE_CODEMODS).join('\n'),
		).toContain('does not declare the table')
	})

	it('a ddl table the footprint does not claim goes red', () => {
		const auth = BUNDLES.auth as Bundle
		const undeclared: Bundle = {
			...auth,
			ownership: {
				...auth.ownership,
				tables: auth.ownership.tables.filter((t) => t !== 'two_factor'),
			},
		}
		expect(
			checkBundleContract(undeclared, BUNDLES, BUNDLE_CODEMODS).join('\n'),
		).toContain('ddl creates table "two_factor"')
	})

	// Owned-code routes. `storage` mounts /api/upload and
	// /files/:key from the app template, not from a generated page. Nothing can
	// derive those from the runtime, so — like `ddl` tables — they are declared,
	// and being declared is what makes them collision-checkable.
	it('an owned-code route is part of the footprint and collides like any other', () => {
		const squatter: Bundle = {
			...(BUNDLES.email as Bundle),
			slug: 'squatter',
			ownership: { tables: [], routes: [], ownedRoutes: ['/api/upload'] },
		}
		expect(
			footprintCollisions(squatter, [BUNDLES.storage as Bundle]).join('\n'),
		).toContain('/api/upload')
	})

	it('an owned-code route declared as a page route is refused', () => {
		// The two halves carry different obligations: `routes` is derived from the
		// runtime and cannot drift; `ownedRoutes` is a claim a reviewer must read.
		const muddled: Bundle = {
			...(BUNDLES.storage as Bundle),
			ownership: { tables: ['file_object'], routes: ['/api/upload'] },
		}
		expect(
			checkBundleContract(muddled, BUNDLES, BUNDLE_CODEMODS).join('\n'),
		).toContain('belongs in ownership.ownedRoutes')
	})

	it('a page route misfiled as an owned route is refused', () => {
		const muddled: Bundle = {
			...(BUNDLES.members as Bundle),
			ownership: {
				tables: ['organization', 'member', 'invitation'],
				routes: [],
				ownedRoutes: ['/organizations'],
			},
		}
		expect(
			checkBundleContract(muddled, BUNDLES, BUNDLE_CODEMODS).join('\n'),
		).toContain('belongs in ownership.routes')
	})

	it('an installed bundle blocks a colliding install', () => {
		const squatter: Bundle = {
			...(BUNDLES.admin as Bundle),
			slug: 'squatter',
			ownership: { tables: ['audit_log'], routes: [] },
		}
		const errors = footprintCollisions(squatter, [BUNDLES.audit as Bundle])
		expect(errors.join('\n')).toContain('table "audit_log"')
	})

	// The catalog-size cap. Breadth waited on the L3 combination gate,
	// which now runs the whole subset lattice on every PR; the cap is the outer
	// bound the gate can still enumerate, not the safety mechanism itself.
	it('the user-facing catalog stays within the cap the lattice gate can enumerate', () => {
		expect(listUserFacingBundles().length).toBeLessThanOrEqual(
			USER_FACING_CATALOG_CAP,
		)
	})

	it('plumbing is not counted as user-facing', () => {
		const plumbing = listBundles()
			.filter((b) => !b.userFacing)
			.map((b) => b.slug)
			.sort()
		expect(plumbing).toEqual(['db-plugins', 'di'])
	})
})
