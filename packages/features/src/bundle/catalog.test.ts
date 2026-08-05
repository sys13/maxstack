import {
	collectSpecSystemErrors,
	minimalPRD,
	newSpecSystem,
	type SpecSystem,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { PLANS } from '../billing/index.ts'
import { applyBundle, resolveInstallOrder } from './apply.ts'
import { BUNDLES, getBundle, listBundles } from './catalog.ts'

const base = (): SpecSystem =>
	newSpecSystem(
		minimalPRD({
			title: 'Catalog',
			tldr: 'catalog test',
			problem: 'checking every bundle applies',
			northStar: 'green',
			persona: 'maintainer',
			differentiation: 'none',
		}),
	)

const SEMVER = /^\d+\.\d+\.\d+$/

describe('the bundle catalog', () => {
	it('exposes the promoted staged modules', () => {
		expect(
			listBundles()
				.map((b) => b.slug)
				.sort(),
		).toEqual(
			[
				'admin',
				'api-keys',
				'audit',
				'auth',
				'billing',
				'db-plugins',
				'di',
				'email',
				'flags',
				'jobs',
				'members',
				'compliance',
				'observability',
				'notifications',
				'preferences',
				'storage',
				'webhooks',
			].sort(),
		)
	})

	it('every bundle is a semver-versioned entry with its own artifact', () => {
		for (const bundle of listBundles()) {
			expect(bundle.version).toMatch(SEMVER)
			expect(bundle.artifacts.length).toBeGreaterThan(0)
			expect(bundle.title).toBeTruthy()
		}
	})

	it('every prerequisite resolves to a real catalog bundle', () => {
		for (const bundle of listBundles()) {
			for (const prereq of bundle.prerequisites) {
				expect(getBundle(prereq), `${bundle.slug} → ${prereq}`).toBeDefined()
			}
		}
	})

	it('applies each bundle (prereqs first) onto a base spec, keeping it valid', () => {
		for (const bundle of listBundles()) {
			let spec = base()
			const order = resolveInstallOrder(bundle.slug, BUNDLES, [])
			for (const b of order) spec = applyBundle(spec, b)
			expect(collectSpecSystemErrors(spec), bundle.slug).toEqual([])
		}
	})

	it('carries auth infra DDL but no auth spec entities', () => {
		const auth = getBundle('auth')
		expect(auth?.runtime.ddl).toContain('"user"')
		expect(auth?.runtime.entities).toHaveLength(0)
	})

	it('billing contributes the subscription mirror + usage ledger + pages, depends on auth', () => {
		const billing = getBundle('billing')
		expect(billing?.prerequisites).toContain('auth')
		expect(billing?.runtime.entities.map((e) => e.key)).toEqual([
			'subscription',
			'usage_event',
		])
		expect(billing?.runtime.pages.map((p) => p.route)).toEqual([
			'/subscriptions',
			'/usage',
		])
		expect(billing?.runtime.diBindings).toEqual([
			'billing',
			'entitlements',
			'metering',
		])
	})

	it('admin is gated by the analytics entitlement, granted by a paid plan', () => {
		expect(getBundle('admin')?.entitlement).toBe('analytics')
		// The gate is meaningful: some plan actually grants the key.
		const grantsAnalytics = Object.values(PLANS).some((p) =>
			p.entitlements.includes('analytics'),
		)
		expect(grantsAnalytics).toBe(true)
		// And the free tier does not — the gate keeps out unpaid subjects.
		expect(PLANS.free?.entitlements).not.toContain('analytics')
	})
})
