/**
 * Bundle codemods — the dep-currency story for installed bundles (task 28). A
 * bundle is versioned (`Bundle.version`); when the catalog ships a newer version
 * with a schema/DI change, an *installed* project is still pinned to the version
 * it was added at (recorded in `maxstack.json`). `maxstack gen --upgrade` reconciles the
 * gap: for each installed bundle whose catalog version is newer, it runs the
 * registered codemods between the two versions to migrate the project's spec, then
 * records the new version.
 *
 * A codemod is the exact same discipline as everything else in this repo: it is a
 * pure `SpecSystem → SpecSystem` transform expressed through validated spec-ops,
 * and it is **idempotent** — a codemod may run against a spec that already has the
 * change (a fresh install at the new version, or a re-run), and must be a no-op in
 * that case. So the mechanism is safe to run on every `upgrade`, and a partially
 * migrated project converges.
 *
 * The registry starts small (one real codemod: `billing` 0.1.0 → 0.2.0 adds the
 * `currentPeriodEnd` field a 0.1.0 subscription mirror lacked). More land here as
 * catalog bundles take breaking changes; a version gap with *no* registered
 * codemod is a clean version bump (no schema migration needed), not an error.
 */

import {
	applyOp,
	type BlockSpec,
	type EntityId,
	type EntitySpec,
	type FieldId,
	type FieldSpec,
	type ISODate,
	manual,
	type OpId,
	type PageId,
	type PageSpec,
	type SpecSystem,
	USER_ENTITY_ID,
} from '@maxstack/spec'
import type { InstalledBundle } from './types.ts'

/**
 * What a codemod stamps its ops with. Only the date, and only because a gate
 * that compares two upgrades byte-for-byte cannot have a wall clock in the
 * middle of it: `maxstack gen --upgrade` passes nothing and gets today, the
 * upgrade-safety fixtures pass a fixed date and get a reproducible
 * op log. The *origin* is deliberately not a parameter — a codemod is the
 * platform migrating the project, which is `human` in the op-log vocabulary and
 * not something a caller gets to relabel.
 */
export interface CodemodMeta {
	appliedAt: ISODate
}

/**
 * One migration step for a bundle, from `from` to `to` (both exclusive-of-nothing
 * semver strings). `migrate` folds the change into the spec through spec-ops and
 * MUST be idempotent (a no-op when the change is already present).
 */
export interface BundleCodemod {
	slug: string
	from: string
	to: string
	description: string
	migrate(spec: SpecSystem, meta?: CodemodMeta): SpecSystem
}

/** Today's date as an ISO `YYYY-MM-DD` — the default codemod op stamp. */
function today(): ISODate {
	return new Date().toISOString().slice(0, 10) as ISODate
}

/**
 * The op-log metadata every codemod step stamps.
 *
 * `origin: 'human'` because a codemod only ever runs inside `maxstack gen --upgrade`,
 * which a person invokes — the codemod is the *mechanism*, not the author. The
 * `codemod` surface is what distinguishes it in the trail: a
 * reviewer looking at a declaration they never wrote needs to see that an
 * upgrade rewrote it, and `origin` alone would have told them a human did.
 */
function opMeta(opId: string, meta: CodemodMeta | undefined) {
	return {
		id: opId as OpId,
		origin: 'human' as const,
		appliedAt: meta?.appliedAt ?? today(),
		actor: {
			surface: 'codemod' as const,
			path: 'bundle-upgrade-codemod',
		},
	}
}

/** Whether entity `entityId` already has a field named `name`. */
function hasField(spec: SpecSystem, entityId: EntityId, name: string): boolean {
	const entity = spec.data.entities.find((e) => e.id === entityId)
	return !!entity?.fields.some((f) => f.name === name)
}

/**
 * Add `field` to `entityId` if the entity exists and lacks it — the idempotent
 * building block most schema codemods need. A missing entity is left alone (the
 * bundle that owns it isn't installed here), so the codemod stays a no-op rather
 * than throwing.
 */
function addFieldIfMissing(
	spec: SpecSystem,
	entityId: EntityId,
	field: FieldSpec,
	opId: string,
	meta?: CodemodMeta,
): SpecSystem {
	if (!spec.data.entities.some((e) => e.id === entityId)) return spec
	if (hasField(spec, entityId, field.name)) return spec
	return applyOp(
		spec,
		{ op: 'data.addField', args: { entityId, field } },
		opMeta(opId, meta),
	)
}

/**
 * Declare a field **open** over a set of candidate entities if it is not open
 * already — the idempotent building block a codemod that ships an
 * open reference needs.
 *
 * A missing entity or field is left alone, on {@link addFieldIfMissing}'s
 * reasoning: the bundle that owns it may not be installed here, and a codemod
 * that throws on somebody else's absent table is a codemod that blocks an
 * unrelated upgrade. A field that already carries a `reference` is left alone
 * too — the project narrowed it, and re-opening it would un-declare a relation
 * its rows depend on.
 */
function openFieldIfBare(
	spec: SpecSystem,
	entityId: EntityId,
	fieldId: FieldId,
	candidates: EntityId[],
	opId: string,
	meta?: CodemodMeta,
): SpecSystem {
	const field = spec.data.entities
		.find((e) => e.id === entityId)
		?.fields.find((f) => f.id === fieldId)
	if (!field || field.reference || field.openReference) return spec
	return applyOp(
		spec,
		{
			op: 'data.setFieldOpenReference',
			args: { entityId, fieldId, candidates },
		},
		opMeta(opId, meta),
	)
}

/**
 * Add `entity` to the spec if no entity with its id is present — the idempotent
 * building block a codemod that introduces a whole entity needs (mirrors
 * {@link addFieldIfMissing} for the entity level). A re-run, or an install already
 * at the new version, is a no-op.
 */
function addEntityIfMissing(
	spec: SpecSystem,
	entity: EntitySpec,
	opId: string,
	meta?: CodemodMeta,
): SpecSystem {
	if (spec.data.entities.some((e) => e.id === entity.id)) return spec
	return applyOp(
		spec,
		{ op: 'data.addEntity', args: { entity } },
		opMeta(opId, meta),
	)
}

/**
 * Add `page` if no page with its id is present — the page-level counterpart of
 * {@link addEntityIfMissing}, and the half issue #195 found missing.
 *
 * A codemod that materializes an entity without the page the same version ships
 * leaves the project in **a state neither version recognizes**: it has the table
 * a fresh install has, and not the admin surface a fresh install has, so
 * "upgraded to 0.3.0" and "installed at 0.3.0" are two different apps carrying
 * the same version pin. The upgrade-safety gate asserts convergence
 * (`specContentKey(upgraded) === specContentKey(fresh)`) precisely so that gap
 * cannot be shipped again.
 *
 * A missing target entity is left alone rather than throwing, for the same
 * reason {@link addFieldIfMissing} does — the page op would not validate, and a
 * codemod running against a spec that does not have the bundle is a no-op, not
 * an error.
 */
function addPageIfMissing(
	spec: SpecSystem,
	page: PageSpec,
	opId: string,
	meta?: CodemodMeta,
): SpecSystem {
	if (spec.pages.pages.some((p) => p.id === page.id)) return spec
	if (
		page.entityId &&
		!spec.data.entities.some((e) => e.id === page.entityId)
	) {
		return spec
	}
	return applyOp(
		spec,
		{ op: 'page.addPage', args: { page } },
		opMeta(opId, meta),
	)
}

/**
 * Declare an existing field a foreign key, if the entity and field exist and the
 * field is not already a reference. Idempotent in both directions:
 * a fresh install already ships the declaration, and a re-run finds it there.
 *
 * The column-type half of the change is the migration's job, not the spec's —
 * `specSchemaDdl` reconciles a reference column behind a guard and fails loudly
 * on a value that is not an id.
 */
function declareReferenceIfMissing(
	spec: SpecSystem,
	entityId: EntityId,
	fieldId: string,
	reference: EntityId,
	opId: string,
	meta?: CodemodMeta,
): SpecSystem {
	const entity = spec.data.entities.find((e) => e.id === entityId)
	const field = entity?.fields.find((f) => f.id === fieldId)
	if (!entity || !field || field.reference) return spec
	return applyOp(
		spec,
		{
			op: 'data.setFieldReference',
			args: { entityId, fieldId: fieldId as FieldId, reference },
		},
		opMeta(opId, meta),
	)
}

/**
 * The codemod registry. Ordered per bundle so a multi-hop upgrade
 * (0.1.0 → 0.3.0) runs its intermediate steps in sequence.
 */
export const BUNDLE_CODEMODS: BundleCodemod[] = [
	{
		slug: 'members',
		from: '0.1.0',
		to: '0.2.0',
		description:
			'Declare the organization foreign keys. 0.1.0 modelled ' +
			'`member.organizationId`, `member.userId` and `invitation.organizationId` ' +
			'as bare strings, so the platform could not resolve them to a name, could ' +
			'not see the relation in the graph, and could not roll anything up through ' +
			'them. This declares what was already true of the data. The organization ' +
			'columns change type (`text` → `uuid`) when the schema is next synced; the ' +
			'migration does that behind a guard and fails loudly if a row holds ' +
			'something that is not an id — which would mean the column was never ' +
			'really a foreign key.',
		migrate(spec, meta) {
			const withMemberOrg = declareReferenceIfMissing(
				spec,
				'e-member' as EntityId,
				'fld-member-organizationId',
				'e-organization' as EntityId,
				'op-codemod-members-0.2.0-member-org',
				meta,
			)
			const withMemberUser = declareReferenceIfMissing(
				withMemberOrg,
				'e-member' as EntityId,
				'fld-member-userId',
				USER_ENTITY_ID,
				'op-codemod-members-0.2.0-member-user',
				meta,
			)
			return declareReferenceIfMissing(
				withMemberUser,
				'e-invitation' as EntityId,
				'fld-invitation-organizationId',
				'e-organization' as EntityId,
				'op-codemod-members-0.2.0-invitation-org',
				meta,
			)
		},
	},
	{
		slug: 'audit',
		from: '0.1.0',
		to: '0.2.0',
		description:
			'Add `origin` and `apiKeyId` to `audit_log`. 0.1.0 recorded ' +
			'only a `userId`, which cannot distinguish a person in the admin UI from ' +
			'a script running under their api key or an agent driving MCP as them. ' +
			'Both fields are optional: existing rows keep reading, and an entry with ' +
			'no origin is a pre-upgrade entry rather than a claim that it was human.',
		migrate(spec, meta) {
			const withOrigin = addFieldIfMissing(
				spec,
				'e-audit_log' as EntityId,
				fld('audit_log', 'origin', 'string', false),
				'op-codemod-audit-0.2.0-origin',
				meta,
			)
			return addFieldIfMissing(
				withOrigin,
				'e-audit_log' as EntityId,
				fld('audit_log', 'apiKeyId', 'string', false),
				'op-codemod-audit-0.2.0-apiKeyId',
				meta,
			)
		},
	},
	{
		slug: 'audit',
		from: '0.2.0',
		to: '0.3.0',
		description:
			'Add `orgId` and `sourceKey` to `audit_log`. Both ' +
			'facts already reached the sink and neither reached the row: an upgraded ' +
			'trail can say which tenant a write landed in, and that a declared ' +
			'source’s own run made it rather than a person. Optional, so pre-upgrade ' +
			'rows keep reading — an entry with no `orgId` is an entry recorded before ' +
			'the column existed, not a claim that the write was tenant-less.',
		migrate(spec, meta) {
			const withOrg = addFieldIfMissing(
				spec,
				'e-audit_log' as EntityId,
				fld('audit_log', 'orgId', 'string', false),
				'op-codemod-audit-0.3.0-orgId',
				meta,
			)
			return addFieldIfMissing(
				withOrg,
				'e-audit_log' as EntityId,
				fld('audit_log', 'sourceKey', 'string', false),
				'op-codemod-audit-0.3.0-sourceKey',
				meta,
			)
		},
	},
	{
		slug: 'billing',
		from: '0.1.0',
		to: '0.2.0',
		description:
			'Add the `currentPeriodEnd` date field to the `subscription` mirror ' +
			'(0.1.0 tracked only status; 0.2.0 records when the period ends).',
		migrate(spec, meta) {
			return addFieldIfMissing(
				spec,
				'e-subscription' as EntityId,
				{
					id: 'fld-subscription-currentPeriodEnd',
					name: 'currentPeriodEnd',
					type: 'date',
					required: false,
					provenance: manual(),
				},
				'op-codemod-billing-0.2.0',
				meta,
			)
		},
	},
	{
		slug: 'billing',
		from: '0.3.0',
		to: '0.4.0',
		description:
			'Declare both `subject` columns OPEN over `e-user` and `e-organization` ' +
			'. 0.3.0 shipped them as bare strings with the loss recorded ' +
			'as a "cannot": the billing subject is a user in a per-seat app and an ' +
			'organization in a per-workspace one, and a reference names exactly one. ' +
			'The candidates are the catalog’s to declare and the choice is the ' +
			'project’s — narrow with `data.setFieldReference`. Idempotent, and a ' +
			'no-op on a field a project has already narrowed. The emitted column is ' +
			'unchanged (`text` either way), so this needs no data migration.',
		migrate(spec, meta) {
			const withSubscription = openFieldIfBare(
				spec,
				'e-subscription' as EntityId,
				'fld-subscription-subject' as FieldId,
				['e-user' as EntityId, 'e-organization' as EntityId],
				'op-codemod-billing-0.4.0-subscription-subject',
				meta,
			)
			return openFieldIfBare(
				withSubscription,
				'e-usage_event' as EntityId,
				'fld-usage_event-subject' as FieldId,
				['e-user' as EntityId, 'e-organization' as EntityId],
				'op-codemod-billing-0.4.0-usage-subject',
				meta,
			)
		},
	},
	{
		slug: 'billing',
		from: '0.2.0',
		to: '0.3.0',
		description:
			'Materialize the `usage_event` ledger the metered quota check totals over, ' +
			'and the `/usage` admin page that reads it (0.2.0 mirrored subscriptions ' +
			'only; 0.3.0 adds usage metering). Idempotent: a spec that already has the ' +
			'entity and the page is left untouched. The page half was missing at ' +
			'first — an upgraded 0.3.0 project had the ledger table and no way to ' +
			'look at it, which is a state neither version recognizes.',
		migrate(spec, meta) {
			const withEntity = addEntityIfMissing(
				spec,
				{
					id: 'e-usage_event' as EntityId,
					name: 'Usage event',
					// Verbatim from the catalog's 0.3.0 runtime. An upgraded project and
					// a fresh install must be the *same* app, and the description is part
					// of what the schema emitter renders.
					description:
						'One recorded consumption of a metered dimension by a subject — the ' +
						'ledger `MeterService` totals to compare usage against a plan’s allowance.',
					fields: [
						fld('usage_event', 'subject', 'string', true),
						fld('usage_event', 'meter', 'string', true),
						fld('usage_event', 'quantity', 'number', true),
						fld('usage_event', 'at', 'date', true),
					],
					provenance: manual(),
				},
				'op-codemod-billing-0.3.0',
				meta,
			)
			return addPageIfMissing(
				withEntity,
				{
					id: 'pg-usage' as PageId,
					name: 'Usage',
					route: '/usage',
					entityId: 'e-usage_event' as EntityId,
					blocks: [
						{
							id: 'blk-usage-table',
							type: 'table',
							provenance: manual(),
						} satisfies BlockSpec,
					],
					e2eTests: ['an admin can audit recorded usage per subject and meter'],
					// `priority: 'low'` in the catalog, which `applyBundle` lowers to
					// provenance priority 'medium' — mirrored here so the two paths agree.
					provenance: manual({ priority: 'medium' }),
				},
				'op-codemod-billing-0.3.0-page',
				meta,
			)
		},
	},
]

/** Build a {@link FieldSpec} with the same id convention bundle install mints. */
function fld(
	entityKey: string,
	name: string,
	type: FieldSpec['type'],
	required: boolean,
): FieldSpec {
	return {
		id: `fld-${entityKey}-${name}`,
		name,
		type,
		required,
		provenance: manual(),
	}
}

/** Parse `"a.b.c"` into a comparable numeric tuple. */
function parseSemver(v: string): [number, number, number] {
	const [a = 0, b = 0, c = 0] = v.split('.').map((n) => Number.parseInt(n, 10))
	return [a, b, c]
}

/** `-1 | 0 | 1` comparing two semver strings by major, minor, patch. */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a)
	const pb = parseSemver(b)
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0)
		if (d !== 0) return d < 0 ? -1 : 1
	}
	return 0
}

/** A planned upgrade for one installed bundle. */
export interface BundleUpgrade {
	slug: string
	fromVersion: string
	toVersion: string
	/** The codemods that apply across the gap, in order (may be empty). */
	steps: BundleCodemod[]
}

/**
 * Plan the upgrades for a set of installed bundles against the catalog's current
 * versions. For each installed bundle whose catalog version is newer, collect the
 * registered codemods whose `from` is at or above the installed version and whose
 * `to` is at or below the catalog version, ordered by `to`. A bundle already at
 * (or ahead of) the catalog version is skipped; a newer bundle with no codemods
 * is a clean version bump (`steps: []`).
 */
export function planBundleUpgrades(
	installed: readonly InstalledBundle[],
	catalog: Record<string, { version: string }>,
): BundleUpgrade[] {
	const plans: BundleUpgrade[] = []
	for (const record of installed) {
		const current = catalog[record.slug]
		if (!current) continue
		if (compareSemver(current.version, record.version) <= 0) continue
		const steps = BUNDLE_CODEMODS.filter(
			(c) =>
				c.slug === record.slug &&
				compareSemver(c.from, record.version) >= 0 &&
				compareSemver(c.to, current.version) <= 0,
		).sort((a, b) => compareSemver(a.to, b.to))
		plans.push({
			slug: record.slug,
			fromVersion: record.version,
			toVersion: current.version,
			steps,
		})
	}
	return plans
}

/**
 * Apply an upgrade plan's codemods to the spec, in bundle then step order. Pure —
 * returns a new system. Each step is idempotent, so re-running a plan (or running
 * one whose changes are partly present) converges.
 */
export function applyBundleUpgrades(
	spec: SpecSystem,
	plans: readonly BundleUpgrade[],
	meta?: CodemodMeta,
): SpecSystem {
	let system = spec
	for (const plan of plans) {
		for (const step of plan.steps) system = step.migrate(system, meta)
	}
	return system
}

/**
 * The other half of an upgrade: move each installed bundle's recorded version to
 * what its plan reached, leaving every other record — and the order of the list
 * — untouched.
 *
 * It lives here rather than inside `maxstack gen --upgrade` because the upgrade-safety
 * gate must run the *same* version bump the CLI runs. A gate that
 * reimplements the step it is checking proves that the reimplementation works.
 * Pure: returns a new array.
 */
export function bumpInstalledVersions(
	installed: readonly InstalledBundle[],
	plans: readonly BundleUpgrade[],
): InstalledBundle[] {
	return installed.map((record) => {
		const plan = plans.find((p) => p.slug === record.slug)
		return plan ? { slug: record.slug, version: plan.toVersion } : record
	})
}
