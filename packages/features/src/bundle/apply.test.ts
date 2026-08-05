import {
	collectSpecSystemErrors,
	minimalPRD,
	newSpecSystem,
	type SpecSystem,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import {
	applyBundle,
	bundleToOps,
	resolveInstallOrder,
	validateBundleApply,
} from './apply.ts'
import { BUNDLES, getBundle } from './catalog.ts'

const base = (): SpecSystem =>
	newSpecSystem(
		minimalPRD({
			title: 'Test',
			tldr: 'a test project',
			problem: 'testing bundle apply',
			northStar: 'green tests',
			persona: 'the maintainer',
			differentiation: 'none',
		}),
	)

const members = () => {
	const b = getBundle('members')
	if (!b) throw new Error('members bundle missing')
	return b
}

describe('bundleToOps', () => {
	it('orders entities before the pages that reference them', () => {
		const ops = bundleToOps(members())
		const kinds = ops.map((o) => o.op)
		const firstPage = kinds.indexOf('page.addPage')
		const lastEntity = kinds.lastIndexOf('data.addEntity')
		expect(lastEntity).toBeLessThan(firstPage)
	})

	it('mints ids + manual provenance from the bundle keys', () => {
		const [first] = bundleToOps(members())
		expect(first?.op).toBe('data.addEntity')
		if (first?.op !== 'data.addEntity') return
		expect(first.args.entity.id).toBe('e-organization')
		expect(first.args.entity.fields[0]?.id).toBe('fld-organization-name')
		expect(first.args.entity.provenance?.isAddedManually).toBe(true)
		expect(first.args.entity.provenance?.isAccepted).toBe(true)
	})
})

describe('applyBundle', () => {
	it('folds a bundle into a valid spec, never mutating the input', () => {
		const s0 = base()
		const s1 = applyBundle(s0, members())
		expect(s0.data.entities).toHaveLength(0) // input untouched
		expect(s1.data.entities.map((e) => e.id)).toEqual([
			'e-organization',
			'e-member',
			'e-invitation',
		])
		expect(s1.pages.pages.map((p) => p.id)).toEqual(['pg-organizations'])
		expect(s1.pages.pages[0]?.entityId).toBe('e-organization')
		expect(collectSpecSystemErrors(s1)).toEqual([])
		// One op per entity + page in the op log.
		expect(s1.opLog).toHaveLength(4)
	})

	it('throws on a double install (id collision)', () => {
		const s1 = applyBundle(base(), members())
		expect(() => applyBundle(s1, members())).toThrow(/already exists/)
	})
})

describe('validateBundleApply', () => {
	it('flags an unmet prerequisite', () => {
		const errors = validateBundleApply(base(), members(), [])
		expect(errors.some((e) => e.includes('requires "auth"'))).toBe(true)
	})

	it('passes when prerequisites are installed and no ids collide', () => {
		expect(validateBundleApply(base(), members(), ['auth'])).toEqual([])
	})

	it('flags a structural collision with the current spec', () => {
		const s1 = applyBundle(base(), members())
		const errors = validateBundleApply(s1, members(), ['auth', 'members'])
		expect(errors.some((e) => e.includes('already exists'))).toBe(true)
	})
})

describe('resolveInstallOrder', () => {
	it('returns prerequisites before the requested bundle', () => {
		const order = resolveInstallOrder('members', BUNDLES, [])
		expect(order.map((b) => b.slug)).toEqual(['auth', 'members'])
	})

	it('skips already-installed prerequisites', () => {
		const order = resolveInstallOrder('members', BUNDLES, ['auth'])
		expect(order.map((b) => b.slug)).toEqual(['members'])
	})

	it('resolves a multi-prerequisite bundle transitively', () => {
		const order = resolveInstallOrder('admin', BUNDLES, [])
		expect(order.map((b) => b.slug)).toEqual(['auth', 'audit', 'admin'])
	})

	it('is empty when everything is already installed', () => {
		expect(
			resolveInstallOrder('members', BUNDLES, ['auth', 'members']),
		).toEqual([])
	})

	it('throws on an unknown slug', () => {
		expect(() => resolveInstallOrder('nope', BUNDLES, [])).toThrow(
			/unknown bundle/,
		)
	})
})
