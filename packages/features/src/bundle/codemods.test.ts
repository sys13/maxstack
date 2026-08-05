import { minimalPRD, newSpecSystem, type SpecSystem } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { applyBundle } from './apply.ts'
import { getBundle } from './catalog.ts'
import {
	applyBundleUpgrades,
	BUNDLE_CODEMODS,
	compareSemver,
	planBundleUpgrades,
} from './codemods.ts'
import type { InstalledBundle } from './types.ts'

const base = (): SpecSystem =>
	newSpecSystem(
		minimalPRD({
			title: 'Codemods',
			tldr: 'codemod test',
			problem: 'migrating an installed bundle',
			northStar: 'green',
			persona: 'maintainer',
			differentiation: 'none',
		}),
	)

function mustGetBundle(id: string) {
	const bundle = getBundle(id)
	if (!bundle) throw new Error(`bundle not found: ${id}`)
	return bundle
}

const auth = () => mustGetBundle('auth')
const billing = () => mustGetBundle('billing')

/** Install billing (with its auth prereq) onto a base spec. */
function installBilling(): SpecSystem {
	let spec = base()
	spec = applyBundle(spec, auth())
	spec = applyBundle(spec, billing())
	return spec
}

const fieldNames = (spec: SpecSystem): string[] =>
	spec.data.entities
		.find((e) => e.id === 'e-subscription')
		?.fields.map((f) => f.name) ?? []

describe('compareSemver', () => {
	it('orders by major, minor, patch', () => {
		expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
		expect(compareSemver('0.2.0', '0.1.0')).toBe(1)
		expect(compareSemver('1.0.0', '0.9.9')).toBe(1)
		expect(compareSemver('0.2.0', '0.2.0')).toBe(0)
	})
})

describe('planBundleUpgrades', () => {
	const catalog = { billing: { version: '0.2.0' }, auth: { version: '0.1.0' } }

	it('plans a codemod for a bundle behind the catalog', () => {
		const installed: InstalledBundle[] = [{ slug: 'billing', version: '0.1.0' }]
		const plans = planBundleUpgrades(installed, catalog)
		expect(plans).toHaveLength(1)
		expect(plans[0]).toMatchObject({
			slug: 'billing',
			fromVersion: '0.1.0',
			toVersion: '0.2.0',
		})
		expect(plans[0]?.steps.map((s) => s.to)).toEqual(['0.2.0'])
	})

	it('skips a bundle already at the catalog version', () => {
		const installed: InstalledBundle[] = [{ slug: 'billing', version: '0.2.0' }]
		expect(planBundleUpgrades(installed, catalog)).toEqual([])
	})

	it('a version bump with no registered codemod is a clean bump (empty steps)', () => {
		const installed: InstalledBundle[] = [{ slug: 'auth', version: '0.0.9' }]
		const plans = planBundleUpgrades(installed, {
			auth: { version: '0.1.0' },
		})
		expect(plans).toHaveLength(1)
		expect(plans[0]?.steps).toEqual([])
	})

	it('ignores installed bundles absent from the catalog', () => {
		const installed: InstalledBundle[] = [{ slug: 'ghost', version: '0.1.0' }]
		expect(planBundleUpgrades(installed, catalog)).toEqual([])
	})
})

describe('applyBundleUpgrades — billing 0.1.0 → 0.2.0', () => {
	it('adds the currentPeriodEnd field a 0.1.0 install lacked', () => {
		// Simulate a 0.1.0 subscription mirror: same entity minus currentPeriodEnd.
		let spec = base()
		spec = applyBundle(spec, auth())
		spec = applyBundle(spec, {
			...billing(),
			version: '0.1.0',
			runtime: {
				...billing().runtime,
				entities: billing().runtime.entities.map((e) => ({
					...e,
					fields: e.fields.filter((f) => f.name !== 'currentPeriodEnd'),
				})),
			},
		})
		expect(fieldNames(spec)).not.toContain('currentPeriodEnd')

		const plans = planBundleUpgrades([{ slug: 'billing', version: '0.1.0' }], {
			billing: { version: '0.2.0' },
		})
		const migrated = applyBundleUpgrades(spec, plans)
		expect(fieldNames(migrated)).toContain('currentPeriodEnd')
	})

	it('is idempotent — running against a 0.2.0 install is a no-op', () => {
		const spec = installBilling() // already has currentPeriodEnd
		expect(fieldNames(spec)).toContain('currentPeriodEnd')
		const plans = planBundleUpgrades([{ slug: 'billing', version: '0.1.0' }], {
			billing: { version: '0.2.0' },
		})
		const migrated = applyBundleUpgrades(spec, plans)
		// Field count unchanged (no duplicate), spec still valid.
		expect(
			fieldNames(migrated).filter((n) => n === 'currentPeriodEnd'),
		).toHaveLength(1)
	})
})

describe('applyBundleUpgrades — audit 0.2.0 → 0.3.0', () => {
	const audit = () => mustGetBundle('audit')
	const auditFields = (spec: SpecSystem): string[] =>
		spec.data.entities
			.find((e) => e.id === 'e-audit_log')
			?.fields.map((f) => f.name) ?? []

	/** Install the audit log as it stood at 0.2.0: without the two attribution
	 * columns 0.3.0 adds. */
	const installAuditV2 = (): SpecSystem =>
		applyBundle(base(), {
			...audit(),
			version: '0.2.0',
			runtime: {
				...audit().runtime,
				entities: audit().runtime.entities.map((e) => ({
					...e,
					fields: e.fields.filter(
						(f) => f.name !== 'orgId' && f.name !== 'sourceKey',
					),
				})),
			},
		})

	const plan = () =>
		planBundleUpgrades([{ slug: 'audit', version: '0.2.0' }], {
			audit: { version: '0.3.0' },
		})

	it('adds the orgId and sourceKey columns a 0.2.0 trail lacked', () => {
		const spec = installAuditV2()
		expect(auditFields(spec)).not.toContain('orgId')
		const migrated = applyBundleUpgrades(spec, plan())
		// The tenant a write happened in and the source that made it — both already
		// reached the sink before this, and neither reached the row.
		expect(auditFields(migrated)).toContain('orgId')
		expect(auditFields(migrated)).toContain('sourceKey')
	})

	it('is idempotent — a fresh 0.3.0 install is left alone', () => {
		const spec = applyBundle(base(), audit())
		const migrated = applyBundleUpgrades(spec, plan())
		expect(auditFields(migrated).filter((n) => n === 'orgId')).toHaveLength(1)
		expect(auditFields(migrated).filter((n) => n === 'sourceKey')).toHaveLength(
			1,
		)
	})
})

const entityIds = (spec: SpecSystem): string[] =>
	spec.data.entities.map((e) => e.id)

/** Install billing as it stood at 0.2.0: without the 0.3.0 `usage_event` entity. */
function installBillingV2(): SpecSystem {
	let spec = base()
	spec = applyBundle(spec, auth())
	spec = applyBundle(spec, {
		...billing(),
		version: '0.2.0',
		runtime: {
			...billing().runtime,
			entities: billing().runtime.entities.filter(
				(e) => e.key !== 'usage_event',
			),
			pages: billing().runtime.pages.filter((p) => p.key !== 'usage'),
		},
	})
	return spec
}

describe('applyBundleUpgrades — billing 0.2.0 → 0.3.0', () => {
	it('materializes the usage_event ledger a 0.2.0 install lacked', () => {
		const spec = installBillingV2()
		expect(entityIds(spec)).not.toContain('e-usage_event')

		const plans = planBundleUpgrades([{ slug: 'billing', version: '0.2.0' }], {
			billing: { version: '0.3.0' },
		})
		expect(plans[0]?.steps.map((s) => s.to)).toEqual(['0.3.0'])
		const migrated = applyBundleUpgrades(spec, plans)
		const usage = migrated.data.entities.find((e) => e.id === 'e-usage_event')
		expect(usage).toBeDefined()
		expect(usage?.fields.map((f) => f.name)).toEqual([
			'subject',
			'meter',
			'quantity',
			'at',
		])
	})

	it('is idempotent — running against a spec that already has usage_event is a no-op', () => {
		const spec = installBilling() // current catalog: already has usage_event
		expect(entityIds(spec)).toContain('e-usage_event')
		const plans = planBundleUpgrades([{ slug: 'billing', version: '0.2.0' }], {
			billing: { version: '0.3.0' },
		})
		const migrated = applyBundleUpgrades(spec, plans)
		expect(
			migrated.data.entities.filter((e) => e.id === 'e-usage_event'),
		).toHaveLength(1)
	})

	it('a full 0.1.0 → 0.3.0 upgrade runs both steps in order', () => {
		let spec = base()
		spec = applyBundle(spec, auth())
		spec = applyBundle(spec, {
			...billing(),
			version: '0.1.0',
			runtime: {
				...billing().runtime,
				entities: billing()
					.runtime.entities.filter((e) => e.key !== 'usage_event')
					.map((e) => ({
						...e,
						fields: e.fields.filter((f) => f.name !== 'currentPeriodEnd'),
					})),
				pages: billing().runtime.pages.filter((p) => p.key !== 'usage'),
			},
		})
		const plans = planBundleUpgrades([{ slug: 'billing', version: '0.1.0' }], {
			billing: { version: '0.3.0' },
		})
		expect(plans[0]?.steps.map((s) => s.to)).toEqual(['0.2.0', '0.3.0'])
		const migrated = applyBundleUpgrades(spec, plans)
		expect(fieldNames(migrated)).toContain('currentPeriodEnd')
		expect(entityIds(migrated)).toContain('e-usage_event')
	})
})

describe('codemod registry', () => {
	it('every registered codemod targets a real catalog bundle', () => {
		for (const codemod of BUNDLE_CODEMODS) {
			const bundle = getBundle(codemod.slug)
			expect(bundle, codemod.slug).toBeDefined()
			// The codemod’s target version does not exceed the catalog version.
			expect(
				compareSemver(codemod.to, bundle?.version ?? '0.0.0'),
			).toBeLessThanOrEqual(0)
		}
	})
})
