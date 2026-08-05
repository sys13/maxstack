/**
 * Example app: saas-starter (a multi-tenant SaaS shell **assembled from
 * bundles**, not hand-authored).
 *
 * Every other example spells its spec out inline; this one is the Phase 6
 * proof: a starter app whose whole data + page surface is
 * *folded in from the catalog* through the same validated `applyBundle` path
 * `maxstack add` uses. The base is an empty `newSpecSystem(minimalPRD(...))`;
 * the target set `members` + `billing` + `admin` drags in its prerequisites
 * (`auth`, `audit`) via `resolveInstallOrder`, so the assembled spec carries the
 * organizations, members, invitations, and subscriptions schema plus the
 * organizations + subscriptions admin pages — auth and audit contribute infra
 * (DDL / DI), no spec structure.
 *
 * The change set then exercises the moat over that assembled surface with a
 * SaaS-shaped backlog: add a members page (op), grow the org/member/subscription
 * schema (field ops), open + fill an organizations filter slot, retitle
 * subscriptions (regeneration-as-diff), eject subscriptions (the chosen escape
 * hatch), roll up per-org usage by month (a typed op since #170), and bill the
 * overage against a plan allowance — an off-surface ask resolved by ejecting the
 * billing surface. Every change still lands regen-safe, so the assembled shell
 * stays green.
 *
 * Exit: the assembly is headless and the run lands
 * well under the 30-min wall-clock budget (near-instant under `MOCK_AI`; the
 * budget is asserted in `saas-starter.test.ts`), validate green.
 */

import { bundle } from '@maxstack/features'
import type { ExampleApp, ExampleChange } from '@maxstack/spec-derive'
import {
	applyOp,
	type EntityId,
	type FieldId,
	manual,
	minimalPRD,
	newSpecSystem,
	type OpId,
	type SpecSystem,
} from './deps.ts'
import {
	addField,
	addPage,
	addRollup,
	addSlot,
	ejectPage,
	fillSlot,
	offSurface,
	page,
	retitle,
	table,
} from './kit.ts'

const { BUNDLES, applyBundle, resolveInstallOrder } = bundle

/**
 * The SaaS starter's product layer — a minimal but valid PRD. The distinctive
 * shape (multi-tenant, billed, audited) lives in the *bundles*, not this prose.
 */
const saasStarterPRD = minimalPRD({
	title: 'SaaS Starter — a multi-tenant, billed, audited app shell',
	tldr: 'The bundle-assembled starting point for a real SaaS: auth, orgs & members, billing, and admin metrics, wired together.',
	problem:
		'Every SaaS re-implements the same shell — sign-in, tenancy, subscriptions, an audit trail, an admin dashboard — before it writes a line of product.',
	northStar: 'Time to a safe change on a real SaaS shell',
	persona: 'A founder standing up a new multi-tenant product',
	differentiation:
		'The shell is assembled from versioned bundles through the same validated spec-op path an agent uses, so it stays regen-safe and upgradable — not a one-time scaffold that rots.',
})

/**
 * Assemble the starter spec from the catalog. For each target bundle we resolve
 * its not-yet-installed prerequisites (topological order) and fold each runtime
 * in through `applyBundle` — the exact path `maxstack add` takes — accumulating
 * the installed set so a shared prerequisite (`auth`) is applied once.
 */
export function assembleSaasStarterSpec(): SpecSystem {
	const targets = ['members', 'billing', 'admin'] as const
	let spec = newSpecSystem(saasStarterPRD, { autoAccept: true })
	const installed: string[] = []
	for (const target of targets) {
		for (const b of resolveInstallOrder(target, BUNDLES, installed)) {
			spec = applyBundle(spec, b, { appliedAt: '2026-07-09' })
			installed.push(b.slug)
		}
	}
	// SPEC EDIT 2026-07-28: name the tenant on the usage ledger.
	//
	// `usage_event.subject` is polymorphic *in the bundle* on purpose — "whatever
	// this app bills", a user id in a per-seat product and an org id in a per-org
	// one — so the catalog has no honest single entity to point it at. This app is
	// the per-org case, and a multi-tenant usage ledger that cannot say which
	// tenant consumed is not a ledger. The edge is therefore declared here, on the
	// assembled spec, exactly the way a real project would narrow a
	// deliberately-open bundle field.
	//
	// Since #216 the platform has that narrowing as a first-class op
	// (`data.setFieldOpenReference` in the bundle, `data.setFieldReference` in the
	// project), which is what this comment was describing by hand. The fixture is
	// deliberately NOT rewired: how a corpus app is assembled is part of what the
	// expressibility score measures, so it moves under a declared corpus version
	// with the comparability break stated — see `docs/corpus-integrity.md`.
	//
	// Additive: a new column, so no shipped column changes type. See
	// docs/corpus/saas-starter-usage-tenant.md.
	return applyOp(
		spec,
		{
			op: 'data.addField',
			args: {
				entityId: 'e-usage_event' as EntityId,
				field: {
					id: 'fld-usage_event-organizationId' as FieldId,
					name: 'organizationId',
					type: 'string',
					required: true,
					reference: 'e-organization' as EntityId,
					provenance: manual(),
				},
			},
		},
		{
			id: 'op-saas-starter-usage-tenant' as OpId,
			origin: 'human',
			appliedAt: '2026-07-28',
			actor: { surface: 'harness', path: 'example-saas-starter' },
		},
	)
}

/** The bundle slugs installed in `assembleSaasStarterSpec`, in install order. */
export const saasStarterBundles = [
	'auth',
	'members',
	'billing',
	'audit',
	'admin',
] as const

/** A user-owned render fn for the organizations filter slot. */
const orgFiltersBody = [
	'// User-owned: a status filter above the organizations table.',
	'export function orgFilters() {',
	'\treturn <div role="search" aria-label="filter organizations">All / Active</div>',
	'}',
].join('\n')

/** The members roster page introduced as a spec op. */
const membersPage = page({
	id: 'pg-members',
	name: 'Members',
	route: '/members',
	entityId: 'e-member',
	blocks: [table('blk-members-table')],
	e2eTests: [
		'an admin can see every member and the org they belong to',
		'an admin can change a member’s role',
	],
})

/**
 * The change set over the assembled surface — a SaaS-shaped backlog of ten
 * changes (seven spec ops, one slot fill, one eject, one off-surface) folded over
 * the org/member/subscription/usage schema. Every change lands regen-safe: the
 * one off-surface ask (overage billing) is resolved by *ejecting* the billing
 * surface, not left unexpressible, so the assembled shell stays green (
 * guardrail).
 */
const changes: ExampleChange[] = [
	addPage(
		'ch-add-members-page',
		'Add the members roster page (spec op).',
		membersPage,
	),
	addField(
		'ch-org-plan-field',
		'Add a plan field to organizations for tenant-level tiering (spec op).',
		'e-organization',
		'fld-organization-plan',
		'plan',
		'string',
	),
	addSlot(
		'ch-add-org-filter-slot',
		'Open a filter slot on the organizations page (spec op).',
		'pg-organizations',
		'blk-organization-filters',
		'orgFilters',
	),
	fillSlot(
		'ch-fill-org-filter',
		'Fill the organizations filter slot (slot fill).',
		'organization',
		'orgFilters',
		orgFiltersBody,
	),
	retitle(
		'ch-retitle-subscriptions',
		'Rename subscriptions to “Billing & Subscriptions” (regeneration-as-diff).',
		'subscription',
		'Billing & Subscriptions',
	),
	addField(
		'ch-member-title-field',
		'Add a job-title field to members (spec op).',
		'e-member',
		'fld-member-title',
		'title',
		'string',
	),
	addField(
		'ch-sub-trial-field',
		'Track each subscription’s trial-end date (spec op).',
		'e-subscription',
		'fld-subscription-trial',
		'trialEndsAt',
		'date',
	),
	ejectPage(
		'ch-eject-subscriptions',
		'Eject the subscriptions page for a bespoke billing layout (eject).',
		'subscription',
	),
	addRollup(
		// RECLASSIFIED 2026-07-28 by issue #170, from off-surface/eject — the one
		// ask in the cluster that was actually being *ejected* rather than left
		// unbuilt. `data.addRollup` is the op: billed quantity per tenant, bucketed
		// monthly. See docs/corpus/saas-starter-usage-metering.md.
		'ch-usage-metering',
		'A per-org usage-metering dashboard aggregating billed events (spec op).',
		'e-organization',
		{
			id: 'drv-organization-usage',
			name: 'usageByMonth',
			over: 'e-usage_event',
			via: 'fld-usage_event-organizationId',
			fn: 'sum',
			field: 'fld-usage_event-quantity',
			groupBy: { field: 'fld-usage_event-at', bucket: 'month' },
			// Two years of billing periods — the cost bound a grouped rollup states.
			limit: 24,
		},
	),
	offSurface(
		// CORPUS HARDENING 2026-07-28 — replaces the residual
		// difficulty the reclassification above removed, in the same product area
		// and the same shape: what a `sum` of a ledger still cannot do. Resolved
		// by ejecting, like the ask it replaces, so the assembled shell keeps
		// landing every change.
		// See docs/corpus/saas-starter-overage-billing.md.
		'ch-usage-overage-billing',
		'Bill the overage: compare each org’s metered usage against its plan allowance mid-period, warn at 80%, meter the excess in tiered blocks, and prorate all of it when the plan changes on the 14th — no op models an allowance, a tier ladder, or proration, so the billing surface is ejected to build it by hand (off-surface, eject).',
		'organization',
		'eject',
	),
]

export const saasStarterExample: ExampleApp = {
	id: 'saas-starter',
	title: 'SaaS Starter — bundle-assembled multi-tenant shell',
	spec: assembleSaasStarterSpec(),
	changes,
}
