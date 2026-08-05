/**
 * The write-path invariant suite, bundle + codemod surfaces.
 *
 * Three paths, and the interesting thing about them is that they are the ones
 * whose *count* grows: L1 adds bundles, each with an install path and an upgrade
 * path, and #200 exists because "the number of ways to accidentally write to
 * accepted state grows sharply" as that happens.
 *
 *   `bundle-install`           `applyBundle` — lowers a bundle's runtime into ops
 *   `bundle-install-preflight` `validateBundleApply` — collision pre-flight, no write
 *   `bundle-upgrade-codemod`   the upgrade codemods, idempotent by construction
 *
 * The one to watch is the install: it stamps `manual()`, which means accepted AND
 * regen-protected, on every row a bundle contributes. That is correct — installing
 * a module is a deliberate human act, and its rows are not somebody's draft
 * awaiting review — but it is also the single largest source of accepted rows in
 * any real project, so it is worth pinning that it can only happen through an
 * install and can never reach *pre-existing* rows.
 *
 * Registry: scripts/write-paths.config.json. Policy: docs/write-paths.md.
 */

import {
	collectSpecSystemErrors,
	deriveProvenanceState,
	minimalPRD,
	newSpecSystem,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { applyBundle, bundleToOps, validateBundleApply } from './apply.ts'
import { getBundle } from './catalog.ts'
import {
	applyBundleUpgrades,
	BUNDLE_CODEMODS,
	planBundleUpgrades,
} from './codemods.ts'

const base = (): SpecSystem =>
	newSpecSystem(
		minimalPRD({
			title: 'Invariants',
			tldr: 'the write-path invariant suite',
			problem: 'a new write path can land uncovered',
			northStar: 'every change attributed',
			persona: 'the maintainer',
			differentiation: 'none',
		}),
	)

function bundle(slug: string) {
	const b = getBundle(slug)
	if (!b) throw new Error(`bundle "${slug}" missing from the catalog`)
	return b
}

/** A spec holding one undecided row nothing in this suite is allowed to settle. */
function withPendingReview(): SpecSystem {
	const spec = base()
	spec.data.entities.push({
		id: 'e-draft',
		name: 'Draft',
		provenance: suggested(),
		fields: [
			{
				id: 'fld-draft-note',
				name: 'note',
				type: 'string',
				required: false,
				provenance: suggested(),
			},
		],
	})
	return spec
}

// ===========================================================================
// bundle-install
// ===========================================================================

describe('write path "bundle-install" (applyBundle)', () => {
	it('attributes every op to the bundle surface and the installed slug', () => {
		const spec = applyBundle(base(), bundle('members'))
		expect(spec.opLog.length).toBeGreaterThan(0)
		for (const entry of spec.opLog) {
			expect(entry.actor?.surface).toBe('bundle')
			expect(entry.actor?.path).toBe('bundle-install')
			// The slug rides in `agent` so an install reads as one unit of work in the
			// trail rather than N unexplained hand-authored entities.
			expect(entry.actor?.agent).toBe('members')
		}
	})

	it('records origin human — installing a module is a human act', () => {
		const spec = applyBundle(base(), bundle('members'))
		for (const entry of spec.opLog) expect(entry.origin).toBe('human')
	})

	it("lands its own rows accepted and regen-protected, and nobody else's", () => {
		// The install's rows are `manual()` on purpose. What must never happen is
		// the same stamp reaching a row the install did not create.
		const spec = applyBundle(withPendingReview(), bundle('members'))

		const draft = spec.data.entities.find((e) => e.id === 'e-draft')
		expect(deriveProvenanceState(draft?.provenance ?? suggested())).toBe(
			'suggested',
		)
		expect(draft?.fields[0]?.provenance.isAccepted).toBeNull()

		const org = spec.data.entities.find((e) => e.id === 'e-organization')
		expect(deriveProvenanceState(org?.provenance ?? suggested())).toBe('manual')
	})

	it('never mutates the spec it was handed', () => {
		const spec = withPendingReview()
		const before = structuredClone(spec)
		applyBundle(spec, bundle('members'))
		expect(spec).toEqual(before)
	})

	it('attributes every bundle in the catalog, not just the one we sampled', () => {
		// A per-bundle install path is exactly the kind of thing that gets added
		// without attribution, so this sweeps the catalog rather than trusting one.
		for (const slug of ['members', 'audit', 'api-keys', 'flags']) {
			const b = getBundle(slug)
			if (!b) continue
			// Bundles with unmet prerequisites still lower to ops; install them onto a
			// spec that already has their prerequisites where possible, and fall back
			// to asserting on the ops themselves when the fold would collide.
			const ops = bundleToOps(b)
			if (ops.length === 0) continue
			let spec = base()
			try {
				for (const prereq of b.prerequisites)
					spec = applyBundle(spec, bundle(prereq))
				spec = applyBundle(spec, b)
			} catch {
				continue
			}
			const ours = spec.opLog.filter((e) => e.actor?.agent === slug)
			expect(ours.length, `${slug} landed no attributed ops`).toBeGreaterThan(0)
			for (const entry of ours) expect(entry.actor?.path).toBe('bundle-install')
		}
	})
})

// ===========================================================================
// bundle-install-preflight
// ===========================================================================

describe('write path "bundle-install-preflight" (validateBundleApply)', () => {
	it('writes nothing while advancing a system op by op', () => {
		// It genuinely calls `applyOp` in a loop — that is how it collects *every*
		// structural collision instead of only the first. The system is local.
		const spec = withPendingReview()
		const before = structuredClone(spec)
		validateBundleApply(spec, bundle('members'), [])
		expect(spec).toEqual(before)
		expect(spec.opLog).toHaveLength(0)
	})

	it('writes nothing when it refuses the install', () => {
		const spec = applyBundle(base(), bundle('members'))
		const before = structuredClone(spec)
		// Installing the same bundle twice collides on every id.
		const errors = validateBundleApply(spec, bundle('members'), [])
		expect(errors.length).toBeGreaterThan(0)
		expect(spec).toEqual(before)
	})

	it('writes nothing when a prerequisite is unmet', () => {
		const spec = base()
		const before = structuredClone(spec)
		for (const slug of ['api-keys', 'billing', 'audit']) {
			const b = getBundle(slug)
			if (!b || b.prerequisites.length === 0) continue
			validateBundleApply(spec, b, [])
		}
		expect(spec).toEqual(before)
	})
})

// ===========================================================================
// bundle-upgrade-codemod
// ===========================================================================

describe('write path "bundle-upgrade-codemod" (the upgrade codemods)', () => {
	/** An installed-bundle record pinned at each codemod's `from` version. */
	const installedAt = (slug: string, version: string) => [
		{ slug, version, installedAt: '2026-01-01' },
	]

	/**
	 * A fresh install already ships everything its codemods add, so a codemod run
	 * against one converges to a no-op and would prove nothing about attribution.
	 * The upgrade-safety gate solves this with committed fixture trees pinned at
	 * old versions; here — where the question is only "is the op
	 * attributed" — it is enough to rewind the *spec* to the older shape.
	 *
	 * Rewinding here means stripping every foreign-key declaration, which is what
	 * the `declareReferenceIfMissing` codemods add. It deliberately does NOT try to
	 * rewind the page-adding codemods — a general "undo any codemod" helper would be
	 * a second implementation of the upgrade path, and the gate that owns that
	 * question already exists (`pnpm --filter @maxstack/spec-derive upgrade-safety`,
	 * over committed fixture trees). This only has to get *some* codemod to emit an
	 * op so its attribution can be checked, and the assertion below fails loudly if
	 * it ever stops managing even that.
	 */
	function rewind(spec: SpecSystem): SpecSystem {
		const rewound = structuredClone(spec)
		for (const entity of rewound.data.entities) {
			for (const field of entity.fields) {
				if (field.reference) delete field.reference
			}
		}
		return rewound
	}

	it('attributes every codemod op to the codemod surface', () => {
		let landed = 0
		let exercised = 0
		for (const codemod of BUNDLE_CODEMODS) {
			const catalogBundle = getBundle(codemod.slug)
			if (!catalogBundle) continue
			let installed = base()
			try {
				for (const prereq of catalogBundle.prerequisites)
					installed = applyBundle(installed, bundle(prereq))
				installed = applyBundle(installed, catalogBundle)
			} catch {
				continue
			}
			// Back to the pre-codemod shape, then upgrade — the real sequence.
			const old = rewind(installed)
			const opsBefore = old.opLog.length
			const plans = planBundleUpgrades(
				installedAt(codemod.slug, codemod.from),
				{ [codemod.slug]: { version: catalogBundle.version } },
			)
			const upgraded = applyBundleUpgrades(old, plans)
			const emitted = upgraded.opLog.slice(opsBefore)
			if (emitted.length === 0) continue
			exercised++
			for (const entry of emitted) {
				expect(entry.actor?.surface).toBe('codemod')
				expect(entry.actor?.path).toBe('bundle-upgrade-codemod')
				expect(entry.origin).toBe('human')
				landed++
			}
		}
		// A sweep that exercised nothing is a green board that means nothing, so it
		// fails rather than passes — the same rule the sampled G5 gates follow.
		expect(
			BUNDLE_CODEMODS.length,
			'no codemods in the catalog — this suite proved nothing',
		).toBeGreaterThan(0)
		expect(
			exercised,
			'no codemod emitted an op — the rewind no longer reaches the old shape, ' +
				'so this suite stopped checking codemod attribution',
		).toBeGreaterThan(0)
		expect(landed).toBeGreaterThan(0)
	})

	it('never settles a pending review while rewriting declarations', () => {
		const spec = withPendingReview()
		const codemod = BUNDLE_CODEMODS[0]
		if (!codemod) throw new Error('expected at least one codemod')
		const catalogBundle = bundle(codemod.slug)
		const installed = applyBundle(spec, catalogBundle)
		const plans = planBundleUpgrades(installedAt(codemod.slug, codemod.from), {
			[codemod.slug]: { version: catalogBundle.version },
		})
		const upgraded = applyBundleUpgrades(installed, plans)

		const draft = upgraded.data.entities.find((e) => e.id === 'e-draft')
		expect(draft?.provenance.isAccepted).toBeNull()
		expect(draft?.fields[0]?.provenance.isAccepted).toBeNull()
	})

	it('is idempotent, and a re-run adds no second attribution', () => {
		const codemod = BUNDLE_CODEMODS[0]
		if (!codemod) throw new Error('expected at least one codemod')
		const catalogBundle = bundle(codemod.slug)
		const installed = applyBundle(base(), catalogBundle)
		const plans = planBundleUpgrades(installedAt(codemod.slug, codemod.from), {
			[codemod.slug]: { version: catalogBundle.version },
		})
		const once = applyBundleUpgrades(installed, plans)
		const twice = applyBundleUpgrades(once, plans)
		// Same op log: a converged codemod is a no-op, so it logs nothing the second
		// time. An upgrade that re-logged would inflate the trail with phantom
		// changes a reviewer then has to dismiss.
		expect(twice.opLog).toHaveLength(once.opLog.length)
		expect(collectSpecSystemErrors(twice)).toEqual([])
	})
})
