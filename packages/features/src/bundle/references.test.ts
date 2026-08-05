/**
 * Bundle foreign keys as declared relations, and the rule that
 * governs declaring one.
 *
 * Declaring `reference` on a field changes the column type `from-spec` emits —
 * `uuid` for a spec-entity target, `text` for a virtual entity with text ids
 * (`e-user`). A bundle field that already shipped as a bare `string`
 * is a `text` column in every live database, so:
 *
 *   - a reference to a **text-id** target is free: same column, no migration;
 *   - a reference to a **spec entity** is a `text → uuid` change.
 *
 * The second used to be forbidden outright, on the additive-only DDL rule, and
 * this file asserted that no such reference existed. That assertion is what made
 * the catalog's relations permanently untyped — nothing could ever be declared,
 * so nothing ever was.
 *
 * It is now a **conditional**, not a prohibition. A type-changing reference is
 * allowed when the migration that performs it exists, which mechanically means:
 *
 *   1. `specSchemaDdl` reconciles a reference column behind a guard, so an
 *      existing database is actually migrated instead of silently disagreeing
 *      with drizzle — and the `USING` cast fails loudly on a value that is not
 *      an id (`from-spec.test.ts`).
 *   2. The owning bundle has **moved past its `initialVersion`**, and a
 *      registered codemod covers the step, so an installed project's *spec*
 *      gains the declaration on `maxstack gen --upgrade` rather than only new installs
 *      getting it.
 *
 * The tests below are the mechanical form of that conditional. A reference
 * declared on a shipped column without the codemod behind it still fails.
 */

import { type SpecFieldShape, specSchemaDdl } from '@maxstack/core'
import {
	type EntityId,
	type FieldSpec,
	minimalPRD,
	newSpecSystem,
	type SpecSystem,
	USER_ENTITY_ID,
	virtualEntity,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { applyBundle } from './apply.ts'
import { BUNDLES, listBundles } from './catalog.ts'
import {
	applyBundleUpgrades,
	BUNDLE_CODEMODS,
	compareSemver,
	planBundleUpgrades,
} from './codemods.ts'
import type { Bundle } from './types.ts'

/** The plan `maxstack gen --upgrade` builds for a project pinned at members 0.1.0. */
function upgradePlan() {
	return planBundleUpgrades([{ slug: 'members', version: '0.1.0' }], {
		members: { version: (BUNDLES.members as Bundle).version },
	})
}

/** A field on an entity, by id — the shape these assertions keep reaching for. */
function fieldIn(
	spec: SpecSystem,
	entityId: string,
	fieldId: string,
): FieldSpec | undefined {
	return spec.data.entities
		.find((e) => e.id === (entityId as EntityId))
		?.fields.find((f) => f.id === fieldId)
}

/**
 * The members bundle as it shipped at 0.1.0: organization FKs as bare strings.
 * Installing the *current* bundle would ship the declarations already, which is
 * the one thing an upgrade test must not do.
 */
function legacyMembers(): Bundle {
	const current = BUNDLES.members as Bundle
	return {
		...current,
		version: '0.1.0',
		runtime: {
			...current.runtime,
			entities: current.runtime.entities.map((e) => ({
				...e,
				fields: e.fields.map(({ reference, ...rest }) =>
					reference === 'e-organization' ? rest : { reference, ...rest },
				),
			})),
		},
	} as Bundle
}

/** Every (bundle, entity, field) triple in the catalog. */
function allFields(): {
	bundle: Bundle
	entityKey: string
	field: Bundle['runtime']['entities'][number]['fields'][number]
}[] {
	return listBundles().flatMap((bundle) =>
		bundle.runtime.entities.flatMap((entity) =>
			entity.fields.map((field) => ({
				bundle,
				entityKey: entity.key,
				field,
			})),
		),
	)
}

/** The SQL type `from-spec` would emit for one bundle field. */
function sqlTypeFor(
	field: Bundle['runtime']['entities'][number]['fields'][number],
): string {
	if (!field.reference) {
		return specSchemaDdl([
			{
				name: 't',
				fields: [
					{ name: 'c', type: field.type, required: false } as SpecFieldShape,
				],
			},
		]).match(/ADD COLUMN IF NOT EXISTS "c" (\w+);/)?.[1] as string
	}
	const virtual = virtualEntity(field.reference)
	return virtual?.idType ?? 'uuid'
}

describe('a type-changing reference ships with the migration that performs it', () => {
	/** References whose target is a spec entity — the `text` → `uuid` case. */
	const typeChanging = () =>
		allFields()
			.filter((f) => f.field.reference)
			.filter(
				(f) => virtualEntity(f.field.reference as string)?.idType !== 'text',
			)

	it('is exactly the organization FKs today', () => {
		// Named rather than counted, so adding one is a deliberate edit here.
		expect(
			typeChanging()
				.map((f) => `${f.bundle.slug}.${f.entityKey}.${f.field.name}`)
				.sort(),
		).toEqual([
			'members.invitation.organizationId',
			'members.member.organizationId',
		])
	})

	it('every one is carried by a codemod on a bundle that has moved', () => {
		// The condition that replaced the old prohibition. A declaration with no
		// codemod behind it migrates new installs and silently skips existing
		// projects, which is worse than not declaring it at all.
		for (const { bundle } of typeChanging()) {
			expect(
				compareSemver(bundle.version, bundle.initialVersion),
				`${bundle.slug} declares a type-changing reference but is still at its initialVersion`,
			).toBeGreaterThan(0)
			expect(
				BUNDLE_CODEMODS.some((c) => c.slug === bundle.slug),
				`${bundle.slug} declares a type-changing reference with no registered codemod`,
			).toBe(true)
		}
	})

	it('the codemod declares it on an already-installed spec', () => {
		// End-to-end: a 0.1.0-shaped spec (bare strings) upgraded through the
		// registered codemod comes out with the relations declared.
		let spec = newSpecSystem(
			minimalPRD({
				title: 'Upgrade fixture',
				tldr: 'A project installed before the FKs were declared.',
				problem: 'Its member table models the org as a bare string.',
				northStar: 'Relations resolve',
				persona: 'A maintainer running maxstack gen --upgrade',
				differentiation: 'n/a',
			}),
			{ autoAccept: true },
		)
		spec = applyBundle(spec, BUNDLES.auth as Bundle, {
			appliedAt: '2026-07-01',
		})
		spec = applyBundle(spec, legacyMembers(), { appliedAt: '2026-07-01' })
		const before = fieldIn(spec, 'e-member', 'fld-member-organizationId')
		expect(before?.reference).toBeUndefined()

		const upgraded = applyBundleUpgrades(spec, upgradePlan())
		expect(
			fieldIn(upgraded, 'e-member', 'fld-member-organizationId')?.reference,
		).toBe('e-organization')
		expect(
			fieldIn(upgraded, 'e-invitation', 'fld-invitation-organizationId')
				?.reference,
		).toBe('e-organization')

		// Idempotent: running it again against the migrated spec is a no-op.
		expect(
			JSON.stringify(applyBundleUpgrades(upgraded, upgradePlan()).data),
		).toBe(JSON.stringify(upgraded.data))
	})

	it('emits a guarded reconciliation for the changed column, not a bare ADD COLUMN', () => {
		// The half a codemod cannot do: an installed database still holds `text`.
		const ddl = specSchemaDdl([
			{
				name: 'member',
				fields: [
					{
						name: 'organizationId',
						type: 'string',
						required: true,
						reference: { table: 'organization', column: 'id' },
					} as SpecFieldShape,
				],
			},
		])
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "organizationId" uuid')
		expect(ddl).toContain("data_type <> 'uuid'")
		expect(ddl).toContain('USING "organizationId"::uuid')
	})
})

describe('the user references that were free to declare', () => {
	const fieldOf = (slug: string, entityKey: string, name: string) =>
		BUNDLES[slug]?.runtime.entities
			.find((e) => e.key === entityKey)
			?.fields.find((f) => f.name === name)

	it('audit_log.userId belongs to the auth user', () => {
		expect(fieldOf('audit', 'audit_log', 'userId')?.reference).toBe(
			USER_ENTITY_ID,
		)
	})

	it('invitation.inviterId belongs to the auth user', () => {
		expect(fieldOf('members', 'invitation', 'inviterId')?.reference).toBe(
			USER_ENTITY_ID,
		)
	})

	it('both still emit text columns — the whole reason they were free', () => {
		for (const field of [
			fieldOf('audit', 'audit_log', 'userId'),
			fieldOf('members', 'invitation', 'inviterId'),
		]) {
			expect(field).toBeDefined()
			expect(sqlTypeFor(field as never)).toBe('text')
		}
	})
})

describe('the foreign keys a project declares, not the catalog', () => {
	const fieldOf = (slug: string, entityKey: string, name: string) =>
		BUNDLES[slug]?.runtime.entities
			.find((e) => e.key === entityKey)
			?.fields.find((f) => f.name === name)

	// This used to be a recorded "cannot": the billing subject is "whatever
	// the app treats as the billing subject" — a user id in a per-seat product, an
	// organization id in a per-workspace one — and `reference` names exactly one
	// entity, so no value was honest. Issue #216 declares the *candidates* instead
	// and leaves the choice to the project, which is where the ambiguity actually
	// resolves: a catalog cannot know and an app always does.
	it('billing subjects are open over their candidates, not bare strings', () => {
		for (const entity of ['subscription', 'usage_event']) {
			const field = fieldOf('billing', entity, 'subject')
			// Still no single target — declaring one would be wrong for half of all
			// apps, which is the fact that has not changed.
			expect(field?.reference).toBeUndefined()
			expect(field?.openReference).toEqual(['e-organization', 'e-user'])
		}
	})

	it('both subject columns name the same candidates', () => {
		// A project that narrowed one and not the other would have a usage ledger it
		// could not join to its own subscriptions.
		expect(fieldOf('billing', 'usage_event', 'subject')?.openReference).toEqual(
			fieldOf('billing', 'subscription', 'subject')?.openReference,
		)
	})
})
