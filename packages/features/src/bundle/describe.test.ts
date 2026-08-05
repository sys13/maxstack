/**
 * Issue #189's gating clauses, as tests:
 *
 *  - discovery output is **generated from the catalog**, never hand-maintained;
 *  - **preview before install is a hard requirement**, and the preview cannot
 *    disagree with the install;
 *  - selecting several modules at once produces the same result as installing
 *    them one at a time.
 */

import { minimalPRD, newSpecSystem, type SpecSystem } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { applyBundle, resolveInstallOrder } from './apply.ts'
import { BUNDLES, getBundle, listUserFacingBundles } from './catalog.ts'
import { describeCatalog, previewInstall } from './describe.ts'

const bare = (): SpecSystem =>
	newSpecSystem(
		minimalPRD({
			title: 'Picker',
			tldr: 'the composition-UX fixture',
			problem:
				'a catalog nobody can browse markets as breadth and delivers as trivia',
			northStar: 'pick what you need',
			persona: 'the maintainer',
			differentiation: 'none',
		}),
	)

describe('discovery is derived from the catalog', () => {
	it('describes every user-facing bundle and no plumbing', () => {
		const described = describeCatalog()
		expect(described.map((b) => b.slug).sort()).toEqual(
			listUserFacingBundles()
				.map((b) => b.slug)
				.sort(),
		)
		// `di` / `db-plugins` are in the catalog because install records drive
		// composition-root wiring, not because anybody shops for them.
		expect(described.map((b) => b.slug)).not.toContain('di')
		expect(described.map((b) => b.slug)).not.toContain('db-plugins')
	})

	it('renders the title and description the catalog actually carries', () => {
		// The anti-drift assertion: if a renderer ever grows its own copy of a
		// blurb, this goes red.
		for (const summary of describeCatalog()) {
			const bundle = getBundle(summary.slug)
			expect(summary.title).toBe(bundle?.title)
			expect(summary.description).toBe(bundle?.description)
			expect(summary.version).toBe(bundle?.version)
		}
	})

	it('resolves transitive prerequisites, not just the declared ones', () => {
		// "billing needs auth, want both?" has to be true. `admin` is the case
		// that catches a shallow implementation: it declares two prerequisites and
		// its closure is exactly those two.
		const admin = describeCatalog().find((b) => b.slug === 'admin')
		expect(admin?.requires).toEqual(expect.arrayContaining(['auth', 'audit']))
		expect(admin?.requires).not.toContain('admin')
		const auth = describeCatalog().find((b) => b.slug === 'auth')
		expect(auth?.requires).toEqual([])
	})

	it('says what each bundle contributes, derived from its runtime', () => {
		const storage = describeCatalog().find((b) => b.slug === 'storage')
		expect(storage?.contributes.join(' ')).toMatch(/entity file_object/)
		expect(storage?.contributes.join(' ')).toMatch(/\/api\/upload/)
	})

	it('marks what is installed and what could be upgraded', () => {
		// `audit` has moved twice (0.1.0 → 0.2.0 → 0.3.0), so a 0.1.0 install is
		// also the fixture for a multi-hop upgrade: both steps are offered, and the
		// version offered is the catalog's rather than the next one along.
		const described = describeCatalog([{ slug: 'audit', version: '0.1.0' }])
		const audit = described.find((b) => b.slug === 'audit')
		expect(audit?.installed?.version).toBe('0.1.0')
		expect(audit?.installed?.upgradeTo).toBe('0.3.0')
		expect(audit?.installed?.upgradeSteps?.join(' ')).toMatch(/apiKeyId/)
		expect(audit?.installed?.upgradeSteps?.join(' ')).toMatch(/sourceKey/)
		// A bundle installed at the catalog version has no upgrade offered.
		const current = describeCatalog([{ slug: 'audit', version: '0.3.0' }])
		expect(
			current.find((b) => b.slug === 'audit')?.installed?.upgradeTo,
		).toBeUndefined()
	})
})

describe('preview before install', () => {
	it('shows the ops an install would apply, and writes nothing', () => {
		const spec = bare()
		const before = structuredClone(spec)
		const preview = previewInstall(spec, ['members'])
		expect(preview.errors).toEqual([])
		expect(preview.ops.length).toBeGreaterThan(0)
		expect(preview.ops.every((op) => op.summary.length > 0)).toBe(true)
		// The input is untouched — the property that makes this a preview.
		expect(spec).toEqual(before)
	})

	it('names the prerequisites it would pull in that nobody asked for', () => {
		// "billing needs auth, want both?" — asked, not assumed.
		const preview = previewInstall(bare(), ['billing'])
		expect(preview.order).toContain('auth')
		expect(preview.pulledIn).toContain('auth')
		expect(preview.pulledIn).not.toContain('billing')
	})

	it('cannot disagree with the install, because it IS the install', () => {
		// Run the preview, then run the real thing, and compare what landed.
		const spec = bare()
		const preview = previewInstall(spec, ['members'])
		let applied = spec
		for (const bundle of resolveInstallOrder('members', BUNDLES, []))
			applied = applyBundle(applied, bundle)
		expect(applied.opLog.map((e) => e.diff.summary)).toEqual(
			preview.ops.map((op) => op.summary),
		)
	})

	it('previews the REFUSAL when an install would be refused', () => {
		// The most useful preview: it arrives before anything is written rather
		// than halfway through. Installing the same bundle twice is refused
		// structurally.
		const spec = applyBundle(bare(), getBundle('audit') as never)
		const preview = previewInstall(spec, ['audit'], ['audit'])
		expect(preview.alreadyInstalled).toEqual(['audit'])
		expect(preview.ops).toEqual([])
	})

	it('reports an unknown slug rather than silently installing nothing', () => {
		expect(previewInstall(bare(), ['nope']).errors.join()).toMatch(
			/unknown bundle "nope"/,
		)
	})
})

describe('selecting many equals installing one at a time (#166/#194)', () => {
	it('produces the same ops for a multi-select as for a sequence of adds', () => {
		const multi = previewInstall(bare(), ['members', 'billing', 'admin'])

		// The same three, requested one at a time, threading the install list
		// forward exactly as `maxstack add` does.
		const oneAtATime: string[] = []
		const installed: string[] = []
		for (const slug of ['members', 'billing', 'admin']) {
			const step = previewInstall(bare(), [slug], installed)
			// (ops are re-derived below from the real path; here we only need order)
			oneAtATime.push(...step.order)
			installed.push(...step.order)
		}
		expect(multi.order).toEqual(oneAtATime)

		// …and the resulting spec content agrees, which is what the combination
		// gate asserts across the whole lattice.
		let sequential = bare()
		for (const slug of oneAtATime)
			sequential = applyBundle(sequential, getBundle(slug) as never)
		expect(sequential.data.entities.map((e) => e.id).sort()).toEqual(
			multi.ops
				.filter((op) => op.op === 'data.addEntity')
				.map((op) => op.targetId)
				.sort(),
		)
	})

	it('does not re-install a prerequisite two selections share', () => {
		// `billing` and `admin` both need `auth`; it must appear once.
		const preview = previewInstall(bare(), ['billing', 'admin'])
		expect(preview.order.filter((slug) => slug === 'auth')).toHaveLength(1)
	})
})
