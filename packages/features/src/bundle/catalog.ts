/**
 * The bundle catalog — the staged L5 feature modules promoted to real, versioned
 * {@link Bundle}s. Each entry is pure data: its runtime
 * (what it contributes to a project's spec/store/DI), its prerequisites, and its
 * own eval material (`artifacts`). `maxstack add <slug>` resolves prerequisites
 * over this catalog and folds each runtime into the project spec via `applyBundle`.
 *
 * Two shapes of bundle live here:
 *   - **Schema bundles** contribute `entities`/`pages`/`seeds` (from-spec derives
 *     uuid tables + admin CRUD): `audit` (the `audit_log` table), `members`
 *     (org/member/invitation + an organizations page + a demo org seed), `billing`
 *     (the `subscription` mirror + `usage_event` ledger + subscriptions/usage pages).
 *   - **Infra / mechanism bundles** contribute no spec structure — their value is
 *     the install record + composition-root DI wiring (and `ddl` for auth's
 *     better-auth-managed, text-id identity tables): `auth`, `email`, `db-plugins`,
 *     `di`, `admin`.
 *
 * A bundle may also carry an `entitlement` key (task 28) marking its features as
 * gated: `admin` sets `entitlement: 'analytics'`, so the metrics dashboard only
 * activates at runtime for subjects whose plan grants it (enforced with the
 * billing bundle's `hasEntitlement` primitive at the composition root).
 */

import { USER_ENTITY_ID } from '@maxstack/spec'
import { API_KEYS_DDL, PORTAL_TOKENS_DDL } from '../api-keys/index.ts'
// Deliberately the leaf module, not `../auth/index.ts`: the barrel also
// re-exports `auth.ts`, which imports `better-auth` and its drizzle adapter. The
// catalog is pure data and is reached from `maxstack add`, so going through the
// barrel puts the whole better-auth runtime into the published CLI bundle — an
// import the CLI never calls, whose peer `drizzle-orm` npm can only satisfy by
// auto-installing a second copy that a later install prunes (#348). The catalog
// needs one DDL string; take it from where it is defined.
import { AUTH_DDL } from '../auth/schema.ts'
import { CONSENT_DDL } from '../compliance/index.ts'
import { FLAGS_DDL } from '../flags/index.ts'
import { JOBS_DDL } from '../jobs/index.ts'
import { NOTIFICATIONS_DDL } from '../notifications/index.ts'
import { PREFERENCES_DDL } from '../preferences/index.ts'
import { WEBHOOKS_DDL } from '../webhooks/index.ts'
import type { Bundle } from './types.ts'

const VERSION = '0.1.0'

/** A tiny PRD fragment so every bundle carries at least its own eval material. */
const prd = (title: string, body: string): Bundle['artifacts'][number] => ({
	type: 'prd',
	title,
	md: body,
})

const authBundle: Bundle = {
	slug: 'auth',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Authentication',
	description:
		'better-auth sessions + password login and the canonical identity tables ' +
		'(user/session/account/verification), with a non-input `role` field as the ' +
		'RBAC bridge. Materialized as infra DDL, not a spec entity.',
	prerequisites: [],
	runtime: {
		entities: [],
		pages: [],
		diBindings: ['auth'],
		ddl: AUTH_DDL,
	},
	artifacts: [
		prd(
			'Auth',
			'# Authentication\n\nEmail+password sign-in on better-auth. `user.role` ' +
				'drives RBAC across admin/REST/MCP. The four identity tables are managed ' +
				'by better-auth (text ids) and applied as idempotent DDL at boot.',
		),
	],
	ownership: {
		// better-auth's text-id tables, materialized by `ddl` — no spec entity
		// claims them, so they must be declared to be collision-checked.
		tables: ['user', 'session', 'account', 'verification', 'two_factor'],
		routes: [],
	},
	uninstall: {
		supported: false,
		reason:
			'Identity is load-bearing for everything downstream: members, billing ' +
			'subjects, audit rows, and the op-log author column all reference `user`. ' +
			'Dropping the identity tables would orphan them, and the spec vocabulary ' +
			'has no remove-entity op to unwind the dependents. Start a new project ' +
			'instead of uninstalling auth.',
	},
	evalAsks: [
		{
			id: 'ask-auth-magic-link',
			ask: 'Let people sign in with an emailed magic link instead of a password.',
			source: 'real-product',
			sourceRef:
				'better-auth ships a magicLink plugin; Notion and Vercel both default ' +
				'to passwordless email sign-in.',
		},
		{
			id: 'ask-auth-login-route',
			ask: 'Give the scaffolded app a real /login page wired to the session.',
			source: 'issue-report',
			sourceRef:
				'a dogfooded project installed auth and had nowhere to sign in.',
		},
	],
}

const auditBundle: Bundle = {
	slug: 'audit',
	version: '0.3.0',
	initialVersion: '0.1.0',
	userFacing: true,
	title: 'Audit log',
	description:
		'A write-only audit trail. Contributes the `audit_log` table and an ' +
		'`auditSink` binding services record mutations through. Every entry ' +
		'records how the caller reached the app — a browser session, an api key ' +
		'(with the key id), or an agent over MCP — the organization the write ' +
		'happened in, and the declared source whose run made it, when one did.',
	prerequisites: [],
	runtime: {
		entities: [
			{
				key: 'audit_log',
				name: 'Audit log',
				description: 'Append-only record of who did what to which resource.',
				fields: [
					// `e-user` is a virtual entity with text ids, so the
					// emitted column is `text` either way — declaring the reference
					// costs no DDL change and buys FK resolution + a relation edge.
					{
						name: 'userId',
						type: 'string',
						required: true,
						reference: USER_ENTITY_ID,
					},
					{ name: 'action', type: 'string', required: true },
					{ name: 'resource', type: 'string', required: true },
					{ name: 'resourceId', type: 'string' },
					{ name: 'metadata', type: 'json' },
					{ name: 'ipAddress', type: 'string' },
					{ name: 'userAgent', type: 'string' },
					// Added in 0.2.0 — a 0.1.0 install is migrated by the
					// upgrade codemod. Optional, so a pre-upgrade row reads as "origin
					// unknown" rather than silently as a human session.
					{ name: 'origin', type: 'string' },
					{ name: 'apiKeyId', type: 'string' },
					// Added in 0.3.0. `orgId` is the tenant the write
					// happened in and `sourceKey` the declared source whose run made it;
					// both were readable in the process that recorded the entry and absent
					// from the row, so the persisted trail could not say which tenant a
					// write landed in or that a source had written it at all.
					//
					// Deliberately *not* declared as a reference to `e-organization`, for
					// the reason `userId`'s reference is declared: this bundle has no
					// prerequisites, so the organization entity belongs to a bundle that
					// may not be installed, and a reference to an absent entity is not a
					// spec that loads. The column is `text` either way.
					{ name: 'orgId', type: 'string' },
					{ name: 'sourceKey', type: 'string' },
					{ name: 'createdAt', type: 'date', required: true },
				],
			},
		],
		pages: [],
		diBindings: ['auditSink'],
	},
	artifacts: [
		prd(
			'Audit log',
			'# Audit log\n\nEvery privileged mutation writes an `audit_log` row ' +
				'(userId/action/resource + JSON metadata + createdAt). Backs the admin ' +
				'metrics dashboard and satisfies review/compliance asks.',
		),
	],
	ownership: { tables: ['audit_log'], routes: [] },
	uninstall: {
		supported: false,
		reason:
			'The audit trail is append-only by design and the admin bundle aggregates ' +
			'over it. Removing it would delete the record of who did what, which is ' +
			'the one thing an audit log must not offer as a button.',
	},
	evalAsks: [
		{
			id: 'ask-audit-resource-filter',
			ask: 'Show the audit log filtered to one resource, newest first.',
			source: 'real-product',
			sourceRef:
				'Stripe Dashboard → Developers → Events: filtered by resource type, ' +
				'reverse chronological.',
		},
	],
}

const emailBundle: Bundle = {
	slug: 'email',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Transactional email',
	description:
		'A name-keyed template registry (custom overrides default) plus a mailer ' +
		'transport. Exposes `emailRegistry` and `mailer` bindings.',
	prerequisites: [],
	runtime: {
		entities: [],
		pages: [],
		diBindings: ['emailRegistry', 'mailer'],
	},
	artifacts: [
		prd(
			'Email',
			'# Transactional email\n\nverify-email / password-reset / welcome / ' +
				'newsletter-confirmation templates render to HTML through a registry; a ' +
				'pluggable `Mailer` transport (console/memory built in) sends them.',
		),
	],
	ownership: { tables: [], routes: [] },
	uninstall: {
		supported: true,
		notes:
			'Contributes no schema and no routes: removing the install record and the ' +
			'`emailRegistry`/`mailer` bindings at the composition root is the whole ' +
			'uninstall. Anything that sends mail must be removed first, or its ' +
			'required binding fails loud at boot (which is the intended behaviour).',
	},
	evalAsks: [
		{
			id: 'ask-email-template-override',
			ask: 'Rewrite the password-reset email copy without ejecting the registry.',
			source: 'real-product',
			sourceRef:
				'Postmark and Resend onboarding both treat "replace the default copy" ' +
				'as the first thing a team does before launch.',
		},
	],
}

const dbPluginsBundle: Bundle = {
	slug: 'db-plugins',
	version: VERSION,
	initialVersion: VERSION,
	// Plumbing, not a capability anyone shops for.
	userFacing: false,
	title: 'Seed plugins',
	description:
		'The FK-ordered seed-plugin registry that runs installed bundles’ seeds at ' +
		'boot. Exposes the `dbPlugins` binding.',
	prerequisites: [],
	runtime: {
		entities: [],
		pages: [],
		diBindings: ['dbPlugins'],
	},
	artifacts: [
		prd(
			'Seed plugins',
			'# Seed plugins\n\nA name-keyed registry that seeds in enable order and ' +
				'clears in reverse (FK-safe). Bundle `seeds` are loaded through it at boot, ' +
				'idempotently.',
		),
	],
	ownership: { tables: [], routes: [] },
	uninstall: {
		supported: true,
		notes:
			'Registry only — dropping the `dbPlugins` binding leaves installed ' +
			'bundles’ seeds unloaded, which is a data-freshness change, not a schema one.',
	},
	evalAsks: [
		{
			id: 'ask-db-plugins-seed-after-bundles',
			ask: 'Seed my own demo rows after the bundles’ seeds without hitting FK errors.',
			source: 'dogfood',
			sourceRef:
				'2026-07 demo-seeding session: project seeds had to run after the members ' +
				'bundle’s organization row existed.',
		},
	],
}

const diBundle: Bundle = {
	slug: 'di',
	version: VERSION,
	initialVersion: VERSION,
	// Plumbing, not a capability anyone shops for.
	userFacing: false,
	title: 'Dependency injection',
	description:
		'The typed DI-bindings contract (`createBindings` + missing-binding guard) ' +
		'and its React `<BindingsProvider>`/`useBindings` wiring.',
	prerequisites: [],
	runtime: {
		entities: [],
		pages: [],
	},
	artifacts: [
		prd(
			'DI',
			'# Dependency injection\n\nLibraries declare a typed bindings contract; ' +
				'the app injects concrete values at the composition root; consumers read ' +
				'them via `useBindings()`, failing loud on a missing required binding.',
		),
	],
	ownership: { tables: [], routes: [] },
	uninstall: {
		supported: false,
		reason:
			'The bindings contract is how every other bundle reaches the composition ' +
			'root. Removing it is removing the seam, not a feature — eject the app ' +
			'instead if you want different wiring.',
	},
	evalAsks: [
		{
			id: 'ask-di-swap-mailer',
			ask: 'Swap the console mailer for a real transport in exactly one place.',
			source: 'dogfood',
			sourceRef:
				'apps/web/app/sprout.server.ts composition-root work — the binding swap ' +
				'is the change every dogfood project made first.',
		},
	],
}

const membersBundle: Bundle = {
	slug: 'members',
	// 0.2.0: the organization FKs are declared relations rather than
	// bare strings, so the platform can resolve, traverse and roll up through
	// them. The 0.1.0 → 0.2.0 codemod declares them on an installed spec.
	version: '0.2.0',
	initialVersion: VERSION,
	userFacing: true,
	title: 'Organizations & members',
	description:
		'Multi-tenant org model: organizations, members (with roles), and ' +
		'invitations, plus an organizations admin page. Members reference auth’s ' +
		'`user`, so it depends on the auth bundle.',
	prerequisites: ['auth'],
	runtime: {
		entities: [
			{
				key: 'organization',
				name: 'Organization',
				description: 'A tenant grouping members.',
				fields: [
					{ name: 'name', type: 'string', required: true },
					{ name: 'slug', type: 'string' },
					{ name: 'logo', type: 'string' },
					// The owned team/onboarding route-writes (and the `MemberService`)
					// read these back, so from-spec must materialize them as columns.
					{ name: 'createdAt', type: 'date' },
					{ name: 'updatedAt', type: 'date' },
				],
			},
			{
				key: 'member',
				name: 'Member',
				description: 'A user’s membership in an organization, with a role.',
				fields: [
					// Declared in 0.2.0. The target is a spec entity, so the
					// emitted column is `uuid` where a 0.1.0 install has `text`; the
					// migration reconciles that behind a guard and fails loudly on a
					// value that is not an id (`specSchemaDdl`). An installed project's
					// *spec* is migrated by the 0.1.0 → 0.2.0 codemod.
					{
						name: 'organizationId',
						type: 'string',
						required: true,
						reference: 'e-organization',
					},
					// `member.userId` is a better-auth user id (text) — free to declare,
					// same as `audit_log.userId`: the column stays `text` either way.
					{
						name: 'userId',
						type: 'string',
						required: true,
						reference: USER_ENTITY_ID,
					},
					{ name: 'role', type: 'string', required: true },
					{ name: 'createdAt', type: 'date' },
					{ name: 'updatedAt', type: 'date' },
				],
			},
			{
				key: 'invitation',
				name: 'Invitation',
				description: 'A pending invite to join an organization.',
				fields: [
					// Declared in 0.2.0 alongside `member.organizationId` — see there.
					{
						name: 'organizationId',
						type: 'string',
						required: true,
						reference: 'e-organization',
					},
					{ name: 'email', type: 'string', required: true },
					{ name: 'role', type: 'string', required: true },
					{ name: 'status', type: 'string', required: true },
					// Text-id target: free to declare (see `audit_log.userId`).
					{
						name: 'inviterId',
						type: 'string',
						required: true,
						reference: USER_ENTITY_ID,
					},
					{ name: 'expiresAt', type: 'date', required: true },
					{ name: 'createdAt', type: 'date' },
					{ name: 'updatedAt', type: 'date' },
				],
			},
		],
		pages: [
			{
				key: 'organizations',
				name: 'Organizations',
				route: '/organizations',
				entityKey: 'organization',
				blocks: ['table', 'form'],
				priority: 'high',
				e2eTests: [
					'an admin can create an organization and see it in the list',
					'an admin can edit an organization’s name',
				],
			},
		],
		seeds: [
			{
				entityKey: 'organization',
				rows: [{ name: 'Acme Inc', slug: 'acme' }],
			},
		],
		diBindings: ['memberService', 'auditSink'],
	},
	artifacts: [
		prd(
			'Members',
			'# Organizations & members\n\nOrganizations own members (owner/admin/member ' +
				'roles) and invitations. The `MemberService` enforces the last-owner ' +
				'invariant and records mutations through the audit sink.',
		),
	],
	ownership: {
		tables: ['organization', 'member', 'invitation'],
		routes: ['/organizations'],
	},
	uninstall: {
		supported: false,
		reason:
			'Tenancy is referenced by everything scoped to an organization once it is ' +
			'installed, and the spec vocabulary has no remove-entity op, so an ' +
			'uninstall could not unwind the schema it contributed. Tracked for the ' +
			'catalog-wide uninstall story.',
	},
	evalAsks: [
		{
			id: 'ask-members-org-member-count',
			ask: 'Show each organization’s member count on the organizations table.',
			source: 'real-product',
			sourceRef:
				'GitHub’s organization list and Linear’s workspace switcher both show a ' +
				'member count next to the org name.',
		},
		{
			id: 'ask-members-invite-expiry',
			ask: 'Expire invitations after seven days and mark the stale ones in the list.',
			source: 'real-product',
			sourceRef:
				'Slack workspace invites expire; better-auth’s organization plugin ' +
				'carries `invitation.expiresAt` for exactly this.',
		},
	],
}

const billingBundle: Bundle = {
	slug: 'billing',
	version: '0.4.0',
	initialVersion: '0.1.0',
	userFacing: true,
	title: 'Billing & entitlements',
	description:
		'Stripe-hosted subscriptions (buy — decision d-billing-buy) plus the ' +
		'`hasEntitlement` primitive and usage metering. Contributes the `subscription` ' +
		'mirror table (kept in sync from Stripe webhooks) and a `usage_event` ledger ' +
		'(the source metered quota checks read), with subscriptions + usage admin ' +
		'pages; exposes `billing` (the hosted-checkout provider), `entitlements`, and ' +
		'`metering` bindings. Subjects are auth users, so it depends on the auth bundle.',
	prerequisites: ['auth'],
	runtime: {
		entities: [
			{
				key: 'subscription',
				name: 'Subscription',
				description:
					'A subject’s Stripe subscription mirror — the source `hasEntitlement` ' +
					'reads. One active row per subject (Stripe’s model).',
				fields: [
					// "Whatever the app treats as the billing subject" — a user id in a
					// per-seat product, an organization id in a per-workspace one (see
					// `billing/entitlements.ts`). `reference` names exactly one target,
					// so this shipped as a bare string with the loss recorded as a
					// "cannot": no reference rendering, no edge in the relation
					// graph, no `via` for a rollup, on the two tables where billing
					// questions actually get asked.
					//
					// It is now declared **open**: the catalog names the
					// candidates and the project says which one it means, with
					// `data.setFieldReference`. That matches where the ambiguity lives —
					// a catalog cannot know and an app always does — and costs an
					// existing install nothing, because an un-narrowed open reference
					// emits the same `text` column a bare string does.
					{
						name: 'subject',
						type: 'string',
						required: true,
						openReference: ['e-organization', 'e-user'],
					},
					{ name: 'plan', type: 'string', required: true },
					{ name: 'status', type: 'string', required: true },
					{ name: 'stripeCustomerId', type: 'string' },
					{ name: 'stripeSubscriptionId', type: 'string' },
					// Added in 0.2.0 — a 0.1.0 install is migrated by the upgrade codemod.
					{ name: 'currentPeriodEnd', type: 'date' },
					// The owned billing route-writes read these back, so from-spec must
					// materialize them (matches `billing.server.ts`'s `subscription`).
					{ name: 'createdAt', type: 'date' },
					{ name: 'updatedAt', type: 'date' },
				],
			},
			{
				// Added in 0.3.0 — the metered-billing ledger a quota check totals over.
				// A 0.1.0/0.2.0 install materializes it via the upgrade codemod.
				key: 'usage_event',
				name: 'Usage event',
				description:
					'One recorded consumption of a metered dimension by a subject — the ' +
					'ledger `MeterService` totals to compare usage against a plan’s allowance.',
				fields: [
					// Open over the same two candidates as `subscription.subject` — see
					// there. Both columns name the same thing, so a project that narrows
					// one and not the other has a ledger it cannot join to its own
					// subscriptions.
					{
						name: 'subject',
						type: 'string',
						required: true,
						openReference: ['e-organization', 'e-user'],
					},
					{ name: 'meter', type: 'string', required: true },
					{ name: 'quantity', type: 'number', required: true },
					{ name: 'at', type: 'date', required: true },
				],
			},
		],
		pages: [
			{
				key: 'subscriptions',
				name: 'Subscriptions',
				route: '/subscriptions',
				entityKey: 'subscription',
				blocks: ['table'],
				priority: 'medium',
				e2eTests: ['an admin can see every subject’s active plan and status'],
			},
			{
				key: 'usage',
				name: 'Usage',
				route: '/usage',
				entityKey: 'usage_event',
				blocks: ['table'],
				priority: 'low',
				e2eTests: ['an admin can audit recorded usage per subject and meter'],
			},
		],
		diBindings: ['billing', 'entitlements', 'metering'],
	},
	artifacts: [
		prd(
			'Billing',
			'# Billing & entitlements\n\nStripe owns checkout, the customer portal, ' +
				'invoices, and dunning (buy). The platform owns `hasEntitlement`: a plan ' +
				'grants capability keys, a `subscription` mirror (synced from webhooks) says ' +
				'which plan a subject is on, and the check gates features. Bundles mark ' +
				'themselves gated with `entitlement: <key>`.',
		),
	],
	ownership: {
		tables: ['subscription', 'usage_event'],
		routes: ['/subscriptions', '/usage'],
	},
	uninstall: {
		supported: false,
		reason:
			'The `subscription` mirror is the source `hasEntitlement` reads, and the ' +
			'`usage_event` ledger is a financial record. Deleting either from a live ' +
			'app silently un-gates paid features and destroys billing history; the ' +
			'safe removal is to stop syncing from Stripe, which is a wiring change.',
	},
	evalAsks: [
		{
			id: 'ask-billing-usage-vs-allowance',
			ask: 'Show this month’s usage per subject against the plan’s allowance.',
			source: 'real-product',
			sourceRef:
				'Stripe Billing meters: the usage-vs-included-quantity view is the ' +
				'default screen for a metered plan.',
		},
		{
			id: 'ask-billing-past-due-banner',
			ask: 'Warn a user in-app while their subscription is past_due.',
			source: 'real-product',
			sourceRef:
				'Stripe smart-retries dunning; Vercel and Linear both surface an in-app ' +
				'payment-failed banner rather than only emailing.',
		},
	],
}

const adminBundle: Bundle = {
	slug: 'admin',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Admin metrics',
	description:
		'The admin metrics dashboard — user/system aggregations and registration ' +
		'trends over the auth and audit tables. Exposes the `metrics` binding. ' +
		'Gated by the `analytics` entitlement: the dashboard activates at runtime ' +
		'only for subjects whose plan grants it (see the billing bundle).',
	prerequisites: ['auth', 'audit'],
	entitlement: 'analytics',
	runtime: {
		entities: [],
		pages: [],
		diBindings: ['metrics'],
	},
	artifacts: [
		prd(
			'Admin metrics',
			'# Admin metrics\n\nCount/trend aggregations (total/new-this-week/month, ' +
				'active-today, registration trends by day) over `user` + `audit_log`, ' +
				'rendered on a `/metrics` dashboard. Requires auth + audit.',
		),
	],
	ownership: { tables: [], routes: [] },
	uninstall: {
		supported: true,
		notes:
			'Read-only aggregations over tables other bundles own: removing the ' +
			'install record and the `metrics` binding removes the dashboard and ' +
			'nothing else. No data is lost.',
	},
	evalAsks: [
		{
			id: 'ask-admin-signups-per-day',
			ask: 'Chart registrations per day for the last thirty days on the dashboard.',
			source: 'real-product',
			sourceRef:
				'Plausible and PostHog both lead their default dashboard with a ' +
				'30-day daily-count chart.',
		},
	],
}

/** The catalog, keyed by slug. */
const storageBundle: Bundle = {
	slug: 'storage',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'File storage',
	description:
		'Declared `file` fields on entities — a MIME allowlist and a size cap per ' +
		'field, uploads through the validated write path, and viewer-bound expiring ' +
		'reads. Local disk in dev and S3-compatible in deploy, at tested parity. ' +
		'Image derivatives (thumbnails) are declared in the spec.',
	prerequisites: [],
	runtime: {
		entities: [
			{
				key: 'file_object',
				name: 'File object',
				description:
					'One row per stored blob: what it is, who uploaded it, which field ' +
					'it was for, and which derivatives exist. The read gateway answers ' +
					'with the content type recorded here (validated at upload), and the ' +
					'orphan report is computed against it.',
				fields: [
					// The storage key of the original. A uuid plus an extension derived
					// from the validated content type — never from the uploaded filename.
					{ name: 'key', type: 'string', required: true },
					{ name: 'contentType', type: 'string', required: true },
					{ name: 'size', type: 'number', required: true },
					// Display only. Deliberately separate from `key` so nothing is ever
					// tempted to build a path out of it.
					{ name: 'originalName', type: 'string', required: true },
					{ name: 'uploadedBy', type: 'string' },
					{ name: 'resource', type: 'string' },
					{ name: 'field', type: 'string' },
					// The variants that were actually materialized — a derivative that
					// failed is absent, so a read surface renders what exists rather
					// than what was hoped for.
					{ name: 'derivatives', type: 'json' },
					{ name: 'createdAt', type: 'date', required: true },
				],
			},
		],
		// No pages: `file_object` is infrastructure metadata, not a CRUD surface
		// someone browses. The two routes it owns are the upload endpoint and the
		// read gateway, both owned code in the app template.
		pages: [],
		diBindings: ['storage', 'imageTransformer'],
	},
	artifacts: [
		prd(
			'Storage',
			'# File storage\n\nA `file` field declares its MIME allowlist, its size ' +
				'cap, and any image derivatives; the column stores a storage key, not a ' +
				'URL. `POST /api/upload` re-validates against the field’s declaration ' +
				'server-side, mints a key from the validated content type, materializes ' +
				'declared derivatives, and records a `file_object` row. `GET /files/:key` ' +
				'is the read gateway for every driver: it verifies a viewer-bound, ' +
				'expiring token before streaming bytes, so a copied link does not work ' +
				'for anyone else and a guessed key does not work at all.',
		),
	],
	ownership: {
		tables: ['file_object'],
		routes: [],
		// Owned code in the app template, not generated pages — see
		// `BundleOwnership.ownedRoutes`.
		ownedRoutes: ['/api/upload', '/files/:key'],
	},
	uninstall: {
		supported: false,
		reason:
			'Uninstalling would orphan the bytes: every `file` field in the project ' +
			'stores a key this bundle’s registry is the only record of, and the spec ' +
			'vocabulary has no remove-entity op to unwind either the registry or the ' +
			'fields that point into it. Deleting the objects instead is exactly the ' +
			'automatic mass delete this feature refuses to offer — see the orphan ' +
			'report in `storage/objects.ts`, which is a report on purpose.',
	},
	evalAsks: [
		{
			id: 'ask-storage-avatar-thumbnail',
			ask: 'Let people upload a profile photo and show a 64px thumbnail in the members list.',
			source: 'real-product',
			sourceRef:
				'GitHub, Linear and Slack all store one avatar upload and render several ' +
				'sizes of it; none of them resize in the browser at render time.',
		},
		{
			id: 'ask-storage-private-attachments',
			ask: 'Attach a PDF to an invoice that only that invoice’s owner can download.',
			source: 'real-product',
			sourceRef:
				'Stripe invoice PDFs and Xero attachments are both fetched through a ' +
				'signed, expiring link rather than a public bucket URL.',
		},
	],
}

const jobsBundle: Bundle = {
	slug: 'jobs',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Scheduled work',
	description:
		'Declared recurrence — a named schedule with an IANA timezone, a defined ' +
		'answer for "monthly on the 31st", and an identity every run carries — over ' +
		'a durable job runtime with retries, a dead-letter view and run history. ' +
		'Delivery is at-least-once and the handler is handed the idempotency key ' +
		'that makes a repeat a no-op. Domain logic lives in a generated handler ' +
		'slot the platform never overwrites, so "reorder the queue by an SM-2 grade" ' +
		'is code you own rather than an operator we invented.',
	// Auth, because the gating clause is that a scheduled run carries somebody's
	// authority: `runAs: {kind: "user"}` names a user and `{kind: "service"}` is
	// resolved through the same role/entitlement path a session is. A scheduler
	// with nobody to run as is the implicit-admin bug this bundle exists to avoid.
	prerequisites: ['auth'],
	runtime: {
		// No spec entities. A job row is a record of something the platform
		// decided to do, not a resource anyone edits — an admin CRUD surface over
		// it would offer "create a job", which is a run with no schedule, no
		// identity and no idempotency key, plus a REST endpoint for enqueuing
		// arbitrary work.
		entities: [],
		pages: [],
		ddl: JOBS_DDL,
		diBindings: ['jobQueue', 'scheduler'],
	},
	artifacts: [
		prd(
			'Scheduled work',
			'# Scheduled work\n\nA schedule is a *declaration*: a key, a recurrence, ' +
				'the IANA timezone the recurrence is read in, and the identity its runs ' +
				'carry. It is deliberately not a cron string — `0 0 31 * *` silently ' +
				'skips four months a year and cannot express a timezone at all, which ' +
				'is exactly where scheduling bugs live. Every awkward calendar case has ' +
				'a written answer and a test: day 31 clamps to month end, a local time ' +
				'that does not exist (spring forward) fires at the next instant that ' +
				'does, and a local time that happens twice fires once.\n\n' +
				'**A run runs as somebody.** `runAs` is required with no default and ' +
				'no admin shorthand, because scheduled work is the classic place ' +
				'implicit admin creeps in: a job that quietly holds more authority than ' +
				'any human caller is an authorization bypass with a cron expression in ' +
				'front of it.\n\n' +
				'**Delivery is at-least-once, and we say so.** Exactly-once is a lie in ' +
				'a job system — between "the handler did the work" and "the store ' +
				'recorded that it did" there is a window, and a process that dies ' +
				'inside it leaves a row indistinguishable from one that never ran. What ' +
				'the platform owes you instead is a stable idempotency key, enforced by ' +
				'a unique index rather than an application check: one job per ' +
				'occurrence, across restarts and across processes, with no lock table ' +
				'and no leader election.\n\n' +
				'**Failures are visible.** Retries back off; a permanent failure (an ' +
				'unfilled handler slot, a run with no identity) skips the budget and ' +
				'dead-letters at once; catch-up after an outage is bounded and the ' +
				'dropped occurrences are *reported*, because a missed run you can see ' +
				'is an operational fact and a missed run you cannot is a mystery.\n\n' +
				'**Domain logic is yours.** Each declared schedule generates a ' +
				'user-owned `jobs/<key>.handler.ts` the scheduler calls with a typed ' +
				'context. Regeneration rewrites the registry beside it and never the ' +
				'handler, so bespoke scheduling logic is as safe as an ejected file ' +
				'without paying the eject tax.',
		),
	],
	ownership: {
		tables: ['job'],
		routes: [],
		// Owned code in the app template — the run history, the schedule list and
		// the dead-letter view. See the note on `runtime.entities`.
		ownedRoutes: ['/jobs'],
	},
	uninstall: {
		supported: false,
		reason:
			'The `job` table is the run history and, through `idempotency_key`, the ' +
			'record of which occurrences have already been claimed. Dropping it ' +
			'un-claims every one of them at once, so the next tick re-runs whatever ' +
			'the catch-up window still reaches — the exact duplicate-delivery failure ' +
			'the key exists to prevent. The op vocabulary has no drop-table op, and ' +
			'the operation people actually want is "stop this job", which is ' +
			'`schedules.pause`: reversible, per-schedule, and it keeps the history ' +
			'you need in order to turn it back on.',
	},
	evalAsks: [
		{
			id: 'ask-jobs-monthly-invoice-run',
			ask: 'Issue the recurring invoices on the last day of every month, in the customer’s timezone — and not twice if the worker restarts.',
			source: 'external-corpus',
			sourceRef:
				'The `invoicer` benchmark’s frozen `ch-recurring-invoices` ask, which ' +
				'stood as off-surface/unexpressible from the 2026-07-26 corpus freeze ' +
				'until this bundle absorbed it.',
		},
		{
			id: 'ask-jobs-retry-storm-visible',
			ask: 'Our nightly export has been failing silently for a week — I want to see what died, why, and retry just those.',
			source: 'real-product',
			sourceRef:
				'Sidekiq’s Dead set and Oban’s "discarded" state both exist for exactly ' +
				'this: a retry budget that ends somewhere a human can see, with a ' +
				'per-job retry action rather than a re-run of everything.',
		},
	],
}

const webhooksBundle: Bundle = {
	slug: 'webhooks',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Webhooks',
	description:
		'Signed outbound delivery and verified inbound receivers, both directions ' +
		'over one signature scheme. Outbound: declared events delivered to ' +
		'subscriber endpoints, signed with a timestamp and a nonce, retried with ' +
		'backoff, with a delivery log — over URLs validated against every internal ' +
		'address range at subscribe time and again before each attempt. Payloads are ' +
		'scoped by a default-deny field projection, so adding a column to an ' +
		'entity cannot widen what an existing subscriber receives. Inbound: ' +
		'declared receivers whose signature check is unskippable by construction, ' +
		'with replay protection and a uniform 401 that tells an attacker nothing.',
	// Audit, because #185 requires delivery attempts to be audit-log entries with
	// real provenance and there is no second place to put them. Auth, because the
	// subscription is user-owned for management purposes (who may view, edit and
	// revoke it) — delivery itself is app-wide.
	prerequisites: ['auth', 'audit'],
	runtime: {
		// No spec entities. A subscription holds a live signing secret and a
		// delivery row is a record of something already sent; an admin CRUD
		// surface over either would put the secret in a list view and offer
		// "create a delivery", which is an unsigned POST to an arbitrary URL with
		// a form in front of it.
		entities: [],
		pages: [],
		ddl: WEBHOOKS_DDL,
		diBindings: ['webhookService', 'webhookReceivers'],
	},
	artifacts: [
		prd(
			'Webhooks',
			'# Webhooks\n\n## Outbound is an SSRF surface\n\nAn outbound webhook ' +
				'is a feature whose entire job is "let a user make this server issue an ' +
				'HTTP request to a URL the user chose". So the URL is validated before ' +
				'it is stored **and** before every delivery — the second check is the ' +
				'DNS-rebinding case, where a hostname that resolved to a public address ' +
				'at subscribe time resolves to the cloud metadata endpoint an hour ' +
				'later. Refused: any scheme but https, embedded credentials, any port ' +
				'that is not a web server, every private and link-local range, the ' +
				'decimal/octal/hex spellings of them, IPv4-mapped IPv6, and any name ' +
				'that *resolves* into one. Redirects are never followed: a 302 to an ' +
				'internal address is the cheapest way around all of it.\n\n' +
				'## Outbound is a data-exfiltration surface\n\nA subscription is a ' +
				'standing instruction to send this app’s data to a URL somebody else ' +
				'controls, and nobody re-reviews a webhook they set up a year ago. So a ' +
				'subscription declares which fields it receives and the projection is ' +
				'**default-deny**: adding a column to an entity cannot widen an ' +
				'existing subscription, and a field with a secret-shaped name cannot be ' +
				'projected at all.\n\n' +
				'## Inbound is an unauthenticated write path\n\nNo session, no api ' +
				'key, no human — a POST from the public internet the app is expected to ' +
				'trust. The design constraint is not "make verification easy" but ' +
				'"make skipping it impossible to express": there is no `verify: false`, ' +
				'no optional secret, and a short secret is refused at declaration time, ' +
				'before anything is listening. Replay protection is a signed timestamp ' +
				'and a nonce — a signature over the body alone is replayable forever. ' +
				'The signature is checked *before* the nonce is burned, so an ' +
				'unauthenticated caller cannot pre-burn the nonce a genuine delivery ' +
				'will use.\n\n' +
				'## Every failure looks the same\n\nBad signature, unknown receiver, ' +
				'stale timestamp and replay all return a bare 401 with no body. A ' +
				'receiver that distinguishes them is an oracle. The reason is recorded ' +
				'in the audit log, where it is diagnosis rather than assistance.',
		),
	],
	ownership: {
		tables: ['webhook_subscription', 'webhook_delivery'],
		routes: [],
		// Owned code in the app template. `/api/webhooks/:receiver` is reachable
		// without a session on purpose — that is what an inbound webhook is — which
		// is exactly why the registry in front of it cannot be told not to verify.
		ownedRoutes: ['/webhooks', '/api/webhooks/:receiver'],
	},
	uninstall: {
		supported: false,
		reason:
			'The subscription table holds live signing secrets that third-party ' +
			'systems are configured against; dropping it silently stops every ' +
			'integration that depends on this app, with no signal on either side. ' +
			'The delivery log is also the evidence of what was sent to whom, which ' +
			'is the record a data-protection question is answered from. The op ' +
			'vocabulary has no drop-table op. The operation people want is "stop ' +
			'this subscription", which is `unsubscribe` — per-subscription, ' +
			'reversible by re-subscribing, and it keeps the log.',
	},
	evalAsks: [
		{
			id: 'ask-webhooks-signed-outbound',
			ask: 'Notify our Zapier endpoint whenever an invoice is paid, and let us verify the request really came from you.',
			source: 'real-product',
			sourceRef:
				'Stripe, GitHub and Shopify all ship the same scheme: a shared secret, ' +
				'an HMAC over a signed payload that includes a timestamp, and a ' +
				'documented verification snippet — because a subscriber who cannot ' +
				'verify has to trust the source IP.',
		},
		{
			id: 'ask-webhooks-provider-callback',
			ask: 'Mark the subscription active when the payment provider calls us back — without opening a write endpoint anyone can POST to.',
			source: 'issue-report',
			sourceRef:
				'the gating clause ("inbound webhooks are an unauthenticated ' +
				'write path"), and the concrete need in the `billing` bundle, whose ' +
				'provider callbacks have no other way in.',
		},
	],
}

const observabilityBundle: Bundle = {
	slug: 'observability',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Observability',
	description:
		'Structured request logs with a correlating request id, error capture ' +
		'with a pluggable reporter, in-process rate limiting, and health / ' +
		'readiness endpoints wired to the runtime by default. Every log line and ' +
		'every captured error is redacted **by default** — declared-sensitive ' +
		'fields first, an over-eager name backstop under them, and query strings ' +
		'stripped entirely, because a password-reset link is a credential shaped ' +
		'like a path. The health endpoint answers reachable / not reachable and ' +
		'tells an unauthenticated caller nothing about internal topology.',
	// No prerequisites. Observability that only works once you have installed
	// auth is observability that is absent exactly when a bare app is falling
	// over, which is the first thing anyone needs it for.
	prerequisites: [],
	runtime: {
		// Request-path infrastructure: no tables, no pages. The log line goes to
		// stdout, where the deployment's pipeline picks it up; storing it would be
		// building a log database nobody asked for, in the app whose failures it
		// is supposed to survive.
		entities: [],
		pages: [],
		diBindings: ['errorReporter', 'rateLimiter'],
	},
	artifacts: [
		prd(
			'Observability',
			'# Observability\n\nOne structured JSON line per request — request id, ' +
				'method, redacted path, status, duration, and the api key when one was ' +
				'used, so a spike traces to a credential rather than only to the ' +
				'account that holds it.\n\n' +
				'**Redaction is not opt-in.** Every line and every captured error goes ' +
				'through `redact` before it is written, so the failure mode is a ' +
				'redacted field somebody wanted rather than a leaked one nobody ' +
				'noticed. The primary rule is declared sensitivity; underneath it sits ' +
				'a deliberately over-eager name backstop, because a redacted ' +
				'`tokenCount` is a worse log line and a logged `accessToken` is an ' +
				'incident. Redaction walks nested objects, arrays and an error’s ' +
				'`cause` chain, survives a circular reference, and bounds depth — a ' +
				'logger that can be crashed by the thing it is logging turns an error ' +
				'into an outage.\n\n' +
				'**Health endpoints answer a question, not a survey.** `/health` pings ' +
				'the store and returns reachable / not reachable with a duration. The ' +
				'failure detail goes to the error reporter, where an operator sees it; ' +
				'it is absent from the response, where a stranger would.',
		),
	],
	ownership: {
		tables: [],
		routes: [],
		ownedRoutes: ['/health'],
	},
	uninstall: {
		supported: true,
		notes:
			'Contributes no schema and no data. Removing the install record and the ' +
			'`errorReporter` / `rateLimiter` bindings is the whole uninstall — but ' +
			'note what goes with them: the rate limiter is a real control, not only ' +
			'a diagnostic, so removing this bundle removes a defense as well as a ' +
			'signal.',
	},
	evalAsks: [
		{
			id: 'ask-observability-trace-one-request',
			ask: 'A customer says the app was slow at 14:20 — I want to find that exact request and see what it did.',
			source: 'real-product',
			sourceRef:
				'The request-id-per-request pattern every hosted platform ships (Heroku ' +
				'`X-Request-Id`, Cloudflare `cf-ray`, Vercel `x-vercel-id`) exists ' +
				'because correlating by timestamp alone stops working at any real ' +
				'traffic level.',
		},
		{
			id: 'ask-observability-no-pii-in-logs',
			ask: 'Our logs are shipped to a third-party vendor — make sure a password-reset link can never end up in one.',
			source: 'issue-report',
			sourceRef:
				'the gating clause ("observability must not leak PII into logs ' +
				'or traces by default"), and the concrete shape it takes here: signed ' +
				'file URLs and unsubscribe links are both credentials carried in a ' +
				'query string that a naive request log writes out verbatim.',
		},
	],
}

const complianceBundle: Bundle = {
	slug: 'compliance',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Data compliance',
	description:
		'Export-my-data and delete-my-data **derived from the relation graph**, ' +
		'not hand-listed: a row two relation hops from the subject with no owner ' +
		'column of its own is still theirs, and the flow finds it. Every table ' +
		'carries a declared retention class, and an unclassified one makes both ' +
		'flows refuse to run rather than quietly skip it. Deletion goes in ' +
		'foreign-key order; a table on legal hold is pseudonymized rather than ' +
		'deleted. Versioned terms and cookie consent are recorded ' +
		'append-only, and a retention purge job clears soft-deleted rows.',
	// Auth for the subject identity every flow is scoped to; audit because
	// #188's hardest question is what an erasure does to an append-only trail,
	// and answering it requires the trail to exist.
	prerequisites: ['auth', 'audit'],
	runtime: {
		// `consent` is materialized as raw DDL rather than a spec entity: an admin
		// CRUD surface over consent records would offer "create a consent", which
		// is a signed statement about what somebody agreed to, written by somebody
		// else.
		entities: [],
		pages: [],
		ddl: CONSENT_DDL,
		diBindings: ['consentService', 'retentionPolicies'],
	},
	artifacts: [
		prd(
			'Data compliance',
			'# Data compliance\n\n**A compliance flow that is wrong is worse than ' +
				'absent.** A delete-my-data flow that misses a related table is a legal ' +
				'exposure the subject believes is handled — so both flows are derived ' +
				'from the relation graph rather than from a list somebody maintains. ' +
				'Seed with the directly-owned rows, then pull in anything whose foreign ' +
				'key points at something already collected, to a fixed point. A comment ' +
				'on the subject’s post has no `userId` and is still theirs.\n\n' +
				'**Silence is the dangerous outcome, so there is none.** Every ' +
				'registered table must declare a retention class: `personal` ' +
				'(exported, erased), `operational` (neither — and it must say *why* it ' +
				'holds no personal data), or `legal-hold` (exported, retained — and it ' +
				'must name the obligation and the columns to pseudonymize). An ' +
				'unclassified table makes both flows throw, naming it, before a single ' +
				'row is read.\n\n' +
				'**Deletion respects the graph it was derived from.** Children before ' +
				'parents, so a delete cannot fail on a constraint and leave the erasure ' +
				'half-applied; a genuine foreign-key cycle is deleted last and named in ' +
				'the report rather than silently attempted. Erasure always ' +
				'hard-deletes, even for a soft-delete resource: a right-to-erasure ' +
				'request is not a moderation action and must not wait out a retention ' +
				'window.\n\n' +
				'**The append-only conflict has a recorded answer, not an improvised ' +
				'one.** a `legal-hold` table keeps its rows and has its ' +
				'declared subject-identifier columns overwritten with a tombstone, so ' +
				'the trail still says somebody did this — which is what makes it useful ' +
				'— and no longer says who.',
		),
	],
	ownership: {
		tables: ['consent'],
		routes: [],
		ownedRoutes: ['/settings/export-data', '/settings/consent'],
	},
	uninstall: {
		supported: false,
		reason:
			'The consent table is the record of what each person agreed to and when ' +
			'— the lawful basis for processing that already happened. Dropping it ' +
			'does not undo the processing, it deletes the proof that it was ' +
			'permitted. Removing the bundle would also remove the export and ' +
			'erasure surfaces while the obligation to honor those requests ' +
			'continues, which is a worse position than never having offered them: ' +
			'the flows were advertised and are now silently absent.',
	},
	evalAsks: [
		{
			id: 'ask-compliance-delete-everything',
			ask: 'A user asked us to delete their account and everything attached to it — including the comments they left on other people’s posts.',
			source: 'real-product',
			sourceRef:
				'The GDPR Article 17 request every consumer product receives, and the ' +
				'specific shape that breaks a naive implementation: the comment rows ' +
				'carry a `postId`, not a `userId`, so an owner-column sweep misses ' +
				'them and reports success.',
		},
		{
			id: 'ask-compliance-audit-vs-erasure',
			ask: 'Legal says the audit log has to survive a deletion request. Both things cannot be true — which is it?',
			source: 'issue-report',
			sourceRef:
				'the gating clause ("the audit log is append-only *by design* — ' +
				'the interaction with a deletion request needs a recorded decision, ' +
				'not an improvised one").',
		},
	],
}

const apiKeysBundle: Bundle = {
	slug: 'api-keys',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'API keys',
	description:
		'Programmatic access to the derived REST API and MCP endpoint: keys ' +
		'scoped per resource and action, hashed at rest and shown exactly once, ' +
		'rotatable and revocable immediately, with a per-key request budget and ' +
		'its own line in the audit log. A key can never do more than the person ' +
		'who issued it.',
	// A key belongs to a user, its scope is intersected with that user's role,
	// and revoking the user has to revoke their keys. None of that has a meaning
	// without an identity table, so the dependency is real rather than defensive.
	prerequisites: ['auth'],
	runtime: {
		// `api_key` is a text-id table this feature manages directly — the same
		// shape as better-auth's tables, and for the same reason: the rows are
		// credentials, not a CRUD resource. Contributing it as a spec entity would
		// derive an admin list over the token hashes and a REST surface a key could
		// point at *itself* to widen its own scope.
		entities: [],
		pages: [],
		// Both credential tables travel together: a portal token is a
		// scoped, expiring, revocable credential, which is exactly what this bundle
		// models. Adding a 17th bundle for it would have doubled issue #194's
		// combination lattice for no capability the catalog did not already have.
		ddl: `${API_KEYS_DDL}\n${PORTAL_TOKENS_DDL}`,
		diBindings: ['apiKeyService'],
	},
	artifacts: [
		prd(
			'API keys',
			'# API keys\n\nA key is issued against a user, scoped to a set of ' +
				'resource + action pairs, and optionally pinned to one organization ' +
				'with its own per-minute budget. Only a SHA-256 hash is stored; the ' +
				'plaintext is displayed once at issue or rotation and is not ' +
				'recoverable afterwards.\n\nThe scope is enforced in the permission ' +
				'layer, not at the route: `authorize()` intersects the key’s scope ' +
				'with the holder’s own access rules, so every surface that reaches ' +
				'the ops layer — REST, MCP, admin loaders — is gated by the same ' +
				'check, and a key is structurally incapable of exceeding its holder. ' +
				'Unlike everything else in the permission layer, a key is *closed* by ' +
				'default: a resource the scope does not name is denied even when that ' +
				'resource has no access rule at all.',
		),
	],
	ownership: {
		// Two credential tables, both text-id and both managed directly. A portal
		// token is a scoped, expiring, revocable credential, which is
		// exactly what this bundle already models — and the catalog is at its
		// 16-bundle cap, so a 17th bundle for it would have doubled the
		// combination lattice for no capability the catalog did not already have.
		// It is a SEPARATE table rather than nullable columns on `api_key` because
		// the permission layer reads an absent scope as "unrestricted session".
		tables: ['api_key', 'portal_token'],
		routes: [],
		// The management page is owned code in the app template, not a generated
		// CRUD page — see the note on `runtime.entities` above. Portals are reached
		// at `/p/:key`, which is a spec-derived route rather than a bundle one.
		ownedRoutes: ['/api-keys'],
	},
	uninstall: {
		supported: false,
		reason:
			'Uninstalling would leave a table of live credentials behind that nothing ' +
			'in the project manages any more — the op vocabulary has no drop-table op, ' +
			'and removing the management page while the bearer-token path stays ' +
			'mounted is the worst of both. The operation people actually want is ' +
			'"stop all programmatic access", which is revoking every key: that is ' +
			'reversible, visible in the audit log, and already supported.',
	},
	evalAsks: [
		{
			id: 'ask-api-keys-read-only-integration',
			ask: 'Give our data team a key that can read orders and nothing else, and show me when it was last used.',
			source: 'real-product',
			sourceRef:
				'Stripe restricted keys and GitHub fine-grained PATs both scope per ' +
				'resource with read/write granularity and surface a last-used ' +
				'timestamp in the key list.',
		},
		{
			id: 'ask-api-keys-rotate-on-leak',
			ask: 'A key got committed to a public repo — rotate it and make sure the old one stops working right away.',
			source: 'real-product',
			sourceRef:
				'GitHub secret scanning’s documented remediation is rotate-then-revoke; ' +
				'Stripe’s dashboard offers "roll key" with an immediate-expiry option ' +
				'for exactly this incident.',
		},
	],
}

const flagsBundle: Bundle = {
	slug: 'flags',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Feature flags',
	description:
		'Declared feature flags with server-side targeting by role, organization, ' +
		'or a stable percentage rollout. The declaration lives in the spec, so a ' +
		'flagged page or block is visible in the workbench instead of buried in ' +
		'code — and generation never reads a flag’s value, so a gated surface ' +
		'cannot break determinism. Flag age, last use, and what each flag still ' +
		'gates are reported, and removal is a first-class op.',
	// Targeting names roles and organizations. Roles come from the identity
	// layer; without it "on for admins" has nothing to match against.
	prerequisites: ['auth'],
	runtime: {
		// No spec entities: a flag's declaration IS spec data
		// (`SpecSystem.flags`), contributed by the `flags.declare` op rather than
		// by a table. The only table is telemetry — how often each flag is
		// evaluated — which is deliberately not a CRUD resource: editing a usage
		// counter is meaningless, and deriving an admin surface over it would
		// invite someone to treat it as the flag's value.
		entities: [],
		pages: [],
		ddl: FLAGS_DDL,
		diBindings: ['flagService'],
	},
	artifacts: [
		prd(
			'Feature flags',
			'# Feature flags\n\nA flag is declared in the spec: a key, a default, ' +
				'and optional targeting by role, organization, or percentage. Pages ' +
				'and blocks are gated on a flag key with `flags.gate`; the running app ' +
				'composes a gated surface only for viewers the flag is on for, and a ' +
				'gated page’s URL 404s for everyone else — hiding the nav entry alone ' +
				'would be a link nobody can see and anybody can type.\n\n' +
				'**Determinism.** Evaluation happens per request against a viewer the ' +
				'server resolves; the ownership generators cannot reach it. So a flag ' +
				'does not produce two code paths to keep deterministic — it produces ' +
				'one, and the generated tree for a flagged app is byte-identical to ' +
				'the tree for an unflagged one.\n\n' +
				'**Retirement.** Stale flags are the failure mode of every flag ' +
				'system, so the flag layer is enumerable: what a flag gates is ' +
				'computed from the spec, how recently it was evaluated is coalesced ' +
				'telemetry, and `flags.remove` is an op — refused while any surface ' +
				'still gates on it, so removal can never leave a dangling gate.',
		),
	],
	ownership: {
		tables: ['flag_evaluation'],
		routes: [],
	},
	uninstall: {
		supported: true,
		notes:
			'Removing the bundle drops the telemetry table and the `flagService` ' +
			'binding. Declared flags are spec data and survive; ungate the surfaces ' +
			'(`flags.gate {flag: null}`) and remove the declarations (`flags.remove`) ' +
			'first, or every gated page stays hidden — an unevaluated gate reads as ' +
			'off, which is the safe direction but not a working app.',
	},
	evalAsks: [
		{
			id: 'ask-flags-percentage-rollout',
			ask: 'Put the new checkout behind a flag, turn it on for our own staff, then ramp it to 10% of customers.',
			source: 'real-product',
			sourceRef:
				'LaunchDarkly and Flagsmith both lead their docs with the same three ' +
				'steps — internal-only, then a percentage ramp on a stable bucket, ' +
				'then full release.',
		},
		{
			id: 'ask-flags-find-the-dead-ones',
			ask: 'Which flags are still on in production but nothing checks any more?',
			source: 'real-product',
			sourceRef:
				'GitHub’s and Slack’s published flag-cleanup practice both key on the ' +
				'same two signals: age since declaration and time since last evaluation.',
		},
	],
}

const preferencesBundle: Bundle = {
	slug: 'preferences',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Preferences',
	description:
		'Typed per-user and per-organization settings, declared once and resolved ' +
		'user → organization → default. The settings UI is derived from the ' +
		'declarations rather than hand-built beside them, so adding a preference ' +
		'is one entry instead of a column, a form field, a loader and an action. ' +
		'Reads are cached per scope, so settings do not cost a query on every page.',
	// An organization-scoped default has no meaning without organizations, and
	// the RBAC on changing one is a role check — both come from members/auth.
	prerequisites: ['auth', 'members'],
	runtime: {
		// Two text-id key/value tables this feature manages directly, like
		// better-auth's. Contributing them as spec entities would derive an admin
		// CRUD surface over rows whose meaning is entirely in their declaration —
		// a grid of ("u_18f", "digest-frequency", "weekly") teaches nobody
		// anything, and editing it would bypass every type check on the way in.
		entities: [],
		pages: [],
		ddl: PREFERENCES_DDL,
		diBindings: ['preferencesService'],
	},
	artifacts: [
		prd(
			'Preferences',
			'# Preferences\n\nEach preference is declared once: a key, a type ' +
				'(boolean | string | number | enum), the scopes it may be set at, and ' +
				'a default. A value is resolved user → organization → default, and ' +
				'only for scopes the declaration names — so an organization default ' +
				'applies to members who have not chosen, and stops applying the moment ' +
				'one does. That distinction is why storage is one row per *set* value ' +
				'rather than a column per preference: a column always has a value, so ' +
				'it cannot express "has not chosen".\n\n' +
				'The settings page renders `PreferencesService.describe()` through ' +
				'`<PreferencesForm>` and names no preference itself. Writes go through ' +
				'the service, which type-checks against the declaration, refuses an ' +
				'unknown key, refuses one user editing another’s, and requires an ' +
				'owner or admin for organization defaults.',
		),
	],
	ownership: {
		tables: ['user_preference', 'organization_preference'],
		routes: [],
		// The settings page is owned code in the app template, not a generated
		// CRUD page — see the note on `runtime.entities` above.
		ownedRoutes: ['/settings'],
	},
	uninstall: {
		supported: false,
		reason:
			'The tables hold choices people made — notification opt-outs among them. ' +
			'The op vocabulary has no drop-table op, and removing the settings page ' +
			'while `NotificationService` still reads the channel preferences would ' +
			'leave users emailed by a system they can no longer opt out of. The ' +
			'operation people actually want is "stop offering a preference", which ' +
			'is removing its declaration: the stored rows stop resolving, the field ' +
			'leaves the derived form, and nothing is silently re-enabled.',
	},
	evalAsks: [
		{
			id: 'ask-preferences-org-default-with-override',
			ask: 'Default everyone in the org to the weekly digest, but let people switch themselves to daily.',
			source: 'real-product',
			sourceRef:
				'Linear and Notion both ship workspace notification defaults that a ' +
				'member can override per account, with the workspace value shown as ' +
				'the inherited one.',
		},
		{
			id: 'ask-preferences-new-toggle',
			ask: 'Add a "mention emails" toggle to account settings.',
			source: 'dogfood',
			sourceRef:
				'The old settings page in apps/web: the same three facts were ' +
				'written in four places (column, form input, loader mapping, action ' +
				'mapping), which is what made this the promotion’s first ask.',
		},
	],
}

const notificationsBundle: Bundle = {
	slug: 'notifications',
	version: VERSION,
	initialVersion: VERSION,
	userFacing: true,
	title: 'Notifications',
	description:
		'Declared notification types with an opt-out each, an in-app inbox, and ' +
		'digest or immediate email over the email bundle. How loud a message is ' +
		'comes from its declaration and the recipient’s preference, never from the ' +
		'call site: activity defaults to the digest, product news is opt-in, and ' +
		'only transactional mail goes out immediately. Delivery is idempotent — a ' +
		'redelivered event cannot become a second email — and content is filtered ' +
		'against the recipient’s read access at send time, in the digest as well ' +
		'as in the inbox.',
	// Preferences (which itself pulls auth + members) is where every opt-out
	// lives, and the email bundle is the transport and template registry. Both
	// are load-bearing rather than defensive: without preferences there is no
	// per-type opt-out, and #184 treats that as a day-one requirement.
	prerequisites: ['auth', 'email', 'preferences'],
	runtime: {
		// No spec entities. A delivery row is a record of something already
		// decided, not a resource anyone edits — an admin CRUD surface over it
		// would offer "create a notification", which is a send with no type, no
		// preference check and no idempotency key, and a REST endpoint pointed at
		// other people's inboxes.
		entities: [],
		pages: [],
		ddl: NOTIFICATIONS_DDL,
		diBindings: ['notificationService'],
	},
	artifacts: [
		prd(
			'Notifications',
			'# Notifications\n\nEvery notification is an instance of a *declared ' +
				'type*: a key, a class (`transactional` / `activity` / `marketing`), ' +
				'and the delivery it defaults to. The class is enforced, not ' +
				'documented — an activity type may not default to immediate email and ' +
				'a marketing type may not default to email at all — because the ' +
				'cheapest thing to write at a call site must not be the thing that ' +
				'gets the sending domain blocked.\n\n' +
				'Each declaration derives its own preference rows, so a ' +
				'new type ships with a per-type opt-out and an inbox toggle on the day ' +
				'it ships. Values resolve user → organization → declaration: an ' +
				'organization can steer the default, a member always wins over it, and ' +
				'the account-wide email switch overrides both.\n\n' +
				'**Delivery is at-least-once, so every send is a claim.** The row goes ' +
				'in first under a unique `(user, dedupe key)`; only the writer that ' +
				'won the insert mails, and a digest claims its `(user, window)` pair ' +
				'before it renders. A claim that was never mailed is the one case a ' +
				'retry may finish — otherwise at-least-once quietly becomes ' +
				'at-most-once.\n\n' +
				'**Content cannot outlive access.** A notification names the row it is ' +
				'about, and that read access is re-checked wherever content is ' +
				'rendered: the immediate email, the inbox, and the digest — where the ' +
				'gap between the event and the send is largest and the aggregation ' +
				'hides what was included.\n\n' +
				'**Unsubscribe is a signed link, not a login.** Anything opt-out-able ' +
				'refuses to send without one, and the token carries only a user and a ' +
				'scope, so it can silence mail and do nothing else.',
		),
	],
	ownership: {
		tables: ['notification', 'notification_digest'],
		routes: [],
		// Owned code in the app template — see the note on `runtime.entities`.
		// `/unsubscribe` is reachable without a session on purpose: requiring a
		// login to stop email is how a sender gets reported as spam.
		ownedRoutes: ['/notifications', '/unsubscribe'],
	},
	uninstall: {
		supported: false,
		reason:
			'The delivery table is the record of what was already sent, and its ' +
			'`dedupe_key` rows are what stop a redelivery becoming a second email — ' +
			'dropping it re-opens every suppressed duplicate at once. The op ' +
			'vocabulary has no drop-table op, and removing the inbox while other ' +
			'code still calls `notify()` would leave notifications with nowhere to ' +
			'land. The operation people actually want is "stop sending me this", ' +
			'which is a preference: it is per-type, reversible, and already the ' +
			'unsubscribe link’s job.',
	},
	evalAsks: [
		{
			id: 'ask-notifications-digest-not-firehose',
			ask: 'Stop emailing me on every comment — send me one summary a day instead, but keep security alerts immediate.',
			source: 'real-product',
			sourceRef:
				'GitHub, Linear and Jira all ship exactly this split: a per-type ' +
				'delivery choice with a digest option, and a security/account class ' +
				'that is excluded from it.',
		},
		{
			id: 'ask-notifications-no-duplicate-email',
			ask: 'Our worker retried after a timeout and everyone got the same email twice — make that impossible.',
			source: 'issue-report',
			sourceRef:
				'the gating clause ("delivery is at-least-once … a duplicate ' +
				'must never produce a duplicate email"), which is the failure the jobs ' +
				'primitive in `features/jobs` produces by design: it retries with ' +
				'backoff and cannot know whether the handler’s send got out.',
		},
	],
}

export const BUNDLES: Record<string, Bundle> = {
	[authBundle.slug]: authBundle,
	[auditBundle.slug]: auditBundle,
	[emailBundle.slug]: emailBundle,
	[dbPluginsBundle.slug]: dbPluginsBundle,
	[diBundle.slug]: diBundle,
	[storageBundle.slug]: storageBundle,
	[jobsBundle.slug]: jobsBundle,
	[webhooksBundle.slug]: webhooksBundle,
	[observabilityBundle.slug]: observabilityBundle,
	[complianceBundle.slug]: complianceBundle,
	[apiKeysBundle.slug]: apiKeysBundle,
	[flagsBundle.slug]: flagsBundle,
	[membersBundle.slug]: membersBundle,
	[preferencesBundle.slug]: preferencesBundle,
	[notificationsBundle.slug]: notificationsBundle,
	[billingBundle.slug]: billingBundle,
	[adminBundle.slug]: adminBundle,
}

/** Look up a bundle by slug. */
export function getBundle(slug: string): Bundle | undefined {
	return BUNDLES[slug]
}

/** All catalog bundles, in catalog order. */
export function listBundles(): Bundle[] {
	return Object.values(BUNDLES)
}

/**
 * The capabilities a user actually installs — the catalog minus plumbing (`di`,
 * `db-plugins`). This is the number epic #164's exit criterion counts, and the
 * one {@link USER_FACING_CATALOG_CAP} bounds.
 */
export function listUserFacingBundles(): Bundle[] {
	return listBundles().filter((b) => b.userFacing)
}

/**
 * The catalog-size cap, enforced in `contract.test.ts`.
 *
 * Six bundles is 63 non-empty subsets; sixteen is 65,535. The cap stood at ten
 * because past roughly there we would have been shipping combinations nobody
 * had ever run held the catalog until the L3 combination gate
 * existed, precisely so that raising this number could not be the quiet way to
 * ship untested combinations.
 *
 * That gate now exists: the combination-safety sweep installs
 * every prerequisite-closed subset of this catalog in several valid topological
 * orders and asserts each produces a byte-identical project, on every PR. So
 * the cap moves to sixteen — epic #164's target — and the thing actually
 * protecting composition is the gate, not the number. Raise this further only
 * alongside the gate's own bound (`MAX_ENUMERATED`) and a runtime measurement:
 * a cap the lattice cannot enumerate is a cap that stopped meaning anything.
 */
export const USER_FACING_CATALOG_CAP = 16
