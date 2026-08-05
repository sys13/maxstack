/**
 * The feature-bundle format — the union of the three shapes
 * the archive prototyped:
 *
 *   - **Runtime**  : schema (entities) + pages + seeds + DI binding keys — what
 *                    the bundle contributes to a project's live spec/app.
 *   - **Artifacts**: its own PRD fragment, tech spec, tests, issue template
 *                    (prd2's `FeatureBundle.artifacts`) — a bundle carries its
 *                    own eval material.
 *   - **Deps & policy**: `prerequisites` (other bundle slugs it needs) and an
 *                    optional `entitlement` key gating it (task 28).
 *
 * A bundle is pure data. `applyBundle` turns its runtime into typed spec-ops
 * against a project's spec, so adding a bundle uses the exact same validated
 * path an agent's spec-ops do — never a bespoke mutation.
 */

import type { EntityId, FieldType } from '@maxstack/spec'

export type BundleArtifactType =
	| 'prd'
	| 'tech_spec'
	| 'tests'
	| 'issue_template'

export interface BundleArtifact {
	type: BundleArtifactType
	title: string
	/** Markdown body — the bundle's own eval/spec material. */
	md: string
}

/** A field on a bundle entity (provenance + branded ids are minted on apply). */
export interface BundleField {
	name: string
	type: FieldType
	required?: boolean
	/**
	 * The entity this field points at, when it is a foreign key.
	 *
	 * Bundles shipped every FK as a bare `string` for a long time, which meant
	 * the platform could derive nothing from them: no display-field resolution,
	 * no edge in the relation graph, and no `via` traversal for a rollup.
	 * A relation that is not declared is a relation that does not exist.
	 *
	 * **Declaring one is not always free.** `from-spec.ts` emits `uuid` for a
	 * reference to a spec entity where a bare `string` field emits `text`, and
	 * the platform's DDL is additive-only — so adding `reference` to a field that
	 * already shipped is a column-type change no `ADD COLUMN IF NOT EXISTS` can
	 * perform. It is free only when the target's ids are text, i.e. a virtual
	 * entity like `e-user` (`idType: 'text'`), where the emitted
	 * column is `text` either way.
	 */
	reference?: EntityId
	/**
	 * The entities this field *could* point at, when the catalog cannot know and
	 * a project always does.
	 *
	 * The case this exists for is billing's `subject` — "whatever this app bills",
	 * a user id in a per-seat product and an organization id in a per-workspace
	 * one. {@link reference} names exactly one entity, so both columns shipped as
	 * bare strings with the loss recorded as a "cannot": no `<ReferenceField>`, no
	 * edge in the relation graph, no `via` for a rollup, on the two tables where
	 * billing questions actually get asked.
	 *
	 * Declaring it costs a project nothing until the project narrows it: the
	 * column emitted is the same `text` a bare string emits, so this is additive
	 * on an installed bundle in a way `reference` is not (see above — `reference`
	 * changes the emitted column type). A project narrows with
	 * `data.setFieldReference`, which refuses any target not on this list.
	 *
	 * See `FieldSpec.openReference` for the full argument, including why this is
	 * not a polymorphic reference.
	 */
	openReference?: EntityId[]
}

/** A schema entity the bundle contributes to the project's data layer. */
export interface BundleEntity {
	/** Unprefixed key, e.g. `organization` (apply mints `e-organization`). */
	key: string
	name: string
	description?: string
	fields: BundleField[]
}

/** A page the bundle contributes to the project's page layer. */
export interface BundlePage {
	/** Unprefixed key, e.g. `organizations` (apply mints `pg-organizations`). */
	key: string
	name: string
	route: string
	/** The entity key this page is a CRUD surface for. */
	entityKey: string
	/** Block template keys (`table`, `form`, …); defaults to `['table']`. */
	blocks?: string[]
	priority?: 'high' | 'medium' | 'low'
	e2eTests?: string[]
}

/** Seed rows for a bundle entity (applied to the store, not the spec). */
export interface BundleSeed {
	entityKey: string
	rows: Record<string, unknown>[]
}

export interface BundleRuntime {
	entities: BundleEntity[]
	pages: BundlePage[]
	seeds?: BundleSeed[]
	/** DI binding keys the bundle's components require at the composition root. */
	diBindings?: string[]
	/**
	 * Raw, idempotent DDL for infra tables the bundle materializes *outside* the
	 * spec→store bridge — better-auth's `user`/`session`/… are text-id tables the
	 * library manages, not the uuid tables `from-spec` derives from `entities`.
	 * Applied at the composition root (never via `data.addEntity`), so it does not
	 * appear as a spec entity / admin CRUD resource.
	 */
	ddl?: string
}

/**
 * How a bundle comes back out (contract requirement 5). Sixteen bundles means
 * people will try things, so a one-way door on every module is hostile — but an
 * honest "you cannot, and here is why" is a legitimate answer. `supported:
 * false` therefore *requires* a reason, and the contract check enforces it.
 */
export type BundleUninstall =
	| { supported: true; notes?: string }
	| { supported: false; reason: string }

/**
 * Where a bundle's eval ask came from. Deliberately the same honesty vocabulary
 * as `docs/corpus/README.md`, minus `invented` — an ask written to fit the ops
 * we already shipped measures nothing.
 */
export type BundleAskSource =
	| 'real-product'
	| 'dogfood'
	| 'user-report'
	| 'issue-report'
	| 'external-corpus'

/**
 * A change ask that exercises a bundle's surface (contract requirement 3): the
 * bundle carries the material its own cost is measured with, so promoting a
 * capability area to the catalog cannot quietly skip measurement.
 *
 * These are *bundle-scoped* asks. They are not folded into the benchmark
 * backlogs in `benchmarks/src/`, so they never move the published
 * expressibility denominator — see `docs/corpus-integrity.md` for why that
 * number only moves with a justification note.
 */
export interface BundleEvalAsk {
	/** Unique across the catalog; conventionally `ask-<slug>-<topic>`. */
	id: string
	/** The change a maintainer of an app with this bundle would ask for. */
	ask: string
	source: BundleAskSource
	/** The concrete origin — name the product, session, or issue. */
	sourceRef: string
}

/**
 * What a bundle claims at install (contract requirement 7), so a collision is
 * detected at install rather than discovered later.
 *
 * Spec ids are deliberately *not* declared here: they are minted
 * deterministically from the runtime's keys (`e-<key>`, `fld-<key>-<name>`, …),
 * so a hand-written copy would be drift surface with no extra information.
 * `bundleFootprint()` derives them; the contract check cross-references the
 * declarations below against the same runtime, so a bundle that grows an entity
 * without updating `tables` goes red.
 */
export interface BundleOwnership {
	/**
	 * Database tables the bundle materializes: every spec entity key, plus any
	 * table the bundle creates through raw `ddl` (which no op can reveal).
	 */
	tables: string[]
	/** Routes the bundle mounts as spec **pages** — must match its pages exactly. */
	routes: string[]
	/**
	 * Routes the bundle mounts as **owned code** in the app template rather than
	 * as a generated page: `storage`'s `/api/upload` and `/files/:key`, `admin`'s
	 * `/metrics`. No op reveals these, so — exactly like `ddl` tables — they must
	 * be declared to be collision-checked.
	 *
	 * Kept separate from {@link routes} rather than merged into it because the two
	 * carry different obligations. A `routes` entry is derivable from the runtime
	 * and cross-checked against it, so it cannot drift. An `ownedRoutes` entry is
	 * a claim nothing can verify from data, so it is a claim a reviewer has to
	 * read. Collapsing them would let an unverifiable claim hide among verifiable
	 * ones.
	 */
	ownedRoutes?: string[]
}

export interface Bundle {
	/** Stable catalog id, e.g. `members`. */
	slug: string
	/** Semver, bumped on breaking schema/DI changes (drives `maxstack gen --upgrade`). */
	version: string
	/**
	 * The version this bundle first shipped at. With {@link version} it bounds the
	 * codemod chain a project installed at any point in the bundle's life must be
	 * able to walk (contract requirement 2).
	 */
	initialVersion: string
	title: string
	description: string
	/**
	 * Whether this is a capability a user installs, or plumbing the platform
	 * needs. `di` / `db-plugins` are plumbing: they are in the catalog because
	 * install records drive composition-root wiring, not because anyone shops for
	 * them. The catalog-size gates count only user-facing entries.
	 */
	userFacing: boolean
	/** Other bundle slugs that must be present first (topologically resolved). */
	prerequisites: string[]
	/** Entitlement key that gates this bundle at runtime (task 28), if any. */
	entitlement?: string
	runtime: BundleRuntime
	artifacts: BundleArtifact[]
	ownership: BundleOwnership
	uninstall: BundleUninstall
	evalAsks: BundleEvalAsk[]
}

/** A record of a bundle installed into a project (persisted in `maxstack.json`). */
export interface InstalledBundle {
	slug: string
	version: string
}
