/**
 * Branded IDs for the spec system — the cross-layer reference vocabulary.
 *
 * The product layer (prd.types) already owns its category-typed IDs. This module
 * adds the data-layer, page-layer, and pricing-layer IDs plus the op/instance
 * IDs, so that a spec op can point at "entity `e-order`" or "page `pg-checkout`"
 * with the same compile-time safety the PRD gets — you cannot pass a page id
 * where an entity id is required, and a bare string literal of the right shape
 * is automatically the right branded type (§3-L1: native branded-ID
 * cross-references, built into the base types from day one).
 *
 * Prefixes are DISJOINT across every layer (product prefixes live in prd.types:
 * sh- m- ev- bg-/ug- a- r- s- as- rk- p- ms- d-). The template-literal type
 * requires the character after the stem to be `-`, so `pg-` never collides with
 * the product `p-` (PhaseId), etc. Existence of a referenced id is a runtime
 * concern (spec-system.schema.ts), exactly as it is for the PRD.
 */

// Re-export the product-layer ids so the whole vocabulary is one import surface.
export type {
	ActivityId,
	AssumptionId,
	DecisionId,
	EventId,
	GoalId,
	ISODate,
	MetricId,
	MilestoneId,
	PhaseId,
	RequirementId,
	RiskId,
	ScopeItemId,
	StakeholderId,
} from '../prd/prd.types.ts'

// ---- data layer -----------------------------------------------------------
export type EntityId = `e-${string}`
export type FieldId = `fld-${string}`
/**
 * A derived value on an entity — a computed field or a rollup.
 * Distinct from {@link FieldId} because a derived value is never a stored
 * column: it has no DDL, is never written, and the runtime evaluates it on read.
 * Giving it its own prefix means a rollup id can't be passed where a stored
 * field is wanted (e.g. as a `groupBy` key, which must be storable).
 *
 * Disjoint from the product layer's `d-` (DecisionId) — the template-literal
 * type requires the character after the stem to be `-`, and `drv-x`'s second
 * character is `r`.
 */
export type DerivedId = `drv-${string}`

// ---- page/UX layer --------------------------------------------------------
export type PageId = `pg-${string}`
export type BlockId = `blk-${string}`

// ---- business model layer -------------------------------------------------
export type TierId = `tr-${string}`

// ---- flag layer -----------------------------------------------------------
/**
 * A declared feature flag. Disjoint from every prefix above: the
 * template-literal type requires a `-` after the stem, and no other layer uses
 * `flg`. A flag's *key* (what a gated surface names) is a separate, human-chosen
 * string — the id is the spec-internal handle, exactly as elsewhere.
 */
export type FlagId = `flg-${string}`

// ---- schedule layer -------------------------------------------------------
/**
 * A declared schedule. Disjoint from every prefix above — no other
 * layer uses `sch`, and the template-literal type requires the `-`. As with a
 * flag, the schedule's *key* (what the handler slot is registered under and what
 * every job row carries) is a separate, human-chosen string; the id is the
 * spec-internal handle.
 */
export type ScheduleId = `sch-${string}`

// ---- source layer ---------------------------------------------------------
/**
 * A declared external data source. Disjoint from every prefix
 * above — no other layer uses `src`, and the template-literal type requires the
 * `-`. As with a flag or a schedule, the source's *key* (what every job row and
 * refiner module carries) is a separate, human-chosen string.
 */
export type SourceId = `src-${string}`

// ---- search layer ---------------------------------------------------------
/**
 * A declared full-text search index. Disjoint from every prefix
 * above — no other layer uses `idx`, and the template-literal type requires the
 * `-`. As with a flag, a schedule or a source, the index's *key* (what the
 * database object is named and what shows up in `EXPLAIN`) is a separate,
 * human-chosen string.
 */
export type SearchIndexId = `idx-${string}`

// ---- document layer -------------------------------------------------------
/**
 * A declared document template. Disjoint from every prefix above —
 * no other layer uses `doc`, and the template-literal type requires the `-`.
 * As everywhere else, the template's *key* (the URL segment, the stored object
 * path, the string a person types) is separate from the spec-internal handle.
 */
export type DocumentTemplateId = `doc-${string}`

// ---- import layer ---------------------------------------------------------
/**
 * A declared importer. Disjoint from every prefix above — no other
 * layer uses `imp`, and the template-literal type requires the `-`. As
 * everywhere else, the importer's *key* (the URL segment, the audit metadata,
 * the parser module's name) is separate from the spec-internal handle.
 */
export type ImporterId = `imp-${string}`

// ---- portal layer ---------------------------------------------------------
/**
 * A declared public/token/role-scoped surface. Disjoint from every
 * prefix above — no other layer uses `ptl`, and the template-literal type
 * requires the `-`. As everywhere else the portal's *key* (the `/p/<key>` URL
 * segment, the audit label, the rate-limit bucket) is separate from the
 * spec-internal handle; here that separation earns its keep twice over, because
 * the key is the half that ends up in somebody's browser history.
 */
export type PortalId = `ptl-${string}`

// ---- live layer -----------------------------------------------------------
/**
 * A declared live subscription. Disjoint from every prefix above —
 * no other layer uses `lv`, and the template-literal type requires the `-`. As
 * everywhere else the channel's *key* (the `/api/live/<key>` URL segment, the
 * metric label, the generated slot module) is separate from the spec-internal
 * handle; here the separation matters because the key is what an incident report
 * quotes when a channel is the reason the app is slow.
 */
export type LiveId = `lv-${string}`

// ---- view layer -----------------------------------------------------------
/**
 * A declared list action. Disjoint from every prefix above — no other
 * layer uses `act`, and the template-literal type requires the `-`. As
 * everywhere else the action's *key* (the `/api/:resource/actions/<key>` URL
 * segment, the audit label, the MCP tool name) is separate from the
 * spec-internal handle; here the separation earns its keep because the label a
 * button carries is prose somebody will reword, and rewording a button must not
 * move an endpoint.
 */
export type ActionId = `act-${string}`

// ---- access layer ---------------------------------------------------------
/**
 * A declared role — a named grant set. Disjoint from every prefix above,
 * including the product layer's `r-` (RequirementId): the template-literal type
 * requires the character after the stem to be `-`, and `rol-x`'s second
 * character is `o`. As everywhere else the role's *key* (what a session carries,
 * what an audit line quotes, what a person says out loud) is separate from the
 * spec-internal handle — relabelling a role must never move anybody's authority.
 */
export type RoleId = `rol-${string}`

/**
 * A declared group — a named set whose membership is runtime data. Disjoint
 * from every prefix above; no other layer uses `grp`. The group's *key* is the
 * durable name a binding points at, which is the whole reason a group exists
 * rather than a list of people.
 */
export type GroupId = `grp-${string}`

/**
 * A standing (bootstrap) role binding. Disjoint from every prefix above; no
 * other layer uses `bnd`. Unlike a role or a group it has no key — a binding is
 * never named by anything, it *is* the edge between two things that are.
 */
export type AccessBindingId = `bnd-${string}`

// ---- system-level ---------------------------------------------------------
/** A single applied spec-op instance in the op log. */
export type OpId = `op-${string}`

/** The layer an id belongs to — used by diffs and the op vocabulary metadata. */
export type SpecLayer =
	| 'product'
	| 'access'
	| 'data'
	| 'page'
	| 'pricing'
	| 'theme'
	| 'flags'
	| 'schedules'
	| 'sources'
	| 'search'
	| 'documents'
	| 'imports'
	| 'portals'
	| 'live'
	| 'view'
	| 'site'
	| 'system'

/**
 * The prefix segment of a branded id (everything up to and including the first
 * `-`). Cheap runtime discriminator for logging/diffing; the compile-time
 * guarantee is the template-literal types above.
 */
export function idPrefix(id: string): string {
	const dash = id.indexOf('-')
	return dash === -1 ? id : id.slice(0, dash + 1)
}
