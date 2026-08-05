/**
 * The SaaS-starter example — the Phase 6 proof that a starter app can be
 * *assembled from the bundle catalog* rather than hand-authored. These are the
 * structural assertions (assembled from bundles, valid spec, the standard
 * change mix); the harness proves it runs through the pipeline headless, under
 * the 30-min wall-clock budget, with regen-safety 100% (`eval.test.ts`).
 */

import { validateSpecSystem } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import {
	assembleSaasStarterSpec,
	saasStarterBundles,
	saasStarterExample,
} from './saas-starter.ts'

describe('saas-starter example (assembled from bundles)', () => {
	it('assembles a valid three-layer spec from the catalog', () => {
		expect(() => validateSpecSystem(saasStarterExample.spec)).not.toThrow()
	})

	it('folds every target bundle and its prerequisites into the spec', () => {
		// members → auth; billing → (auth already); admin → auth + audit.
		expect(saasStarterBundles).toEqual([
			'auth',
			'members',
			'billing',
			'audit',
			'admin',
		])
		// Each install is recorded in the op log as a validated bundle op.
		const bundleOps = saasStarterExample.spec.opLog.filter((o) =>
			o.id.startsWith('op-bundle-'),
		)
		expect(bundleOps.length).toBeGreaterThan(0)
	})

	it('lands the schema bundles’ entities (orgs, members, invitations, subscriptions, audit)', () => {
		const ids = saasStarterExample.spec.data.entities.map((e) => e.id)
		expect(ids).toEqual(
			expect.arrayContaining([
				'e-organization',
				'e-member',
				'e-invitation',
				'e-subscription',
				'e-audit_log',
			]),
		)
	})

	it('lands the schema bundles’ admin pages (organizations + subscriptions)', () => {
		const routes = saasStarterExample.spec.pages.pages.map((p) => p.route)
		expect(routes).toEqual(
			expect.arrayContaining(['/organizations', '/subscriptions']),
		)
	})

	it('marks bundle-installed rows as accepted + regen-protected (manual provenance)', () => {
		const org = saasStarterExample.spec.data.entities.find(
			(e) => e.id === 'e-organization',
		)
		expect(org?.provenance.isAccepted).toBe(true)
		expect(org?.provenance.isAddedManually).toBe(true)
	})

	it('carries a SaaS-shaped backlog spanning every expressibility category', () => {
		const kinds = new Set(saasStarterExample.changes.map((c) => c.kind))
		expect(kinds).toEqual(
			new Set(['spec-op', 'slot-fill', 'eject', 'off-surface']),
		)
		// Its one off-surface ask is resolved by ejecting (not left unexpressible),
		// so the assembled shell still lands every change regen-safe.
		const off = saasStarterExample.changes.filter(
			(c) => c.kind === 'off-surface',
		)
		expect(off).toHaveLength(1)
		expect(
			off.every((c) => c.kind === 'off-surface' && c.resolution === 'eject'),
		).toBe(true)
	})

	it('is deterministic — reassembling yields the same spec', () => {
		expect(JSON.stringify(assembleSaasStarterSpec())).toBe(
			JSON.stringify(assembleSaasStarterSpec()),
		)
	})
})
