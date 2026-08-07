/**
 * Typed spec-ops — the mutation vocabulary of the spec system.
 *
 * Source: saaskit-one-ejectable's `op` command (`data.addEntity`,
 * `pricing.addTier`, `page.addBlock`). §3-L1: AI and UI mutate the spec through
 * *named operations*, not freehand file edits. Ops are **validated, logged, and
 * diffable** — this is exactly what the MCP `propose_spec_change` tool emits (a
 * typed op, never a write) and what `apply_spec_change` applies under policy.
 *
 * The first 10 ops span all four layers so the vocabulary is proven end-to-end
 * rather than product-only:
 *
 *   product:  prd.addRequirement · prd.addScopeItem · prd.addRisk ·
 *             prd.addMetric · prd.recordDecision
 *   data:     data.addEntity · data.addField
 *   page:     page.addPage · page.addBlock · page.setBlockOrder ·
 *             page.setBlockVariant · page.setBlockFields ·
 *             page.setBlockEditable · page.setE2ETests
 *   pricing:  pricing.addTier
 * theme: theme.set (visual design as spec-as-data;
 *             full-replace, last-wins on the singleton theme)
 *
 * Plus one **system-level** op, `provenance.review` — the accept/reject
 * decision on a suggested row, wrapped as an op so every review lands in the
 * op log as an audit entry. It is NOT a structural mutation (the settled
 * decision stands: accepting changes a row's *provenance*, via the settled
 * {@link accept}/{@link reject} transitions — reject is a soft-reject, never a
 * delete); the op is the audit wrapper around that transition.
 *
 * Every structural op is **additive** in v1 (the minimum-mechanism cut —
 * remove/rename arrive with evidence, alongside the eject ladder). Every op:
 *   1. validates its preconditions (refs resolve, ids are fresh) → `string[]`;
 *   2. applies immutably (structuredClone, never touches the input) → `SpecSystem`;
 *   3. diffs (a structured, human-readable {@link SpecDiff});
 * and `applyOp` appends an {@link AppliedOp} to the op log (with the caller's
 * origin + timestamp, kept out of the pure core so the functions stay
 * deterministic and testable).
 */

import type { Metric, Requirement, Risk, ScopeItem } from '../prd/prd.types.ts'
import type { OpActor } from './actor.ts'
import {
	assertAppendOnly,
	type LedgerEntry,
	recordDecision,
	validateLedgerEntry,
} from './decision-ledger.ts'
import {
	DOCUMENT_FORMATS,
	DOCUMENT_KEY_RE,
	DOCUMENT_PAGE_SIZES,
	DOCUMENT_SECTION_KINDS,
	type DocumentDelivery,
	type DocumentSection,
	type DocumentTemplateSpec,
	describeDelivery,
	describeDocumentTemplate,
	hasActiveDelivery,
	MAX_DOCUMENT_SECTION_FIELDS,
	MAX_DOCUMENT_SECTIONS,
	MAX_DOCUMENT_TABLE_COLUMNS,
	MAX_DOCUMENT_TABLE_ROWS,
	printableFieldTypes,
} from './documents.ts'
import {
	FLAG_KEY_RE,
	type FlagSpec,
	type FlagTargeting,
	flagGates,
	MAX_ROLLOUT_PERCENT,
} from './flags.ts'
import type {
	BlockId,
	DocumentTemplateId,
	EntityId,
	FieldId,
	FlagId,
	ImporterId,
	ISODate,
	LiveId,
	OpId,
	PageId,
	PortalId,
	ScheduleId,
	SearchIndexId,
	SourceId,
	SpecLayer,
} from './ids.ts'
import {
	describeImporter,
	IMPORT_FORMATS,
	IMPORT_KEY_RE,
	IMPORT_PARSER_SLOT_RE,
	type ImportColumn,
	type ImporterSpec,
	importableFieldTypes,
	MAX_IMPORT_COLUMNS,
	MAX_IMPORT_ROWS,
	upsertKeyFieldTypes,
} from './imports.ts'
import {
	describeLiveSubscription,
	LIVE_KEY_RE,
	LIVE_KINDS,
	LIVE_SCOPE_KINDS,
	type LiveSubscriptionSpec,
	liveScopeFieldTypes,
	MAX_LIVE_FIELDS,
	MAX_LIVE_MESSAGE_RATE,
	MAX_LIVE_SUBSCRIBERS,
	MAX_PRESENCE_TTL_SECONDS,
	MAX_PRESENT,
	MAX_UNBOUNDED_SUBSCRIBERS,
	pushableFieldTypes,
} from './live.ts'
import {
	describePortal,
	MAX_PORTAL_FIELDS,
	MAX_PORTAL_TOKEN_TTL_HOURS,
	MAX_PORTAL_WRITE_RATE,
	MAX_PUBLIC_WRITE_RATE,
	PORTAL_AUDIENCES,
	PORTAL_KEY_RE,
	PORTAL_LAYOUTS,
	PORTAL_SCOPES,
	PORTAL_WRITE_ACTIONS,
	type PortalSpec,
	type PortalWrite,
	portalFilterFieldTypes,
} from './portals.ts'
import {
	accept,
	deriveProvenanceState,
	manual,
	type Provenance,
	type Provenanced,
	type ProvenanceState,
	provenanceSchema,
	reject,
	suggested,
	unreview,
} from './provenance.ts'
import {
	describeRecurrence,
	isValidTimezone,
	MAX_FANOUT_ORGS,
	MAX_INTERVAL_MINUTES,
	MIN_INTERVAL_MINUTES,
	SCHEDULE_KEY_RE,
	SCHEDULE_RECURRENCE_KINDS,
	SCHEDULE_RUN_AS_KINDS,
	SCHEDULE_TIME_RE,
	type ScheduleRecurrence,
	type ScheduleSpec,
} from './schedules.ts'
import {
	describeSearchIndex,
	MAX_SEARCH_FIELDS,
	SEARCH_KEY_RE,
	SEARCH_LANGUAGES,
	SEARCH_WEIGHT_FACTORS,
	SEARCH_WEIGHTS,
	type SearchField,
	type SearchIndexSpec,
	searchableFieldTypes,
} from './search.ts'
import {
	describeSource,
	MAX_SOURCE_MAPPINGS,
	MAX_SYNC_RECORDS,
	SECRET_NAME_RE,
	SOURCE_AUTH_KINDS,
	SOURCE_KEY_RE,
	SOURCE_LIMIT_BOUNDS,
	SOURCE_METHODS,
	SOURCE_MODES,
	SOURCE_TRIGGER_KINDS,
	type SourceLimits,
	type SourceMapping,
	type SourceSpec,
} from './sources.ts'
import {
	collectSpecSystemErrors,
	documentTemplateErrors,
	importerErrors,
	liveSubscriptionErrors,
	portalErrors,
	recurrenceErrors,
	runAsErrors,
	searchIndexErrors,
	sourceErrors,
} from './spec-system.schema.ts'
import {
	ACCENT_RE,
	AGG_FNS,
	AGG_FNS_NEEDING_FIELD,
	BLOCK_VARIANTS,
	type BlockOrder,
	type BlockSpec,
	type BlockVariant,
	type BoardSpec,
	CALENDAR_DISPLAYS,
	type CalendarSpec,
	COMPUTED_OPERATORS,
	type ComputedFieldSpec,
	type EntitySpec,
	FIELD_TYPES,
	FILE_DERIVATIVE_MAX_DIMENSION,
	FILE_MAX_SIZE_CEILING,
	type FieldDisplaySpec,
	type FieldOption,
	type FieldSpec,
	isAcceptPattern,
	isImageAcceptPattern,
	MAX_COMPUTED_DEPTH,
	MAX_ROLLUP_HOPS,
	MAX_ROLLUP_LIMIT,
	MAX_VALUE_LIMIT,
	NUMBER_DISPLAY_FORMATS,
	NUMERIC_AGG_FNS,
	type PageSpec,
	type PricingTier,
	type RollupSpec,
	type SpecSystem,
	THEME_DENSITIES,
	THEME_FONTS,
	THEME_PRESETS,
	THEME_RADII,
	THEME_TYPE_SCALES,
	type ThemeSpec,
	TIME_BUCKETS,
	type TimelineSpec,
} from './spec-system.ts'
import { virtualEntity } from './virtual-entities.ts'

// ===========================================================================
// Op-input variants — provenance is OPTIONAL on every "add" op's payload.
// ===========================================================================

/**
 * A row shape as an op author writes it: every field the stored row has,
 * except `provenance` is optional. Hand-authoring the 5-key {@link Provenance}
 * object on every entity/field/page/block/tier tripled the size of every op
 * file and isn't documented anywhere — `applyOp` stamps a default
 * (via {@link defaultProvenance}) when the author omits it, exactly like the
 * docs' examples show.
 */
type WithOptionalProvenance<T extends Provenanced> = Omit<T, 'provenance'> & {
	provenance?: Provenance
}

/**
 * A field as an op author writes it. `options` additionally accepts bare
 * strings — `["book","article"]` — which {@link applyOp} canonicalizes to
 * `{label, value}`. Typing it here rather than only coercing at
 * runtime means the accepted shape is discoverable, instead of something you
 * find out by writing it and watching every write fail at form submit.
 */
export type FieldSpecInput = Omit<
	WithOptionalProvenance<FieldSpec>,
	'options'
> & { options?: (string | FieldOption)[] }
/**
 * Note the `computed`/`rollups` omission: an entity is created with
 * its stored fields, and derived values are layered on afterwards by
 * `data.addComputed` / `data.addRollup`. Allowing them inline would let a rollup
 * name an entity created in the same op — so either the validator resolves
 * relations against a spec that doesn't exist yet, or it rejects a payload that
 * looks reasonable. Neither is worth it: a rollup is only authorable once the
 * relation it aggregates over exists, which is strictly after both entities do.
 */
export type EntitySpecInput = WithOptionalProvenance<
	Omit<EntitySpec, 'fields' | 'computed' | 'rollups'>
> & { fields: FieldSpecInput[] }
/** Derived-value inputs — provenance is stamped by `applyOp`. */
export type ComputedFieldSpecInput = WithOptionalProvenance<ComputedFieldSpec>
export type RollupSpecInput = WithOptionalProvenance<RollupSpec>
export type BlockSpecInput = WithOptionalProvenance<BlockSpec>
export type PageSpecInput = WithOptionalProvenance<Omit<PageSpec, 'blocks'>> & {
	blocks: BlockSpecInput[]
}
export type PricingTierInput = WithOptionalProvenance<PricingTier>
/**
 * A flag as an op author writes it: `declaredAt` is omitted too,
 * because `applyOp` stamps it from the op's own `appliedAt`.
 */
export type FlagSpecInput = WithOptionalProvenance<
	Omit<FlagSpec, 'declaredAt'>
> & { declaredAt?: ISODate }

/**
 * A schedule as an op author writes it: `declaredAt` is omitted,
 * because `applyOp` stamps it from the op's own `appliedAt` — and for an
 * `interval` recurrence that stamp is the anchor the occurrences count from, so
 * it has to be the real application date rather than whatever was typed.
 */
export type ScheduleSpecInput = WithOptionalProvenance<
	Omit<ScheduleSpec, 'declaredAt'>
> & { declaredAt?: ISODate }

/**
 * A source as an op author writes it: `declaredAt` is stamped by
 * `applyOp`, on the same argument the schedule input makes — a hand-authored
 * date is a date that lies the moment somebody copies an op file.
 */
export type SourceSpecInput = WithOptionalProvenance<
	Omit<SourceSpec, 'declaredAt'>
> & { declaredAt?: ISODate }

/**
 * A search index as an op author writes it: `declaredAt` is
 * stamped by `applyOp`, on the same argument the source and schedule inputs
 * make.
 */
export type SearchIndexSpecInput = WithOptionalProvenance<
	Omit<SearchIndexSpec, 'declaredAt'>
> & { declaredAt?: ISODate }

/**
 * A document template as an op argument — `declaredAt` optional because it is
 * stamped by `applyOp`, on the same argument the source, schedule and search
 * inputs make.
 */
export type DocumentTemplateSpecInput = WithOptionalProvenance<
	Omit<DocumentTemplateSpec, 'declaredAt'>
> & { declaredAt?: ISODate }

/**
 * An importer as an op argument — `declaredAt` optional because it
 * is stamped by `applyOp`, on the same argument every input above makes.
 *
 * `upsertFieldId` is deliberately NOT made optional here. It is nullable, and
 * `null` is a decision; leaving it out is not one, and the whole design of this
 * primitive is arranged so that the destructive option is never the one you get
 * by not thinking about it.
 */
export type ImporterSpecInput = WithOptionalProvenance<
	Omit<ImporterSpec, 'declaredAt'>
> & { declaredAt?: ISODate }

/**
 * A portal as an op argument — `declaredAt` optional because it is
 * stamped by `applyOp`, on the same argument every input above makes.
 *
 * Nothing else is made optional here, and that is the point rather than
 * pedantry. `readFields`, `writes`, `paused`, `audience` and `scope` are all
 * required, because every one of them is a decision about who can see somebody's
 * data, and a default is a decision made by whoever wrote the generator.
 */
export type PortalSpecInput = WithOptionalProvenance<
	Omit<PortalSpec, 'declaredAt'>
> & { declaredAt?: ISODate }

/**
 * A live subscription as an op argument — `declaredAt` optional
 * because it is stamped by `applyOp`, on the same argument every input above
 * makes.
 *
 * Nothing else is made optional, and the two that matter most are
 * `maxSubscribers` and `maxMessagesPerMinute`. Both are ceilings on what this
 * declaration does to somebody's running process, and a helper that filled
 * either in would let a spec describe a channel whose cost nobody chose.
 */
export type LiveSubscriptionSpecInput = WithOptionalProvenance<
	Omit<LiveSubscriptionSpec, 'declaredAt'>
> & { declaredAt?: ISODate }

/** What a `flags.gate` op points at — a page, or a block within a page. */
export interface FlagGateTarget {
	kind: 'page' | 'block'
	id: string
	/** Required for `kind: "block"` — the page the block lives on. */
	parentId?: string
}

/**
 * The provenance an add op's row gets when the author didn't supply one.
 * `human` (the CLI's `op`/`add-entity`/`add-field` commands, always `origin:
 * 'human'`) stamps {@link manual} — accepted and regen-protected, matching
 * hand-authored intent. `ai` (the MCP `apply_spec_change` path) stamps an
 * *accepted* {@link suggested} row: applying an op IS the accept half of
 * suggest→accept (propose_spec_change is the suggest half), so the row goes
 * live immediately while `isSuggested: true` keeps the AI origin visible.
 * A row that should land undecided (a review-queue candidate) passes an
 * explicit `suggested()` in the op args instead (an undecided
 * default made every MCP-applied field silently invisible to the runtime,
 * which grounds on accepted rows only).
 *
 * The axis it reads is {@link ApplyMeta.authorship}, **not**
 * {@link ApplyMeta.origin}, and the difference is issue #359: `origin` says who
 * *made the request*, and for a landed AI proposal that is a maintainer at a
 * browser while the change itself was written by an agent. `authorship` falls
 * back to `origin` because for every other write path the two genuinely are the
 * same fact — a person typing `maxstack add-field` both asks for the field and
 * authored it.
 */
function defaultProvenance(meta: ApplyMeta): Provenance {
	return (meta.authorship ?? meta.origin) === 'human'
		? manual()
		: accept(suggested())
}

// ===========================================================================
// The op vocabulary — a discriminated union on `op`
// ===========================================================================

export type MoscowBucket = 'mustHave' | 'shouldHave' | 'couldHave' | 'wontHave'

// ---------------------------------------------------------------------------
// Review targets — how `provenance.review` names a provenanced row
// ---------------------------------------------------------------------------

/**
 * The provenanced entity kinds a review decision can act on.
 *
 * `portal` is here and its arrival is worth recording, because its
 * absence produced the sharpest possible version of a review dead end.
 * `activePortals` requires `isAccepted === true` with no accepted-else-all
 * fallback — deliberately, since the fallback would let a *suggestion* put
 * somebody's table on the internet. But with `portal` outside this list,
 * `provenance.review` refused the target outright, so an agent-proposed portal
 * landed `suggested`, published nothing, and had no path to ever become live.
 * The only live portal was a hand-authored one. #198 calls the exposure view
 * "the single most important thing a human should review", and you cannot review
 * what you cannot decide on.
 *
 * Being reviewable is not the same as being *batchable*: `portal` is left out of
 * bulk review's `UNDERSTOOD_KINDS`, so it classifies as high risk and is refused
 * a place in any batch. A public surface gets a decision, never a sweep.
 */
export type ReviewTargetKind =
	| 'entity'
	| 'field'
	| 'page'
	| 'block'
	| 'tier'
	| 'flag'
	| 'schedule'
	| 'source'
	| 'searchIndex'
	| 'portal'

export const REVIEW_TARGET_KINDS = [
	'entity',
	'field',
	'page',
	'block',
	'tier',
	'flag',
	'schedule',
	'source',
	'searchIndex',
	'portal',
] as const satisfies readonly ReviewTargetKind[]

/**
 * A stable locator for one provenanced row anywhere in the spec. `parentId`
 * disambiguates nested rows (a field lives under an entity, a block under a
 * page); it is absent for the top-level kinds.
 */
export interface ReviewTarget {
	kind: ReviewTargetKind
	id: string
	parentId?: string
}

/** The layer a review target's kind lives in — drives the diff's layer tag. */
export function reviewTargetLayer(kind: ReviewTargetKind): SpecLayer {
	switch (kind) {
		case 'entity':
		case 'field':
			return 'data'
		case 'page':
		case 'block':
			return 'page'
		case 'tier':
			return 'pricing'
		case 'flag':
			return 'flags'
		case 'schedule':
			return 'schedules'
		case 'source':
			return 'sources'
		case 'searchIndex':
			return 'search'
		case 'portal':
			return 'portals'
	}
}

/**
 * Find the provenanced row a target points at (a live reference into `system`,
 * so callers who transition it must be holding a clone). `undefined` when the
 * target doesn't resolve — the caller decides whether that's an error.
 */
export function locateReviewTarget(
	system: SpecSystem,
	target: ReviewTarget,
): { provenance: Provenance } | undefined {
	switch (target.kind) {
		case 'entity':
			return system.data.entities.find((e) => e.id === target.id)
		case 'field':
			return system.data.entities
				.find((e) => e.id === target.parentId)
				?.fields.find((f) => f.id === target.id)
		case 'page':
			return system.pages.pages.find((p) => p.id === target.id)
		case 'block':
			return system.pages.pages
				.find((p) => p.id === target.parentId)
				?.blocks.find((b) => b.id === target.id)
		case 'tier':
			return system.pricing.tiers.find((t) => t.id === target.id)
		case 'flag':
			return system.flags?.flags.find((f) => f.id === target.id)
		case 'schedule':
			return system.schedules?.schedules.find((s) => s.id === target.id)
		case 'source':
			return system.sources?.sources.find((s) => s.id === target.id)
		case 'searchIndex':
			return system.search?.indexes.find((i) => i.id === target.id)
		case 'portal':
			return system.portals?.portals.find((p) => p.id === target.id)
	}
}

/**
 * The nested rows a cascading review also decides: an entity's fields, a
 * page's blocks. Empty for leaf kinds (field/block/tier).
 */
export function locateReviewChildren(
	system: SpecSystem,
	target: ReviewTarget,
): { provenance: Provenance }[] {
	switch (target.kind) {
		case 'entity':
			return system.data.entities.find((e) => e.id === target.id)?.fields ?? []
		case 'page':
			return system.pages.pages.find((p) => p.id === target.id)?.blocks ?? []
		default:
			return []
	}
}

/**
 * What a `provenance.review` op does to the row it names.
 *
 * `accept` / `reject` are the two decisions. `reset` is the **undo**:
 * it returns a settled row to *undecided*, which is what makes an accepted batch
 * reversible without anybody editing provenance out of band.
 *
 * It is an op rather than a mutation for the same reason accept is: the trail has
 * to record that a decision was taken back, and by whom. An undo that left no
 * entry would be the one change in the system nobody could see.
 *
 * `reset` deliberately cannot touch a `manual` row. Un-deciding a hand-authored
 * row would not be an undo — nobody ever decided it — and it would strip the
 * regen protection that makes `isAddedManually` load-bearing.
 */
export type ReviewActionName = 'accept' | 'reject' | 'reset'

export const REVIEW_ACTIONS = [
	'accept',
	'reject',
	'reset',
] as const satisfies readonly ReviewActionName[]

export type SpecOp =
	| {
			op: 'prd.addRequirement'
			args: { requirement: Requirement; intoPhaseId?: string }
	  }
	| { op: 'prd.addScopeItem'; args: { bucket: MoscowBucket; item: ScopeItem } }
	| { op: 'prd.addRisk'; args: { risk: Risk } }
	| { op: 'prd.addMetric'; args: { metric: Metric } }
	| { op: 'prd.recordDecision'; args: { entry: LedgerEntry } }
	| { op: 'data.addEntity'; args: { entity: EntitySpecInput } }
	| {
			op: 'data.addField'
			args: { entityId: EntityId; field: FieldSpecInput }
	  }
	| {
			/**
			 * Declare that an existing string field is a foreign key.
			 *
			 * The one op in the vocabulary that changes a shipped column's type, and
			 * it exists because the alternative is worse: a project (or a bundle)
			 * that modelled a relation as a bare string has no way to say so later,
			 * so the platform can never resolve it, never traverse it, and never roll
			 * anything up through it. Hand-editing the spec JSON is not a fix — it
			 * skips the validation that the target exists and that the field is
			 * shaped like an id holder.
			 *
			 * Narrow on purpose:
			 *
			 * - Only a `string`/`enum` field may be declared. A number or a date is
			 *   not an id, and a `json` column is not one either.
			 * - Only a field with **no** reference yet. Re-pointing an FK at a
			 *   different entity is a data migration this op cannot perform, so it is
			 *   refused rather than silently mis-declared.
			 * - The DDL that follows reconciles the column type behind a guard and
			 *   fails loudly on a value that is not an id — see `specSchemaDdl`.
			 */
			op: 'data.setFieldReference'
			args: { entityId: EntityId; fieldId: FieldId; reference: EntityId }
	  }
	| {
			/**
			 * Declare that a string field holds an id whose target the **project**
			 * decides — the "open" reference a catalog bundle ships when
			 * the answer genuinely depends on the app.
			 *
			 * The case that forced it is billing's `subject`: "whatever this app
			 * bills", a user in a per-seat product and an organization in a
			 * per-workspace one. `data.setFieldReference` names one entity, so there
			 * was no honest op to write and both columns shipped as bare strings.
			 *
			 * This op **declares the ambiguity**; `data.setFieldReference` resolves
			 * it, refusing any target not on this list. Two ops rather than one
			 * because they are said by two different parties at two different times:
			 * a bundle opens, a project narrows.
			 *
			 * Narrow on purpose, mirroring `data.setFieldReference`:
			 *
			 * - Only a `string`/`enum` field. A number or a date is not an id.
			 * - **Two or more** candidates. One candidate is not an ambiguity — it is
			 *   a reference, and declaring it as open would leave a column nothing
			 *   resolves for no reason.
			 * - Not on a field that already has a `reference`. Re-opening a resolved
			 *   reference would un-declare a relation the rows already depend on.
			 * - The emitted column is unchanged (`text` either way), which is what
			 *   makes this additive on an installed bundle where declaring a plain
			 *   reference is not.
			 */
			op: 'data.setFieldOpenReference'
			args: { entityId: EntityId; fieldId: FieldId; candidates: EntityId[] }
	  }
	| {
			/**
			 * Set (or clear) an enum field's per-value row caps — a Kanban WIP limit,
			 * declared where it can actually be enforced.
			 *
			 * Last-wins rather than additive, because the operation a team actually
			 * performs is *changing* a limit ("we keep blocking, raise Doing to 4"),
			 * and an append-only vocabulary would make the most common edit the one
			 * thing you cannot say. An empty `limits` clears every cap, which is how
			 * a team stops running a limited board without deleting the column.
			 *
			 * The cap is enforced in `opCreate`/`opUpdate`, so REST, MCP, the admin
			 * UI and a board drag all hit the identical rule.
			 */
			op: 'data.setFieldLimits'
			args: {
				entityId: EntityId
				fieldId: FieldId
				limits: Record<string, number>
			}
	  }
	| {
			/**
			 * Issue #345 — state how a `number` field is drawn, and on what
			 * scale.
			 *
			 * The field library infers a widget from a column's **name** when its
			 * type carries no signal, so a number called `rating` renders as five
			 * stars. Before this op that inference was unopposable and its scale was
			 * unreachable: `meta.min`/`max`/`step` drove the rating, slider and
			 * duration widgets, but nothing in the spec vocabulary wrote field
			 * metadata, so an app rating books out of 10 got a 5-star widget and no
			 * way to say otherwise.
			 *
			 * `display.format` wins over the name **in both directions** —
			 * `"number"` is the escape hatch that keeps a column called `rating` a
			 * plain number, and `"rating"` promotes a column called `score`.
			 *
			 * Last-wins rather than merged, like `data.setFieldLimits`: the edit a
			 * person actually performs is *changing* a presentation, and an omitted
			 * `max` on a second call has to mean "no declared max" rather than
			 * silently keeping the first one. Passing `{}` clears the declaration
			 * and returns the field to inference.
			 *
			 * **Presentation only.** Nothing here constrains what may be stored: the
			 * column stays a `real` and a value outside the declared range is
			 * accepted and then displayed honestly rather than clamped into a lie.
			 */
			op: 'data.setFieldDisplay'
			args: {
				entityId: EntityId
				fieldId: FieldId
				display: FieldDisplaySpec
			}
	  }
	| {
			/**
			 * Add a value computed from a row's own fields. Never
			 * stored — no DDL, no migration, evaluated on read.
			 */
			op: 'data.addComputed'
			args: { entityId: EntityId; computed: ComputedFieldSpecInput }
	  }
	| {
			/**
			 * Add an aggregate over a related entity's rows. With
			 * `groupBy` it yields a series (a chart or a list); without, a scalar.
			 */
			op: 'data.addRollup'
			args: { entityId: EntityId; rollup: RollupSpecInput }
	  }
	| { op: 'page.addPage'; args: { page: PageSpecInput } }
	| { op: 'page.addBlock'; args: { pageId: PageId; block: BlockSpecInput } }
	| {
			op: 'page.setBlockOrder'
			args: { pageId: PageId; blockId: BlockId; order: BlockOrder }
	  }
	| {
			op: 'page.setBlockVariant'
			args: { pageId: PageId; blockId: BlockId; variant: BlockVariant }
	  }
	| {
			op: 'page.setBlockFields'
			args: { pageId: PageId; blockId: BlockId; fields: string[] }
	  }
	| {
			/**
			 * Name the fields a list's cells edit **in place**.
			 *
			 * Last-wins like the other set-ops, and `[]` clears — a capability that
			 * can only be widened is one nobody can take back after a review.
			 *
			 * This is the one `page.*` op that is not purely presentational, which is
			 * exactly why it is an op: "which cells can be written from the list" is
			 * a line a reviewer reads, not a default. What it does *not* do is create
			 * a write path — the cell submits to the record's own edit route. See
			 * {@link BlockSpec.editable}.
			 */
			op: 'page.setBlockEditable'
			args: { pageId: PageId; blockId: BlockId; editable: string[] }
	  }
	| {
			/**
			 * Set a page's natural-language end-to-end tests.
			 *
			 * `page.addPage` could always carry `e2eTests`, but nothing could add
			 * them afterwards — so a page that existed before anyone thought about
			 * verification could never acquire it, and the only verification route
			 * left was driving a browser by hand. Last-wins, like the other set-ops:
			 * the array replaces whatever was there.
			 */
			op: 'page.setE2ETests'
			args: { pageId: PageId; e2eTests: string[] }
	  }
	| {
			/**
			 * Add a `calendar` block — the page's rows arranged by one of its date
			 * columns, as a month grid, a week grid, or a density heatmap.
			 *
			 * The three corpus asks this op absorbs ("a calendar heatmap of habit
			 * completions", "a drag-and-drop weekly planner", and the sibling
			 * `page.addTimeline`'s Gantt) were three bespoke features that are one
			 * arrangement: the same rows, placed by a date. The op declares which
			 * date, and in which timezone — never inferred, because a view that
			 * buckets by the server's zone and one that buckets by the browser's are
			 * the two halves of every calendar bug ever shipped.
			 *
			 * `reschedule` opens *no new write path*: moving an entry is an ordinary
			 * update of the declared date field through the same server-side
			 * validation, permissions and audit trail as editing it in a form.
			 */
			op: 'page.addCalendar'
			args: {
				pageId: PageId
				blockId: BlockId
				calendar: CalendarSpec
				provenance?: Provenance
			}
	  }
	| {
			/**
			 * Add a `timeline` block — the page's rows as bars across a declared
			 * start/end date range, with optional dependency arrows drawn from a
			 * self-referencing field.
			 *
			 * The edges are *presentation of a declared relation*. The timeline draws
			 * the arrow; it does not reschedule dependents, detect cycles, or compute
			 * a critical path. That line is the whole reason this is a view primitive
			 * and not a scheduling engine.
			 */
			op: 'page.addTimeline'
			args: {
				pageId: PageId
				blockId: BlockId
				timeline: TimelineSpec
				provenance?: Provenance
			}
	  }
	| {
			/**
			 * Add a `board` block — the page's rows as cards in columns, grouped by
			 * one of its enum fields, with drag (and keyboard) moves between columns
			 *.
			 *
			 * The two corpus asks this absorbs — bugtrail's "Kanban board with
			 * drag-between-columns and per-column WIP limits" and crmlite's "drag
			 * deals between pipeline stages" — describe a *bespoke feature*, and it
			 * is three things the spec already knows how to say: an enum with
			 * options is the column set, a rank field is the order within a column,
			 * and a drop is an update of the enum.
			 *
			 * `move` opens *no new write path*: the board reports a card and a
			 * destination, and the values go to the record's own edit route. The WIP
			 * limit it draws is enforced in the shared create/update path, not here
			 * — the board cannot be the thing that enforces it, because it is not
			 * the only way in.
			 */
			op: 'page.addBoard'
			args: {
				pageId: PageId
				blockId: BlockId
				board: BoardSpec
				provenance?: Provenance
			}
	  }
	| { op: 'pricing.addTier'; args: { tier: PricingTierInput } }
	| { op: 'theme.set'; args: { theme: ThemeSpec } }
	| {
			/**
			 * Declare a feature flag. `declaredAt` is stamped from the
			 * op's `appliedAt` — flag age is half of stale-flag reporting, and a
			 * hand-authored date is a date that lies.
			 */
			op: 'flags.declare'
			args: { flag: FlagSpecInput }
	  }
	| {
			/** Replace a flag's targeting wholesale (last-wins). Omit `targeting`
			 * to clear it, which returns the flag to its bare default. */
			op: 'flags.setTargeting'
			args: { flagId: FlagId; targeting?: FlagTargeting }
	  }
	| {
			/**
			 * Gate a page or block on a declared flag, or ungate it with
			 * `flag: null`. The gate is a *presentation* fact: it changes what the
			 * running app composes for a viewer, never what the generator emits.
			 */
			op: 'flags.gate'
			args: { target: FlagGateTarget; flag: string | null }
	  }
	| {
			/**
			 * Remove a flag declaration — the one deliberately non-additive
			 * structural op in the vocabulary (see the module note). Refused while
			 * any surface still gates on it, so removal can never leave a page
			 * pointing at a flag that no longer exists.
			 */
			op: 'flags.remove'
			args: { flagId: FlagId }
	  }
	| {
			/**
			 * Declare a schedule: a recurrence, the timezone it is read
			 * in, and the identity its runs carry. `declaredAt` is stamped from the
			 * op's `appliedAt` — it is the anchor an `interval` counts from.
			 */
			op: 'schedules.declare'
			args: { schedule: ScheduleSpecInput }
	  }
	| {
			/**
			 * Replace a schedule's recurrence (and optionally its timezone)
			 * wholesale, last-wins. The shape of "move the monthly run to the 1st"
			 * and of "this fires too often" are the same edit.
			 */
			op: 'schedules.setRecurrence'
			args: {
				scheduleId: ScheduleId
				recurrence: ScheduleRecurrence
				timezone?: string
			}
	  }
	| {
			/**
			 * Stop (or resume) a schedule without losing its declaration or its run
			 * history. The operation an on-call engineer actually wants at 3am.
			 */
			op: 'schedules.pause'
			args: { scheduleId: ScheduleId; paused: boolean }
	  }
	| {
			/**
			 * Remove a schedule declaration — non-additive, like `flags.remove`, and
			 * for the same reason: a vocabulary that can only accumulate schedules
			 * accumulates jobs nobody remembers enabling. Refused while the schedule
			 * is still active, so removal is always a deliberate two-step (pause,
			 * confirm nothing broke, remove).
			 */
			op: 'schedules.remove'
			args: { scheduleId: ScheduleId }
	  }
	| {
			/**
			 * Declare an external data source: an endpoint, the
			 * credential it uses **by name**, a typed mapping from the response onto
			 * entity fields, and the budget it is allowed to spend against somebody
			 * else's server.
			 *
			 * The op refuses two things outright rather than warning about them: a
			 * credential anywhere in the declaration, and an endpoint the runtime
			 * must not reach. Both are validate-time, because a spec that has already
			 * been committed with a secret in it cannot be un-committed.
			 */
			op: 'sources.declare'
			args: { source: SourceSpecInput }
	  }
	| {
			/**
			 * Replace a source's response mapping wholesale, last-wins. A third party
			 * that renames a field in its response is the single most common reason
			 * to touch a source, and the shape of that edit is "here is the new
			 * mapping", not a patch language.
			 */
			op: 'sources.setMapping'
			args: { sourceId: SourceId; mapping: SourceMapping[] }
	  }
	| {
			/**
			 * Replace a source's rate limit and retry budget, last-wins. Separate
			 * from the mapping because it is a different conversation with a
			 * different reviewer: "we are being rate-limited, slow down" has nothing
			 * to do with which fields land where.
			 */
			op: 'sources.setLimits'
			args: { sourceId: SourceId; limits: SourceLimits }
	  }
	| {
			/**
			 * Stop (or resume) a source without losing its declaration or its run
			 * history. The 3am operation, exactly as `schedules.pause` is: the reason
			 * to stop an integration is usually that the other end is misbehaving,
			 * and deleting the declaration to stop it also deletes what you need to
			 * turn it back on.
			 */
			op: 'sources.pause'
			args: { sourceId: SourceId; paused: boolean }
	  }
	| {
			/**
			 * Remove a source declaration — non-additive, like `flags.remove` and
			 * `schedules.remove`, and refused while the source is still active for
			 * the same reason: removal must never be the fastest way to silence a
			 * failing integration.
			 */
			op: 'sources.remove'
			args: { sourceId: SourceId }
	  }
	| {
			/**
			 * Declare a full-text search index: which fields of one
			 * entity are searchable, how much each one counts toward the rank, which
			 * language stems them, and whether the GIN index physically exists.
			 *
			 * It is one op rather than "add a searchable flag to each field" because
			 * a weighting is a statement about the fields *relative to each other*.
			 * Spread across N field declarations, "the title matters more than the
			 * body" is not written down anywhere, and the review that should have
			 * caught a bad ranking is N separate reviews of one boolean each.
			 */
			op: 'search.declare'
			args: { index: SearchIndexSpecInput }
	  }
	| {
			/**
			 * Replace an index's field list and weights wholesale, last-wins. The
			 * edit somebody makes when they add a field and want it searched, or
			 * when the top result for a common query is obviously wrong — which is
			 * always a change to the *relative* weights, never to one of them.
			 */
			op: 'search.setFields'
			args: { indexId: SearchIndexId; fields: SearchField[] }
	  }
	| {
			/**
			 * Create or drop the physical index, leaving the declaration alone.
			 *
			 * The cost lever, and the reason it is its own op is that it is the one
			 * an operator reaches for under load, on a table whose write rate turned
			 * out to be higher than anyone expected. It changes no answer: search
			 * still runs, over the same expression, with the same ranking, as a
			 * sequential scan. And it is reversible in one additive statement,
			 * because an expression index stores nothing that is not derivable from
			 * the columns it reads.
			 */
			op: 'search.setIndexing'
			args: { indexId: SearchIndexId; indexed: boolean }
	  }
	| {
			/**
			 * Remove an index declaration — non-additive, like `flags.remove`, and
			 * refused while the index is still physically present. That ordering is
			 * not ceremony: the DDL is emitted from the declaration, so removing the
			 * declaration first is what would strand a real GIN index on a real
			 * table with nothing left in the spec that knows its name.
			 */
			op: 'search.remove'
			args: { indexId: SearchIndexId }
	  }
	| {
			/**
			 * Declare a document template: which entity's rows it
			 * renders, on what paper, out of which sections, and where the rendered
			 * copy goes.
			 *
			 * It is one op rather than a page whose blocks happen to print because a
			 * document is one row and no viewer. A page is bound to a route and a
			 * session; a document is bound to a primary key, has a page size, and is
			 * read on paper by somebody who never logs in. Modelling it as a page
			 * would mean every one of those properties living somewhere other than
			 * the declaration that needs them.
			 */
			op: 'documents.declare'
			args: { template: DocumentTemplateSpecInput }
	  }
	| {
			/**
			 * Replace a template's section list wholesale, last-wins — the edit
			 * somebody makes when a field should appear on the invoice, or when the
			 * terms paragraph changes.
			 *
			 * Wholesale rather than per-section for the reason `search.setFields` is:
			 * the sections are only correct *relative to each other*. "Move the totals
			 * above the line items" is not an edit to either one.
			 */
			op: 'documents.setSections'
			args: { templateId: DocumentTemplateId; sections: DocumentSection[] }
	  }
	| {
			/**
			 * Change where a rendered document goes, leaving the layout alone.
			 *
			 * Its own op because delivery is the outward-facing half: turning email
			 * on starts sending mail to customers, and turning everything off is how
			 * a template is retired. Somebody reviewing "did this change what our
			 * customers receive" should be able to answer it by reading the op name.
			 */
			op: 'documents.setDelivery'
			args: { templateId: DocumentTemplateId; delivery: DocumentDelivery }
	  }
	| {
			/**
			 * Remove a template declaration — non-additive, like `flags.remove` and
			 * `search.remove`, and refused while any delivery target is still on.
			 *
			 * The ordering is the same argument search's is, in the outward direction:
			 * the URL and the object path are emitted *from* the declaration, so
			 * removing it first turns a bookmarked link into a 404 and an archive
			 * write into an error, with nothing left in the spec that names either.
			 * `documents.setDelivery` with everything false is the retire step.
			 */
			op: 'documents.remove'
			args: { templateId: DocumentTemplateId }
	  }
	| {
			/**
			 * Declare an importer: which entity a file lands in, what
			 * format it arrives as, which column maps to which field, whether an
			 * existing row can be overwritten, and how many rows one run may take.
			 *
			 * It is one op rather than a mapping wizard the server remembers because
			 * a mapping is a *declaration* — committed, diffed, reviewable — and a
			 * mapping somebody drew in a modal is one with no history and no diff.
			 * And it is one op rather than a page with an upload block because an
			 * importer is a write path with an access rule and a destructive lever,
			 * not a rendering.
			 *
			 * Two things the op refuses outright rather than warning about: an upsert
			 * key that cannot identify a row (a boolean one collapses the table onto
			 * two rows on the first run) and a `file` column (only the upload path
			 * mints a storage key). Both are validate-time, because both are silent
			 * at run time and loud only afterwards.
			 */
			op: 'imports.declare'
			args: { importer: ImporterSpecInput }
	  }
	| {
			/**
			 * Replace an importer's column mapping wholesale, last-wins. Wholesale
			 * for the reason `search.setFields` is: a mapping is only correct
			 * relative to the whole file's shape. "The export gained a column and
			 * renamed two" is one edit to one mapping, not three patches, and a patch
			 * language here would let a mapping be half-migrated between two exports.
			 */
			op: 'imports.setMapping'
			args: { importerId: ImporterId; columns: ImportColumn[] }
	  }
	| {
			/**
			 * Change the upsert key — **the one op in this family that decides
			 * whether running the importer can destroy data.**
			 *
			 * That is the entire reason it is not folded into a general-purpose edit
			 * op. A reviewer looking at a diff should be able to answer "can this
			 * overwrite rows we already have?" from the op *name*, before reading a
			 * single argument. `null` is insert-only; a field id means matching rows
			 * are updated in place. Nothing else in the vocabulary changes that
			 * answer, and this op changes nothing else.
			 */
			op: 'imports.setUpsertKey'
			args: { importerId: ImporterId; upsertFieldId: FieldId | null }
	  }
	| {
			/**
			 * Stop (or resume) an importer without losing its declaration, its
			 * mapping or its parser file. The operational lever, exactly as
			 * `sources.pause` is: the reason to stop an importer is usually that a
			 * partner's export changed shape, and deleting the declaration to stop it
			 * also deletes the mapping you need to fix it.
			 */
			op: 'imports.pause'
			args: { importerId: ImporterId; paused: boolean }
	  }
	| {
			/**
			 * Remove an importer declaration — non-additive, like `sources.remove`,
			 * and refused while it is not paused for the same reason: removal must
			 * never be the fastest way to silence something somebody is mid-way
			 * through using. Pause, confirm nothing downstream broke, then remove.
			 */
			op: 'imports.remove'
			args: { importerId: ImporterId }
	  }
	| {
			/**
			 * Declare a portal: which entity faces outward, to whom,
			 * bounded how, showing exactly which fields, accepting exactly which
			 * writes under exactly which budget.
			 *
			 * **This is the highest-consequence op in the vocabulary.** Every other
			 * op changes what the app can do for the people already inside it; this
			 * one decides what somebody who has never signed in can read. So the
			 * declaration is arranged around what it refuses: projection is opt-in
			 * per field with no "all except" spelling, a collection is never
			 * unbounded, an anonymous `update` is unspellable, a row portal must be
			 * token-scoped, and a token always expires.
			 *
			 * Enforcement of every one of those lives in the permission layer and in
			 * the read/write ops — never in a route. Issue #186's finding was that
			 * `/mcp` and the admin loaders reach the data layer without passing a
			 * route-level gate, so a route-level projection would be a gate two of
			 * the three callers skip.
			 */
			op: 'portals.declare'
			args: { portal: PortalSpecInput }
	  }
	| {
			/**
			 * Replace a portal's field projection wholesale, last-wins — **the
			 * exposure edit.**
			 *
			 * Its own op so that "what can the outside see?" is answerable from the
			 * op *name*, before reading a single argument, and so a diff that widens
			 * a public surface never arrives disguised as a general-purpose edit.
			 * Wholesale for `search.setFields`' reason: a projection is only correct
			 * relative to the whole audience, and a patch language here would let one
			 * be half-migrated between two reviews.
			 */
			op: 'portals.setFields'
			args: { portalId: PortalId; readFields: FieldId[] }
	  }
	| {
			/**
			 * Replace a portal's write surface wholesale, last-wins.
			 *
			 * Separate from `portals.setFields` because turning on an anonymous
			 * `create` is a different decision from showing one more column, and the
			 * two should not share a diff line. Everything a write carries is
			 * required here as it is in the declaration — the field allowlist and the
			 * hourly budget — so widening a write path can never happen by omission.
			 */
			op: 'portals.setWrites'
			args: { portalId: PortalId; writes: PortalWrite[] }
	  }
	| {
			/**
			 * Take a portal offline, or put it back.
			 *
			 * **This is the op somebody runs at 3am**, and the whole design of it is
			 * that it requires removing nothing: the declaration, the projection and
			 * every minted token survive, so bringing the surface back is one op
			 * rather than a re-review. It is also the retire step `portals.remove`
			 * insists on first.
			 */
			op: 'portals.pause'
			args: { portalId: PortalId; paused: boolean }
	  }
	| {
			/**
			 * Remove a portal declaration — non-additive, like `sources.remove` and
			 * `imports.remove`, and refused while it is not paused for the same
			 * reason: removal must never be the fastest way to silence something
			 * somebody is mid-way through using. Pause, confirm nothing downstream
			 * broke, then remove.
			 */
			op: 'portals.remove'
			args: { portalId: PortalId }
	  }
	| {
			/**
			 * Declare a live channel: which entity a subscriber follows,
			 * whether they receive rows or identities, bounded to which rows, carrying
			 * exactly which columns, under exactly which subscriber and message
			 * ceilings.
			 *
			 * **The whole risk of this layer is scope, so the declaration is arranged
			 * around what it cannot say.** There is no event kind, no caller-composed
			 * payload, no cursor position and no per-keystroke channel — every message
			 * exists because a row changed, which is exactly what makes it
			 * authorizable as a read of that row. Conflict resolution beyond
			 * last-write-wins is out by recorded decision (`d-live-last-write-wins`),
			 * not by omission.
			 *
			 * Both ceilings are required rather than defaulted for the reason
			 * `SearchIndexSpec.indexed` and `ImporterSpec.maxRows` are: how much load
			 * a declaration puts on a deployment is a decision about that deployment.
			 */
			op: 'live.declare'
			args: { subscription: LiveSubscriptionSpecInput }
	  }
	| {
			/**
			 * Replace a channel's pushed columns wholesale, last-wins — **the payload
			 * edit.**
			 *
			 * Its own op so that "what does a subscriber actually receive?" is
			 * answerable from the op *name*. A push is a read; what it carries is its
			 * own review, exactly as `portals.setFields` is its own review. Wholesale
			 * for `search.setFields`' reason: a projection is only correct relative to
			 * the whole channel, and a patch language would let one be half-migrated
			 * between two reviews.
			 */
			op: 'live.setFields'
			args: { subscriptionId: LiveId; fields: FieldId[] }
	  }
	| {
			/**
			 * Replace a channel's two ceilings — **the load lever.**
			 *
			 * This is the op an operator reaches for when a channel is the reason the
			 * app is slow, and it is separate from `live.setFields` because "we are
			 * sending too much" and "we are sending the wrong thing" are different
			 * problems diagnosed by different people. Precedent: `sources.setLimits`,
			 * which exists for the identical reason on the identical kind of number.
			 *
			 * Both values are required together rather than individually optional: a
			 * subscriber ceiling and a message rate multiply into the load this
			 * process actually carries, and letting one be adjusted without restating
			 * the other is how the product of the two stops being something anybody
			 * reviewed.
			 */
			op: 'live.setLimits'
			args: {
				subscriptionId: LiveId
				maxSubscribers: number
				maxMessagesPerMinute: number
			}
	  }
	| {
			/**
			 * Take a channel offline, or put it back — **the 3am lever.**
			 *
			 * It removes nothing: the declaration, the projection and both ceilings
			 * survive, so bringing the channel back is one op rather than a
			 * re-review. It is safe to pull *because subscribers fall back to
			 * polling* — a paused channel makes the app slower, not broken, which is
			 * the property that makes shedding a real option under load rather than a
			 * last resort. It is also the retire step `live.remove` insists on first.
			 */
			op: 'live.pause'
			args: { subscriptionId: LiveId; paused: boolean }
	  }
	| {
			/**
			 * Remove a live declaration — non-additive, like `sources.remove`,
			 * `imports.remove` and `portals.remove`, and refused while it is not
			 * paused for the same reason: removal must never be the fastest way to
			 * silence something somebody is mid-way through using. Pause, confirm the
			 * polling fallback carried the surface, then remove.
			 */
			op: 'live.remove'
			args: { subscriptionId: LiveId }
	  }
	| {
			op: 'provenance.review'
			args: {
				target: ReviewTarget
				action: ReviewActionName
				/**
				 * Also decide the target's still-undecided nested rows (an entity's
				 * fields, a page's blocks). Cascading touches ONLY rows whose derived
				 * state is `suggested` — including the target itself — so it can never
				 * flip a settled or manual row.
				 */
				cascade?: boolean
			}
	  }

export type SpecOpName = SpecOp['op']

export const SPEC_OP_NAMES = [
	'prd.addRequirement',
	'prd.addScopeItem',
	'prd.addRisk',
	'prd.addMetric',
	'prd.recordDecision',
	'data.addEntity',
	'data.addField',
	'data.setFieldReference',
	'data.setFieldOpenReference',
	'data.setFieldLimits',
	'data.setFieldDisplay',
	'data.addComputed',
	'data.addRollup',
	'page.addPage',
	'page.addBlock',
	'page.setBlockOrder',
	'page.setBlockVariant',
	'page.setBlockFields',
	'page.setBlockEditable',
	'page.setE2ETests',
	'page.addCalendar',
	'page.addTimeline',
	'page.addBoard',
	'pricing.addTier',
	'theme.set',
	'flags.declare',
	'flags.setTargeting',
	'flags.gate',
	'flags.remove',
	'schedules.declare',
	'schedules.setRecurrence',
	'schedules.pause',
	'schedules.remove',
	'sources.declare',
	'sources.setMapping',
	'sources.setLimits',
	'sources.pause',
	'sources.remove',
	'search.declare',
	'search.setFields',
	'search.setIndexing',
	'search.remove',
	'documents.declare',
	'documents.setSections',
	'documents.setDelivery',
	'documents.remove',
	'imports.declare',
	'imports.setMapping',
	'imports.setUpsertKey',
	'imports.pause',
	'imports.remove',
	'portals.declare',
	'portals.setFields',
	'portals.setWrites',
	'portals.pause',
	'portals.remove',
	'live.declare',
	'live.setFields',
	'live.setLimits',
	'live.pause',
	'live.remove',
	'provenance.review',
] as const satisfies readonly SpecOpName[]

// ---------------------------------------------------------------------------
// Per-op argument schemas — what makes the `ops` vocabulary self-describing
// ---------------------------------------------------------------------------

/**
 * A JSON-Schema node describing one arg (or nested arg). Deliberately a small,
 * hand-rolled subset — enough to express the op arg shapes (objects, arrays,
 * enums, string-or-object unions, nullable keys) without pulling a full
 * JSON-Schema dependency into the base spec package. `type` accepts a string
 * array for nullable keys (`['string','null']`), which is valid JSON Schema.
 */
export interface OpArgProperty {
	type?: string | readonly string[]
	description?: string
	enum?: readonly string[]
	pattern?: string
	properties?: Record<string, OpArgProperty>
	required?: readonly string[]
	items?: OpArgProperty
	oneOf?: readonly OpArgProperty[]
}

/** The JSON Schema for one op's `args` object. */
export interface OpArgSchema {
	type: 'object'
	properties: Record<string, OpArgProperty>
	required?: readonly string[]
}

/**
 * `provenance` is OPTIONAL on every add-op payload and best OMITTED — `applyOp`
 * stamps the correct default (accepted). Modelled so the accepted shape is
 * discoverable, with the "omit it" guidance in the description rather than by
 * leaving agents to find out at write time.
 */
const PROVENANCE_PROP: OpArgProperty = {
	type: 'object',
	description:
		'OPTIONAL — best OMITTED; the server stamps the correct default (accepted). If supplied it must be the full 5-key object.',
	properties: {
		isSuggested: { type: 'boolean' },
		isAccepted: { type: ['boolean', 'null'], description: 'null = undecided.' },
		isAddedManually: { type: ['boolean', 'null'] },
		suggestedDescription: { type: ['string', 'null'] },
		priority: { type: 'string', enum: ['medium', 'high'] },
	},
	required: [
		'isSuggested',
		'isAccepted',
		'isAddedManually',
		'suggestedDescription',
		'priority',
	],
}

const RATIONALE_PROP: OpArgProperty = {
	type: 'object',
	properties: {
		reasoning: { type: 'string' },
		heuristicApplied: { type: 'string' },
	},
	required: ['reasoning'],
}

const ESTIMATE_PROP: OpArgProperty = {
	type: 'object',
	description: 'confidence is 0–1.',
	properties: {
		effort: { type: 'number' },
		impact: { type: 'number' },
		confidence: { type: 'number' },
	},
	required: ['effort', 'impact', 'confidence'],
}

/**
 * The computed-field expression AST.
 *
 * JSON Schema would express the recursion with `$ref` to a named definition,
 * which the hand-rolled {@link OpArgProperty} subset does not model. The obvious
 * workaround — unrolling a few levels — was tried and reverted: it rendered four
 * near-identical nested blocks into the generated reference doc, which taught a
 * reader strictly less than one level plus an honest sentence saying it recurses.
 *
 * So: one level, a worked example in the description, and the *validator* is what
 * enforces the real shape and depth ({@link MAX_COMPUTED_DEPTH}).
 */
const COMPUTED_EXPR_PROP: OpArgProperty = {
	type: 'object',
	description:
		"Closed arithmetic AST over the row's own NUMBER fields — no strings, no parsing, no eval. " +
		'One of {kind:"field",field:"fld-…"} · {kind:"literal",value:<number>} · ' +
		'{kind:"binary",op:"+|-|*|/",left:<node>,right:<node>}, where each operand is itself a node ' +
		`of the same three shapes (nesting up to ${MAX_COMPUTED_DEPTH} deep). ` +
		'e.g. estimated 1RM = weight * (1 + reps/30) is {kind:"binary",op:"*",' +
		'left:{kind:"field",field:"fld-weight"},right:{kind:"binary",op:"+",' +
		'left:{kind:"literal",value:1},right:{kind:"binary",op:"/",' +
		'left:{kind:"field",field:"fld-reps"},right:{kind:"literal",value:30}}}}.',
	properties: {
		kind: { type: 'string', enum: ['field', 'literal', 'binary'] },
		field: { type: 'string', description: 'kind:"field" — a number field id.' },
		value: { type: 'number', description: 'kind:"literal" — a finite number.' },
		op: { type: 'string', enum: [...COMPUTED_OPERATORS] },
		left: {
			type: 'object',
			description:
				'kind:"binary" — the left operand, itself an expression node.',
		},
		right: {
			type: 'object',
			description:
				'kind:"binary" — the right operand, itself an expression node.',
		},
	},
	required: ['kind'],
}

/** A field as an op author writes it (options accepts bare strings). */
const FIELD_INPUT_PROP: OpArgProperty = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'branded id, prefix "fld-".' },
		name: { type: 'string' },
		type: {
			type: 'string',
			enum: [...FIELD_TYPES],
			description:
				'one of the seven canonical types; "text" is CLI sugar and is rejected in a raw op (use "string"). "file" stores a storage key and requires the "file" block below. "date" is a timestamp WITHOUT time zone — a wall clock, not an instant; it reads back as "2026-03-08 09:00:00" and re-zoning such a value moves it by the offset. The generated API says the same thing from the other side: it takes the wall clock as written and DISCARDS a trailing "Z" or "+HH:MM" rather than shifting the value.',
		},
		required: { type: 'boolean' },
		reference: {
			type: 'string',
			description:
				'target entity id (e-…) for a belongs-to FK; the virtual "e-user" grounds to the auth user table.',
		},
		options: {
			type: 'array',
			description:
				'enum options for type:"enum" — bare strings like ["book","article"] are canonicalized to {label,value}.',
			items: {
				oneOf: [
					{ type: 'string' },
					{
						type: 'object',
						properties: {
							label: { type: 'string' },
							value: { type: 'string' },
						},
						required: ['label', 'value'],
					},
				],
			},
		},
		file: {
			type: 'object',
			description:
				'required for type:"file", rejected on every other type. The column stores a storage key; the runtime re-signs it into a short-lived URL on read.',
			properties: {
				accept: {
					type: 'array',
					description:
						'MIME allowlist, e.g. ["image/png","image/jpeg"] or ["image/*"]. Non-empty; a bare "*" wildcard is rejected.',
					items: { type: 'string' },
				},
				maxSizeBytes: {
					type: 'number',
					description: `hard per-file cap in bytes, enforced server-side (max ${FILE_MAX_SIZE_CEILING}).`,
				},
				derivatives: {
					type: 'array',
					description:
						'image variants materialized at upload, addressable as "<key>@<name>". Image-only allowlists.',
					items: {
						type: 'object',
						properties: {
							name: {
								type: 'string',
								description: 'lowercase slug, e.g. "thumb".',
							},
							width: { type: 'number' },
							height: { type: 'number' },
							fit: { type: 'string', enum: ['cover', 'contain'] },
						},
						required: ['name', 'width'],
					},
				},
			},
			required: ['accept', 'maxSizeBytes'],
		},
		rank: {
			type: 'boolean',
			description:
				'type:"string" only — marks the field a manual-ordering key: never null (database default), hidden and read-only in forms, and the column a board orders cards by.',
		},
		limits: {
			type: 'object',
			description:
				'type:"enum" only — per-value row caps ({"doing":3} = a WIP limit of 3). Enforced on every create/update, not just in the UI. Keys must be declared option values.',
		},
		provenance: PROVENANCE_PROP,
	},
	required: ['id', 'name', 'type', 'required'],
}

const BLOCK_ORDER_PROP: OpArgProperty = {
	type: 'object',
	properties: {
		field: {
			type: 'string',
			description: 'a field on the page’s backing entity, e.g. "points".',
		},
		direction: {
			type: 'string',
			enum: ['asc', 'desc'],
			description: 'defaults to "asc".',
		},
	},
	required: ['field'],
}

/** A block as an op author writes it. */
const BLOCK_INPUT_PROP: OpArgProperty = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'branded id, prefix "blk-".' },
		type: {
			type: 'string',
			description:
				'a template-registry key: "table", "form", "hero", "slot:<name>", …',
		},
		variant: {
			type: 'string',
			enum: [...BLOCK_VARIANTS],
			description: 'presentation for list/table blocks.',
		},
		order: BLOCK_ORDER_PROP,
		mode: {
			type: 'string',
			enum: ['append', 'replace'],
			description: 'only meaningful on slot:<name> blocks.',
		},
		provenance: PROVENANCE_PROP,
	},
	required: ['id', 'type'],
}

/**
 * Who a flag is *also* on for. Every key is an OR over the flag's
 * default, which is why the validator rejects targeting on a default-true flag:
 * there is nothing left for it to turn on.
 */
/**
 * A schedule's recurrence. Modelled as one object with a `kind`
 * discriminator and the union of the per-kind keys, because the hand-rolled
 * schema subset here has no discriminated-union node — the *validator* rejects
 * a key that does not belong to the declared kind, so an agent that reads this
 * schema and guesses wrong gets a named error rather than a silent misfire.
 */
const SCHEDULE_RECURRENCE_PROP: OpArgProperty = {
	type: 'object',
	description:
		'how often it fires. Deliberately not a cron string: `0 0 31 * *` silently skips four months a year and cannot carry a timezone at all.',
	properties: {
		kind: { type: 'string', enum: [...SCHEDULE_RECURRENCE_KINDS] },
		everyMinutes: {
			type: 'number',
			description: `kind:"interval" only — integer ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES}, elapsed absolute time anchored on the declaration date (so DST never doubles or skips it).`,
		},
		atTime: {
			type: 'string',
			pattern: SCHEDULE_TIME_RE.source,
			description:
				'kind:"daily"/"weekly"/"monthly" — HH:MM, read on the clock in the declared timezone.',
		},
		onWeekday: {
			type: 'number',
			description: 'kind:"weekly" only — integer 0–6, 0 = Sunday.',
		},
		onDayOfMonth: {
			type: 'number',
			description:
				'kind:"monthly" only — integer 1–31. A day past the end of a short month clamps to that month’s last day; it is never skipped and never rolls into the next month.',
		},
	},
	required: ['kind'],
}

/**
 * Who a scheduled run is. Required on `schedules.declare` with no default —
 * see the module note on `schedules.ts`.
 */
const SCHEDULE_RUN_AS_PROP: OpArgProperty = {
	type: 'object',
	description:
		'whose authority every run carries. REQUIRED, no default, and no admin shorthand: scheduled work that acquires authority nobody wrote down is an authorization bypass with a cron expression in front of it.',
	properties: {
		kind: { type: 'string', enum: [...SCHEDULE_RUN_AS_KINDS] },
		role: {
			type: 'string',
			description:
				'kind:"service" — a named service role, resolved through the same RBAC/entitlement path a human session is.',
		},
		userId: {
			type: 'string',
			description:
				'kind:"user" — the user whose role, org and plan the run gets.',
		},
		orgId: {
			type: 'string',
			description:
				'optional — the organization the run acts in. Required in practice for work that touches tenant-scoped data: a background run has no request, so it has no org switcher to resolve one from, and without this it reaches no tenant-scoped row at all. Re-verified against membership at run time for kind:"user"; taken as declared for kind:"service". Mutually exclusive with eachOrg.',
		},
		eachOrg: {
			type: 'boolean',
			description: `optional — run once PER ORG instead of once in one declared org: the tenant-scoped answer for an app that needs the same nightly work for every customer, rather than one schedule per customer that somebody has to add on signup and remove on churn. Every org for kind:"service"; the orgs they are a member of (verified at run time) for kind:"user". Bounded at ${MAX_FANOUT_ORGS} runs per occurrence — a fan-out spends a request per tenant against somebody else's rate limit on every fire — and a wider one runs the bound's worth and reports what it left out. Cannot be combined with orgId.`,
		},
		maxOrgs: {
			type: 'number',
			description: `optional, eachOrg only — lower the fan-out bound below ${MAX_FANOUT_ORGS}. An integer 1–${MAX_FANOUT_ORGS}.`,
		},
	},
	required: ['kind'],
}

// ---------------------------------------------------------------------------
// External-source arg shapes
//
// These descriptions are the surface an agent reads before it writes a source
// declaration, so the two refusals it is most likely to trip are stated in the
// schema itself rather than discovered from an error: a credential in the spec,
// and an endpoint the runtime will not reach.
// ---------------------------------------------------------------------------

const SOURCE_AUTH_PROP: OpArgProperty = {
	type: 'object',
	description:
		'how the request authenticates. REQUIRED — {kind:"none"} states that the endpoint is public. Every other variant carries secretName, which is the NAME of a deployment secret (e.g. "OPENLIBRARY_TOKEN"), NEVER the secret. A credential-shaped string anywhere in this op is refused: a spec is committed, diffed, shown in the workbench and passed to agents, so one leak is every leak.',
	properties: {
		kind: { type: 'string', enum: [...SOURCE_AUTH_KINDS] },
		secretName: {
			type: 'string',
			pattern: SECRET_NAME_RE.source,
			description:
				'kind:"bearer"/"header"/"query" — the secret’s NAME, env-var shaped and uppercase.',
		},
		header: {
			type: 'string',
			description: 'kind:"header" — the header the secret is sent in.',
		},
		param: {
			type: 'string',
			description: 'kind:"query" — the query parameter the secret is sent in.',
		},
	},
	required: ['kind'],
}

const SOURCE_REQUEST_PROP: OpArgProperty = {
	type: 'object',
	description:
		'the request issued. Its origin IS the allowlist: the runtime refuses anything else and never follows a redirect.',
	properties: {
		url: {
			type: 'string',
			description:
				'absolute https URL. No credentials, no fragment, port 443/8443 or none, and never an internal address (loopback / link-local / RFC1918 / CGNAT, in every spelling). In enrich mode it may carry {fieldName} placeholders resolved from the triggering row and percent-encoded by the runtime.',
		},
		method: { type: 'string', enum: [...SOURCE_METHODS] },
		query: {
			type: 'object',
			description:
				'static query parameters; values may carry {fieldName} placeholders. Credential parameter names (key, api_key, token, access_token, secret, signature, …) are refused — use auth.',
		},
		headers: {
			type: 'object',
			description:
				'static request headers. Credential header names (authorization, x-api-key, cookie, …) are refused outright — use auth.',
		},
	},
	required: ['url'],
}

const SOURCE_MAPPING_PROP: OpArgProperty = {
	type: 'array',
	description: `response paths → entity fields. 1–${MAX_SOURCE_MAPPINGS} entries. The mapping is typed by the TARGET COLUMN's declared type — there is no second type to drift from it — and a value that cannot be coerced is dropped with a reason rather than written as a lie.`,
	items: {
		type: 'object',
		properties: {
			from: {
				type: 'string',
				description:
					'path into the response: dotted keys and [n] indices, e.g. "cover.large" or "authors[0].name". No wildcards, no filters, no expressions.',
			},
			to: { type: 'string', description: 'field id on the source’s entity.' },
		},
		required: ['from', 'to'],
	},
}

const SEARCH_FIELDS_PROP: OpArgProperty = {
	type: 'array',
	description: `which fields are searchable and how much each counts toward the rank. 1–${MAX_SEARCH_FIELDS} entries, no field twice. Order does not matter — the emitted index is sorted by weight, so two specs that declare the same weighting produce the same index.`,
	items: {
		type: 'object',
		properties: {
			fieldId: {
				type: 'string',
				description: `field id (prefix "fld-") of the index's entity. Must be a ${searchableFieldTypes.join(' or ')} field: a reference stores an id rather than text, and a number/boolean/date is already answerable by a filter, exactly and with an index.`,
			},
			weight: {
				type: 'string',
				enum: [...SEARCH_WEIGHTS],
				description: `how much a match here counts: ${SEARCH_WEIGHTS.map((w) => `${w}=${SEARCH_WEIGHT_FACTORS[w]}`).join(', ')}. Postgres's own four levels, not a scale this vocabulary invented — a tsvector holds exactly four, so a wider scale would silently round.`,
			},
		},
		required: ['fieldId', 'weight'],
	},
}

const SOURCE_LIMITS_PROP: OpArgProperty = {
	type: 'object',
	description:
		'how hard this app may lean on somebody else’s server, and how patiently it waits. Every key is REQUIRED: an inherited retry policy against a third party is how a transient 503 becomes a self-inflicted denial of service the partner notices first.',
	properties: {
		requestsPerMinute: {
			type: 'number',
			description: `integer ${SOURCE_LIMIT_BOUNDS.minRequestsPerMinute}–${SOURCE_LIMIT_BOUNDS.maxRequestsPerMinute}, across the whole deployment.`,
		},
		timeoutMs: {
			type: 'number',
			description: `integer ${SOURCE_LIMIT_BOUNDS.minTimeoutMs}–${SOURCE_LIMIT_BOUNDS.maxTimeoutMs} — a hung socket is not a retry.`,
		},
		maxAttempts: {
			type: 'number',
			description: `integer ${SOURCE_LIMIT_BOUNDS.minAttempts}–${SOURCE_LIMIT_BOUNDS.maxAttempts}, including the first. 1 = no retry.`,
		},
		backoffMs: {
			type: 'number',
			description: `integer ${SOURCE_LIMIT_BOUNDS.minBackoffMs}–${SOURCE_LIMIT_BOUNDS.maxBackoffMs} — the first backoff; it doubles per attempt.`,
		},
	},
	required: ['requestsPerMinute', 'timeoutMs', 'maxAttempts', 'backoffMs'],
}

const SOURCE_TRIGGERS_PROP: OpArgProperty = {
	type: 'array',
	description:
		'what runs the source. enrich: create/update/manual. sync: schedule/webhook/manual. A create/update trigger ENQUEUES work — enrichment never runs inline in a write, so a source that is down cannot fail a create.',
	items: {
		type: 'object',
		properties: {
			kind: { type: 'string', enum: [...SOURCE_TRIGGER_KINDS] },
			scheduleKey: {
				type: 'string',
				description:
					'kind:"schedule" — the key of an already-declared schedule (schedules.declare).',
			},
		},
		required: ['kind'],
	},
}

const SOURCE_COLLECTION_PROP: OpArgProperty = {
	type: 'object',
	description:
		'sync mode only, and REQUIRED there: how the response’s records are found and keyed. Without a stable remote id every run appends the same rows again.',
	properties: {
		path: {
			type: 'string',
			description:
				'path to the array of records; omit when the response document IS the array.',
		},
		idPath: {
			type: 'string',
			description: 'path, within one record, to its stable remote id.',
		},
		idField: {
			type: 'string',
			description:
				'the STRING field id the remote id is stored in — the upsert key. Stored, not hidden: "which remote record is this" is a question support asks.',
		},
		maxRecords: {
			type: 'number',
			description: `integer 1–${MAX_SYNC_RECORDS}; a run that hits the bound reports the truncation rather than hiding it.`,
		},
	},
	required: ['idPath', 'idField', 'maxRecords'],
}

const FLAG_TARGETING_PROP: OpArgProperty = {
	type: 'object',
	description:
		'who the flag is ALSO on for, beyond its default. Keys are OR-ed. Rejected when default is already true.',
	properties: {
		roles: {
			type: 'array',
			description: 'roles the flag is on for, e.g. ["admin"].',
			items: { type: 'string' },
		},
		organizations: {
			type: 'array',
			description: 'organization ids the flag is on for.',
			items: { type: 'string' },
		},
		rolloutPercent: {
			type: 'number',
			description: `integer 0–${MAX_ROLLOUT_PERCENT}; a stable hash bucket of subject:key, so ramping up never turns anyone back off. A viewer with no subject id is never bucketed on.`,
		},
	},
}

/**
 * The section vocabulary as an arg schema. Deliberately flat and closed: an
 * agent reading this sees six kinds and no way to nest them, which is the same
 * message the type is sending.
 */
const IMPORT_COLUMNS_PROP: OpArgProperty = {
	type: 'array',
	description: `which file column lands on which entity field. 1–${MAX_IMPORT_COLUMNS} entries, no column twice and no FIELD twice — two columns writing one field is data loss whose winner depends on declaration order. The cell is parsed as the TARGET FIELD's declared type, so there is no second type here to drift from the column's, and there is deliberately no transform language: splitting a value or looking one up is what the parser slot is for.`,
	items: {
		type: 'object',
		properties: {
			column: {
				type: 'string',
				description:
					'the header name (csv) or object key (ndjson/json, and whatever a custom parser yields). Matched exactly, after trimming.',
			},
			fieldId: {
				type: 'string',
				description: `field id (prefix "fld-") of THIS importer's entity — checked against its owner, because an id from another entity resolves and would map this file's column onto somebody else's table. Importable types: ${importableFieldTypes.join(', ')}. A file field is refused: it stores a storage key only the upload path can mint, so a value from a file would be a key nobody minted.`,
			},
		},
		required: ['column', 'fieldId'],
	},
}

const IMPORT_UPSERT_KEY_PROP: OpArgProperty = {
	type: ['string', 'null'],
	description: `the field that decides whether a row ALREADY EXISTS — the single lever that decides whether running this importer can overwrite somebody's data. REQUIRED and nullable, never defaulted. null = insert-only: every line becomes a new row and nothing existing is touched. A field id = matching rows are updated in place. Must be one of ${upsertKeyFieldTypes.join(', ')}, must not be a reference, and must also appear in the column mapping — a key can only identify a row if the file supplies it, and one that does not silently degrades to insert-only, i.e. duplicates. A boolean key is refused because it collapses the whole table onto two rows on the first run; a date matches either nothing or everything sharing a day; equality on json is equality on its serialization.`,
}

/**
 * The field projection, in the arg vocabulary an agent reads.
 *
 * The description is longer than the type warrants on purpose: this is the one
 * argument in the whole vocabulary where the *absence* of a spelling is the
 * design, and an agent that does not know there is no "all" will try to find it.
 */
const PORTAL_READ_FIELDS_PROP: OpArgProperty = {
	type: 'array',
	description: `EXACTLY the fields this audience may read — 1–${MAX_PORTAL_FIELDS} field ids (prefix "fld-") of THIS portal's entity, checked against its owner because an id from another entity resolves and would project somebody else's column. There is deliberately NO "expose everything" value and NO exclusion list: an "all except" list silently exposes every field added AFTER it was written, which is the exact failure this layer exists to prevent. The runtime rebuilds each row from this list plus the primary key and drops every other key — including derived values, the soft-delete column and the tenant column. A public or token portal may not name a file field (it holds a storage key, i.e. an object path into the bucket) or a reference to e-user (an identity-table primary key, i.e. a way to enumerate accounts).`,
	items: { type: 'string' },
}

const PORTAL_WRITES_PROP: OpArgProperty = {
	type: 'array',
	description: `What the outside may WRITE. [] means read-only, and that is the common case. At most one entry per action. A "public" portal may declare "create" (a comment form) but NEVER "update": anonymous update means anyone on the internet may edit a row that already exists, and there is no honest product reason to spell that. There is no "delete" at all — not a declaration, not a spelling, no path. A row-scoped portal may not declare "create", because a create reaches a row that does not exist yet and is therefore outside the bound.`,
	items: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: [...PORTAL_WRITE_ACTIONS],
				description:
					'"create" or "update". Nothing else exists, and "delete" is absent by construction rather than by omission.',
			},
			fieldIds: {
				type: 'array',
				description: `the ONLY fields this write may set, opt-in per field. A payload naming anything else is REFUSED, not silently stripped: a caller who thinks their value landed and finds it did not is worse off than one who got an error. May not name the collection filter's field — the bound is server-stamped on create and immutable on update, exactly as the tenant column is, because a writable bound is a portal that can write a row out of its own filter.`,
				items: { type: 'string' },
			},
			rateLimitPerHour: {
				type: 'number',
				description: `integer 1–${MAX_PORTAL_WRITE_RATE}, and at most ${MAX_PUBLIC_WRITE_RATE} for an unauthenticated ("public") portal. REQUIRED, never defaulted: writes from the outside are always budgeted, and how many an hour is acceptable belongs to whoever owns the table. Enforced at the write op, not at the route — and a host with no limiter wired gets NO portal writes rather than unlimited ones.`,
			},
		},
		required: ['action', 'fieldIds', 'rateLimitPerHour'],
	},
}

const PORTAL_FILTER_PROP: OpArgProperty = {
	type: 'object',
	description: `The bound on which rows the outside can enumerate. REQUIRED for scope "collection", refused for scope "row". A collection portal is never unbounded — "the outside can list this table" is not a feature anybody means to ship; "the outside can list the PUBLISHED posts of THIS author" is. It is forced after any caller-supplied filter, exactly as the tenant and soft-delete scopes are, so nothing a caller sends can widen it, and it is server-stamped on create so a portal cannot write a row outside its own bound.`,
	properties: {
		fieldId: {
			type: 'string',
			description: `field id of this portal's entity. Must be one of ${portalFilterFieldTypes.join(', ')}: a bound has to be an equality somebody can read, and a date bound matches a microsecond while a json bound matches a serialization.`,
		},
		equals: {
			type: ['string', 'number', 'boolean'],
			description:
				'the value the bound column must hold. Its type must match the field’s declared type — a mismatched bound matches nothing in Postgres and everything in a reviewer’s head.',
		},
	},
	required: ['fieldId', 'equals'],
}

/**
 * A live channel's pushed columns, in the arg vocabulary an agent reads.
 *
 * Longer than the type warrants, on `PORTAL_READ_FIELDS_PROP`'s reasoning: the
 * *absence* of an "all" spelling is the design, and an agent that does not know
 * that will hunt for one.
 */
const LIVE_FIELDS_PROP: OpArgProperty = {
	type: 'array',
	description: `EXACTLY the columns a change notification carries — 1–${MAX_LIVE_FIELDS} field ids (prefix "fld-") of THIS subscription's entity, checked against its owner because an id from another entity resolves and would push somebody else's column. There is deliberately NO "push everything" value and NO exclusion list: a push is a read, and an "all except" list silently pushes every column added AFTER it was written. Only ${pushableFieldTypes.join(', ')} may be pushed: a file field is refused outright, because it holds a storage key, i.e. an object path into the bucket, and putting one on a push hands that URL to everybody holding the channel open, on every write. MUST BE EMPTY for kind "presence": presence reports identities and never row data.`,
	items: { type: 'string' },
}

const LIVE_SCOPE_PROP: OpArgProperty = {
	type: 'object',
	description: `The bound on which rows a subscriber may follow. REQUIRED and never unbounded by omission — a subscription with no bound is a broadcast of the whole table, which is the storm this layer exists to make unspellable. "row" = the one row a subscriber names, and the ONLY legal scope for kind "presence" (presence is "who is viewing THIS record"; anything wider is a live directory of everyone in the app). "filtered" = the rows sharing one column value (a project's tasks, a thread's posts) — the shape that scales, because the fan-out set is a fraction of the table. "all" = every row: legitimate for a small internal ops dashboard, a disaster for a customer-facing list, and therefore capped at ${MAX_UNBOUNDED_SUBSCRIBERS} subscribers.`,
	properties: {
		kind: { type: 'string', enum: [...LIVE_SCOPE_KINDS] },
		fieldId: {
			type: 'string',
			description: `REQUIRED for kind "filtered", refused otherwise. A field id of this subscription's entity, of type ${liveScopeFieldTypes.join(', ')}: a bound has to be an equality somebody can read, and a date bound matches a microsecond while a json bound matches a serialization.`,
		},
	},
	required: ['kind'],
}

const LIVE_MAX_SUBSCRIBERS_PROP: OpArgProperty = {
	type: 'number',
	description: `integer 1–${MAX_LIVE_SUBSCRIBERS}, and at most ${MAX_UNBOUNDED_SUBSCRIBERS} when the scope is "all". REQUIRED, never defaulted: how many connections this channel may hold open is a decision about somebody's deployment, and a default is that decision made by whoever wrote the generator. A connection over the cap is REFUSED with a stated status rather than queued — a queue for connections is a slower way to run out of file descriptors.`,
}

const LIVE_MAX_RATE_PROP: OpArgProperty = {
	type: 'number',
	description: `integer 1–${MAX_LIVE_MESSAGE_RATE}, per subscriber. REQUIRED, never defaulted. A subscriber over it is SHED — disconnected with a reason — rather than buffered: an unbounded buffer is how one slow client takes the process down, and a bounded buffer that silently drops leaves a subscriber whose view is wrong with nothing telling it so. It reconnects and re-reads, which is a correct view rather than a stale one.`,
}

const DOCUMENT_SECTIONS_PROP: OpArgProperty = {
	type: 'array',
	description: `the document, top to bottom. 1–${MAX_DOCUMENT_SECTIONS} entries. There is no nesting, no width and no color: a section is a heading, a paragraph, a labelled block of this row’s fields, a table of related rows, a rule, or a slot for bespoke layout. Styling comes from the app’s theme (theme.set), so a document matches the product without declaring anything.`,
	items: {
		type: 'object',
		properties: {
			kind: { type: 'string', enum: [...DOCUMENT_SECTION_KINDS] },
			level: {
				type: 'number',
				description:
					'kind:"heading" — 1 for the document title, 2 for a section head. There is no 3.',
			},
			text: {
				type: 'string',
				description:
					'kind:"heading"/"text" — the words. May carry {fieldName} placeholders resolved against the row (e.g. "Invoice {number}"); a placeholder that is not a field or derived value on the entity is refused here rather than printed literally on something a customer receives. There is deliberately no {today}: same row + same template must give the same bytes, and an issue date is a date FIELD on the row.',
			},
			fieldIds: {
				type: 'array',
				description: `kind:"fields"/"table" — field ids (prefix "fld-") or derived-value ids (prefix "drv-"), in print order. Up to ${MAX_DOCUMENT_SECTION_FIELDS} in a fields block and ${MAX_DOCUMENT_TABLE_COLUMNS} in a table. Derived values are included on purpose: an invoice total is a rollup you already declared, so this layer ships no arithmetic of its own. Only ${printableFieldTypes.join(', ')} fields print — json is punctuation and file holds a storage key.`,
				items: { type: 'string' },
			},
			columns: {
				type: 'number',
				description:
					'kind:"fields" — 1 or 2. Pairs down one column or two; two is the shape of an address block. There is no 3, because a third column is a layout language.',
			},
			caption: {
				type: 'string',
				description:
					'kind:"fields"/"table" — optional block caption ("Bill to"). Placeholders allowed.',
			},
			over: {
				type: 'string',
				description: `kind:"table" — entity id (prefix "e-") on the many side. Spelled exactly as a rollup spells it, because it means exactly the same thing. At most ${MAX_DOCUMENT_TABLE_ROWS} rows print, and a row past that is reported on the page ("showing the first N of M") rather than dropped — a document that quietly omits billable lines is the worst bug this feature could have.`,
			},
			via: {
				type: 'string',
				description:
					'kind:"table" — the field id on `over` that references THIS template’s entity. Checked against its target, not just its existence: a via pointing at some other entity would fetch rows and print somebody else’s line items under this customer’s letterhead.',
			},
			orderBy: {
				type: 'string',
				description:
					'kind:"table" — a STORED field id of `over` to order the rows by. Absent means primary-key order, which is still deterministic; what is never allowed is table order, because a document whose rows move between renders is not byte-identical.',
			},
			direction: {
				type: 'string',
				enum: ['asc', 'desc'],
				description: 'kind:"table" — "asc" when absent.',
			},
			name: {
				type: 'string',
				description:
					'kind:"slot" — the identifier an owned module is registered under. The fill returns layout blocks rather than HTML or PDF operators, so a bespoke region still renders to both targets and still cannot reach a row the caller may not read.',
			},
		},
		required: ['kind'],
	},
}

const DOCUMENT_DELIVERY_PROP: OpArgProperty = {
	type: 'object',
	description:
		'where a rendered document goes. REQUIRED, and every target defaults to off — "who receives this" is not something a code generator should decide. `store` composes the storage bundle and `email` the email bundle; neither grew a document-shaped special case to make that work.',
	properties: {
		download: {
			type: 'boolean',
			description:
				'serve it over HTTP at /documents/<key>/<id>.html|.pdf, behind the same read gate as the row.',
		},
		store: {
			type: 'object',
			description: 'write it to the storage bundle.',
			properties: {
				path: {
					type: 'string',
					description:
						'object key template, e.g. "invoices/{number}.pdf". At least one {placeholder} is REQUIRED: a constant path is one object key for every row, so the archive would hold exactly one document however many were sent.',
				},
				format: { type: 'string', enum: [...DOCUMENT_FORMATS] },
			},
			required: ['path', 'format'],
		},
		email: {
			type: 'object',
			description:
				'attach it to a transactional email through the email bundle.',
			properties: {
				template: {
					type: 'string',
					description: 'the name the body template is registered under.',
				},
				subject: {
					type: 'string',
					description: 'subject line. Placeholders allowed.',
				},
				to: {
					type: 'object',
					description:
						'the recipient address, as a field path of at most one hop. Two hops is a query, and an outbound email should never traverse a path nobody wrote down.',
					properties: {
						via: {
							type: 'string',
							description:
								'optional — a REFERENCE field id on this entity to follow first (an invoice’s client).',
						},
						fieldId: {
							type: 'string',
							description:
								'a string field id holding the address, on the referenced entity when via is set.',
						},
					},
					required: ['fieldId'],
				},
				format: { type: 'string', enum: [...DOCUMENT_FORMATS] },
			},
			required: ['template', 'subject', 'to', 'format'],
		},
	},
	required: ['download'],
}

/** Self-describing metadata — the payload the MCP tool-listing exposes. */
export interface SpecOpMeta {
	name: SpecOpName
	layer: SpecLayer
	summary: string
	/**
	 * JSON Schema for the op's `args` object, so `query_spec {section:"ops",
	 * ops:[…]}` is genuinely self-describing — an agent reads the arg shape
	 * instead of guessing it or falling back to CLI sugar. It is
	 * served per named op, not for all 60 at once: that payload is ~170k
	 * characters and hosts refuse it.
	 */
	args: OpArgSchema
}

export const SPEC_OP_VOCABULARY: Record<SpecOpName, SpecOpMeta> = {
	'prd.addRequirement': {
		name: 'prd.addRequirement',
		layer: 'product',
		summary: 'Add a requirement (optionally into a roadmap phase).',
		args: {
			type: 'object',
			properties: {
				requirement: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "r-".' },
						userStory: { type: 'string' },
						acceptanceCriteria: { type: 'array', items: { type: 'string' } },
						priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
						edgeCasesAndErrorStates: {
							type: 'array',
							items: { type: 'string' },
						},
						priorityRationale: RATIONALE_PROP,
						estimate: ESTIMATE_PROP,
						servesMetricIds: {
							type: 'array',
							items: { type: 'string', description: 'metric id, prefix "m-".' },
						},
						interactionsWithExisting: {
							type: 'array',
							items: { type: 'string' },
						},
						enhancesRequirementIds: {
							type: 'array',
							items: {
								type: 'string',
								description: 'requirement id, prefix "r-".',
							},
						},
						ownerId: {
							type: 'string',
							description: 'stakeholder id, prefix "sh-".',
						},
					},
					required: [
						'id',
						'userStory',
						'acceptanceCriteria',
						'priority',
						'edgeCasesAndErrorStates',
					],
				},
				intoPhaseId: {
					type: 'string',
					description:
						'optional roadmap phase id (prefix "p-") to slot it into.',
				},
			},
			required: ['requirement'],
		},
	},
	'prd.addScopeItem': {
		name: 'prd.addScopeItem',
		layer: 'product',
		summary: 'Add a MoSCoW scope item.',
		args: {
			type: 'object',
			properties: {
				bucket: {
					type: 'string',
					enum: ['mustHave', 'shouldHave', 'couldHave', 'wontHave'],
				},
				item: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "s-".' },
						description: { type: 'string' },
						rationale: RATIONALE_PROP,
						realizedByRequirementId: {
							type: 'string',
							description: 'requirement id, prefix "r-".',
						},
					},
					required: ['id', 'description'],
				},
			},
			required: ['bucket', 'item'],
		},
	},
	'prd.addRisk': {
		name: 'prd.addRisk',
		layer: 'product',
		summary: 'Add a risk.',
		args: {
			type: 'object',
			properties: {
				risk: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "rk-".' },
						description: { type: 'string' },
						type: {
							type: 'string',
							enum: [
								'technical_risk',
								'market_risk',
								'dependency_risk',
								'operational_risk',
							],
						},
						likelihood: { type: 'number', description: '0–1.' },
						impact: { type: 'number', description: '0–1.' },
						mitigation: { type: 'string' },
						threatensAssumptionIds: {
							type: 'array',
							items: {
								type: 'string',
								description: 'assumption id, prefix "as-".',
							},
						},
						validatedByActivityId: {
							type: 'string',
							description: 'activity id, prefix "a-".',
						},
						ownerId: {
							type: 'string',
							description: 'stakeholder id, prefix "sh-".',
						},
					},
					required: [
						'id',
						'description',
						'type',
						'likelihood',
						'impact',
						'mitigation',
					],
				},
			},
			required: ['risk'],
		},
	},
	'prd.addMetric': {
		name: 'prd.addMetric',
		layer: 'product',
		summary: 'Add a supporting metric.',
		args: {
			type: 'object',
			properties: {
				metric: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "m-".' },
						name: { type: 'string' },
						definition: { type: 'string' },
						baseline: {
							type: 'number',
							description: 'where we are today; may be 0.',
						},
						target: { type: 'string' },
						timeframe: { type: 'string' },
						measuredByEventIds: {
							type: 'array',
							items: { type: 'string', description: 'event id, prefix "ev-".' },
						},
						ownerId: {
							type: 'string',
							description: 'stakeholder id, prefix "sh-".',
						},
					},
					required: ['id', 'name', 'definition'],
				},
			},
			required: ['metric'],
		},
	},
	'prd.recordDecision': {
		name: 'prd.recordDecision',
		layer: 'product',
		summary: 'Append a decision to the ledger.',
		args: {
			type: 'object',
			properties: {
				entry: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "d-".' },
						question: { type: 'string' },
						options: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string' },
									description: { type: 'string' },
									pros: { type: 'array', items: { type: 'string' } },
									cons: { type: 'array', items: { type: 'string' } },
								},
								required: ['id', 'description', 'pros', 'cons'],
							},
						},
						chosenOptionId: {
							type: ['string', 'null'],
							description: 'null while pending; else must match an option id.',
						},
						rationale: { type: 'string' },
						status: { type: 'string', enum: ['pending', 'resolved'] },
						decidedAt: {
							type: ['string', 'null'],
							description: 'YYYY-MM-DD; null while pending.',
						},
						origin: { type: 'string', enum: ['ai', 'human'] },
						recordedAt: { type: 'string', description: 'YYYY-MM-DD.' },
						recommendedOptionId: {
							type: 'string',
							description: 'must be one of options[].id.',
						},
					},
					required: [
						'id',
						'question',
						'options',
						'chosenOptionId',
						'rationale',
						'status',
						'decidedAt',
						'origin',
						'recordedAt',
					],
				},
			},
			required: ['entry'],
		},
	},
	'data.addEntity': {
		name: 'data.addEntity',
		layer: 'data',
		summary: 'Add a data entity.',
		args: {
			type: 'object',
			properties: {
				entity: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "e-".' },
						name: { type: 'string' },
						description: { type: 'string' },
						fields: { type: 'array', items: FIELD_INPUT_PROP },
						provenance: PROVENANCE_PROP,
					},
					required: ['id', 'name', 'fields'],
				},
			},
			required: ['entity'],
		},
	},
	'data.addField': {
		name: 'data.addField',
		layer: 'data',
		summary: 'Add a field to an entity.',
		args: {
			type: 'object',
			properties: {
				entityId: {
					type: 'string',
					description: 'target entity id, prefix "e-".',
				},
				field: FIELD_INPUT_PROP,
			},
			required: ['entityId', 'field'],
		},
	},
	'data.setFieldReference': {
		name: 'data.setFieldReference',
		layer: 'data',
		summary:
			'Declare that an existing string field is a foreign key to another entity. The one op that changes a shipped column’s type; the migration reconciles it behind a guard and fails loudly on a value that is not an id.',
		args: {
			type: 'object',
			properties: {
				entityId: {
					type: 'string',
					description: 'entity that owns the field, prefix "e-".',
				},
				fieldId: {
					type: 'string',
					description:
						'the field to declare, prefix "fld-". Must be a string/enum field that does not already reference something.',
				},
				reference: {
					type: 'string',
					description:
						'the entity the field points at, prefix "e-" (a spec entity, or a virtual one such as the auth user).',
				},
			},
			required: ['entityId', 'fieldId', 'reference'],
		},
	},
	'data.setFieldOpenReference': {
		name: 'data.setFieldOpenReference',
		layer: 'data',
		summary:
			'Declare that a string field holds an id of one of several entities, and that the PROJECT decides which (billing’s "subject" is a user in a per-seat app and an organization in a per-workspace one). Declares the ambiguity; data.setFieldReference resolves it and refuses anything off the list. Emits the same text column, so it is additive on an installed bundle.',
		args: {
			type: 'object',
			properties: {
				entityId: {
					type: 'string',
					description: 'entity that owns the field, prefix "e-".',
				},
				fieldId: {
					type: 'string',
					description:
						'the field to open, prefix "fld-". Must be a string/enum field that does not already reference something.',
				},
				candidates: {
					type: 'array',
					description:
						'the entities this field could point at, prefix "e-". Two or more — one candidate is a reference, not an ambiguity.',
					items: { type: 'string' },
				},
			},
			required: ['entityId', 'fieldId', 'candidates'],
		},
	},
	'data.setFieldLimits': {
		name: 'data.setFieldLimits',
		layer: 'data',
		summary:
			'Set per-value row caps on an enum field — a Kanban WIP limit ({"doing": 3}). Enforced on every create/update (REST, MCP, forms and board drags alike), never only in the UI. Last-wins; {} clears every cap.',
		args: {
			type: 'object',
			properties: {
				entityId: {
					type: 'string',
					description: 'entity that owns the field, prefix "e-".',
				},
				fieldId: {
					type: 'string',
					description:
						'the enum field to cap, prefix "fld-". It must carry declared options.',
				},
				limits: {
					type: 'object',
					description: `map of option VALUE -> cap, e.g. {"doing": 3}. Each cap is a positive integer ≤ ${MAX_VALUE_LIMIT}. An option with no entry is uncapped. Pass {} to clear.`,
				},
			},
			required: ['entityId', 'fieldId', 'limits'],
		},
	},
	'data.setFieldDisplay': {
		name: 'data.setFieldDisplay',
		layer: 'data',
		summary:
			'State how a NUMBER field is drawn and on what scale, instead of letting its NAME decide. A number called "rating" or "stars" otherwise renders as a 5-star widget and one called "duration" as 3m 20s. format wins over the name in both directions: "number" is the escape hatch that keeps a column called rating a plain number; "rating" promotes a column called score. min/max/step declare the scale (a rating out of 10, a 0–100 score). Presentation only — nothing here constrains what may be stored, and a value outside the range is displayed honestly rather than clamped. Last-wins; {} clears the declaration and returns the field to inference.',
		args: {
			type: 'object',
			properties: {
				entityId: {
					type: 'string',
					description: 'entity that owns the field, prefix "e-".',
				},
				fieldId: {
					type: 'string',
					description:
						'the number field to present, prefix "fld-". Refused on any other field type.',
				},
				display: {
					type: 'object',
					properties: {
						format: {
							type: 'string',
							enum: [...NUMBER_DISPLAY_FORMATS],
							description:
								'"number" (plain — the escape hatch from the name heuristic), "grouped", "percent", "currency", "rating" (stars, out of max), "slider" (range over min/max/step), "duration" (seconds, read as 1h 2m 3s).',
						},
						min: { type: 'number', description: 'low end of the scale.' },
						max: {
							type: 'number',
							description:
								'high end of the scale — the star count for a rating (default 5 when unstated).',
						},
						step: {
							type: 'number',
							description: 'granularity of the scale; must be positive.',
						},
					},
				},
			},
			required: ['entityId', 'fieldId', 'display'],
		},
	},
	'data.addComputed': {
		name: 'data.addComputed',
		layer: 'data',
		summary:
			"Add a value computed from a row's own numeric fields (never stored; evaluated on read).",
		args: {
			type: 'object',
			properties: {
				entityId: {
					type: 'string',
					description: 'target entity id, prefix "e-".',
				},
				computed: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "drv-".' },
						name: {
							type: 'string',
							description:
								'accessor name; must not collide with a field or another derived value.',
						},
						expr: COMPUTED_EXPR_PROP,
						provenance: PROVENANCE_PROP,
					},
					required: ['id', 'name', 'expr'],
				},
			},
			required: ['entityId', 'computed'],
		},
	},
	'data.addRollup': {
		name: 'data.addRollup',
		layer: 'data',
		summary:
			"Add an aggregate over a related entity's rows. With groupBy it yields a series (chart/list); without, a scalar.",
		args: {
			type: 'object',
			properties: {
				entityId: {
					type: 'string',
					description: 'entity the rollup is exposed on, prefix "e-".',
				},
				rollup: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "drv-".' },
						name: {
							type: 'string',
							description:
								'accessor name; must not collide with a field or another derived value.',
						},
						over: {
							type: 'string',
							description:
								'entity whose rows are aggregated (the "many" side), prefix "e-".',
						},
						via: {
							description: `path of reference fields from \`over\` up to \`entityId\`: a single "fld-…" for the common one-hop case, or an array of up to ${MAX_ROLLUP_HOPS} for a multi-hop path (each element an FK on the previous hop's target). Set = per-row; omit = table-wide.`,
							oneOf: [
								{ type: 'string' },
								{ type: 'array', items: { type: 'string' } },
							],
						},
						fn: { type: 'string', enum: [...AGG_FNS] },
						field: {
							type: 'string',
							description:
								'value on `over` to aggregate. Required for every fn but "count". A stored field ("fld-…") or a computed field ("drv-…") — never another rollup, which is what keeps the derived graph acyclic.',
						},
						where: {
							type: 'array',
							description: "equality constraints on `over`'s fields (AND-ed).",
							items: {
								type: 'object',
								properties: {
									field: { type: 'string' },
									equals: {},
								},
								required: ['field', 'equals'],
							},
						},
						groupBy: {
							type: 'object',
							description:
								'group the aggregate into a series. With `bucket`, the key is a truncated date (a time series).',
							properties: {
								field: { type: 'string' },
								bucket: { type: 'string', enum: [...TIME_BUCKETS] },
							},
							required: ['field'],
						},
						limit: {
							type: 'number',
							description: `max groups returned; REQUIRED when groupBy is set (the cost bound). Cap ${MAX_ROLLUP_LIMIT}.`,
						},
						provenance: PROVENANCE_PROP,
					},
					required: ['id', 'name', 'over', 'fn'],
				},
			},
			required: ['entityId', 'rollup'],
		},
	},
	'page.addPage': {
		name: 'page.addPage',
		layer: 'page',
		summary: 'Add a page.',
		args: {
			type: 'object',
			properties: {
				page: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "pg-".' },
						name: { type: 'string' },
						route: {
							type: 'string',
							description:
								'the page\'s URL, leading slash, e.g. "/invoices". May be more than one segment ("/app/invoices"). Use "/" for the app\'s main surface — a page declared at "/" is served as the app\'s root, and an app whose primary surface lives there reads as an app rather than as an index of pages. Without one, "/" is a generated list of links to the pages below it.',
						},
						blocks: { type: 'array', items: BLOCK_INPUT_PROP },
						entityId: {
							type: 'string',
							description: 'backing entity id (prefix "e-") for a CRUD page.',
						},
						e2eTests: {
							type: 'array',
							items: { type: 'string' },
							description: 'natural-language e2e test descriptions.',
						},
						provenance: PROVENANCE_PROP,
					},
					required: ['id', 'name', 'route', 'blocks'],
				},
			},
			required: ['page'],
		},
	},
	'page.addBlock': {
		name: 'page.addBlock',
		layer: 'page',
		summary: 'Add a block to a page.',
		args: {
			type: 'object',
			properties: {
				pageId: {
					type: 'string',
					description: 'target page id, prefix "pg-".',
				},
				block: BLOCK_INPUT_PROP,
			},
			required: ['pageId', 'block'],
		},
	},
	'page.setBlockOrder': {
		name: 'page.setBlockOrder',
		layer: 'page',
		summary:
			'Set the row ordering of a list/table block (spec-as-data ranking, e.g. points desc).',
		args: {
			type: 'object',
			properties: {
				pageId: { type: 'string', description: 'page id, prefix "pg-".' },
				blockId: { type: 'string', description: 'block id, prefix "blk-".' },
				order: BLOCK_ORDER_PROP,
			},
			required: ['pageId', 'blockId', 'order'],
		},
	},
	'page.setBlockVariant': {
		name: 'page.setBlockVariant',
		layer: 'page',
		summary:
			'Set a list/table block’s presentation: table (default admin grid) | cards (responsive card grid) | feed (stacked title/description/date rows). A filled replace-mode slot on the same page supersedes sibling block presentation — it renders INSTEAD of this list, so on such a page this op changes the spec and nothing a user can see.',
		args: {
			type: 'object',
			properties: {
				pageId: { type: 'string', description: 'page id, prefix "pg-".' },
				blockId: { type: 'string', description: 'block id, prefix "blk-".' },
				variant: { type: 'string', enum: [...BLOCK_VARIANTS] },
			},
			required: ['pageId', 'blockId', 'variant'],
		},
	},
	'page.setBlockFields': {
		name: 'page.setBlockFields',
		layer: 'page',
		summary:
			'Choose which entity fields a list/table block renders, in order (first = the title column). Overrides the zero-config column picks.',
		args: {
			type: 'object',
			properties: {
				pageId: { type: 'string', description: 'page id, prefix "pg-".' },
				blockId: { type: 'string', description: 'block id, prefix "blk-".' },
				fields: {
					type: 'array',
					description:
						'entity FIELD NAMES (not ids), in render order; the first is the title column.',
					items: { type: 'string' },
				},
			},
			required: ['pageId', 'blockId', 'fields'],
		},
	},
	'page.setBlockEditable': {
		name: 'page.setBlockEditable',
		layer: 'page',
		summary:
			'Name the fields a list/table block edits IN PLACE — click a cell, type, done, no trip to the form. The cell submits to the record’s own edit route, so an inline edit runs the same validation, permission check, value limits and audit entry as the form; the list gets no write path of its own. References, files, json and rank keys are refused — a cell editor cannot represent them. Last-wins; pass [] to make the list read-only again.',
		args: {
			type: 'object',
			properties: {
				pageId: { type: 'string', description: 'page id, prefix "pg-".' },
				blockId: { type: 'string', description: 'block id, prefix "blk-".' },
				editable: {
					type: 'array',
					description:
						'entity FIELD NAMES (not ids) whose cells edit in place. Simple types only: string, number, boolean, enum (with options), date. This array REPLACES the block’s current list; pass [] to clear.',
					items: { type: 'string' },
				},
			},
			required: ['pageId', 'blockId', 'editable'],
		},
	},
	'page.setE2ETests': {
		name: 'page.setE2ETests',
		layer: 'page',
		summary:
			'Set a page’s natural-language e2e tests — one sentence per behaviour. `run_generator e2e-tests` scaffolds a Playwright spec per sentence and `run_checks` runs them, which is the cheap verification path.',
		args: {
			type: 'object',
			properties: {
				pageId: { type: 'string', description: 'page id, prefix "pg-".' },
				e2eTests: {
					type: 'array',
					description:
						'natural-language test descriptions, e.g. "a signed-in user can archive a deck". Last-wins: this array REPLACES the page’s current list. Pass [] to clear.',
					items: { type: 'string' },
				},
			},
			required: ['pageId', 'e2eTests'],
		},
	},
	'page.addCalendar': {
		name: 'page.addCalendar',
		layer: 'page',
		summary:
			'Add a calendar block: the page’s rows arranged by one of its date fields, as a month grid, a week grid, or a density heatmap.',
		args: {
			type: 'object',
			properties: {
				pageId: { type: 'string', description: 'page id, prefix "pg-".' },
				blockId: {
					type: 'string',
					description: 'new block id, prefix "blk-".',
				},
				calendar: {
					type: 'object',
					properties: {
						dateField: {
							type: 'string',
							description:
								'FIELD NAME (not id) of a `date` field on the page’s backing entity — the day each row is placed on.',
						},
						endField: {
							type: 'string',
							description:
								'optional second `date` field ending a multi-day entry.',
						},
						display: {
							type: 'string',
							enum: [...CALENDAR_DISPLAYS],
							description:
								'month/week place each row on its day; heatmap draws rows-per-day density over a rolling year.',
						},
						timezone: {
							type: 'string',
							description:
								'IANA timezone the days are bucketed in, e.g. "America/New_York". REQUIRED and never inferred.',
						},
						titleField: {
							type: 'string',
							description: 'field rendered as the entry label.',
						},
						reschedule: {
							type: 'boolean',
							description:
								'allow moving an entry to another day (drag or keyboard); the move is an ordinary validated update of dateField. Not allowed with display "heatmap".',
						},
					},
					required: ['dateField', 'display', 'timezone'],
				},
				provenance: PROVENANCE_PROP,
			},
			required: ['pageId', 'blockId', 'calendar'],
		},
	},
	'page.addTimeline': {
		name: 'page.addTimeline',
		layer: 'page',
		summary:
			'Add a timeline (Gantt) block: the page’s rows as bars across a start/end date range, with optional dependency arrows from a self-referencing field.',
		args: {
			type: 'object',
			properties: {
				pageId: { type: 'string', description: 'page id, prefix "pg-".' },
				blockId: {
					type: 'string',
					description: 'new block id, prefix "blk-".',
				},
				timeline: {
					type: 'object',
					properties: {
						startField: {
							type: 'string',
							description:
								'FIELD NAME (not id) of the `date` field a bar starts at.',
						},
						endField: {
							type: 'string',
							description:
								'FIELD NAME of the `date` field a bar ends at. Required — a bar has two ends.',
						},
						timezone: {
							type: 'string',
							description:
								'IANA timezone the days are bucketed in. REQUIRED and never inferred.',
						},
						titleField: {
							type: 'string',
							description: 'field rendered as the bar label.',
						},
						dependsOn: {
							type: 'string',
							description:
								'FIELD NAME of a field referencing the SAME entity — drawn as an arrow. Presentation only: no rescheduling of dependents, no critical path.',
						},
						reschedule: {
							type: 'boolean',
							description:
								'allow moving a bar (start and end shift together, duration preserved) through the same validated update path as a form edit.',
						},
					},
					required: ['startField', 'endField', 'timezone'],
				},
				provenance: PROVENANCE_PROP,
			},
			required: ['pageId', 'blockId', 'timeline'],
		},
	},
	'page.addBoard': {
		name: 'page.addBoard',
		layer: 'page',
		summary:
			'Add a Kanban board block: the page’s rows as cards in columns grouped by one of its enum fields, moved between columns by drag or keyboard. WIP limits are declared on the field (data.setFieldLimits), not here.',
		args: {
			type: 'object',
			properties: {
				pageId: { type: 'string', description: 'page id, prefix "pg-".' },
				blockId: {
					type: 'string',
					description: 'new block id, prefix "blk-".',
				},
				board: {
					type: 'object',
					properties: {
						groupField: {
							type: 'string',
							description:
								'FIELD NAME (not id) of an `enum` field on the page’s backing entity that carries declared options — those options ARE the board’s columns, in the order declared.',
						},
						rankField: {
							type: 'string',
							description:
								'FIELD NAME of a field declared with rank:true — persists manual order within a column. Omit for column-only moves.',
						},
						titleField: {
							type: 'string',
							description: 'field rendered as the card title.',
						},
						cardFields: {
							type: 'array',
							description:
								'extra FIELD NAMES rendered on the card below its title; enums render as chips.',
							items: { type: 'string' },
						},
						move: {
							type: 'boolean',
							description:
								'allow moving a card (drag or keyboard); the move is an ordinary validated update of groupField (and rankField), and is refused when it would exceed the target column’s declared WIP limit.',
						},
					},
					required: ['groupField'],
				},
				provenance: PROVENANCE_PROP,
			},
			required: ['pageId', 'blockId', 'board'],
		},
	},
	'pricing.addTier': {
		name: 'pricing.addTier',
		layer: 'pricing',
		summary: 'Add a pricing tier.',
		args: {
			type: 'object',
			properties: {
				tier: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "tr-".' },
						name: { type: 'string' },
						priceMonthly: { type: 'number' },
						features: { type: 'array', items: { type: 'string' } },
						provenance: PROVENANCE_PROP,
					},
					required: ['id', 'name', 'priceMonthly', 'features'],
				},
			},
			required: ['tier'],
		},
	},
	'theme.set': {
		name: 'theme.set',
		layer: 'theme',
		summary:
			'Set the app’s visual theme: a curated preset (zinc | ocean | forest | sunset | mono | rose | amber) plus optional accent (#hex), radius (sm|md|lg|full), density (comfortable|compact), font (sans|serif|mono|rounded|humanist), typeScale (compact|default|relaxed). Last-wins — replaces the whole theme.',
		args: {
			type: 'object',
			properties: {
				theme: {
					type: 'object',
					properties: {
						preset: { type: 'string', enum: [...THEME_PRESETS] },
						accent: {
							type: 'string',
							pattern: ACCENT_RE.source,
							description: '#rgb or #rrggbb.',
						},
						radius: { type: 'string', enum: [...THEME_RADII] },
						density: { type: 'string', enum: [...THEME_DENSITIES] },
						font: { type: 'string', enum: [...THEME_FONTS] },
						typeScale: { type: 'string', enum: [...THEME_TYPE_SCALES] },
					},
					required: ['preset'],
				},
			},
			required: ['theme'],
		},
	},
	'flags.declare': {
		name: 'flags.declare',
		layer: 'flags',
		summary:
			'Declare a feature flag: a key, a default, and optional targeting (roles | organizations | rolloutPercent). Evaluated server-side per viewer; generation never reads a flag’s value.',
		args: {
			type: 'object',
			properties: {
				flag: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "flg-".' },
						key: {
							type: 'string',
							pattern: FLAG_KEY_RE.source,
							description:
								'the stable key a gated surface names, e.g. "checkout-v2".',
						},
						description: {
							type: 'string',
							description: 'what the flag turns on, in one line.',
						},
						default: {
							type: 'boolean',
							description: 'the value when no targeting rule matches.',
						},
						targeting: FLAG_TARGETING_PROP,
						provenance: PROVENANCE_PROP,
					},
					required: ['id', 'key', 'description', 'default'],
				},
			},
			required: ['flag'],
		},
	},
	'flags.setTargeting': {
		name: 'flags.setTargeting',
		layer: 'flags',
		summary:
			'Replace a flag’s targeting wholesale (last-wins). Omit `targeting` to clear it and return the flag to its bare default — this is how a rollout is ramped, paused, or completed.',
		args: {
			type: 'object',
			properties: {
				flagId: { type: 'string', description: 'flag id, prefix "flg-".' },
				targeting: FLAG_TARGETING_PROP,
			},
			required: ['flagId'],
		},
	},
	'flags.gate': {
		name: 'flags.gate',
		layer: 'flags',
		summary:
			'Gate a page or block on a declared flag, or ungate it with flag:null. A gated surface is composed only for viewers the flag is on for; the generated code is identical either way.',
		args: {
			type: 'object',
			properties: {
				target: {
					type: 'object',
					properties: {
						kind: { type: 'string', enum: ['page', 'block'] },
						id: { type: 'string', description: 'the gated row’s id.' },
						parentId: {
							type: 'string',
							description: 'required for kind:"block" — its page id.',
						},
					},
					required: ['kind', 'id'],
				},
				flag: {
					type: ['string', 'null'],
					description: 'a declared flag key, or null to ungate.',
				},
			},
			required: ['target', 'flag'],
		},
	},
	'flags.remove': {
		name: 'flags.remove',
		layer: 'flags',
		summary:
			'Remove a flag declaration. Refused while any page or block still gates on it — ungate those surfaces first. This is the cleanup half of the flag lifecycle; a flag system without it accumulates dead flags forever.',
		args: {
			type: 'object',
			properties: {
				flagId: { type: 'string', description: 'flag id, prefix "flg-".' },
			},
			required: ['flagId'],
		},
	},
	'schedules.declare': {
		name: 'schedules.declare',
		layer: 'schedules',
		summary:
			'Declare a schedule: a named recurrence, the IANA timezone it is read in, and the identity its runs carry. Delivery is at-least-once — the handler gets an idempotency key and must tolerate a repeat.',
		args: {
			type: 'object',
			properties: {
				schedule: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "sch-".' },
						key: {
							type: 'string',
							pattern: SCHEDULE_KEY_RE.source,
							description:
								'the stable key the handler slot is registered under and every job row carries, e.g. "invoice.recurring".',
						},
						description: {
							type: 'string',
							description: 'what the schedule does, in one line.',
						},
						timezone: {
							type: 'string',
							description:
								'IANA zone the wall-clock kinds are read in, e.g. "America/New_York". Not the server’s zone — a server that moves region must not move everybody’s monthly run.',
						},
						recurrence: SCHEDULE_RECURRENCE_PROP,
						runAs: SCHEDULE_RUN_AS_PROP,
						entityId: {
							type: 'string',
							description:
								'optional — the entity the work operates over, when there is one. Declared so "the monthly invoice run" is a reviewable statement about invoices.',
						},
						paused: {
							type: 'boolean',
							description: 'declare it stopped; resume with schedules.pause.',
						},
						provenance: PROVENANCE_PROP,
					},
					required: [
						'id',
						'key',
						'description',
						'timezone',
						'recurrence',
						'runAs',
					],
				},
			},
			required: ['schedule'],
		},
	},
	'schedules.setRecurrence': {
		name: 'schedules.setRecurrence',
		layer: 'schedules',
		summary:
			'Replace a schedule’s recurrence wholesale (last-wins), optionally moving its timezone with it. This is how a run is moved, slowed down, or re-anchored.',
		args: {
			type: 'object',
			properties: {
				scheduleId: {
					type: 'string',
					description: 'schedule id, prefix "sch-".',
				},
				recurrence: SCHEDULE_RECURRENCE_PROP,
				timezone: {
					type: 'string',
					description: 'optional — leave it out to keep the declared zone.',
				},
			},
			required: ['scheduleId', 'recurrence'],
		},
	},
	'schedules.pause': {
		name: 'schedules.pause',
		layer: 'schedules',
		summary:
			'Stop or resume a schedule, keeping its declaration and its run history. The 3am operation: the reason to stop a job is usually that something downstream is wrong, and deleting the declaration also deletes what you need to turn it back on.',
		args: {
			type: 'object',
			properties: {
				scheduleId: {
					type: 'string',
					description: 'schedule id, prefix "sch-".',
				},
				paused: {
					type: 'boolean',
					description: 'true stops it, false resumes.',
				},
			},
			required: ['scheduleId', 'paused'],
		},
	},
	'schedules.remove': {
		name: 'schedules.remove',
		layer: 'schedules',
		summary:
			'Remove a schedule declaration. Refused while it is still active — pause it first, so removal is always deliberate rather than the fastest way to silence a page.',
		args: {
			type: 'object',
			properties: {
				scheduleId: {
					type: 'string',
					description: 'schedule id, prefix "sch-".',
				},
			},
			required: ['scheduleId'],
		},
	},
	'sources.declare': {
		name: 'sources.declare',
		layer: 'sources',
		summary:
			'Declare an external data source: an endpoint, the credential it uses BY NAME, a typed mapping from the response onto entity fields, and the request budget it may spend. Two refusals are absolute — a credential anywhere in the declaration, and an endpoint the runtime must not reach. Generation never fetches; only the running app does.',
		args: {
			type: 'object',
			properties: {
				source: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "src-".' },
						key: {
							type: 'string',
							pattern: SOURCE_KEY_RE.source,
							description:
								'the stable key every job row, log line and refiner module carries, e.g. "isbn.lookup".',
						},
						description: {
							type: 'string',
							description: 'what the source is for, in one line.',
						},
						mode: {
							type: 'string',
							enum: [...SOURCE_MODES],
							description:
								'"enrich" = one request about one row, mapped back onto it. "sync" = a remote collection upserted into the entity by a stable remote id.',
						},
						entityId: {
							type: 'string',
							description: 'the entity the mapped values are written to.',
						},
						request: SOURCE_REQUEST_PROP,
						auth: SOURCE_AUTH_PROP,
						mapping: SOURCE_MAPPING_PROP,
						limits: SOURCE_LIMITS_PROP,
						triggers: SOURCE_TRIGGERS_PROP,
						inputField: {
							type: 'string',
							description:
								'enrich mode only, and REQUIRED there — the field whose value drives the lookup. Enrichment is skipped when it is empty.',
						},
						collection: SOURCE_COLLECTION_PROP,
						refine: {
							type: 'boolean',
							description:
								'emit the user-owned refiner slot sources/<key>.refine.ts and take its return value as final. For what a path cannot say — resolving a remote record to a local foreign key, reconciling two providers. Off by default; a project that does not need one grows no file.',
						},
						paused: {
							type: 'boolean',
							description: 'declare it stopped; resume with sources.pause.',
						},
						provenance: PROVENANCE_PROP,
					},
					required: [
						'id',
						'key',
						'description',
						'mode',
						'entityId',
						'request',
						'auth',
						'mapping',
						'limits',
						'triggers',
					],
				},
			},
			required: ['source'],
		},
	},
	'sources.setMapping': {
		name: 'sources.setMapping',
		layer: 'sources',
		summary:
			'Replace a source’s response mapping wholesale (last-wins). The edit a third party forces when it renames a field in its response — which is the most common reason to touch a source at all.',
		args: {
			type: 'object',
			properties: {
				sourceId: { type: 'string', description: 'source id, prefix "src-".' },
				mapping: SOURCE_MAPPING_PROP,
			},
			required: ['sourceId', 'mapping'],
		},
	},
	'sources.setLimits': {
		name: 'sources.setLimits',
		layer: 'sources',
		summary:
			'Replace a source’s rate limit and retry budget wholesale (last-wins). Separate from the mapping because "we are being rate-limited, slow down" is a different conversation from "these fields moved".',
		args: {
			type: 'object',
			properties: {
				sourceId: { type: 'string', description: 'source id, prefix "src-".' },
				limits: SOURCE_LIMITS_PROP,
			},
			required: ['sourceId', 'limits'],
		},
	},
	'sources.pause': {
		name: 'sources.pause',
		layer: 'sources',
		summary:
			'Stop or resume a source, keeping its declaration and its run history. The 3am operation: the reason to stop an integration is usually that the other end is misbehaving, and deleting the declaration also deletes what you need to turn it back on.',
		args: {
			type: 'object',
			properties: {
				sourceId: { type: 'string', description: 'source id, prefix "src-".' },
				paused: {
					type: 'boolean',
					description: 'true stops it fetching, false resumes.',
				},
			},
			required: ['sourceId', 'paused'],
		},
	},
	'sources.remove': {
		name: 'sources.remove',
		layer: 'sources',
		summary:
			'Remove a source declaration. Refused while it is still active — pause it first, so removal is always deliberate rather than the fastest way to silence a failing integration.',
		args: {
			type: 'object',
			properties: {
				sourceId: { type: 'string', description: 'source id, prefix "src-".' },
			},
			required: ['sourceId'],
		},
	},
	'search.declare': {
		name: 'search.declare',
		layer: 'search',
		summary:
			'Declare a ranked full-text index over one entity: which fields are searchable, how much each counts toward the rank, which language stems them, and whether the physical index exists. Ranked search then works in admin, over REST and over MCP, filtered by the same read rules a list query passes.',
		args: {
			type: 'object',
			properties: {
				index: {
					type: 'object',
					properties: {
						id: {
							type: 'string',
							description: 'branded id, prefix "idx-".',
						},
						key: {
							type: 'string',
							pattern: SEARCH_KEY_RE.source,
							description:
								'the name the database object carries, and what shows up in EXPLAIN when somebody goes looking for why a write got slow.',
						},
						description: {
							type: 'string',
							description:
								'what this index is for, in one line. An index nobody can explain is one nobody can decide to stop paying for.',
						},
						entityId: {
							type: 'string',
							description:
								'entity id, prefix "e-". One index per entity: an entity has one answer to "what does searching this mean", and the weights are how you express the rest. Searching several entities is a fan-out where each one passes its own read gate — a shared index would hold rows from tables with different rules and could only ever be gated once, for all of them.',
						},
						language: {
							type: 'string',
							enum: [...SEARCH_LANGUAGES],
							description:
								'the stemmer and stop-word list. On the index rather than global because the query must be parsed with the same configuration the index was built with — a deployment-level setting would silently invalidate every index when somebody changed it. Use "simple" for identifiers, tags, SKUs, or any corpus that is not prose in one language.',
						},
						fields: SEARCH_FIELDS_PROP,
						indexed: {
							type: 'boolean',
							description:
								'whether the GIN index physically exists. Required, not defaulted: whether this costs every write is a decision about somebody’s production database. false is the write-heavy opt-out and changes only the cost — the same query runs over the same expression and returns the same ranked rows, as a sequential scan.',
						},
						provenance: PROVENANCE_PROP,
					},
					required: [
						'id',
						'key',
						'description',
						'entityId',
						'language',
						'fields',
						'indexed',
					],
				},
			},
			required: ['index'],
		},
	},
	'search.setFields': {
		name: 'search.setFields',
		layer: 'search',
		summary:
			'Replace an index’s field list and weights wholesale, last-wins. The edit you make when a new field should be searchable, or when the top result for a common query is obviously wrong — which is always a change to the relative weights, never to one of them alone.',
		args: {
			type: 'object',
			properties: {
				indexId: {
					type: 'string',
					description: 'search index id, prefix "idx-".',
				},
				fields: SEARCH_FIELDS_PROP,
			},
			required: ['indexId', 'fields'],
		},
	},
	'search.setIndexing': {
		name: 'search.setIndexing',
		layer: 'search',
		summary:
			'Create or drop the physical index, leaving the declaration alone. The cost lever an operator reaches for under load. It changes no answer — search still runs over the same expression with the same ranking, as a sequential scan — and it is reversible in one additive statement, because an expression index stores nothing that is not derivable from the columns it reads.',
		args: {
			type: 'object',
			properties: {
				indexId: {
					type: 'string',
					description: 'search index id, prefix "idx-".',
				},
				indexed: {
					type: 'boolean',
					description:
						'true creates the GIN index, false drops it. Dropping loses no data by construction.',
				},
			},
			required: ['indexId', 'indexed'],
		},
	},
	'search.remove': {
		name: 'search.remove',
		layer: 'search',
		summary:
			'Remove a search index declaration. Refused while the physical index still exists — set indexed:false first, because the DDL is emitted from the declaration and removing it first would strand a real index on a real table with nothing left in the spec that knows its name.',
		args: {
			type: 'object',
			properties: {
				indexId: {
					type: 'string',
					description: 'search index id, prefix "idx-".',
				},
			},
			required: ['indexId'],
		},
	},
	'documents.declare': {
		name: 'documents.declare',
		layer: 'documents',
		summary:
			'Declare a document template over one entity: the sections it prints, the paper it is laid out for, and where a rendered copy goes. Renders to print-ready HTML and to PDF from one compiled layout — no headless browser — and rendering is a read of the row, through the same gate a GET passes.',
		args: {
			type: 'object',
			properties: {
				template: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "doc-".' },
						key: {
							type: 'string',
							pattern: DOCUMENT_KEY_RE.source,
							description:
								'the URL segment and stored object-key prefix — the string a person types and a support ticket quotes.',
						},
						description: {
							type: 'string',
							description:
								'what this document is, in one line. A document nobody can explain is one nobody can decide to stop sending.',
						},
						entityId: {
							type: 'string',
							description:
								'entity id, prefix "e-". SEVERAL templates per entity is fine and expected — an invoice, a receipt and a statement are three documents about one row, unlike a search index, where one entity has one answer to what searching it means.',
						},
						pageSize: {
							type: 'string',
							enum: [...DOCUMENT_PAGE_SIZES],
							description:
								'the paper. On the template rather than a global setting because a business with clients on two continents sends both.',
						},
						sections: DOCUMENT_SECTIONS_PROP,
						delivery: DOCUMENT_DELIVERY_PROP,
						provenance: PROVENANCE_PROP,
					},
					required: [
						'id',
						'key',
						'description',
						'entityId',
						'pageSize',
						'sections',
						'delivery',
					],
				},
			},
			required: ['template'],
		},
	},
	'documents.setSections': {
		name: 'documents.setSections',
		layer: 'documents',
		summary:
			'Replace a template’s sections wholesale, last-wins. Wholesale because the sections are only correct relative to each other — "move the totals above the line items" is not an edit to either one.',
		args: {
			type: 'object',
			properties: {
				templateId: {
					type: 'string',
					description: 'document template id, prefix "doc-".',
				},
				sections: DOCUMENT_SECTIONS_PROP,
			},
			required: ['templateId', 'sections'],
		},
	},
	'documents.setDelivery': {
		name: 'documents.setDelivery',
		layer: 'documents',
		summary:
			'Change where a rendered document goes, leaving the layout alone. Its own op because this is the outward-facing half: turning email on starts sending mail to customers, and turning every target off is how a template is retired.',
		args: {
			type: 'object',
			properties: {
				templateId: {
					type: 'string',
					description: 'document template id, prefix "doc-".',
				},
				delivery: DOCUMENT_DELIVERY_PROP,
			},
			required: ['templateId', 'delivery'],
		},
	},
	'documents.remove': {
		name: 'documents.remove',
		layer: 'documents',
		summary:
			'Remove a document template declaration. Refused while any delivery target is still on — the URL and the object path are emitted from the declaration, so removing it first turns a bookmarked link into a 404 and an archive write into an error. Retire it with documents.setDelivery first.',
		args: {
			type: 'object',
			properties: {
				templateId: {
					type: 'string',
					description: 'document template id, prefix "doc-".',
				},
			},
			required: ['templateId'],
		},
	},
	'imports.declare': {
		name: 'imports.declare',
		layer: 'imports',
		summary:
			'Declare an importer over one entity: the file format, the column-to-field mapping, the upsert key that decides whether existing rows can be overwritten, and the row ceiling. Running it is ALWAYS two steps — a dry-run reporting exactly what would change, then an explicit apply — and that is structural rather than a policy: the apply function takes a plan and there is no overload that takes bytes.',
		args: {
			type: 'object',
			properties: {
				importer: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "imp-".' },
						key: {
							type: 'string',
							pattern: IMPORT_KEY_RE.source,
							description:
								'the URL segment, the audit label, and (for a custom importer) the parser module name — the string a person types and a support ticket quotes.',
						},
						description: {
							type: 'string',
							description:
								'what this importer is for, in one line. An importer nobody can explain is one nobody can decide to pause.',
						},
						entityId: {
							type: 'string',
							description:
								'entity id, prefix "e-". SEVERAL importers per entity is fine and expected — "the CSV our old tool exports" and "an Anki deck" are two different files about one table, unlike a search index, where one entity has one answer to what searching it means.',
						},
						format: {
							type: 'string',
							enum: [...IMPORT_FORMATS],
							description:
								'csv/ndjson/json are read incrementally over chunks, so a large file costs memory proportional to one row rather than to the file. "custom" is the honest fourth: the platform does not know how to read a .apkg or an .xlsx, and saying so with a typed parser slot is what keeps the vocabulary from growing a parser per vendor.',
						},
						parserSlot: {
							type: 'string',
							pattern: IMPORT_PARSER_SLOT_RE.source,
							description:
								'REQUIRED iff format is "custom", refused otherwise. Names the user-owned module (imports/<key>.parse.ts) that turns bytes into raw records. Those records then feed the IDENTICAL mapping, validation and write pipeline a CSV takes — the bespoke half stops at parsing and never reaches the write path, which is what keeps the slot from being a bypass.',
						},
						columns: IMPORT_COLUMNS_PROP,
						upsertFieldId: IMPORT_UPSERT_KEY_PROP,
						maxRows: {
							type: 'number',
							description: `integer 1–${MAX_IMPORT_ROWS}. Required, never defaulted. A run that exceeds it FAILS LOUDLY rather than truncating: a silently truncated import looks exactly like a successful one, and the missing rows are found weeks later by somebody who assumes they were never in the file.`,
						},
						paused: {
							type: 'boolean',
							description:
								'whether the importer accepts uploads. Required, never defaulted — "is this write path open" is a decision about somebody’s production data. Flip it with imports.pause.',
						},
						provenance: PROVENANCE_PROP,
					},
					required: [
						'id',
						'key',
						'description',
						'entityId',
						'format',
						'columns',
						'upsertFieldId',
						'maxRows',
						'paused',
					],
				},
			},
			required: ['importer'],
		},
	},
	'imports.setMapping': {
		name: 'imports.setMapping',
		layer: 'imports',
		summary:
			'Replace an importer’s column mapping wholesale, last-wins. The edit a partner forces when their export gains a column or renames two — which is one edit to one mapping rather than three patches, because a mapping is only correct relative to the whole file’s shape.',
		args: {
			type: 'object',
			properties: {
				importerId: {
					type: 'string',
					description: 'importer id, prefix "imp-".',
				},
				columns: IMPORT_COLUMNS_PROP,
			},
			required: ['importerId', 'columns'],
		},
	},
	'imports.setUpsertKey': {
		name: 'imports.setUpsertKey',
		layer: 'imports',
		summary:
			'Change whether — and on what — this importer may OVERWRITE rows that already exist. Its own op precisely so a reviewer can answer "can this destroy data?" from the op name, before reading a single argument. null makes it insert-only; a field id makes matching rows update in place. Nothing else in the vocabulary changes that answer, and this op changes nothing else.',
		args: {
			type: 'object',
			properties: {
				importerId: {
					type: 'string',
					description: 'importer id, prefix "imp-".',
				},
				upsertFieldId: IMPORT_UPSERT_KEY_PROP,
			},
			required: ['importerId', 'upsertFieldId'],
		},
	},
	'imports.pause': {
		name: 'imports.pause',
		layer: 'imports',
		summary:
			'Stop or resume an importer, keeping its declaration, its mapping and its parser file. The operational lever: the reason to stop an importer is usually that a partner’s export changed shape, and deleting the declaration to stop it also deletes the mapping you need to fix it. Pausing is also the retire step before imports.remove.',
		args: {
			type: 'object',
			properties: {
				importerId: {
					type: 'string',
					description: 'importer id, prefix "imp-".',
				},
				paused: {
					type: 'boolean',
					description: 'true refuses uploads, false accepts them again.',
				},
			},
			required: ['importerId', 'paused'],
		},
	},
	'imports.remove': {
		name: 'imports.remove',
		layer: 'imports',
		summary:
			'Remove an importer declaration. Refused while it is not paused — pause it first, so removal is never the fastest way to silence something somebody is mid-way through using.',
		args: {
			type: 'object',
			properties: {
				importerId: {
					type: 'string',
					description: 'importer id, prefix "imp-".',
				},
			},
			required: ['importerId'],
		},
	},
	'portals.declare': {
		name: 'portals.declare',
		layer: 'portals',
		summary:
			'Declare a PUBLIC, token-scoped or role-scoped surface over one entity: who is on the other side, which rows they may reach, EXACTLY which fields they may read, and which writes (if any) they may perform under which hourly budget. This is the highest-consequence op in the vocabulary — every other op changes what the app does for people already inside it; this one decides what somebody who has never signed in can read. Enforcement lives in the permission layer and the read/write ops, never in a route.',
		args: {
			type: 'object',
			properties: {
				portal: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "ptl-".' },
						key: {
							type: 'string',
							pattern: PORTAL_KEY_RE.source,
							description:
								'the URL segment (/p/<key>), the audit label and the rate-limit bucket — the string a person types and a support ticket quotes.',
						},
						description: {
							type: 'string',
							description:
								'what this portal is for, in one line. It is printed beside the field list in the exposure report, and a portal nobody can explain is one nobody can decide to pause.',
						},
						entityId: {
							type: 'string',
							description:
								'entity id, prefix "e-". SEVERAL portals per entity is expected: a public archive and a client portal are two different outsides on one table.',
						},
						audience: {
							type: 'string',
							enum: [...PORTAL_AUDIENCES],
							description:
								'"public" = no credential at all, the URL is the whole of it. "token" = one holder of one minted, expiring, revocable link (the client a freelancer sent an invoice to). "role" = an ordinary signed-in session whose role matches.',
						},
						role: {
							type: 'string',
							description:
								'REQUIRED iff audience is "role", refused otherwise. An unnamed role grants to every session; a role on a public portal reads as a restriction and enforces nothing.',
						},
						token: {
							type: 'object',
							description:
								'REQUIRED iff audience is "token", refused otherwise. There is no non-expiring portal token and no default that would produce one by omission — a link somebody emailed a client is a credential sitting in a mail archive, and the only thing that reliably closes it is an expiry chosen when it was minted. The token itself is minted, hashed, expired and revoked by the api-keys bundle; nothing about it is stored in the spec.',
							properties: {
								ttlHours: {
									type: 'number',
									description: `integer 1–${MAX_PORTAL_TOKEN_TTL_HOURS} (one year). Beyond a year the honest answer is an account, not a link.`,
								},
								maxUses: {
									type: ['number', 'null'],
									description:
										'REQUIRED and nullable. null = any number of opens before it expires — a recorded decision. An integer is a hard use cap. Omitting the key is an author who has not decided, which is the one thing it may not be.',
								},
							},
							required: ['ttlHours', 'maxUses'],
						},
						scope: {
							type: 'string',
							enum: [...PORTAL_SCOPES],
							description:
								'"row" = exactly one row, named by the token that opened it, and therefore REQUIRES audience "token": the only thing that can name one row from outside without being guessable, revocable and expiring is a credential, and a row id in a public URL appears in every log and referrer header and can never be revoked. "collection" = the rows a declared filter admits, and no others.',
						},
						readFields: PORTAL_READ_FIELDS_PROP,
						filter: PORTAL_FILTER_PROP,
						writes: PORTAL_WRITES_PROP,
						layout: {
							type: 'string',
							enum: [...PORTAL_LAYOUTS],
							description:
								'presentation ONLY, from theme.set’s block-variant vocabulary — it never affects what is exposed, which is why the exposure report does not mention it. "detail" is required for scope "row" and refused for "collection".',
						},
						paused: {
							type: 'boolean',
							description:
								'whether the surface answers at all. Required, never defaulted. Flip it with portals.pause — the op somebody runs at 3am, which loses nothing.',
						},
						provenance: PROVENANCE_PROP,
					},
					required: [
						'id',
						'key',
						'description',
						'entityId',
						'audience',
						'scope',
						'readFields',
						'writes',
						'layout',
						'paused',
					],
				},
			},
			required: ['portal'],
		},
	},
	'portals.setFields': {
		name: 'portals.setFields',
		layer: 'portals',
		summary:
			'Replace a portal’s field projection wholesale, last-wins — THE EXPOSURE EDIT. Its own op so that "what can the outside see?" is answerable from the op name, before reading a single argument, and so a diff that widens a public surface never arrives disguised as a general-purpose edit.',
		args: {
			type: 'object',
			properties: {
				portalId: { type: 'string', description: 'portal id, prefix "ptl-".' },
				readFields: PORTAL_READ_FIELDS_PROP,
			},
			required: ['portalId', 'readFields'],
		},
	},
	'portals.setWrites': {
		name: 'portals.setWrites',
		layer: 'portals',
		summary:
			'Replace a portal’s write surface wholesale, last-wins. Separate from portals.setFields because turning on an anonymous create is a different decision from showing one more column, and the two should not share a diff line.',
		args: {
			type: 'object',
			properties: {
				portalId: { type: 'string', description: 'portal id, prefix "ptl-".' },
				writes: PORTAL_WRITES_PROP,
			},
			required: ['portalId', 'writes'],
		},
	},
	'portals.pause': {
		name: 'portals.pause',
		layer: 'portals',
		summary:
			'Take a portal offline, or put it back. The op somebody runs at 3am: it requires removing nothing, so the declaration, the projection and every minted token survive and bringing the surface back is one op rather than a re-review. Also the retire step portals.remove insists on first.',
		args: {
			type: 'object',
			properties: {
				portalId: { type: 'string', description: 'portal id, prefix "ptl-".' },
				paused: {
					type: 'boolean',
					description:
						'true stops answering, false answers again. Nothing else changes in either direction.',
				},
			},
			required: ['portalId', 'paused'],
		},
	},
	'portals.remove': {
		name: 'portals.remove',
		layer: 'portals',
		summary:
			'Remove a portal declaration. Refused while it is not paused — pause it first, so removal is never the fastest way to silence something somebody is mid-way through using, and so the thing that stopped the exposure is the thing that is easy to undo.',
		args: {
			type: 'object',
			properties: {
				portalId: { type: 'string', description: 'portal id, prefix "ptl-".' },
			},
			required: ['portalId'],
		},
	},
	'live.declare': {
		name: 'live.declare',
		layer: 'live',
		summary:
			'Declare a LIVE channel over one entity: whether subscribers receive changed rows or the identities of who is viewing a record, bounded to which rows, carrying exactly which columns, under an explicit subscriber ceiling and per-subscriber message rate. The scope line is deliberately narrow — we push changes and we report presence. There is no event kind, no caller-composed payload and no cursor channel: every message exists because a ROW CHANGED, which is what makes it authorizable per message as a read of that row. Conflict resolution beyond last-write-wins is out by recorded decision (d-live-last-write-wins), not by omission. At most one "query" and one "presence" channel per entity.',
		args: {
			type: 'object',
			properties: {
				subscription: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'branded id, prefix "lv-".' },
						key: {
							type: 'string',
							pattern: LIVE_KEY_RE.source,
							description:
								'the channel name in logs and metrics, the /api/live/<key> URL segment and the generated slot module — the string a person types and an incident report quotes.',
						},
						description: {
							type: 'string',
							description:
								'what this channel is for, in one line. It is printed beside the ceilings in the load report, and a channel nobody can explain is one nobody can decide to pause at 3am.',
						},
						entityId: {
							type: 'string',
							description:
								'entity id, prefix "e-". At most ONE channel of each kind per entity: every write to this table pays for every channel over it, so two would double that cost forever with nothing to say which one a surface should read.',
						},
						kind: {
							type: 'string',
							enum: [...LIVE_KINDS],
							description:
								'"query" = changed ROWS are pushed to whoever may read them, which is what makes a derived list, board or calendar update without a refresh. "presence" = the IDENTITIES currently viewing one record, and nothing else about them. There is no third kind, and in particular none that lets a caller push a payload it composed.',
						},
						fields: LIVE_FIELDS_PROP,
						scope: LIVE_SCOPE_PROP,
						maxSubscribers: LIVE_MAX_SUBSCRIBERS_PROP,
						maxMessagesPerMinute: LIVE_MAX_RATE_PROP,
						presenceTtlSeconds: {
							type: 'number',
							description: `integer 1–${MAX_PRESENCE_TTL_SECONDS}. REQUIRED iff kind is "presence", refused otherwise, and never defaulted: a browser tab that crashed sends no goodbye, and the only thing that ever removes its entry is a TTL somebody chose.`,
						},
						maxPresent: {
							type: 'number',
							description: `integer 1–${MAX_PRESENT}. REQUIRED iff kind is "presence", refused otherwise. A cap rather than a page — "212 people are viewing this" is a count, and a list of 212 identities is a directory export with a live feed attached.`,
						},
						slot: {
							type: 'boolean',
							description:
								'whether the platform opens a user-owned file for bespoke live UI over this channel. false emits NOTHING and is the honest common case: a derived list, board or calendar simply updates, and the declaration is the whole implementation. true says the surface is genuinely bespoke — a drag-and-drop board, a threaded reader — and the platform’s job is to say where that code goes and never overwrite it.',
						},
						paused: {
							type: 'boolean',
							description:
								'whether the channel accepts connections. Required, never defaulted. Flip it with live.pause — safe to pull precisely because subscribers fall back to polling the ordinary list endpoint, so a paused channel makes the app slower rather than broken.',
						},
						provenance: PROVENANCE_PROP,
					},
					required: [
						'id',
						'key',
						'description',
						'entityId',
						'kind',
						'fields',
						'scope',
						'maxSubscribers',
						'maxMessagesPerMinute',
						'slot',
						'paused',
					],
				},
			},
			required: ['subscription'],
		},
	},
	'live.setFields': {
		name: 'live.setFields',
		layer: 'live',
		summary:
			'Replace a live channel’s pushed columns wholesale, last-wins — THE PAYLOAD EDIT. Its own op so that "what does a subscriber actually receive?" is answerable from the op name, before reading a single argument: a push is a read, and what it carries is its own review.',
		args: {
			type: 'object',
			properties: {
				subscriptionId: {
					type: 'string',
					description: 'live subscription id, prefix "lv-".',
				},
				fields: LIVE_FIELDS_PROP,
			},
			required: ['subscriptionId', 'fields'],
		},
	},
	'live.setLimits': {
		name: 'live.setLimits',
		layer: 'live',
		summary:
			'Replace a live channel’s two ceilings — THE LOAD LEVER, the op an operator reaches for when a channel is the reason the app is slow. Separate from live.setFields because "we are sending too much" and "we are sending the wrong thing" are different problems found by different people. Both values are restated together rather than patched individually: they multiply into the load the process actually carries, and adjusting one without the other is how the product of the two stops being something anybody reviewed.',
		args: {
			type: 'object',
			properties: {
				subscriptionId: {
					type: 'string',
					description: 'live subscription id, prefix "lv-".',
				},
				maxSubscribers: LIVE_MAX_SUBSCRIBERS_PROP,
				maxMessagesPerMinute: LIVE_MAX_RATE_PROP,
			},
			required: ['subscriptionId', 'maxSubscribers', 'maxMessagesPerMinute'],
		},
	},
	'live.pause': {
		name: 'live.pause',
		layer: 'live',
		summary:
			'Take a live channel offline, or put it back. The 3am lever: it removes nothing, so the declaration, the projection and both ceilings survive and bringing the channel back is one op rather than a re-review. Safe to pull because subscribers fall back to polling the ordinary list endpoint — a paused channel makes the app slower, not broken. Also the retire step live.remove insists on first.',
		args: {
			type: 'object',
			properties: {
				subscriptionId: {
					type: 'string',
					description: 'live subscription id, prefix "lv-".',
				},
				paused: {
					type: 'boolean',
					description:
						'true stops accepting connections and closes the open ones; false starts answering again. The declaration is untouched either way.',
				},
			},
			required: ['subscriptionId', 'paused'],
		},
	},
	'live.remove': {
		name: 'live.remove',
		layer: 'live',
		summary:
			'Remove a live declaration. Refused while it is not paused — pause it first, confirm the polling fallback carried the surface, then remove, so removal is never the fastest way to silence something somebody is mid-way through using.',
		args: {
			type: 'object',
			properties: {
				subscriptionId: {
					type: 'string',
					description: 'live subscription id, prefix "lv-".',
				},
			},
			required: ['subscriptionId'],
		},
	},
	'provenance.review': {
		name: 'provenance.review',
		layer: 'system',
		summary:
			'Accept or reject a suggestion, or reset a settled row back to undecided (a provenance transition, logged for audit — reject is a soft-reject, never a delete, and reset is the undo for an accepted batch). With cascade:true the decision also covers the target’s still-undecided nested rows (fields/blocks); a cascading reset instead covers its settled ones, since those are what an undo has to take back. Never touches a manual row.',
		args: {
			type: 'object',
			properties: {
				target: {
					type: 'object',
					properties: {
						kind: { type: 'string', enum: [...REVIEW_TARGET_KINDS] },
						id: { type: 'string', description: 'the reviewed row’s id.' },
						parentId: {
							type: 'string',
							description:
								'required for nested kinds — the entity id of a field, the page id of a block.',
						},
					},
					required: ['kind', 'id'],
				},
				action: { type: 'string', enum: [...REVIEW_ACTIONS] },
				cascade: {
					type: 'boolean',
					description:
						'also decide the target’s still-undecided nested rows (fields/blocks).',
				},
			},
			required: ['target', 'action'],
		},
	},
}

// ===========================================================================
// Diffs + the op log
// ===========================================================================

export interface SpecDiff {
	op: SpecOpName
	layer: SpecLayer
	/**
	 * Structural adds are `add`; `provenance.review` is a `review` transition;
	 * `set` is an in-place field mutation of an existing row (the first
	 * non-additive structural op — `page.setBlockOrder` retunes an existing
	 * block's ranking without adding or removing anything); `remove` deletes a
	 * row outright, which only `flags.remove` does (a flag system
	 * whose declarations can only accumulate is a flag system full of dead
	 * flags). The deletion is still auditable: the op log keeps this diff.
	 */
	change: 'add' | 'review' | 'set' | 'remove'
	/** The branded id of the thing added or reviewed. */
	targetId: string
	/** The parent it was added under (entity for a field, page for a block). */
	parentId?: string
	summary: string
}

export interface AppliedOp {
	id: OpId
	op: SpecOp
	/** The author *kind*. See {@link OpActor} for which author. */
	origin: 'ai' | 'human'
	appliedAt: ISODate
	diff: SpecDiff
	/**
	 * Which author landed it — surface, agent, session, api key.
	 *
	 * Optional on the *record* and required on the *input* ({@link ApplyMeta}),
	 * which is the asymmetry that lets attribution be mandatory going forward
	 * without rewriting history: an entry decoded from a `spec.json` written
	 * before #200 genuinely has no actor, and inventing one for it would put a
	 * fabricated provenance record in an audit trail.
	 */
	actor?: OpActor
}

// ===========================================================================
// Shared id-collision helpers
// ===========================================================================

function requirementIds(system: SpecSystem): Set<string> {
	return new Set(system.product.requirements.map((r) => r.id))
}
function metricIds(system: SpecSystem): Set<string> {
	return new Set([
		system.product.goals.northStarMetric.id,
		...system.product.goals.supportingMetrics.map((m) => m.id),
		...(system.product.goals.guardrailMetrics ?? []).map((m) => m.id),
	])
}
function scopeIds(system: SpecSystem): Set<string> {
	const s = system.product.scope
	return new Set(
		[...s.mustHave, ...s.shouldHave, ...s.couldHave, ...s.wontHave].map(
			(i) => i.id,
		),
	)
}

/**
 * An op author may supply `provenance` explicitly on an add-op row (usually
 * they shouldn't — {@link defaultProvenance} stamps the right shape). When they
 * do, it must be the real five-column {@link Provenance}: a malformed object
 * would otherwise pass the precondition checks, get stamped verbatim by
 * `applyOp`, and only blow up at save time in the system validator — after
 * `propose_spec_change` already said valid.
 */
function provenanceShapeErrors(
	opName: SpecOpName,
	rows: readonly { what: string; provenance?: Provenance }[],
): string[] {
	const errors: string[] = []
	for (const { what, provenance } of rows) {
		if (provenance === undefined) continue
		if (!provenanceSchema.safeParse(provenance).success)
			errors.push(
				`${opName}: ${what}: malformed provenance — omit it to get the server default, or pass the full {isSuggested: boolean, isAccepted: boolean|null, isAddedManually: boolean|null, suggestedDescription: string|null, priority: "medium"|"high"}`,
			)
	}
	return errors
}

/**
 * A field's `reference` must resolve to an entity — an existing one, (for
 * `data.addEntity`) another entity being added in the same op so a self- or
 * sibling-reference validates, or a well-known {@link virtualEntity} (`e-user`
 * → the auth bundle's user table). Additive-only: a reference can
 * only be added, never point at a removed entity (there is no remove op).
 */
function fieldReferenceErrors(
	system: SpecSystem,
	field: Pick<FieldSpec, 'id' | 'reference' | 'openReference'>,
	opName: SpecOpName,
	extraEntityIds: readonly EntityId[] = [],
): string[] {
	const errors: string[] = []
	const isKnown = (id: EntityId): boolean =>
		system.data.entities.some((e) => e.id === id) ||
		extraEntityIds.includes(id) ||
		virtualEntity(id) !== undefined
	// A candidate that names no entity in *this* project is deliberately NOT an
	// error. The whole premise of an open reference is that the
	// ambiguity lives in the catalog: billing's subject is open over `e-user` and
	// `e-organization`, and a per-seat app installs the first and not the second.
	// Requiring every candidate to exist would force billing to depend on the
	// members bundle, which is the coupling this mechanism exists to avoid.
	//
	// A typo is still caught, where it can be: the bundle contract check asserts
	// every candidate names an entity some bundle in the catalog declares, and
	// narrowing to an unknown entity is refused by the check below.
	if ((field.openReference?.length ?? 0) === 1)
		errors.push(
			`${opName}: field "${field.id}" declares one open-reference candidate, which is not an ambiguity — declare it as a plain reference instead`,
		)
	if (!field.reference) return errors
	if (!isKnown(field.reference))
		errors.push(
			`${opName}: field "${field.id}" -> unknown reference entity "${field.reference}"`,
		)
	return errors
}

/**
 * The op wire format carries a field's `type` verbatim — the compile-time
 * {@link FieldType} union can't guard a JSON payload an agent posts through the
 * MCP `apply_spec_change` tool. An unrecognized `type` (e.g. the CLI-sugar
 * `"text"`, which the terminal DSL aliases to `string` but raw ops do not) would
 * otherwise land in the spec and crash every derived `/admin*` route at render
 * with no rollback. Reject it here so both suggest and accept fail structured.
 */
function fieldTypeErrors(
	field: Pick<FieldSpec, 'id' | 'type'>,
	opName: SpecOpName,
): string[] {
	return (FIELD_TYPES as readonly string[]).includes(field.type)
		? []
		: [
				`${opName}: field "${field.id}" -> unknown type "${field.type}" (expected one of ${FIELD_TYPES.join(', ')})`,
			]
}

/**
 * Normalize an enum field's `options` to the canonical `{label, value}` shape,
 * accepting a bare `string[]`.
 *
 * `["book", "article"]` is the shape agents reach for — two independent trial
 * runs wrote it — and it used to be accepted by validation and then ground to a
 * column that rejected every write, failing at form submit rather than at the
 * op. Since the coercion is lossless and produces exactly what the CLI's
 * `--field kind:enum(book,article)` sugar already builds, accept it rather than
 * spending an agent turn on a round-trip.
 *
 * Returns the input untouched when it isn't an enum or isn't coercible; genuinely
 * malformed options are reported by {@link fieldOptionErrors}, not silently
 * repaired.
 */
function normalizeFieldOptions<T extends { type: string; options?: unknown }>(
	field: T,
): Omit<T, 'options'> & { options?: FieldOption[] } {
	const rest = field as Omit<T, 'options'> & { options?: FieldOption[] }
	if (field.type !== 'enum' || !Array.isArray(field.options)) return rest
	return {
		...rest,
		options: (field.options as unknown[]).map((o) =>
			typeof o === 'string' ? { label: o, value: o } : (o as FieldOption),
		),
	}
}

/** Canonicalize every enum field on an entity. */
function normalizeEntityOptions(
	entity: Omit<EntitySpec, 'fields'> & {
		fields: (Omit<FieldSpec, 'options'> & {
			options?: (string | FieldOption)[]
		})[]
	},
): EntitySpec {
	return { ...entity, fields: entity.fields.map(normalizeFieldOptions) }
}

/**
 * Options that can't be coerced into `{label, value}` — the cases worth an
 * error rather than a repair, because guessing would put an unusable column in
 * the spec with no rollback.
 */
// ---------------------------------------------------------------------------
// Derived-value validation.
//
// #170's gating requirement: "a rollup over a relation that does not exist fails
// at `maxstack validate`, not at render time with an empty card." Everything a
// derived value points at — the aggregated entity, the FK back to the owner, the
// aggregated column, every filter field, the group-by key, every leaf of a
// computed expression — is resolved here, before the op lands.
// ---------------------------------------------------------------------------

/** Every name already taken on an entity: stored fields plus derived values. */
function takenNames(entity: EntitySpec): Set<string> {
	return new Set([
		...entity.fields.map((f) => f.name),
		...(entity.computed ?? []).map((c) => c.name),
		...(entity.rollups ?? []).map((r) => r.name),
	])
}

/** Every derived id already used on an entity. */
function derivedIds(entity: EntitySpec): Set<string> {
	return new Set([
		...(entity.computed ?? []).map((c) => c.id),
		...(entity.rollups ?? []).map((r) => r.id),
	])
}

/**
 * Walk a computed expression, checking depth, operators, literals, and that
 * every leaf resolves to a *numeric stored field* on the entity.
 *
 * Numeric-only is deliberate: arithmetic over a string or a date has no
 * meaning the runtime could honor, and silently coercing would produce a card
 * showing `NaN`. A computed field also may not reference another derived value —
 * that would let two computed fields reference each other, and a cycle detector
 * is a lot of machinery to buy for a feature nobody asked for.
 */
function computedExprErrors(
	expr: unknown,
	entity: EntitySpec,
	label: string,
	opName: SpecOpName,
	depth = 1,
): string[] {
	if (depth > MAX_COMPUTED_DEPTH)
		return [
			`${opName}: ${label} -> expression nests deeper than ${MAX_COMPUTED_DEPTH}`,
		]
	if (typeof expr !== 'object' || expr === null)
		return [`${opName}: ${label} -> expression node must be an object`]

	const node = expr as { kind?: unknown }
	switch (node.kind) {
		case 'field': {
			const { field } = expr as { field?: unknown }
			if (typeof field !== 'string')
				return [`${opName}: ${label} -> field node needs a "field" id`]
			const target = entity.fields.find((f) => f.id === field)
			if (!target)
				return [
					`${opName}: ${label} -> unknown field "${field}" on ${entity.id}`,
				]
			if (target.type !== 'number')
				return [
					`${opName}: ${label} -> field "${field}" is ${target.type}, but arithmetic needs number`,
				]
			return []
		}
		case 'literal': {
			const { value } = expr as { value?: unknown }
			return typeof value === 'number' && Number.isFinite(value)
				? []
				: [`${opName}: ${label} -> literal must be a finite number`]
		}
		case 'binary': {
			const { op, left, right } = expr as {
				op?: unknown
				left?: unknown
				right?: unknown
			}
			const errors: string[] = []
			if (!(COMPUTED_OPERATORS as readonly unknown[]).includes(op))
				errors.push(
					`${opName}: ${label} -> unknown operator "${String(op)}" (expected one of ${COMPUTED_OPERATORS.join(' ')})`,
				)
			// A literal zero divisor is the one arithmetic error catchable statically,
			// and it is worth catching: it turns every row's card into an error.
			if (
				op === '/' &&
				typeof right === 'object' &&
				right !== null &&
				(right as { kind?: unknown }).kind === 'literal' &&
				(right as { value?: unknown }).value === 0
			)
				errors.push(`${opName}: ${label} -> division by the literal 0`)
			errors.push(
				...computedExprErrors(left, entity, label, opName, depth + 1),
				...computedExprErrors(right, entity, label, opName, depth + 1),
			)
			return errors
		}
		default:
			return [
				`${opName}: ${label} -> unknown expression kind "${String(node.kind)}" (expected field, literal, or binary)`,
			]
	}
}

/** Validate a computed field against the entity it lands on. */
function computedFieldErrors(
	entity: EntitySpec,
	computed: ComputedFieldSpecInput,
	opName: SpecOpName,
): string[] {
	const errors: string[] = []
	const label = `computed "${computed.id}"`
	if (derivedIds(entity).has(computed.id))
		errors.push(`${opName}: derived id "${computed.id}" already exists`)
	if (!computed.name)
		errors.push(`${opName}: ${label} -> needs a non-empty name`)
	else if (takenNames(entity).has(computed.name))
		errors.push(
			`${opName}: ${label} -> name "${computed.name}" collides with an existing field or derived value on ${entity.id}`,
		)
	errors.push(...computedExprErrors(computed.expr, entity, label, opName))
	return errors
}

/** Validate a rollup: the aggregated entity, the FK, the column, filters, bounds. */
function rollupErrors(
	system: SpecSystem,
	entity: EntitySpec,
	rollup: RollupSpecInput,
	opName: SpecOpName,
): string[] {
	const errors: string[] = []
	const label = `rollup "${rollup.id}"`

	if (derivedIds(entity).has(rollup.id))
		errors.push(`${opName}: derived id "${rollup.id}" already exists`)
	if (!rollup.name) errors.push(`${opName}: ${label} -> needs a non-empty name`)
	else if (takenNames(entity).has(rollup.name))
		errors.push(
			`${opName}: ${label} -> name "${rollup.name}" collides with an existing field or derived value on ${entity.id}`,
		)

	if (!(AGG_FNS as readonly string[]).includes(rollup.fn))
		errors.push(
			`${opName}: ${label} -> unknown fn "${rollup.fn}" (expected one of ${AGG_FNS.join(', ')})`,
		)

	// The relation must exist. This is the check #170 names explicitly.
	const over = system.data.entities.find((e) => e.id === rollup.over)
	if (!over) {
		errors.push(
			`${opName}: ${label} -> unknown entity "${rollup.over}" to roll up`,
		)
		return errors
	}

	// Walk the `via` path from `over` up to the owning entity. Every hop must be a
	// real reference field on the current entity, and the last hop must land on
	// `entity` — a rollup wired through an unrelated FK would silently aggregate
	// the wrong rows, which is worse than failing.
	if (rollup.via !== undefined) {
		const hops = Array.isArray(rollup.via) ? rollup.via : [rollup.via]
		if (hops.length === 0) {
			errors.push(
				`${opName}: ${label} -> via -> empty path; omit "via" for a table-wide rollup`,
			)
		} else if (hops.length > MAX_ROLLUP_HOPS) {
			errors.push(
				`${opName}: ${label} -> via -> ${hops.length} hops exceeds the ${MAX_ROLLUP_HOPS}-hop cap (each hop is a join)`,
			)
		} else {
			let current: EntitySpec | undefined = over
			for (const [i, hop] of hops.entries()) {
				const where = current ? current.id : '(unresolved)'
				const fk: FieldSpec | undefined = current?.fields.find(
					(f) => f.id === hop,
				)
				if (!fk) {
					errors.push(
						`${opName}: ${label} -> via[${i}] -> unknown field "${hop}" on ${where}`,
					)
					break
				}
				if (!fk.reference) {
					// An open reference is refused with the *fix* rather than with the
					// generic "not a reference": narrowing is a
					// precondition for traversal, not an alternative to it. Aggregating
					// across whatever ids happen to be in an un-narrowed column is a
					// number nobody can audit and everybody believes — which for the
					// billing ledger this exists for is the worst possible shape.
					errors.push(
						fk.openReference
							? `${opName}: ${label} -> via[${i}] -> field "${fk.id}" is an OPEN reference over ${fk.openReference.join(', ')} and has not been narrowed; declare which one this app means with data.setFieldReference before rolling up through it`
							: `${opName}: ${label} -> via[${i}] -> field "${fk.id}" is not a reference, so it cannot relate ${where} to the next hop`,
					)
					break
				}
				const isLast = i === hops.length - 1
				if (isLast) {
					if (fk.reference !== entity.id)
						errors.push(
							`${opName}: ${label} -> via[${i}] -> field "${fk.id}" references "${fk.reference}", not "${entity.id}"; the last hop must land on the entity the rollup is exposed on`,
						)
					break
				}
				const nextEntity: EntitySpec | undefined = system.data.entities.find(
					(e) => e.id === fk.reference,
				)
				if (!nextEntity) {
					errors.push(
						`${opName}: ${label} -> via[${i}] -> field "${fk.id}" references unknown entity "${fk.reference}"`,
					)
					break
				}
				current = nextEntity
			}
		}
	}

	// The aggregated value: a stored field, or a computed field on `over`.
	const needsField = (AGG_FNS_NEEDING_FIELD as readonly string[]).includes(
		rollup.fn,
	)
	if (needsField && rollup.field === undefined) {
		errors.push(
			`${opName}: ${label} -> fn "${rollup.fn}" needs a field to aggregate`,
		)
	} else if (rollup.field !== undefined) {
		if (rollup.fn === 'count')
			errors.push(
				`${opName}: ${label} -> fn "count" counts rows and takes no field (use countDistinct)`,
			)
		const stored = over.fields.find((f) => f.id === rollup.field)
		const computed = (over.computed ?? []).find((c) => c.id === rollup.field)
		// Rolling up a rollup is the ONE edge that would make the derived graph
		// cyclic (see `RollupSpec.field`). Name it explicitly rather than letting it
		// fall through to a confusing "unknown field".
		const isRollup = (over.rollups ?? []).some((r) => r.id === rollup.field)

		if (isRollup)
			errors.push(
				`${opName}: ${label} -> cannot aggregate rollup "${rollup.field}"; a rollup may aggregate a stored or computed field, never another rollup`,
			)
		else if (!stored && !computed)
			errors.push(
				`${opName}: ${label} -> unknown field "${rollup.field}" on ${over.id}`,
			)
		else if (
			stored &&
			(NUMERIC_AGG_FNS as readonly string[]).includes(rollup.fn) &&
			stored.type !== 'number'
		)
			errors.push(
				`${opName}: ${label} -> fn "${rollup.fn}" needs a number field, but "${stored.id}" is ${stored.type}`,
			)
		// A computed field needs no numeric check: its expression is arithmetic over
		// number fields, so it is numeric by construction.
	}

	for (const filter of rollup.where ?? []) {
		const target = over.fields.find((f) => f.id === filter.field)
		if (!target)
			errors.push(
				`${opName}: ${label} -> where -> unknown field "${filter.field}" on ${over.id}`,
			)
	}

	// Grouping, and the cost bound it requires.
	if (rollup.groupBy) {
		const key = over.fields.find((f) => f.id === rollup.groupBy?.field)
		if (!key)
			errors.push(
				`${opName}: ${label} -> groupBy -> unknown field "${rollup.groupBy.field}" on ${over.id}`,
			)
		const bucket = rollup.groupBy.bucket
		if (bucket !== undefined) {
			if (!(TIME_BUCKETS as readonly string[]).includes(bucket))
				errors.push(
					`${opName}: ${label} -> groupBy -> unknown bucket "${bucket}" (expected one of ${TIME_BUCKETS.join(', ')})`,
				)
			else if (key && key.type !== 'date')
				errors.push(
					`${opName}: ${label} -> groupBy -> bucket "${bucket}" needs a date field, but "${key.id}" is ${key.type}`,
				)
		}
		// #170's cost-visibility gate: an unbounded GROUP BY is the foot-gun.
		if (rollup.limit === undefined)
			errors.push(
				`${opName}: ${label} -> a grouped rollup must declare a limit (the cost bound); max ${MAX_ROLLUP_LIMIT}`,
			)
	}
	if (rollup.limit !== undefined) {
		if (!Number.isInteger(rollup.limit) || rollup.limit < 1)
			errors.push(`${opName}: ${label} -> limit must be a positive integer`)
		else if (rollup.limit > MAX_ROLLUP_LIMIT)
			errors.push(
				`${opName}: ${label} -> limit ${rollup.limit} exceeds the ${MAX_ROLLUP_LIMIT} cap`,
			)
	}

	return errors
}

function fieldOptionErrors(
	field: { id: string; type: string; options?: unknown },
	opName: SpecOpName,
): string[] {
	if (field.type !== 'enum') return []
	const raw = field.options as unknown
	if (raw === undefined) return []
	if (!Array.isArray(raw))
		return [`${opName}: field "${field.id}" -> options must be an array`]
	if (raw.length === 0)
		return [`${opName}: enum field "${field.id}" needs at least one option`]
	const bad = raw.findIndex(
		(o) =>
			!(
				typeof o === 'string' ||
				(typeof o === 'object' &&
					o !== null &&
					typeof (o as { value?: unknown }).value === 'string')
			),
	)
	return bad === -1
		? []
		: [
				`${opName}: field "${field.id}" -> option ${bad} must be a string or {label, value} (got ${JSON.stringify(raw[bad])})`,
			]
}

/**
 * Issue #183 — the `file` declaration is where a file field's security posture
 * is stated, so this validator is deliberately strict in both directions: a
 * `file` field *must* carry an allowlist and a cap, and a non-file field must
 * not carry one (a `file` block on a `string` field would be a constraint
 * nothing enforces, which is worse than no constraint at all).
 *
 * Everything checked here is a property the upload path later relies on:
 * `acceptsContentType` needs syntactically valid patterns, the server-side size
 * wall needs a finite positive cap, and the derivative materializer needs
 * unique names and bounded dimensions.
 */
function fieldFileErrors(
	field: { id: string; type: string; file?: unknown; reference?: unknown },
	opName: SpecOpName,
): string[] {
	const where = `${opName}: field "${field.id}"`
	const raw = field.file

	if (field.type !== 'file') {
		return raw === undefined
			? []
			: [
					`${where} -> only a field of type "file" may declare "file" constraints`,
				]
	}
	if (field.reference !== undefined) {
		return [`${where} -> a file field cannot also be a reference`]
	}
	if (raw === undefined) {
		return [
			`${where} -> a file field must declare "file" with an "accept" allowlist and "maxSizeBytes" (uploads are unbounded otherwise)`,
		]
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return [`${where} -> "file" must be an object`]
	}

	const errors: string[] = []
	const spec = raw as {
		accept?: unknown
		maxSizeBytes?: unknown
		derivatives?: unknown
	}

	// --- accept -------------------------------------------------------------
	const accept = spec.accept
	let acceptPatterns: string[] = []
	if (!Array.isArray(accept) || accept.length === 0) {
		errors.push(
			`${where} -> "file.accept" must be a non-empty array of MIME patterns (e.g. ["image/png","image/jpeg"])`,
		)
	} else {
		acceptPatterns = accept.filter((p): p is string => typeof p === 'string')
		for (const [index, pattern] of accept.entries()) {
			// Checked before the syntax rule so `*` / `*&#47;*` — the mistake people
			// actually make — gets an error that names the mistake, rather than the
			// generic "that is not a MIME pattern" the syntax rule would give it.
			if (typeof pattern === 'string' && pattern.trimStart().startsWith('*')) {
				errors.push(
					`${where} -> "file.accept[${index}]" cannot be a bare wildcard — name the types this field accepts`,
				)
			} else if (typeof pattern !== 'string' || !isAcceptPattern(pattern)) {
				errors.push(
					`${where} -> "file.accept[${index}]" must be a MIME type or one-level wildcard like "image/*" (got ${JSON.stringify(pattern)})`,
				)
			}
		}
	}

	// --- maxSizeBytes -------------------------------------------------------
	const cap = spec.maxSizeBytes
	if (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0) {
		errors.push(
			`${where} -> "file.maxSizeBytes" must be a positive integer number of bytes`,
		)
	} else if (cap > FILE_MAX_SIZE_CEILING) {
		errors.push(
			`${where} -> "file.maxSizeBytes" ${cap} exceeds the ${FILE_MAX_SIZE_CEILING}-byte ceiling for a form file field`,
		)
	}

	// --- derivatives --------------------------------------------------------
	const derivatives = spec.derivatives
	if (derivatives !== undefined) {
		if (!Array.isArray(derivatives)) {
			errors.push(`${where} -> "file.derivatives" must be an array`)
		} else {
			const imageOnly =
				acceptPatterns.length > 0 && acceptPatterns.every(isImageAcceptPattern)
			if (derivatives.length > 0 && !imageOnly) {
				errors.push(
					`${where} -> "file.derivatives" needs an image-only "accept" allowlist (there is nothing to resize otherwise)`,
				)
			}
			const seen = new Set<string>()
			for (const [index, entry] of derivatives.entries()) {
				const at = `${where} -> "file.derivatives[${index}]"`
				if (typeof entry !== 'object' || entry === null) {
					errors.push(`${at} must be an object`)
					continue
				}
				const d = entry as { name?: unknown; width?: unknown; height?: unknown }
				if (
					typeof d.name !== 'string' ||
					!/^[a-z0-9][a-z0-9-]*$/.test(d.name)
				) {
					errors.push(
						`${at}.name must be a lowercase slug (it becomes the "@name" suffix on the storage key)`,
					)
				} else if (seen.has(d.name)) {
					errors.push(`${at}.name "${d.name}" is declared twice`)
				} else {
					seen.add(d.name)
				}
				for (const dim of ['width', 'height'] as const) {
					const value = d[dim]
					if (value === undefined && dim === 'height') continue
					if (
						typeof value !== 'number' ||
						!Number.isInteger(value) ||
						value <= 0 ||
						value > FILE_DERIVATIVE_MAX_DIMENSION
					) {
						errors.push(
							`${at}.${dim} must be an integer between 1 and ${FILE_DERIVATIVE_MAX_DIMENSION}`,
						)
					}
				}
			}
		}
	}

	return errors
}

/**
 * Issue #172 — a `rank: true` field is a manual-ordering key, and the rules are
 * the ones that make the *rest* of the design work rather than style choices:
 *
 *  - **`string` only.** The key is an opaque string compared lexicographically,
 *    and `rankBetween` can always produce one between two others. A number can
 *    not: floats run out of precision after a few dozen reorders in the same
 *    gap, and integers run out immediately.
 *  - **Never required.** The column is written by the platform (a database
 *    default at insert, a drag afterwards), never typed by a person, so
 *    demanding it on a form is demanding a sort key nobody can author.
 *  - **Never a reference, never an enum's option list.** A rank key means
 *    nothing except "after this one, before that one".
 */
function fieldRankErrors(
	field: {
		id: string
		type: string
		rank?: unknown
		required?: unknown
		reference?: unknown
	},
	opName: SpecOpName,
): string[] {
	const where = `${opName}: field "${field.id}"`
	if (field.rank === undefined) return []
	if (typeof field.rank !== 'boolean')
		return [`${where} -> "rank" must be a boolean`]
	if (!field.rank) return []
	const errors: string[] = []
	if (field.type !== 'string')
		errors.push(
			`${where} -> only a "string" field may be a rank key (got "${field.type}") — the key is an opaque string so a new one always fits between two others`,
		)
	if (field.reference !== undefined)
		errors.push(`${where} -> a rank key cannot also be a reference`)
	if (field.required === true)
		errors.push(
			`${where} -> a rank key cannot be required — it is stamped by the database and set by moving a row, never typed into a form`,
		)
	return errors
}

/**
 * Issue #172 — per-value row caps (WIP limits). Validated against the field's
 * *declared* options rather than against whatever is in the table, so a cap on
 * a value the column cannot hold is refused at op time instead of silently
 * never firing.
 */
function fieldLimitsErrors(
	field: { id: string; type: string; limits?: unknown; options?: unknown },
	opName: SpecOpName,
	/** The values the field may hold, when they are known (an already-stored
	 * field's options; the op payload's own for a field being added). */
	values?: readonly string[],
): string[] {
	const where = `${opName}: field "${field.id}"`
	const raw = field.limits
	if (raw === undefined) return []
	if (field.type !== 'enum')
		return [
			`${where} -> only an "enum" field may declare value limits (got "${field.type}")`,
		]
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return [`${where} -> "limits" must be an object of value -> cap`]

	const errors: string[] = []
	for (const [value, cap] of Object.entries(raw as Record<string, unknown>)) {
		if (values && !values.includes(value))
			errors.push(
				`${where} -> limit on "${value}", which is not one of the declared options (${values.join(', ') || 'none'})`,
			)
		if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1)
			errors.push(
				`${where} -> limit for "${value}" must be a positive integer (got ${JSON.stringify(cap)})`,
			)
		else if (cap > MAX_VALUE_LIMIT)
			errors.push(
				`${where} -> limit for "${value}" is ${cap}, above the ${MAX_VALUE_LIMIT} ceiling — a cap that high is not a constraint the product has`,
			)
	}
	return errors
}

/**
 * Issue #345 — a `number` field's declared presentation. Two things are being
 * refused here, and both are about keeping the key honest about what it is:
 *
 *  - **Number fields only.** Every member of {@link NUMBER_DISPLAY_FORMATS} is a
 *    way of drawing a number, so `display` on a string or a date names a widget
 *    that does not exist for it. A silently-ignored declaration is worse than a
 *    refusal: the author reads the spec back and believes it.
 *  - **A range that is a range.** `min` must be below `max` and `step` must be
 *    positive, because the widgets divide by them — a `max` of 0 is a rating
 *    with no stars and a `step` of 0 is a slider that cannot move.
 *
 * What is deliberately *not* checked: nothing here is a constraint on stored
 * values. `display` says how a number is drawn, and the API keeps accepting
 * numbers outside it (see {@link FieldSpec.display}).
 */
function fieldDisplayErrors(
	field: { id: string; type: string; display?: unknown },
	opName: SpecOpName,
): string[] {
	const where = `${opName}: field "${field.id}"`
	const raw = field.display
	if (raw === undefined) return []
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return [`${where} -> "display" must be an object`]
	if (field.type !== 'number')
		return [
			`${where} -> only a "number" field may declare display (got "${field.type}") — every declarable format is a way of drawing a number`,
		]

	const errors: string[] = []
	const { format, min, max, step } = raw as Record<string, unknown>
	if (
		format !== undefined &&
		!(NUMBER_DISPLAY_FORMATS as readonly unknown[]).includes(format)
	)
		errors.push(
			`${where} -> display.format "${String(format)}" is not one of ${NUMBER_DISPLAY_FORMATS.join(', ')}`,
		)
	for (const [key, value] of [
		['min', min],
		['max', max],
		['step', step],
	] as const) {
		if (value === undefined) continue
		if (typeof value !== 'number' || !Number.isFinite(value))
			errors.push(`${where} -> display.${key} must be a finite number`)
	}
	if (typeof min === 'number' && typeof max === 'number' && min >= max)
		errors.push(
			`${where} -> display.min (${min}) must be below display.max (${max})`,
		)
	if (typeof step === 'number' && step <= 0)
		errors.push(
			`${where} -> display.step must be positive — a step of ${step} is a control that cannot move`,
		)
	if (format === 'rating' && typeof max === 'number' && max <= 0)
		errors.push(
			`${where} -> a rating's display.max must be positive (got ${max}) — that is the number of stars`,
		)
	return errors
}

/** The values an enum field's options declare, or `undefined` when it has none
 * (a permissive text column — there is nothing to check a limit against). */
function optionValuesOf(field: {
	options?: unknown
}): readonly string[] | undefined {
	const raw = field.options
	if (!Array.isArray(raw) || raw.length === 0) return undefined
	return raw.map((o) =>
		typeof o === 'string' ? o : String((o as { value?: unknown }).value),
	)
}

// ===========================================================================
// validateOp — preconditions, never mutates
// ===========================================================================

/**
 * Is this a `slot:<name>` block? Duplicates `isSlotBlockType` from
 * `@maxstack/core/ownership` rather than importing it — core depends on spec,
 * so the reverse import would be a cycle. The prefix is the shared contract.
 */
function isSlotBlock(type: string): boolean {
	return type.startsWith('slot:')
}

/**
 * Why a field cannot be edited from a list cell, or `null` when it can.
 *
 * The rule is derived from the field's own declaration and lives here, in one
 * function, because both the set-op and the inline block form have to refuse the
 * same declarations — the lesson of #314 is that a declaration legal inline and
 * illegal one op later teaches the inline form as the way to dodge validation.
 *
 * A cell editor is a text box, a number box, a checkbox, a date picker or a
 * select. Everything refused below is refused because *no such editor exists for
 * it*, and a cell that cannot represent its value is a cell that silently
 * corrupts it on the first blur:
 *
 *  - a **reference** holds a foreign key; typing a UUID into a table cell is not
 *    an affordance, it is a data-loss bug with a cursor in it;
 *  - a **file** column holds a storage key the upload path writes;
 *  - **json** has no single-line form, and `String(value)` round-trips to the
 *    literal `[object Object]`;
 *  - a **rank key** is written by moving a row, never by typing (the field's own
 *    declaration already says it is read-only in forms);
 *  - an **enum with no options** would render an empty select — a cell that can
 *    only ever clear the value it shows.
 */
function inlineEditRefusal(field: FieldSpec): string | null {
	if (field.reference || (field.openReference?.length ?? 0) > 0)
		return 'is a reference — a cell editor would be a raw id text box; edit it in the form, which offers a name picker'
	if (field.rank)
		return 'is a rank key — it is written by moving a row, never by typing'
	if (field.type === 'file')
		return 'is a file — it is written by the upload path, not by typing a storage key'
	if (field.type === 'json')
		return 'is json — it has no single-line editor, and a cell would round-trip it to "[object Object]"'
	if (field.type === 'enum' && (field.options?.length ?? 0) === 0)
		return 'is an enum with no declared options — the cell would render an empty select'
	return null
}

/**
 * Everything `page.addPage`'s *inline* blocks must be true about.
 *
 * The bug this exists for: a page declared with a `table` block carrying
 * `order.field: "finishedOn"` and **no `entityId`** was accepted silently, and
 * the batch only refused one op later, when `page.addBoard` ran the very same
 * "is there a backing entity?" check on the very same page. The agent was then
 * told to fix the board — the op that was correctly formed — while the defect
 * sat in the page's own args. A declaration that names columns of an entity the
 * page does not have is unsatisfiable the moment it is written, so it is
 * refused there, at the index whose args have to change.
 *
 * The checks mirror `page.setBlockOrder` / `page.setBlockVariant` /
 * `page.setBlockFields` exactly: the same declaration must not be legal inline
 * and illegal one op later, or the surface teaches that the inline form is the
 * way to dodge validation.
 */
function inlineBlockErrors(
	system: SpecSystem,
	op: Extract<SpecOp, { op: 'page.addPage' }>,
): string[] {
	const errors: string[] = []
	const page = op.args.page
	const blocks = Array.isArray(page.blocks) ? page.blocks : []
	const entity = page.entityId
		? system.data.entities.find((e) => e.id === page.entityId)
		: undefined

	for (const [i, block] of blocks.entries()) {
		const where = `${op.op}: page "${page.id}" block "${block.id}"`
		if (blocks.findIndex((b) => b.id === block.id) !== i) {
			errors.push(`${where} -> duplicate block id`)
			continue
		}

		if (block.mode !== undefined) {
			if (block.mode !== 'append' && block.mode !== 'replace')
				errors.push(
					`${where} -> bad mode "${String(block.mode)}" (expected "append" or "replace")`,
				)
			else if (block.mode === 'replace' && !isSlotBlock(block.type))
				errors.push(
					`${where} -> is type "${block.type}", not a "slot:<name>" block — only a slot can replace the default list`,
				)
		}

		if (
			block.variant !== undefined &&
			!(BLOCK_VARIANTS as readonly string[]).includes(block.variant)
		)
			errors.push(
				`${where} -> unknown variant "${String(block.variant)}" (expected one of ${BLOCK_VARIANTS.join(', ')})`,
			)

		// Presentation keys the runtime only honors on a list/table block. Same
		// rule as the `set*` ops: a silently ignored layout instruction is worse
		// than a rejected one.
		for (const key of ['variant', 'order', 'fields', 'editable'] as const)
			if (block[key] !== undefined && block.type !== 'table')
				errors.push(
					`${where} -> declares "${key}" but is type "${block.type}", not an orderable list/table block`,
				)

		const names: string[] = []
		if (block.order !== undefined) {
			const order = block.order
			if (
				order.direction !== undefined &&
				!['asc', 'desc'].includes(order.direction)
			)
				errors.push(
					`${where} -> order.direction "${order.direction}" is not "asc" or "desc"`,
				)
			if (typeof order.field !== 'string' || order.field === '')
				errors.push(`${where} -> order.field must be a field name`)
			else names.push(order.field)
		}
		if (block.fields !== undefined) {
			if (!Array.isArray(block.fields) || block.fields.length === 0)
				errors.push(
					`${where} -> "fields" must be a non-empty array of field names`,
				)
			else {
				const dupes = block.fields.filter(
					(f, j) => block.fields?.indexOf(f) !== j,
				)
				if (dupes.length > 0)
					errors.push(`${where} -> duplicate field "${dupes[0]}"`)
				names.push(...block.fields)
			}
		}
		// An inline `editable` is checked exactly as `page.setBlockEditable` checks
		// it — the whole point of this function. Unlike `fields`, `[]` is legal: it
		// is the declared read-only list, and the op accepts it as the clear.
		const editable = block.editable
		if (editable !== undefined) {
			if (!Array.isArray(editable))
				errors.push(
					`${where} -> "editable" must be an array of field names (pass [] for none)`,
				)
			else {
				const dupes = editable.filter((f, j) => editable.indexOf(f) !== j)
				if (dupes.length > 0)
					errors.push(`${where} -> duplicate editable field "${dupes[0]}"`)
				names.push(...editable)
			}
		}
		if (names.length === 0) continue

		// The heart of #314: naming columns is only meaningful against a backing
		// entity, and the arg that is missing is the PAGE's `entityId` — so that is
		// what the message names, not the block.
		if (!page.entityId) {
			errors.push(
				`${where} -> names field(s) ${names.map((n) => `"${n}"`).join(', ')} but page "${page.id}" declares no "entityId", so there is no entity those columns could belong to — set entityId on the page`,
			)
			continue
		}
		// An unknown entityId is already reported once, by the case body; naming
		// its fields again would be noise.
		if (!entity) continue
		for (const name of names)
			if (!entity.fields.some((f) => f.name === name))
				errors.push(`${where} -> "${name}" is not a field of "${entity.id}"`)
		for (const name of Array.isArray(editable) ? editable : []) {
			const field = entity.fields.find((f) => f.name === name)
			// An unknown name is already reported by the loop above.
			const refusal = field ? inlineEditRefusal(field) : null
			if (refusal) errors.push(`${where} -> editable "${name}" ${refusal}`)
		}
	}
	return errors
}

/**
 * Everything `page.addCalendar` / `page.addTimeline` must be true about before
 * a view block lands.
 *
 * A date-arranged view is only as trustworthy as the columns it names, so every
 * named field is resolved against the page's backing entity *and* type-checked:
 * a calendar placed by a `string` column renders rows in an order nobody can
 * explain, and finding that out at render time is the failure this prevents.
 * The timezone is checked against the runtime's own IANA database, for the same
 * reason `schedules.declare` does it — a typo'd zone that falls back to UTC is a
 * calendar that is silently wrong by hours.
 */
function viewBlockErrors(
	system: SpecSystem,
	op: Extract<
		SpecOp,
		{ op: 'page.addCalendar' | 'page.addTimeline' | 'page.addBoard' }
	>,
): string[] {
	const errors: string[] = []
	const { pageId, blockId } = op.args
	const page = system.pages.pages.find((p) => p.id === pageId)
	if (!page) return [`${op.op}: unknown page "${pageId}"`]
	if (page.blocks.some((b) => b.id === blockId))
		errors.push(`${op.op}: duplicate block id "${blockId}"`)

	const entity = system.data.entities.find((e) => e.id === page.entityId)
	if (!entity)
		return [
			...errors,
			`${op.op}: page "${pageId}" has no backing entity whose rows could be arranged`,
		]

	/** A named field must exist; when `type` is given it must also be that type. */
	const fieldNamed = (
		label: string,
		name: string,
		type?: FieldSpec['type'],
	): FieldSpec | undefined => {
		const found = entity.fields.find((f) => f.name === name)
		if (!found) {
			errors.push(
				`${op.op}: ${label} "${name}" is not a field of "${entity.id}"`,
			)
			return undefined
		}
		if (type && found.type !== type)
			errors.push(
				`${op.op}: ${label} "${name}" is type "${found.type}", not "${type}" — this view arranges rows by a column of type "${type}"`,
			)
		return found
	}

	// A board arranges rows by a *value*, not by an instant, so it is the one view
	// with no timezone to declare — bucketing a card into a column is the same
	// answer in every zone.
	if (op.op === 'page.addBoard') {
		const board = op.args.board
		if (board.titleField !== undefined)
			fieldNamed('titleField', board.titleField)
		const group = fieldNamed('groupField', board.groupField, 'enum')
		// The options ARE the columns. Without them the board has nothing to draw:
		// an enum with no declared value list grounds to a permissive text column,
		// so the "columns" would be whatever values happen to be in the table today
		// — a board whose shape changes when someone types a typo.
		if (group && !(group.options && group.options.length > 0))
			errors.push(
				`${op.op}: groupField "${board.groupField}" has no declared options, so the board has no columns — declare the enum's values first`,
			)
		if (board.rankField !== undefined) {
			const rank = fieldNamed('rankField', board.rankField)
			// Ordering by a column people can type into is ordering by whatever they
			// typed. `rank: true` is what makes the column non-null, hidden and
			// machine-written; a plain string field is none of those.
			if (rank && rank.rank !== true)
				errors.push(
					`${op.op}: rankField "${board.rankField}" is not declared rank:true — a manual-ordering key has to be a rank field (never null, never hand-edited)`,
				)
		}
		for (const name of board.cardFields ?? []) {
			if (name === board.rankField)
				errors.push(
					`${op.op}: cardFields includes the rankField "${name}" — a rank key is an opaque sort key, not something to show on a card`,
				)
			else fieldNamed('cardFields entry', name)
		}
		const dupes = (board.cardFields ?? []).filter(
			(f, i) => (board.cardFields ?? []).indexOf(f) !== i,
		)
		if (dupes.length > 0)
			errors.push(`${op.op}: duplicate cardFields entry "${dupes[0]}"`)
		return errors
	}

	const view =
		op.op === 'page.addCalendar' ? op.args.calendar : op.args.timeline
	if (!isValidTimezone(view.timezone))
		errors.push(
			`${op.op}: unknown timezone "${view.timezone}" (IANA name, e.g. "America/New_York")`,
		)
	if (view.titleField !== undefined) fieldNamed('titleField', view.titleField)

	if (op.op === 'page.addCalendar') {
		const calendar = op.args.calendar
		if (!(CALENDAR_DISPLAYS as readonly string[]).includes(calendar.display))
			errors.push(
				`${op.op}: unknown display "${String(calendar.display)}" (expected one of ${CALENDAR_DISPLAYS.join(', ')})`,
			)
		fieldNamed('dateField', calendar.dateField, 'date')
		if (calendar.endField !== undefined) {
			fieldNamed('endField', calendar.endField, 'date')
			if (calendar.endField === calendar.dateField)
				errors.push(
					`${op.op}: endField "${calendar.endField}" is the same field as dateField — an entry spanning one field is a single day, so omit it`,
				)
		}
		// A heatmap draws counts, not entries: there is nothing to pick up and no
		// single row a drop would rewrite. Refused rather than silently ignored,
		// the same rule as a variant on a non-list block.
		if (calendar.reschedule && calendar.display === 'heatmap')
			errors.push(
				`${op.op}: display "heatmap" draws per-day counts, so its cells cannot be rescheduled — drop reschedule, or use "month"/"week"`,
			)
		return errors
	}

	const timeline = op.args.timeline
	fieldNamed('startField', timeline.startField, 'date')
	fieldNamed('endField', timeline.endField, 'date')
	if (timeline.endField === timeline.startField)
		errors.push(
			`${op.op}: endField "${timeline.endField}" is the same field as startField — a bar needs two ends`,
		)
	if (timeline.dependsOn !== undefined) {
		const field = fieldNamed('dependsOn', timeline.dependsOn)
		// The arrow points from one row of this entity to another, so the field has
		// to be a declared self-reference. Anything else is a line drawn between
		// rows that are not related, which is worse than no line at all.
		if (field && field.reference !== entity.id)
			errors.push(
				field.reference
					? `${op.op}: dependsOn "${timeline.dependsOn}" references "${field.reference}", not its own entity "${entity.id}" — a dependency edge joins two rows of the same entity`
					: `${op.op}: dependsOn "${timeline.dependsOn}" is not a reference field — declare it with data.setFieldReference to "${entity.id}" first`,
			)
	}
	return errors
}

/**
 * Targeting is an allowlist layered over a default-*off* flag, so
 * targeting a flag that is already on for everyone is rejected rather than
 * stored: it reads like a rollout, changes no outcome, and is exactly the shape
 * a half-finished rollout leaves behind. Turning the default off is the fix.
 */
function flagTargetingErrors(
	opName: SpecOpName,
	targeting: FlagTargeting | undefined,
	defaultValue: boolean,
): string[] {
	if (targeting === undefined) return []
	const errors: string[] = []
	if (typeof targeting !== 'object' || targeting === null)
		return [`${opName}: targeting must be an object`]
	if (defaultValue)
		errors.push(
			`${opName}: targeting cannot narrow a flag whose default is true — it is already on for everyone`,
		)
	const known = new Set(['roles', 'organizations', 'rolloutPercent'])
	for (const key of Object.keys(targeting))
		if (!known.has(key))
			errors.push(
				`${opName}: unknown targeting key "${key}" (expected: ${[...known].join(', ')})`,
			)
	for (const key of ['roles', 'organizations'] as const) {
		const value = targeting[key]
		if (value === undefined) continue
		if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
			errors.push(`${opName}: targeting.${key} must be an array of strings`)
		else if (value.length === 0)
			errors.push(
				`${opName}: targeting.${key} is empty — omit the key rather than declaring a rule that matches nobody`,
			)
	}
	const percent = targeting.rolloutPercent
	if (
		percent !== undefined &&
		(typeof percent !== 'number' ||
			!Number.isInteger(percent) ||
			percent < 0 ||
			percent > MAX_ROLLOUT_PERCENT)
	)
		errors.push(
			`${opName}: targeting.rolloutPercent must be an integer 0–${MAX_ROLLOUT_PERCENT}`,
		)
	return errors
}

export function validateOp(system: SpecSystem, op: SpecOp): string[] {
	const errors: string[] = []
	const dup = (has: boolean, id: string, kind: string) => {
		if (has) errors.push(`${op.op}: ${kind} id "${id}" already exists`)
	}

	switch (op.op) {
		case 'prd.addRequirement': {
			const { requirement, intoPhaseId } = op.args
			dup(
				requirementIds(system).has(requirement.id),
				requirement.id,
				'requirement',
			)
			const metrics = metricIds(system)
			for (const m of requirement.servesMetricIds ?? [])
				if (!metrics.has(m))
					errors.push(`${op.op}: servesMetricIds -> unknown metric "${m}"`)
			const reqs = requirementIds(system)
			for (const e of requirement.enhancesRequirementIds ?? [])
				if (!reqs.has(e))
					errors.push(
						`${op.op}: enhancesRequirementIds -> unknown requirement "${e}"`,
					)
			if (
				intoPhaseId !== undefined &&
				!system.product.roadmap.phases.some((p) => p.id === intoPhaseId)
			)
				errors.push(`${op.op}: intoPhaseId -> unknown phase "${intoPhaseId}"`)
			break
		}
		case 'prd.addScopeItem': {
			dup(scopeIds(system).has(op.args.item.id), op.args.item.id, 'scope')
			const rid = op.args.item.realizedByRequirementId
			if (rid !== undefined && !requirementIds(system).has(rid))
				errors.push(
					`${op.op}: realizedByRequirementId -> unknown requirement "${rid}"`,
				)
			break
		}
		case 'prd.addRisk': {
			dup(
				system.product.risks.some((r) => r.id === op.args.risk.id),
				op.args.risk.id,
				'risk',
			)
			const { likelihood, impact } = op.args.risk
			if (likelihood < 0 || likelihood > 1)
				errors.push(`${op.op}: likelihood out of 0–1`)
			if (impact < 0 || impact > 1) errors.push(`${op.op}: impact out of 0–1`)
			const assumptionIds = new Set(system.product.assumptions.map((a) => a.id))
			for (const a of op.args.risk.threatensAssumptionIds ?? [])
				if (!assumptionIds.has(a))
					errors.push(
						`${op.op}: threatensAssumptionIds -> unknown assumption "${a}"`,
					)
			break
		}
		case 'prd.addMetric': {
			dup(metricIds(system).has(op.args.metric.id), op.args.metric.id, 'metric')
			const eventIds = new Set(
				system.product.execution.analyticsEvents.map((e) => e.id),
			)
			for (const e of op.args.metric.measuredByEventIds ?? [])
				if (!eventIds.has(e))
					errors.push(`${op.op}: measuredByEventIds -> unknown event "${e}"`)
			break
		}
		case 'prd.recordDecision': {
			errors.push(...validateLedgerEntry(op.args.entry))
			break
		}
		case 'data.addEntity': {
			dup(
				system.data.entities.some((e) => e.id === op.args.entity.id),
				op.args.entity.id,
				'entity',
			)
			const fieldIds = new Set<string>()
			for (const f of op.args.entity.fields)
				dup(fieldIds.has(f.id) || !fieldIds.add(f.id), f.id, 'field')
			// A field may reference the entity being added (self-reference) or a
			// pre-existing one; not a sibling not-yet-in-the-system.
			for (const f of op.args.entity.fields) {
				errors.push(
					...fieldReferenceErrors(system, f, op.op, [op.args.entity.id]),
				)
				errors.push(...fieldTypeErrors(f, op.op))
				errors.push(...fieldOptionErrors(f, op.op))
				errors.push(...fieldFileErrors(f, op.op))
				errors.push(...fieldDisplayErrors(f, op.op))
			}
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `entity "${op.args.entity.id}"`,
						provenance: op.args.entity.provenance,
					},
					...op.args.entity.fields.map((f) => ({
						what: `field "${f.id}"`,
						provenance: f.provenance,
					})),
				]),
			)
			break
		}
		case 'data.addField': {
			const entity = system.data.entities.find((e) => e.id === op.args.entityId)
			if (!entity) errors.push(`${op.op}: unknown entity "${op.args.entityId}"`)
			else
				dup(
					entity.fields.some((f) => f.id === op.args.field.id),
					op.args.field.id,
					'field',
				)
			errors.push(...fieldReferenceErrors(system, op.args.field, op.op))
			errors.push(...fieldTypeErrors(op.args.field, op.op))
			errors.push(...fieldOptionErrors(op.args.field, op.op))
			errors.push(...fieldFileErrors(op.args.field, op.op))
			errors.push(...fieldRankErrors(op.args.field, op.op))
			errors.push(...fieldDisplayErrors(op.args.field, op.op))
			errors.push(
				...fieldLimitsErrors(
					op.args.field,
					op.op,
					optionValuesOf(op.args.field),
				),
			)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `field "${op.args.field.id}"`,
						provenance: op.args.field.provenance,
					},
				]),
			)
			break
		}
		case 'data.setFieldOpenReference': {
			const entity = system.data.entities.find((e) => e.id === op.args.entityId)
			const field = entity?.fields.find((f) => f.id === op.args.fieldId)
			if (!entity) {
				errors.push(`${op.op}: unknown entity "${op.args.entityId}"`)
			} else if (!field) {
				errors.push(
					`${op.op}: unknown field "${op.args.fieldId}" on ${op.args.entityId}`,
				)
			} else if (field.reference) {
				// Re-opening a resolved reference would un-declare a relation the rows
				// already depend on — the mirror of `setFieldReference`'s re-pointing
				// refusal, and refused by name for the same reason.
				errors.push(
					`${op.op}: field "${op.args.fieldId}" already references "${field.reference}"; opening a declared reference would un-declare a relation the rows already depend on`,
				)
			} else if (field.type !== 'string' && field.type !== 'enum') {
				errors.push(
					`${op.op}: field "${op.args.fieldId}" is ${field.type}, which cannot hold an id (declare a string field)`,
				)
			}
			errors.push(
				...fieldReferenceErrors(
					system,
					{ id: op.args.fieldId, openReference: op.args.candidates },
					op.op,
				),
			)
			break
		}
		case 'data.setFieldLimits': {
			const entity = system.data.entities.find((e) => e.id === op.args.entityId)
			const field = entity?.fields.find((f) => f.id === op.args.fieldId)
			if (!entity) {
				errors.push(`${op.op}: unknown entity "${op.args.entityId}"`)
				break
			}
			if (!field) {
				errors.push(
					`${op.op}: unknown field "${op.args.fieldId}" on ${op.args.entityId}`,
				)
				break
			}
			const values = optionValuesOf(field)
			if (field.type === 'enum' && values === undefined)
				errors.push(
					`${op.op}: field "${op.args.fieldId}" has no declared options, so there are no values to cap`,
				)
			errors.push(
				...fieldLimitsErrors(
					{ id: op.args.fieldId, type: field.type, limits: op.args.limits },
					op.op,
					values,
				),
			)
			break
		}
		case 'data.setFieldDisplay': {
			const entity = system.data.entities.find((e) => e.id === op.args.entityId)
			const field = entity?.fields.find((f) => f.id === op.args.fieldId)
			if (!entity) {
				errors.push(`${op.op}: unknown entity "${op.args.entityId}"`)
				break
			}
			if (!field) {
				errors.push(
					`${op.op}: unknown field "${op.args.fieldId}" on ${op.args.entityId}`,
				)
				break
			}
			errors.push(
				...fieldDisplayErrors(
					{ id: op.args.fieldId, type: field.type, display: op.args.display },
					op.op,
				),
			)
			break
		}
		case 'data.setFieldReference': {
			const entity = system.data.entities.find((e) => e.id === op.args.entityId)
			const field = entity?.fields.find((f) => f.id === op.args.fieldId)
			if (!entity) {
				errors.push(`${op.op}: unknown entity "${op.args.entityId}"`)
			} else if (!field) {
				errors.push(
					`${op.op}: unknown field "${op.args.fieldId}" on ${op.args.entityId}`,
				)
			} else if (field.reference) {
				// Re-pointing an FK moves what every stored value *means*. That is a
				// data migration, not a declaration, so it is refused by name rather
				// than landing a spec that quietly disagrees with the rows.
				errors.push(
					`${op.op}: field "${op.args.fieldId}" already references "${field.reference}"; a reference is declared once and re-pointing it is a data migration this op cannot perform`,
				)
			} else if (field.type !== 'string' && field.type !== 'enum') {
				errors.push(
					`${op.op}: field "${op.args.fieldId}" is ${field.type}, which cannot hold an id (declare a string field)`,
				)
			} else if (
				field.openReference &&
				!field.openReference.includes(op.args.reference)
			) {
				// Narrowing an open reference. The candidate list is the
				// point of declaring one at all: without this check, `openReference`
				// would be documentation, and a project could point a billing subject
				// at any table in the app.
				errors.push(
					`${op.op}: field "${op.args.fieldId}" is open over ${field.openReference.join(', ')}, and "${op.args.reference}" is not one of them — a project narrows an open reference to one of its declared candidates`,
				)
			}
			errors.push(
				...fieldReferenceErrors(
					system,
					{ id: op.args.fieldId, reference: op.args.reference },
					op.op,
				),
			)
			break
		}
		case 'data.addComputed': {
			const entity = system.data.entities.find((e) => e.id === op.args.entityId)
			if (!entity) {
				errors.push(`${op.op}: unknown entity "${op.args.entityId}"`)
				break
			}
			errors.push(...computedFieldErrors(entity, op.args.computed, op.op))
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `computed "${op.args.computed.id}"`,
						provenance: op.args.computed.provenance,
					},
				]),
			)
			break
		}
		case 'data.addRollup': {
			const entity = system.data.entities.find((e) => e.id === op.args.entityId)
			if (!entity) {
				errors.push(`${op.op}: unknown entity "${op.args.entityId}"`)
				break
			}
			errors.push(...rollupErrors(system, entity, op.args.rollup, op.op))
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `rollup "${op.args.rollup.id}"`,
						provenance: op.args.rollup.provenance,
					},
				]),
			)
			break
		}
		case 'page.addPage': {
			dup(
				system.pages.pages.some((p) => p.id === op.args.page.id),
				op.args.page.id,
				'page',
			)
			if (
				op.args.page.entityId &&
				!system.data.entities.some((e) => e.id === op.args.page.entityId)
			)
				errors.push(
					`${op.op}: entityId -> unknown entity "${op.args.page.entityId}"`,
				)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `page "${op.args.page.id}"`,
						provenance: op.args.page.provenance,
					},
					...op.args.page.blocks.map((b) => ({
						what: `block "${b.id}"`,
						provenance: b.provenance,
					})),
				]),
			)
			errors.push(...inlineBlockErrors(system, op))
			break
		}
		case 'page.addBlock': {
			const page = system.pages.pages.find((p) => p.id === op.args.pageId)
			if (!page) errors.push(`${op.op}: unknown page "${op.args.pageId}"`)
			else
				dup(
					page.blocks.some((b) => b.id === op.args.block.id),
					op.args.block.id,
					'block',
				)
			const { mode, type, id } = op.args.block
			if (mode !== undefined) {
				if (mode !== 'append' && mode !== 'replace')
					errors.push(
						`${op.op}: block "${id}" has bad mode "${String(mode)}" (expected "append" or "replace")`,
					)
				// Only a slot has a component to render in the list's place, so
				// `replace` anywhere else would silently do nothing — and a silently
				// ignored layout instruction is worse than a rejected one.
				else if (mode === 'replace' && !isSlotBlock(type))
					errors.push(
						`${op.op}: block "${id}" is type "${type}", not a "slot:<name>" block — only a slot can replace the default list`,
					)
			}
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `block "${id}"`,
						provenance: op.args.block.provenance,
					},
				]),
			)
			break
		}
		case 'page.setBlockOrder': {
			const { pageId, blockId, order } = op.args
			const page = system.pages.pages.find((p) => p.id === pageId)
			if (!page) {
				errors.push(`${op.op}: unknown page "${pageId}"`)
				break
			}
			const block = page.blocks.find((b) => b.id === blockId)
			if (!block) {
				errors.push(`${op.op}: no block "${blockId}" in "${pageId}"`)
				break
			}
			// Ordering is only honored by list/table blocks; refuse to hang it on a
			// block type the runtime will ignore (a silent no-op is worse than an error).
			if (block.type !== 'table')
				errors.push(
					`${op.op}: block "${blockId}" is type "${block.type}", not an orderable table`,
				)
			if (order.direction && !['asc', 'desc'].includes(order.direction))
				errors.push(`${op.op}: bad direction "${order.direction}"`)
			// The sort field must be a real field on the page's backing entity.
			const entity = system.data.entities.find((e) => e.id === page.entityId)
			if (!entity)
				errors.push(`${op.op}: page "${pageId}" has no backing entity to sort`)
			else if (!entity.fields.some((f) => f.name === order.field))
				errors.push(
					`${op.op}: order.field "${order.field}" is not a field of "${entity.id}"`,
				)
			break
		}
		case 'page.setBlockVariant': {
			const { pageId, blockId, variant } = op.args
			const page = system.pages.pages.find((p) => p.id === pageId)
			if (!page) {
				errors.push(`${op.op}: unknown page "${pageId}"`)
				break
			}
			const block = page.blocks.find((b) => b.id === blockId)
			if (!block) {
				errors.push(`${op.op}: no block "${blockId}" in "${pageId}"`)
				break
			}
			// A variant is only honored by list/table blocks; refuse to hang it on a
			// block type the runtime will ignore (a silently ignored layout
			// instruction is worse than a rejected one — same rule as setBlockOrder).
			if (block.type !== 'table')
				errors.push(
					`${op.op}: block "${blockId}" is type "${block.type}", not a list/table block`,
				)
			if (!(BLOCK_VARIANTS as readonly string[]).includes(variant))
				errors.push(
					`${op.op}: unknown variant "${String(variant)}" (expected one of ${BLOCK_VARIANTS.join(', ')})`,
				)
			break
		}
		case 'page.setBlockFields': {
			const { pageId, blockId, fields } = op.args
			const page = system.pages.pages.find((p) => p.id === pageId)
			if (!page) {
				errors.push(`${op.op}: unknown page "${pageId}"`)
				break
			}
			const block = page.blocks.find((b) => b.id === blockId)
			if (!block) {
				errors.push(`${op.op}: no block "${blockId}" in "${pageId}"`)
				break
			}
			// Same rule as setBlockOrder/setBlockVariant: a presentation instruction
			// the runtime would silently ignore is worse than a rejected one.
			if (block.type !== 'table')
				errors.push(
					`${op.op}: block "${blockId}" is type "${block.type}", not a list/table block`,
				)
			if (!Array.isArray(fields) || fields.length === 0) {
				errors.push(`${op.op}: fields must be a non-empty array of field names`)
				break
			}
			const dupes = fields.filter((f, i) => fields.indexOf(f) !== i)
			if (dupes.length > 0)
				errors.push(`${op.op}: duplicate field "${dupes[0]}"`)
			// Every name must be a real field of the page's backing entity — the op
			// selects *data*, so a typo'd column has to fail loudly, not vanish.
			const entity = system.data.entities.find((e) => e.id === page.entityId)
			if (!entity)
				errors.push(
					`${op.op}: page "${pageId}" has no backing entity whose fields could be selected`,
				)
			else
				for (const name of fields)
					if (!entity.fields.some((f) => f.name === name))
						errors.push(
							`${op.op}: field "${name}" is not a field of "${entity.id}"`,
						)
			break
		}
		case 'page.setBlockEditable': {
			const { pageId, blockId, editable } = op.args
			const page = system.pages.pages.find((p) => p.id === pageId)
			if (!page) {
				errors.push(`${op.op}: unknown page "${pageId}"`)
				break
			}
			const block = page.blocks.find((b) => b.id === blockId)
			if (!block) {
				errors.push(`${op.op}: no block "${blockId}" in "${pageId}"`)
				break
			}
			// Same rule as the sibling set-ops. Here it is load-bearing twice over: a
			// silently ignored *capability* declaration reads as "inline editing is
			// on" to whoever approved it, and it is off.
			if (block.type !== 'table')
				errors.push(
					`${op.op}: block "${blockId}" is type "${block.type}", not a list/table block`,
				)
			if (!Array.isArray(editable)) {
				errors.push(
					`${op.op}: editable must be an array of field names (pass [] to clear, never omit it)`,
				)
				break
			}
			const dupes = editable.filter((f, i) => editable.indexOf(f) !== i)
			if (dupes.length > 0)
				errors.push(`${op.op}: duplicate field "${dupes[0]}"`)
			// `[]` is the clear, and it needs no entity to be meaningful.
			if (editable.length === 0) break
			const entity = system.data.entities.find((e) => e.id === page.entityId)
			if (!entity) {
				errors.push(
					`${op.op}: page "${pageId}" has no backing entity whose fields could be edited`,
				)
				break
			}
			for (const name of editable) {
				const field = entity.fields.find((f) => f.name === name)
				if (!field) {
					errors.push(
						`${op.op}: field "${name}" is not a field of "${entity.id}"`,
					)
					continue
				}
				const refusal = inlineEditRefusal(field)
				if (refusal) errors.push(`${op.op}: field "${name}" ${refusal}`)
			}
			break
		}
		case 'page.setE2ETests': {
			const { pageId, e2eTests } = op.args
			if (!system.pages.pages.some((p) => p.id === pageId)) {
				errors.push(`${op.op}: unknown page "${pageId}"`)
				break
			}
			if (!Array.isArray(e2eTests)) {
				errors.push(
					`${op.op}: e2eTests must be an array of natural-language strings (pass [] to clear, never omit it)`,
				)
				break
			}
			for (const [i, t] of e2eTests.entries()) {
				if (typeof t !== 'string' || t.trim() === '')
					errors.push(
						`${op.op}: e2eTests[${i}] must be a non-empty sentence describing one behaviour; received ${JSON.stringify(t)}`,
					)
			}
			const dupes = e2eTests.filter((t, i) => e2eTests.indexOf(t) !== i)
			if (dupes.length > 0)
				errors.push(`${op.op}: duplicate e2e test "${dupes[0]}"`)
			break
		}
		case 'page.addCalendar':
		case 'page.addTimeline':
		case 'page.addBoard': {
			errors.push(...viewBlockErrors(system, op))
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `block "${op.args.blockId}"`,
						provenance: op.args.provenance,
					},
				]),
			)
			break
		}
		case 'theme.set': {
			const theme = op.args.theme as ThemeSpec | undefined
			if (theme === undefined || typeof theme !== 'object') {
				errors.push(`${op.op}: args.theme must be an object`)
				break
			}
			const inSet = (
				value: string | undefined,
				set: readonly string[],
				key: string,
				required = false,
			) => {
				if (value === undefined) {
					if (required) errors.push(`${op.op}: theme.${key} is required`)
					return
				}
				if (!set.includes(value))
					errors.push(
						`${op.op}: unknown ${key} "${value}" (expected one of ${set.join(', ')})`,
					)
			}
			inSet(theme.preset, THEME_PRESETS, 'preset', true)
			inSet(theme.radius, THEME_RADII, 'radius')
			inSet(theme.density, THEME_DENSITIES, 'density')
			inSet(theme.font, THEME_FONTS, 'font')
			inSet(theme.typeScale, THEME_TYPE_SCALES, 'typeScale')
			if (theme.accent !== undefined && !ACCENT_RE.test(theme.accent))
				errors.push(
					`${op.op}: accent "${theme.accent}" is not a #rgb/#rrggbb hex color`,
				)
			// Reject unknown keys rather than dropping them — a typo like
			// "typescale" silently ignored would read as "the op worked" while the
			// instruction did nothing.
			const known = new Set([
				'preset',
				'accent',
				'radius',
				'density',
				'font',
				'typeScale',
			])
			for (const key of Object.keys(theme))
				if (!known.has(key))
					errors.push(
						`${op.op}: unknown theme key "${key}" (expected: ${[...known].join(', ')})`,
					)
			break
		}
		case 'flags.declare': {
			const { flag } = op.args
			const declared = system.flags?.flags ?? []
			dup(
				declared.some((f) => f.id === flag.id),
				flag.id,
				'flag',
			)
			if (declared.some((f) => f.key === flag.key))
				errors.push(`${op.op}: flag key "${flag.key}" already exists`)
			if (typeof flag.key !== 'string' || !FLAG_KEY_RE.test(flag.key))
				errors.push(
					`${op.op}: key "${String(flag.key)}" must match ${FLAG_KEY_RE.source} (lowercase, digits, dashes)`,
				)
			if (typeof flag.default !== 'boolean')
				errors.push(`${op.op}: flag "${flag.id}" needs a boolean default`)
			if (!flag.description?.trim())
				errors.push(
					`${op.op}: flag "${flag.id}" needs a description — a flag nobody can explain is a flag nobody can retire`,
				)
			errors.push(...flagTargetingErrors(op.op, flag.targeting, flag.default))
			errors.push(
				...provenanceShapeErrors(op.op, [
					{ what: `flag "${flag.id}"`, provenance: flag.provenance },
				]),
			)
			break
		}
		case 'flags.setTargeting': {
			const { flagId, targeting } = op.args
			const flag = (system.flags?.flags ?? []).find((f) => f.id === flagId)
			if (!flag) {
				errors.push(`${op.op}: unknown flag "${flagId}"`)
				break
			}
			errors.push(...flagTargetingErrors(op.op, targeting, flag.default))
			break
		}
		case 'flags.gate': {
			const { target, flag } = op.args
			if (
				flag !== null &&
				!(system.flags?.flags ?? []).some((f) => f.key === flag)
			)
				errors.push(
					`${op.op}: undeclared flag "${String(flag)}" — declare it with flags.declare first`,
				)
			if (target.kind === 'page') {
				if (!system.pages.pages.some((p) => p.id === target.id))
					errors.push(`${op.op}: unknown page "${target.id}"`)
			} else {
				const page = system.pages.pages.find((p) => p.id === target.parentId)
				if (!page)
					errors.push(
						`${op.op}: block target needs parentId — the page the block lives on`,
					)
				else if (!page.blocks.some((b) => b.id === target.id))
					errors.push(`${op.op}: no block "${target.id}" in "${page.id}"`)
			}
			break
		}
		case 'flags.remove': {
			const { flagId } = op.args
			const flag = (system.flags?.flags ?? []).find((f) => f.id === flagId)
			if (!flag) {
				errors.push(`${op.op}: unknown flag "${flagId}"`)
				break
			}
			// Removal is the one non-additive structural op, so it carries the
			// obligation the additive ones don't: it may not leave a dangling gate.
			const gates = flagGates(system, flag.key)
			if (gates.length > 0)
				errors.push(
					`${op.op}: flag "${flag.key}" still gates ${gates.length} surface(s) ` +
						`(${gates.map((g) => g.id).join(', ')}) — ungate them with flags.gate {flag: null} first`,
				)
			break
		}
		case 'schedules.declare': {
			const { schedule } = op.args
			const declared = system.schedules?.schedules ?? []
			dup(
				declared.some((s) => s.id === schedule.id),
				schedule.id,
				'schedule',
			)
			if (declared.some((s) => s.key === schedule.key))
				errors.push(`${op.op}: schedule key "${schedule.key}" already exists`)
			if (
				typeof schedule.key !== 'string' ||
				!SCHEDULE_KEY_RE.test(schedule.key)
			)
				errors.push(
					`${op.op}: key "${String(schedule.key)}" must match ${SCHEDULE_KEY_RE.source}`,
				)
			if (!schedule.description?.trim())
				errors.push(
					`${op.op}: schedule "${schedule.id}" needs a description — a job nobody can explain is a job nobody can turn off`,
				)
			if (
				typeof schedule.timezone !== 'string' ||
				!isValidTimezone(schedule.timezone)
			)
				errors.push(
					`${op.op}: unknown timezone "${String(schedule.timezone)}" — pass an IANA zone like "UTC" or "America/New_York"`,
				)
			errors.push(
				...recurrenceErrors(
					`${op.op}: schedule "${schedule.id}"`,
					schedule.recurrence,
				),
			)
			errors.push(
				...runAsErrors(`${op.op}: schedule "${schedule.id}"`, schedule.runAs),
			)
			if (
				schedule.entityId &&
				!system.data.entities.some((e) => e.id === schedule.entityId)
			)
				errors.push(
					`${op.op}: unknown entity "${schedule.entityId}" — add it with data.addEntity first`,
				)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `schedule "${schedule.id}"`,
						provenance: schedule.provenance,
					},
				]),
			)
			break
		}
		case 'schedules.setRecurrence': {
			const { scheduleId, recurrence, timezone } = op.args
			const schedule = (system.schedules?.schedules ?? []).find(
				(s) => s.id === scheduleId,
			)
			if (!schedule) {
				errors.push(`${op.op}: unknown schedule "${scheduleId}"`)
				break
			}
			errors.push(...recurrenceErrors(`${op.op}: "${scheduleId}"`, recurrence))
			if (timezone !== undefined && !isValidTimezone(timezone))
				errors.push(`${op.op}: unknown timezone "${timezone}"`)
			break
		}
		case 'schedules.pause': {
			const { scheduleId, paused } = op.args
			if (!(system.schedules?.schedules ?? []).some((s) => s.id === scheduleId))
				errors.push(`${op.op}: unknown schedule "${scheduleId}"`)
			if (typeof paused !== 'boolean')
				errors.push(`${op.op}: paused must be a boolean`)
			break
		}
		case 'schedules.remove': {
			const { scheduleId } = op.args
			const schedule = (system.schedules?.schedules ?? []).find(
				(s) => s.id === scheduleId,
			)
			if (!schedule) {
				errors.push(`${op.op}: unknown schedule "${scheduleId}"`)
				break
			}
			// The non-additive op's obligation: removal may not be the quick way to
			// stop a firing job. Pausing is reversible and keeps the history;
			// removal is neither, so it is only ever the second step.
			if (!schedule.paused)
				errors.push(
					`${op.op}: schedule "${schedule.key}" is still active — pause it with schedules.pause {paused: true} first, confirm nothing downstream broke, then remove it`,
				)
			break
		}
		case 'sources.declare': {
			const { source } = op.args
			const declared = system.sources?.sources ?? []
			dup(
				declared.some((s) => s.id === source.id),
				source.id,
				'source',
			)
			if (declared.some((s) => s.key === source.key))
				errors.push(`${op.op}: source key "${source.key}" already exists`)
			// One shared validator with the layer check, so the shapes that must
			// never be *applied* and the ones that must never be *loadable* cannot
			// drift apart. `declaredAt` is stamped below, so the probe carries a
			// placeholder rather than making the validator tolerate its absence.
			errors.push(
				...sourceErrors(
					`${op.op}: source "${source.id}"`,
					{
						...source,
						declaredAt: source.declaredAt ?? '1970-01-01',
					} as SourceSpec,
					system,
				),
			)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{ what: `source "${source.id}"`, provenance: source.provenance },
				]),
			)
			break
		}
		case 'sources.setMapping': {
			const { sourceId, mapping } = op.args
			const source = (system.sources?.sources ?? []).find(
				(s) => s.id === sourceId,
			)
			if (!source) {
				errors.push(`${op.op}: unknown source "${sourceId}"`)
				break
			}
			// Re-validate the whole declaration with the new mapping in place rather
			// than the mapping alone: a mapping is only correct relative to the
			// entity it writes and the mode it runs in, and checking it in isolation
			// would accept a sync whose id field the new mapping now overwrites.
			errors.push(
				...sourceErrors(
					`${op.op}: "${sourceId}"`,
					{ ...source, mapping },
					system,
				),
			)
			break
		}
		case 'sources.setLimits': {
			const { sourceId, limits } = op.args
			const source = (system.sources?.sources ?? []).find(
				(s) => s.id === sourceId,
			)
			if (!source) {
				errors.push(`${op.op}: unknown source "${sourceId}"`)
				break
			}
			errors.push(
				...sourceErrors(
					`${op.op}: "${sourceId}"`,
					{ ...source, limits },
					system,
				),
			)
			break
		}
		case 'sources.pause': {
			const { sourceId, paused } = op.args
			if (!(system.sources?.sources ?? []).some((s) => s.id === sourceId))
				errors.push(`${op.op}: unknown source "${sourceId}"`)
			if (typeof paused !== 'boolean')
				errors.push(`${op.op}: paused must be a boolean`)
			break
		}
		case 'sources.remove': {
			const { sourceId } = op.args
			const source = (system.sources?.sources ?? []).find(
				(s) => s.id === sourceId,
			)
			if (!source) {
				errors.push(`${op.op}: unknown source "${sourceId}"`)
				break
			}
			if (!source.paused)
				errors.push(
					`${op.op}: source "${source.key}" is still active — pause it with sources.pause {paused: true} first, confirm nothing downstream broke, then remove it`,
				)
			break
		}
		case 'pricing.addTier': {
			dup(
				system.pricing.tiers.some((t) => t.id === op.args.tier.id),
				op.args.tier.id,
				'tier',
			)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `tier "${op.args.tier.id}"`,
						provenance: op.args.tier.provenance,
					},
				]),
			)
			break
		}
		case 'search.declare': {
			const { index } = op.args
			const declared = system.search?.indexes ?? []
			dup(
				declared.some((i) => i.id === index.id),
				index.id,
				'search index',
			)
			if (declared.some((i) => i.key === index.key))
				errors.push(`${op.op}: search index key "${index.key}" already exists`)
			// One shared validator with the layer check, for the reason
			// `sources.declare` gives. Everything the emitted DDL interpolates as a
			// literal — the language, the weights, the field names — is refused
			// here, so the SQL generator downstream may assume it passed.
			errors.push(
				...searchIndexErrors(
					`${op.op}: index "${index.id}"`,
					{
						...index,
						declaredAt: index.declaredAt ?? '1970-01-01',
					} as SearchIndexSpec,
					system,
					declared,
				),
			)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{ what: `search index "${index.id}"`, provenance: index.provenance },
				]),
			)
			break
		}
		case 'search.setFields': {
			const { indexId, fields } = op.args
			const index = (system.search?.indexes ?? []).find((i) => i.id === indexId)
			if (!index) {
				errors.push(`${op.op}: unknown search index "${indexId}"`)
				break
			}
			// Re-validate the whole declaration with the new fields spliced in
			// rather than the fields alone: a field list is only correct relative to
			// the entity it indexes.
			errors.push(
				...searchIndexErrors(
					`${op.op}: "${indexId}"`,
					{ ...index, fields },
					system,
				),
			)
			break
		}
		case 'search.setIndexing': {
			const { indexId, indexed } = op.args
			if (!(system.search?.indexes ?? []).some((i) => i.id === indexId))
				errors.push(`${op.op}: unknown search index "${indexId}"`)
			if (typeof indexed !== 'boolean')
				errors.push(`${op.op}: indexed must be true or false`)
			break
		}
		case 'search.remove': {
			const index = (system.search?.indexes ?? []).find(
				(i) => i.id === op.args.indexId,
			)
			if (!index) {
				errors.push(`${op.op}: unknown search index "${op.args.indexId}"`)
				break
			}
			// The non-additive op's obligation, and here it is not only about
			// deliberateness: the DDL is emitted from the declaration, so removing
			// the declaration while the index exists strands a real GIN index on a
			// real table with nothing left in the spec that knows its name.
			if (index.indexed)
				errors.push(
					`${op.op}: search index "${index.key}" still exists physically — set indexed:false with search.setIndexing first, then remove the declaration`,
				)
			break
		}
		case 'documents.declare': {
			const { template } = op.args
			const declared = system.documents?.templates ?? []
			dup(
				declared.some((t) => t.id === template.id),
				template.id,
				'document template',
			)
			if (declared.some((t) => t.key === template.key))
				errors.push(
					`${op.op}: document template key "${template.key}" already exists`,
				)
			// One shared validator with the layer check, for the reason
			// `sources.declare` and `search.declare` give. What it guards is paper a
			// customer receives: an unresolved placeholder, an unprintable field type,
			// or a `via` that is not the foreign key back to this row are all silent at
			// render time — the document comes out, it is just wrong.
			errors.push(
				...documentTemplateErrors(
					`${op.op}: template "${template.id}"`,
					{
						...template,
						declaredAt: template.declaredAt ?? '1970-01-01',
					} as DocumentTemplateSpec,
					system,
					declared,
				),
			)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `document template "${template.id}"`,
						provenance: template.provenance,
					},
				]),
			)
			break
		}
		case 'documents.setSections': {
			const { templateId, sections } = op.args
			const template = (system.documents?.templates ?? []).find(
				(t) => t.id === templateId,
			)
			if (!template) {
				errors.push(`${op.op}: unknown document template "${templateId}"`)
				break
			}
			// Re-validate the whole declaration with the new sections spliced in
			// rather than the sections alone: a section is only correct relative to the
			// entity it prints and the relations it reaches.
			errors.push(
				...documentTemplateErrors(
					`${op.op}: "${templateId}"`,
					{ ...template, sections },
					system,
				),
			)
			break
		}
		case 'documents.setDelivery': {
			const { templateId, delivery } = op.args
			const template = (system.documents?.templates ?? []).find(
				(t) => t.id === templateId,
			)
			if (!template) {
				errors.push(`${op.op}: unknown document template "${templateId}"`)
				break
			}
			errors.push(
				...documentTemplateErrors(
					`${op.op}: "${templateId}"`,
					{ ...template, delivery },
					system,
				),
			)
			break
		}
		case 'documents.remove': {
			const template = (system.documents?.templates ?? []).find(
				(t) => t.id === op.args.templateId,
			)
			if (!template) {
				errors.push(
					`${op.op}: unknown document template "${op.args.templateId}"`,
				)
				break
			}
			// The non-additive op's obligation, pointing outward: the URL and the
			// stored object path are emitted from the declaration, so removing it while
			// a target is live turns a bookmarked link into a 404 and an archive write
			// into an error, with nothing left in the spec that names either.
			if (hasActiveDelivery(template.delivery))
				errors.push(
					`${op.op}: document template "${template.key}" still delivers — turn download/store/email off with documents.setDelivery first, then remove the declaration`,
				)
			break
		}
		case 'imports.declare': {
			const { importer } = op.args
			const declared = system.imports?.importers ?? []
			dup(
				declared.some((i) => i.id === importer.id),
				importer.id,
				'importer',
			)
			if (declared.some((i) => i.key === importer.key))
				errors.push(`${op.op}: importer key "${importer.key}" already exists`)
			// One shared validator with the layer check, for the reason
			// `sources.declare` gives. What it guards is the most destructive surface
			// in the vocabulary: an upsert key that cannot identify a row, two columns
			// writing one field, and a `file` column are each silent at run time and
			// loud only afterwards, when somebody's rows are already gone.
			errors.push(
				...importerErrors(
					`${op.op}: importer "${importer.id}"`,
					{
						...importer,
						declaredAt: importer.declaredAt ?? '1970-01-01',
					} as ImporterSpec,
					system,
					declared,
				),
			)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `importer "${importer.id}"`,
						provenance: importer.provenance,
					},
				]),
			)
			break
		}
		case 'imports.setMapping': {
			const { importerId, columns } = op.args
			const importer = (system.imports?.importers ?? []).find(
				(i) => i.id === importerId,
			)
			if (!importer) {
				errors.push(`${op.op}: unknown importer "${importerId}"`)
				break
			}
			// Re-validate the whole declaration with the new mapping spliced in
			// rather than the mapping alone: a mapping is only correct relative to
			// the entity it writes AND to the upsert key, and checking it in
			// isolation would accept a mapping that drops the key's column — which
			// silently turns an upsert into an insert-only run, i.e. duplicates.
			errors.push(
				...importerErrors(
					`${op.op}: "${importerId}"`,
					{ ...importer, columns },
					system,
				),
			)
			break
		}
		case 'imports.setUpsertKey': {
			const { importerId, upsertFieldId } = op.args
			const importer = (system.imports?.importers ?? []).find(
				(i) => i.id === importerId,
			)
			if (!importer) {
				errors.push(`${op.op}: unknown importer "${importerId}"`)
				break
			}
			if (upsertFieldId !== null && typeof upsertFieldId !== 'string') {
				errors.push(
					`${op.op}: upsertFieldId must be a field id or null (null = insert-only) — not deciding is the one thing it may not be`,
				)
				break
			}
			// The whole declaration again, with the new key spliced in: whether a key
			// is usable depends on the entity's field types AND on the current
			// mapping, so validating the id alone would accept a key the file does
			// not supply.
			errors.push(
				...importerErrors(
					`${op.op}: "${importerId}"`,
					{ ...importer, upsertFieldId },
					system,
				),
			)
			break
		}
		case 'imports.pause': {
			const { importerId, paused } = op.args
			if (!(system.imports?.importers ?? []).some((i) => i.id === importerId))
				errors.push(`${op.op}: unknown importer "${importerId}"`)
			if (typeof paused !== 'boolean')
				errors.push(`${op.op}: paused must be a boolean`)
			break
		}
		case 'imports.remove': {
			const importer = (system.imports?.importers ?? []).find(
				(i) => i.id === op.args.importerId,
			)
			if (!importer) {
				errors.push(`${op.op}: unknown importer "${op.args.importerId}"`)
				break
			}
			// `sources.remove`'s rule, for `sources.remove`'s reason: removal must
			// never be the fastest way to silence something somebody is mid-way
			// through using. Pausing keeps the mapping and the parser file, which is
			// what you need to fix whatever went wrong.
			if (!importer.paused)
				errors.push(
					`${op.op}: importer "${importer.key}" is still active — pause it with imports.pause {paused: true} first, confirm nothing downstream broke, then remove it`,
				)
			break
		}
		case 'portals.declare': {
			const { portal } = op.args
			const declared = system.portals?.portals ?? []
			dup(
				declared.some((p) => p.id === portal.id),
				portal.id,
				'portal',
			)
			if (declared.some((p) => p.key === portal.key))
				errors.push(`${op.op}: portal key "${portal.key}" already exists`)
			// One shared validator with the layer check, for the reason
			// `imports.declare` gives — and here the reason is the strongest it gets
			// anywhere in the vocabulary: a spec can arrive by decoding a directory
			// somebody hand-edited, and a portal that reached the runtime that way
			// would be a public surface nobody reviewed.
			errors.push(
				...portalErrors(
					`${op.op}: portal "${portal.id}"`,
					{
						...portal,
						declaredAt: portal.declaredAt ?? '1970-01-01',
					} as PortalSpec,
					system,
					declared,
				),
			)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{ what: `portal "${portal.id}"`, provenance: portal.provenance },
				]),
			)
			break
		}
		case 'portals.setFields': {
			const { portalId, readFields } = op.args
			const portal = (system.portals?.portals ?? []).find(
				(p) => p.id === portalId,
			)
			if (!portal) {
				errors.push(`${op.op}: unknown portal "${portalId}"`)
				break
			}
			// The whole declaration again, with the new projection spliced in.
			// Whether a field may be exposed depends on the AUDIENCE (a file field
			// and an e-user reference are refused for public and token portals and
			// allowed for role ones), so validating the id list in isolation would
			// accept a projection that is only safe for a portal this is not.
			errors.push(
				...portalErrors(
					`${op.op}: "${portalId}"`,
					{ ...portal, readFields },
					system,
				),
			)
			break
		}
		case 'portals.setWrites': {
			const { portalId, writes } = op.args
			const portal = (system.portals?.portals ?? []).find(
				(p) => p.id === portalId,
			)
			if (!portal) {
				errors.push(`${op.op}: unknown portal "${portalId}"`)
				break
			}
			if (!Array.isArray(writes)) {
				errors.push(
					`${op.op}: writes must be an array — pass [] to make the portal read-only`,
				)
				break
			}
			// Spliced in for the same reason: whether a write is legal depends on the
			// audience (public + update is refused) and on the scope (row + create is
			// refused) and on the filter (a write may not name the bound column).
			errors.push(
				...portalErrors(
					`${op.op}: "${portalId}"`,
					{ ...portal, writes },
					system,
				),
			)
			break
		}
		case 'portals.pause': {
			const { portalId, paused } = op.args
			if (!(system.portals?.portals ?? []).some((p) => p.id === portalId))
				errors.push(`${op.op}: unknown portal "${portalId}"`)
			if (typeof paused !== 'boolean')
				errors.push(`${op.op}: paused must be a boolean`)
			break
		}
		case 'portals.remove': {
			const portal = (system.portals?.portals ?? []).find(
				(p) => p.id === op.args.portalId,
			)
			if (!portal) {
				errors.push(`${op.op}: unknown portal "${op.args.portalId}"`)
				break
			}
			// `imports.remove`'s rule, for a sharper version of its reason: pausing
			// closes the surface immediately and keeps the declaration, the exposure
			// report row and the minted tokens. Removing first would close it just as
			// fast and leave nothing to explain what had been exposed.
			if (!portal.paused)
				errors.push(
					`${op.op}: portal "${portal.key}" is still reachable — pause it with portals.pause {paused: true} first, confirm nothing downstream broke, then remove it`,
				)
			break
		}
		case 'live.declare': {
			const { subscription } = op.args
			const declared = system.live?.subscriptions ?? []
			dup(
				declared.some((l) => l.id === subscription.id),
				subscription.id,
				'live subscription',
			)
			if (declared.some((l) => l.key === subscription.key))
				errors.push(`${op.op}: live key "${subscription.key}" already exists`)
			// One shared validator with the layer check, for `imports.declare`'s
			// reason: a spec can arrive by decoding a directory somebody hand-edited,
			// and an unbounded channel that reached the runtime that way is an outage
			// nobody declared.
			errors.push(
				...liveSubscriptionErrors(
					`${op.op}: subscription "${subscription.id}"`,
					{
						...subscription,
						declaredAt: subscription.declaredAt ?? '1970-01-01',
					} as LiveSubscriptionSpec,
					system,
					declared,
				),
			)
			errors.push(
				...provenanceShapeErrors(op.op, [
					{
						what: `live subscription "${subscription.id}"`,
						provenance: subscription.provenance,
					},
				]),
			)
			break
		}
		case 'live.setFields': {
			const { subscriptionId, fields } = op.args
			const sub = (system.live?.subscriptions ?? []).find(
				(l) => l.id === subscriptionId,
			)
			if (!sub) {
				errors.push(`${op.op}: unknown live subscription "${subscriptionId}"`)
				break
			}
			if (!Array.isArray(fields)) {
				errors.push(`${op.op}: fields must be an array of field ids`)
				break
			}
			// The whole declaration again, with the new projection spliced in.
			// Whether a field list is legal depends on the KIND (a presence channel
			// must carry none at all), so validating the ids in isolation would
			// accept a payload that is only legal for a channel this is not.
			errors.push(
				...liveSubscriptionErrors(
					`${op.op}: "${subscriptionId}"`,
					{ ...sub, fields },
					system,
				),
			)
			break
		}
		case 'live.setLimits': {
			const { subscriptionId, maxSubscribers, maxMessagesPerMinute } = op.args
			const sub = (system.live?.subscriptions ?? []).find(
				(l) => l.id === subscriptionId,
			)
			if (!sub) {
				errors.push(`${op.op}: unknown live subscription "${subscriptionId}"`)
				break
			}
			// Spliced in for the same reason: the subscriber ceiling that is legal
			// depends on the SCOPE, and an "all"-scoped channel's cap is two orders
			// of magnitude tighter than a filtered one's.
			errors.push(
				...liveSubscriptionErrors(
					`${op.op}: "${subscriptionId}"`,
					{ ...sub, maxSubscribers, maxMessagesPerMinute },
					system,
				),
			)
			break
		}
		case 'live.pause': {
			const { subscriptionId, paused } = op.args
			if (
				!(system.live?.subscriptions ?? []).some((l) => l.id === subscriptionId)
			)
				errors.push(`${op.op}: unknown live subscription "${subscriptionId}"`)
			if (typeof paused !== 'boolean')
				errors.push(`${op.op}: paused must be a boolean`)
			break
		}
		case 'live.remove': {
			const sub = (system.live?.subscriptions ?? []).find(
				(l) => l.id === op.args.subscriptionId,
			)
			if (!sub) {
				errors.push(
					`${op.op}: unknown live subscription "${op.args.subscriptionId}"`,
				)
				break
			}
			// `portals.remove`'s rule. Pausing closes every open connection and keeps
			// the declaration, so the surface degrades to polling and somebody can
			// confirm that before the declaration — and the record of what was being
			// pushed — goes away.
			if (!sub.paused)
				errors.push(
					`${op.op}: live channel "${sub.key}" is still accepting connections — pause it with live.pause {paused: true} first, confirm the polling fallback carried the surface, then remove it`,
				)
			break
		}
		case 'provenance.review': {
			const { target, action } = op.args
			if (!REVIEW_TARGET_KINDS.includes(target?.kind))
				errors.push(`${op.op}: bad target kind "${String(target?.kind)}"`)
			else if (!locateReviewTarget(system, target))
				errors.push(
					`${op.op}: no ${target.kind} "${target.id}"${target.parentId ? ` in "${target.parentId}"` : ''}`,
				)
			if (!REVIEW_ACTIONS.includes(action))
				errors.push(
					`${op.op}: bad action "${String(action)}" (expected one of ${REVIEW_ACTIONS.join(', ')})`,
				)
			break
		}
		default: {
			// The union is exhaustive at compile time, but ops arrive as JSON from
			// an agent — and without this the switch matched nothing, returned zero
			// errors, and let an unrecognized op through validation entirely. It
			// then died in `diffOp` on `SPEC_OP_VOCABULARY[op.op].layer` with
			// "Cannot read properties of undefined (reading 'layer')", which names
			// an internal property and nothing an author could act on.
			// The commonest cause is a shape slip — nesting the op inside itself
			// instead of the flat `{op, args}` the tool schema specifies.
			const name = (op as { op?: unknown }).op
			errors.push(
				typeof name === 'string'
					? `unknown op "${name}" — expected one of: ${SPEC_OP_NAMES.join(', ')}`
					: // Almost always the whole op nested inside itself. Say that,
						// rather than stringifying an object into "[object Object]".
						`"op" must be the op name as a string, not ${Array.isArray(name) ? 'an array' : typeof name}. ` +
							`Expected the flat shape {"op": "<name>", "args": {…}} — one of: ${SPEC_OP_NAMES.join(', ')}`,
			)
		}
	}
	return errors
}

// ===========================================================================
// diffOp — a structured description of what the op would change
// ===========================================================================

/** Human summary of a targeting rule, for the diff and the op log. */
function describeTargeting(targeting: FlagTargeting): string {
	const parts: string[] = []
	if (targeting.roles?.length) parts.push(`roles ${targeting.roles.join('/')}`)
	if (targeting.organizations?.length)
		parts.push(`${targeting.organizations.length} org(s)`)
	if (targeting.rolloutPercent !== undefined)
		parts.push(`${targeting.rolloutPercent}% rollout`)
	return parts.length ? parts.join(', ') : 'nothing'
}

export function diffOp(op: SpecOp): SpecDiff {
	const layer = SPEC_OP_VOCABULARY[op.op].layer
	const add = (
		targetId: string,
		summary: string,
		parentId?: string,
	): SpecDiff => ({
		op: op.op,
		layer,
		change: 'add',
		targetId,
		parentId,
		summary,
	})
	switch (op.op) {
		case 'prd.addRequirement':
			return add(
				op.args.requirement.id,
				`Add requirement "${op.args.requirement.id}"${op.args.intoPhaseId ? ` into phase ${op.args.intoPhaseId}` : ''}`,
				op.args.intoPhaseId,
			)
		case 'prd.addScopeItem':
			return add(
				op.args.item.id,
				`Add ${op.args.bucket} scope item "${op.args.item.id}"`,
				op.args.bucket,
			)
		case 'prd.addRisk':
			return add(op.args.risk.id, `Add risk "${op.args.risk.id}"`)
		case 'prd.addMetric':
			return add(
				op.args.metric.id,
				`Add supporting metric "${op.args.metric.id}"`,
			)
		case 'prd.recordDecision':
			return add(
				op.args.entry.id,
				`Record decision "${op.args.entry.id}" (${op.args.entry.status})`,
			)
		case 'data.addEntity':
			return add(
				op.args.entity.id,
				`Add entity "${op.args.entity.id}" (${op.args.entity.fields.length} fields)`,
			)
		case 'data.addField':
			return add(
				op.args.field.id,
				`Add field "${op.args.field.id}" to ${op.args.entityId}`,
				op.args.entityId,
			)
		case 'data.setFieldReference':
			return add(
				op.args.fieldId,
				`Declare field "${op.args.fieldId}" a reference to ${op.args.reference}`,
				op.args.entityId,
			)
		case 'data.setFieldOpenReference':
			return add(
				op.args.fieldId,
				`Open field "${op.args.fieldId}" over ${op.args.candidates.join(', ')} — the project declares which`,
				op.args.entityId,
			)
		case 'data.setFieldLimits': {
			const entries = Object.entries(op.args.limits)
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.fieldId,
				parentId: op.args.entityId,
				summary:
					entries.length === 0
						? `Clear value limits on field "${op.args.fieldId}"`
						: `Limit field "${op.args.fieldId}" to ${entries
								.map(([value, cap]) => `${cap} ${value}`)
								.join(', ')}`,
			}
		}
		case 'data.setFieldDisplay': {
			const { format, min, max, step } = op.args.display
			const scale = [
				min !== undefined ? `min ${min}` : null,
				max !== undefined ? `max ${max}` : null,
				step !== undefined ? `step ${step}` : null,
			]
				.filter(Boolean)
				.join(', ')
			const parts = [format ? `as a ${format}` : null, scale || null]
				.filter(Boolean)
				.join(' ')
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.fieldId,
				parentId: op.args.entityId,
				summary: parts
					? `Display field "${op.args.fieldId}" ${parts}`
					: `Clear the declared display of field "${op.args.fieldId}" — it falls back to inference from the field's name`,
			}
		}
		case 'data.addComputed':
			return add(
				op.args.computed.id,
				`Add computed "${op.args.computed.name}" to ${op.args.entityId}`,
				op.args.entityId,
			)
		case 'data.addRollup': {
			const { rollup } = op.args
			const what = rollup.groupBy
				? `${rollup.fn} of ${rollup.over} by ${rollup.groupBy.bucket ?? 'value'}`
				: `${rollup.fn} of ${rollup.over}`
			return add(
				rollup.id,
				`Add rollup "${rollup.name}" (${what}) to ${op.args.entityId}`,
				op.args.entityId,
			)
		}
		case 'page.addPage':
			return add(
				op.args.page.id,
				`Add page "${op.args.page.id}" (${op.args.page.route})`,
			)
		case 'page.addBlock':
			return add(
				op.args.block.id,
				`Add block "${op.args.block.id}" to ${op.args.pageId}`,
				op.args.pageId,
			)
		case 'page.setBlockOrder': {
			const { blockId, pageId, order } = op.args
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: blockId,
				parentId: pageId,
				summary: `Set order of block "${blockId}" to ${order.field} ${order.direction ?? 'asc'}`,
			}
		}
		case 'page.setBlockVariant': {
			const { blockId, pageId, variant } = op.args
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: blockId,
				parentId: pageId,
				summary: `Set presentation of block "${blockId}" to ${variant}`,
			}
		}
		case 'page.setBlockFields': {
			const { blockId, pageId, fields } = op.args
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: blockId,
				parentId: pageId,
				summary: `Set fields of block "${blockId}" to ${fields.join(', ')}`,
			}
		}
		case 'page.setBlockEditable': {
			const { blockId, pageId, editable } = op.args
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: blockId,
				parentId: pageId,
				summary:
					editable.length === 0
						? `Stop editing any cell of block "${blockId}" in place`
						: `Edit ${editable.join(', ')} in place in block "${blockId}"`,
			}
		}
		case 'page.setE2ETests': {
			const { pageId, e2eTests } = op.args
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: pageId,
				summary:
					e2eTests.length === 0
						? `Clear the e2e tests on "${pageId}"`
						: `Set ${e2eTests.length} e2e test(s) on "${pageId}"`,
			}
		}
		case 'page.addCalendar': {
			const { blockId, pageId, calendar } = op.args
			return add(
				blockId,
				`Add ${calendar.display} calendar "${blockId}" to ${pageId}, by ${calendar.dateField} (${calendar.timezone})`,
				pageId,
			)
		}
		case 'page.addTimeline': {
			const { blockId, pageId, timeline } = op.args
			const edges = timeline.dependsOn
				? `, edges via ${timeline.dependsOn}`
				: ''
			return add(
				blockId,
				`Add timeline "${blockId}" to ${pageId}, ${timeline.startField} → ${timeline.endField} (${timeline.timezone})${edges}`,
				pageId,
			)
		}
		case 'page.addBoard': {
			const { blockId, pageId, board } = op.args
			const ordered = board.rankField ? `, ranked by ${board.rankField}` : ''
			return add(
				blockId,
				`Add board "${blockId}" to ${pageId}, grouped by ${board.groupField}${ordered}`,
				pageId,
			)
		}
		case 'pricing.addTier':
			return add(op.args.tier.id, `Add pricing tier "${op.args.tier.id}"`)
		case 'theme.set': {
			const { preset, ...overrides } = op.args.theme
			const extras = Object.entries(overrides)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => `${k} ${v}`)
				.join(', ')
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: 'theme',
				summary: `Set theme to "${preset}"${extras ? ` (${extras})` : ''}`,
			}
		}
		case 'flags.declare':
			return add(
				op.args.flag.id,
				`Declare flag "${op.args.flag.key}" (default ${op.args.flag.default ? 'on' : 'off'})`,
			)
		case 'flags.setTargeting': {
			const { flagId, targeting } = op.args
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: flagId,
				summary: targeting
					? `Target flag "${flagId}": ${describeTargeting(targeting)}`
					: `Clear targeting on flag "${flagId}"`,
			}
		}
		case 'flags.gate': {
			const { target, flag } = op.args
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: target.id,
				parentId: target.parentId,
				summary: flag
					? `Gate ${target.kind} "${target.id}" on flag "${flag}"`
					: `Ungate ${target.kind} "${target.id}"`,
			}
		}
		case 'flags.remove':
			return {
				op: op.op,
				layer,
				change: 'remove',
				targetId: op.args.flagId,
				summary: `Remove flag "${op.args.flagId}"`,
			}
		case 'schedules.declare':
			return add(
				op.args.schedule.id,
				`Declare schedule "${op.args.schedule.key}" (${describeRecurrence(op.args.schedule.recurrence, op.args.schedule.timezone)})`,
			)
		case 'schedules.setRecurrence': {
			const { scheduleId, recurrence, timezone } = op.args
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: scheduleId,
				summary: `Set schedule "${scheduleId}" to ${describeRecurrence(recurrence, timezone ?? 'its declared zone')}`,
			}
		}
		case 'schedules.pause':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.scheduleId,
				summary: `${op.args.paused ? 'Pause' : 'Resume'} schedule "${op.args.scheduleId}"`,
			}
		case 'schedules.remove':
			return {
				op: op.op,
				layer,
				change: 'remove',
				targetId: op.args.scheduleId,
				summary: `Remove schedule "${op.args.scheduleId}"`,
			}
		case 'sources.declare':
			return add(
				op.args.source.id,
				`Declare source "${op.args.source.key}" (${describeSource(op.args.source as SourceSpec)})`,
			)
		case 'sources.setMapping':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.sourceId,
				summary: `Map ${op.args.mapping.length} response field(s) onto source "${op.args.sourceId}"`,
			}
		case 'sources.setLimits':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.sourceId,
				summary: `Set source "${op.args.sourceId}" to ${op.args.limits.requestsPerMinute} req/min, ${op.args.limits.maxAttempts} attempt(s)`,
			}
		case 'sources.pause':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.sourceId,
				summary: `${op.args.paused ? 'Pause' : 'Resume'} source "${op.args.sourceId}"`,
			}
		case 'sources.remove':
			return {
				op: op.op,
				layer,
				change: 'remove',
				targetId: op.args.sourceId,
				summary: `Remove source "${op.args.sourceId}"`,
			}
		case 'search.declare':
			return add(
				op.args.index.id,
				`Declare search index "${op.args.index.key}" on ${op.args.index.entityId} (${describeSearchIndex(op.args.index as SearchIndexSpec)})`,
			)
		case 'search.setFields':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.indexId,
				summary: `Rank search index "${op.args.indexId}" over ${op.args.fields.length} field(s): ${op.args.fields.map((f) => `${f.fieldId}:${f.weight}`).join(', ')}`,
			}
		case 'search.setIndexing':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.indexId,
				summary: `${op.args.indexed ? 'Create' : 'Drop'} the physical index for search index "${op.args.indexId}" (ranking is unchanged either way)`,
			}
		case 'search.remove':
			return {
				op: op.op,
				layer,
				change: 'remove',
				targetId: op.args.indexId,
				summary: `Remove search index "${op.args.indexId}"`,
			}
		case 'documents.declare':
			return add(
				op.args.template.id,
				`Declare document template "${op.args.template.key}" on ${op.args.template.entityId} (${describeDocumentTemplate(op.args.template as DocumentTemplateSpec)})`,
			)
		case 'documents.setSections':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.templateId,
				summary: `Lay out document template "${op.args.templateId}" as ${op.args.sections.length} section(s): ${op.args.sections.map((sec) => sec.kind).join(', ')}`,
			}
		case 'documents.setDelivery':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.templateId,
				summary: `Deliver document template "${op.args.templateId}" by ${describeDelivery(op.args.delivery)}`,
			}
		case 'documents.remove':
			return {
				op: op.op,
				layer,
				change: 'remove',
				targetId: op.args.templateId,
				summary: `Remove document template "${op.args.templateId}"`,
			}
		case 'imports.declare':
			return add(
				op.args.importer.id,
				`Declare importer "${op.args.importer.key}" on ${op.args.importer.entityId} (${describeImporter(op.args.importer as ImporterSpec)})`,
			)
		case 'imports.setMapping':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.importerId,
				summary: `Map ${op.args.columns.length} file column(s) onto importer "${op.args.importerId}": ${op.args.columns.map((c) => `${c.column}→${c.fieldId}`).join(', ')}`,
			}
		case 'imports.setUpsertKey':
			// The summary says what the change MEANS rather than what it set, because
			// this is the line a reviewer skims to decide whether it can destroy data.
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.importerId,
				summary:
					op.args.upsertFieldId === null
						? `Make importer "${op.args.importerId}" INSERT-ONLY — it can no longer overwrite existing rows`
						: `Let importer "${op.args.importerId}" OVERWRITE existing rows, matched on ${op.args.upsertFieldId}`,
			}
		case 'imports.pause':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.importerId,
				summary: `${op.args.paused ? 'Pause' : 'Resume'} importer "${op.args.importerId}"`,
			}
		case 'imports.remove':
			return {
				op: op.op,
				layer,
				change: 'remove',
				targetId: op.args.importerId,
				summary: `Remove importer "${op.args.importerId}"`,
			}
		case 'portals.declare':
			// The summary names the AUDIENCE and the FIELD COUNT, because the diff is
			// what a human reads before this reaches the internet, and those are the
			// two facts they are least likely to reconstruct from an id.
			return add(
				op.args.portal.id,
				`Declare ${op.args.portal.audience.toUpperCase()} portal "${op.args.portal.key}" on ${op.args.portal.entityId} exposing ${op.args.portal.readFields.length} field(s) (${describePortal(op.args.portal as PortalSpec)})`,
			)
		case 'portals.setFields':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.portalId,
				summary: `Expose ${op.args.readFields.length} field(s) through portal "${op.args.portalId}": ${op.args.readFields.join(', ')}`,
			}
		case 'portals.setWrites':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.portalId,
				summary:
					op.args.writes.length === 0
						? `Make portal "${op.args.portalId}" READ-ONLY`
						: `Let portal "${op.args.portalId}" ${op.args.writes.map((w) => `${w.action.toUpperCase()} ${w.fieldIds.length} field(s) at ${w.rateLimitPerHour}/hour`).join(' and ')}`,
			}
		case 'portals.pause':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.portalId,
				summary: `${op.args.paused ? 'Take portal offline' : 'Bring portal back online'}: "${op.args.portalId}"`,
			}
		case 'portals.remove':
			return {
				op: op.op,
				layer,
				change: 'remove',
				targetId: op.args.portalId,
				summary: `Remove portal "${op.args.portalId}"`,
			}
		case 'live.declare':
			// The summary names the BOUND and both CEILINGS, because a diff of this op
			// is read by whoever will be paged when the channel is the reason the app
			// is slow, and those are the three facts nobody reconstructs from an id.
			return add(
				op.args.subscription.id,
				`Declare ${op.args.subscription.kind.toUpperCase()} channel "${op.args.subscription.key}" on ${op.args.subscription.entityId} (${describeLiveSubscription(op.args.subscription as LiveSubscriptionSpec)})`,
			)
		case 'live.setFields':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.subscriptionId,
				summary: `Push ${op.args.fields.length} field(s) on channel "${op.args.subscriptionId}": ${op.args.fields.join(', ')}`,
			}
		case 'live.setLimits':
			// The product, not the two factors. Neither number alone is the one that
			// hurts; what the process has to serialize and send is their product, and
			// a reviewer who has to multiply is a reviewer who will not.
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.subscriptionId,
				summary: `Cap channel "${op.args.subscriptionId}" at ${op.args.maxSubscribers} subscriber(s) × ${op.args.maxMessagesPerMinute} msg/min = up to ${op.args.maxSubscribers * op.args.maxMessagesPerMinute} messages/minute`,
			}
		case 'live.pause':
			return {
				op: op.op,
				layer,
				change: 'set',
				targetId: op.args.subscriptionId,
				summary: `${op.args.paused ? 'Shed live channel (subscribers fall back to polling)' : 'Bring live channel back online'}: "${op.args.subscriptionId}"`,
			}
		case 'live.remove':
			return {
				op: op.op,
				layer,
				change: 'remove',
				targetId: op.args.subscriptionId,
				summary: `Remove live channel "${op.args.subscriptionId}"`,
			}
		case 'provenance.review': {
			const { target, action, cascade } = op.args
			const verb =
				action === 'accept'
					? 'Accept'
					: action === 'reject'
						? 'Reject'
						: 'Reset'
			// A reset cascades over *settled* rows rather than undecided ones — an
			// undo takes back decisions, so the summary must not claim otherwise.
			const scope = cascade
				? action === 'reset'
					? ' and its settled nested rows'
					: ' and its undecided nested rows'
				: ''
			return {
				op: op.op,
				layer: reviewTargetLayer(target.kind),
				change: 'review',
				targetId: target.id,
				parentId: target.parentId,
				summary: `${verb} ${target.kind} "${target.id}"${scope}${action === 'reset' ? ' (back to undecided)' : ''}`,
			}
		}
	}
}

// ===========================================================================
// applyOp — validated, immutable, logged
// ===========================================================================

export interface ApplyMeta {
	id: OpId
	origin: 'ai' | 'human'
	appliedAt: ISODate
	/**
	 * Which author is landing this op. **Required**, and that is the
	 * point: "no write path lands a change without recorded attribution" is a
	 * promise the typechecker can keep, so a new write path cannot forget to
	 * attribute itself the way it could if this were optional with a default.
	 *
	 * Only `actor.surface` is mandatory — see {@link OpActor} for why the rest is
	 * not (a placeholder in a provenance record reads as an answer).
	 */
	actor: OpActor
	/**
	 * Who *wrote the change*, when that is not who asked for it. Drives the
	 * {@link defaultProvenance} an add op's row lands with; it is **not** recorded
	 * on the op-log entry, because the log's question is who landed this and
	 * `origin` + `actor` already answer it truthfully.
	 *
	 * Optional, defaulting to `origin`, and issue #359 is why it exists at all.
	 * `origin` was doing two jobs — who requested this (a per-request audit fact)
	 * and who authored it (a property of the change, not of the HTTP request that
	 * carried it) — and they only coincide because for most write paths the
	 * requester *is* the author. The workbench's Land button is where they come
	 * apart: a maintainer clicks it (`origin: 'human'`, correctly, since #358) to
	 * land an op an agent proposed, and inferring authorship from the click
	 * stamped `manual()` — erasing the AI lineage the review layer exists to keep
	 * visible, and handing the row the regeneration protection `manual()` carries.
	 *
	 * A host states this only when it *knows* the two differ and can say so from a
	 * record rather than a guess; absent is the honest default everywhere else.
	 */
	authorship?: 'ai' | 'human'
}

/**
 * Validate then apply an op, returning a NEW system. Throws if the op is
 * invalid (so `apply_spec_change` never lands a broken spec). The input system
 * is never mutated. Appends the applied op to `opLog`; `prd.recordDecision`
 * additionally appends to the append-only `ledger` (guarded by
 * {@link assertAppendOnly}).
 */
export function applyOp(
	system: SpecSystem,
	op: SpecOp,
	meta: ApplyMeta,
): SpecSystem {
	const errors = validateOp(system, op)
	if (errors.length)
		throw new Error(`applyOp(${op.op}) rejected:\n- ${errors.join('\n- ')}`)

	const next: SpecSystem = structuredClone(system)
	switch (op.op) {
		case 'prd.addRequirement': {
			next.product.requirements.push(op.args.requirement)
			if (op.args.intoPhaseId) {
				const phase = next.product.roadmap.phases.find(
					(p) => p.id === op.args.intoPhaseId,
				)
				phase?.featureRequirementIds.push(op.args.requirement.id)
			}
			break
		}
		case 'prd.addScopeItem':
			next.product.scope[op.args.bucket].push(op.args.item)
			break
		case 'prd.addRisk':
			next.product.risks.push(op.args.risk)
			break
		case 'prd.addMetric':
			next.product.goals.supportingMetrics.push(op.args.metric)
			break
		case 'prd.recordDecision': {
			const grown = recordDecision(next.ledger, op.args.entry)
			// Guard against the ORIGINAL ledger: the comparison is structural,
			// so the structuredClone in `next` doesn't trip it, and this also
			// catches any accidental mutation of the cloned prefix above.
			assertAppendOnly(system.ledger, grown)
			next.ledger = grown
			break
		}
		case 'data.addEntity': {
			const fallback = defaultProvenance(meta)
			const entity: EntitySpec = normalizeEntityOptions({
				...op.args.entity,
				provenance: op.args.entity.provenance ?? fallback,
				fields: op.args.entity.fields.map((f) => ({
					...f,
					provenance: f.provenance ?? fallback,
				})),
			})
			next.data.entities.push(entity)
			break
		}
		case 'data.addField': {
			const entity = next.data.entities.find((e) => e.id === op.args.entityId)
			const field: FieldSpec = normalizeFieldOptions({
				...op.args.field,
				provenance: op.args.field.provenance ?? defaultProvenance(meta),
			})
			entity?.fields.push(field)
			break
		}
		case 'data.setFieldReference': {
			const entity = next.data.entities.find((e) => e.id === op.args.entityId)
			const field = entity?.fields.find((f) => f.id === op.args.fieldId)
			// The field keeps its declared `type` (a reference is stored as the
			// referenced id, whatever the spec calls it) and its provenance: this
			// declares something that was already true, it does not author a field.
			if (field) {
				field.reference = op.args.reference
				// Narrowing consumes the ambiguity. The candidate list is
				// dropped rather than kept beside the answer, because two live records
				// of what a column points at is how they come to disagree — and
				// `reference` is already the one every consumer reads.
				delete field.openReference
			}
			break
		}
		case 'data.setFieldOpenReference': {
			const entity = next.data.entities.find((e) => e.id === op.args.entityId)
			const field = entity?.fields.find((f) => f.id === op.args.fieldId)
			// Last-wins, and the field keeps its `type` and provenance: this declares
			// something that was already true about the column, it does not author a
			// field. Deduplicated and sorted so the same declaration made twice
			// encodes identically — a spec whose byte content depends on argument
			// order is one the upgrade gate cannot compare.
			if (field) field.openReference = [...new Set(op.args.candidates)].sort()
			break
		}
		case 'data.setFieldLimits': {
			const entity = next.data.entities.find((e) => e.id === op.args.entityId)
			const field = entity?.fields.find((f) => f.id === op.args.fieldId)
			// Last-wins, like `flags.setTargeting`: an empty map removes the caps
			// rather than merging into them, so "we're not running WIP limits any
			// more" is one op and leaves no half-limit behind. The key is deleted
			// (not set to `{}`) so a field with no limits encodes exactly as it did
			// before any limit was declared.
			if (field) {
				if (Object.keys(op.args.limits).length === 0) delete field.limits
				else field.limits = { ...op.args.limits }
			}
			break
		}
		case 'data.setFieldDisplay': {
			const entity = next.data.entities.find((e) => e.id === op.args.entityId)
			const field = entity?.fields.find((f) => f.id === op.args.fieldId)
			// Last-wins, like `data.setFieldLimits` above: a second call with no
			// `max` means "no declared max", not "keep the old one" — otherwise the
			// only way to *remove* a bound would be to know what it used to be. An
			// empty object deletes the key (rather than storing `{}`) so a field
			// returned to inference encodes exactly as it did before it was ever
			// declared, which is what keeps the upgrade gate's byte comparison honest.
			if (field) {
				const declared = Object.fromEntries(
					Object.entries(op.args.display).filter(([, v]) => v !== undefined),
				) as FieldDisplaySpec
				if (Object.keys(declared).length === 0) delete field.display
				else field.display = declared
			}
			break
		}
		case 'data.addComputed': {
			const entity = next.data.entities.find((e) => e.id === op.args.entityId)
			if (entity) {
				const computed: ComputedFieldSpec = {
					...op.args.computed,
					provenance: op.args.computed.provenance ?? defaultProvenance(meta),
				}
				entity.computed = [...(entity.computed ?? []), computed]
			}
			break
		}
		case 'data.addRollup': {
			const entity = next.data.entities.find((e) => e.id === op.args.entityId)
			if (entity) {
				const rollup: RollupSpec = {
					...op.args.rollup,
					provenance: op.args.rollup.provenance ?? defaultProvenance(meta),
				}
				entity.rollups = [...(entity.rollups ?? []), rollup]
			}
			break
		}
		case 'page.addPage': {
			const fallback = defaultProvenance(meta)
			const page: PageSpec = {
				...op.args.page,
				provenance: op.args.page.provenance ?? fallback,
				blocks: op.args.page.blocks.map((b) => ({
					...b,
					provenance: b.provenance ?? fallback,
				})),
			}
			next.pages.pages.push(page)
			break
		}
		case 'page.addBlock': {
			const page = next.pages.pages.find((p) => p.id === op.args.pageId)
			const block: BlockSpec = {
				...op.args.block,
				provenance: op.args.block.provenance ?? defaultProvenance(meta),
			}
			page?.blocks.push(block)
			break
		}
		case 'page.setBlockOrder': {
			const block = next.pages.pages
				.find((p) => p.id === op.args.pageId)
				?.blocks.find((b) => b.id === op.args.blockId)
			if (block) block.order = op.args.order
			break
		}
		case 'page.setBlockVariant': {
			const block = next.pages.pages
				.find((p) => p.id === op.args.pageId)
				?.blocks.find((b) => b.id === op.args.blockId)
			if (block) block.variant = op.args.variant
			break
		}
		case 'page.setBlockFields': {
			const block = next.pages.pages
				.find((p) => p.id === op.args.pageId)
				?.blocks.find((b) => b.id === op.args.blockId)
			// Copy: the op's array must not be aliased into spec state (apply is
			// immutable w.r.t. its input, same contract as the rest of the ops).
			if (block) block.fields = [...op.args.fields]
			break
		}
		case 'page.setBlockEditable': {
			const block = next.pages.pages
				.find((p) => p.id === op.args.pageId)
				?.blocks.find((b) => b.id === op.args.blockId)
			// Copied for the same reason setBlockFields copies: apply is immutable
			// with respect to its input, so the op's array is never aliased into state.
			if (block) block.editable = [...op.args.editable]
			break
		}
		case 'page.setE2ETests': {
			const page = next.pages.pages.find((p) => p.id === op.args.pageId)
			// Copied for the same reason setBlockFields copies: apply is immutable
			// with respect to its input, so the op's array is never aliased into state.
			if (page) page.e2eTests = [...op.args.e2eTests]
			break
		}
		case 'page.addCalendar':
		case 'page.addTimeline':
		case 'page.addBoard': {
			const page = next.pages.pages.find((p) => p.id === op.args.pageId)
			const view =
				op.op === 'page.addCalendar'
					? { calendar: { ...op.args.calendar } }
					: op.op === 'page.addTimeline'
						? { timeline: { ...op.args.timeline } }
						: {
								board: {
									...op.args.board,
									// Copy: the op's array must not be aliased into spec state.
									...(op.args.board.cardFields
										? { cardFields: [...op.args.board.cardFields] }
										: {}),
								},
							}
			page?.blocks.push({
				id: op.args.blockId,
				type:
					op.op === 'page.addCalendar'
						? 'calendar'
						: op.op === 'page.addTimeline'
							? 'timeline'
							: 'board',
				...view,
				provenance: op.args.provenance ?? defaultProvenance(meta),
			})
			break
		}
		case 'theme.set': {
			// Full-replace, last-wins: strip undefined keys so the stored theme (and
			// the encoded theme.json) carries only what was actually set.
			next.theme = Object.fromEntries(
				Object.entries(op.args.theme).filter(([, v]) => v !== undefined),
			) as ThemeSpec
			break
		}
		case 'pricing.addTier': {
			const tier: PricingTier = {
				...op.args.tier,
				provenance: op.args.tier.provenance ?? defaultProvenance(meta),
			}
			next.pricing.tiers.push(tier)
			break
		}
		case 'flags.declare': {
			const flag: FlagSpec = {
				...op.args.flag,
				// Stamped, not authored: flag age is a reported number, and a
				// hand-written date drifts the moment someone copies an op file.
				declaredAt: op.args.flag.declaredAt ?? meta.appliedAt,
				provenance: op.args.flag.provenance ?? defaultProvenance(meta),
			}
			next.flags = { flags: [...(next.flags?.flags ?? []), flag] }
			break
		}
		case 'flags.setTargeting': {
			const flag = next.flags?.flags.find((f) => f.id === op.args.flagId)
			if (flag) {
				// Last-wins, like `theme.set`: an absent `targeting` clears the rule
				// rather than merging into it, so "pause the rollout" is one op.
				if (op.args.targeting === undefined) delete flag.targeting
				else flag.targeting = op.args.targeting
			}
			break
		}
		case 'flags.gate': {
			const { target, flag } = op.args
			const page =
				target.kind === 'page'
					? next.pages.pages.find((p) => p.id === target.id)
					: next.pages.pages.find((p) => p.id === target.parentId)
			const row =
				target.kind === 'page'
					? page
					: page?.blocks.find((b) => b.id === target.id)
			if (row) {
				if (flag === null) delete row.flag
				else row.flag = flag
			}
			break
		}
		case 'flags.remove': {
			// validateOp proved nothing still gates on it.
			const remaining = (next.flags?.flags ?? []).filter(
				(f) => f.id !== op.args.flagId,
			)
			next.flags = { flags: remaining }
			break
		}
		case 'schedules.declare': {
			const schedule: ScheduleSpec = {
				...op.args.schedule,
				// Stamped, not authored — and load-bearing: an `interval` recurrence
				// counts its occurrences from this date.
				declaredAt: op.args.schedule.declaredAt ?? meta.appliedAt,
				provenance: op.args.schedule.provenance ?? defaultProvenance(meta),
			}
			next.schedules = {
				schedules: [...(next.schedules?.schedules ?? []), schedule],
			}
			break
		}
		case 'schedules.setRecurrence': {
			const schedule = next.schedules?.schedules.find(
				(s) => s.id === op.args.scheduleId,
			)
			if (schedule) {
				schedule.recurrence = op.args.recurrence
				if (op.args.timezone !== undefined) schedule.timezone = op.args.timezone
			}
			break
		}
		case 'schedules.pause': {
			const schedule = next.schedules?.schedules.find(
				(s) => s.id === op.args.scheduleId,
			)
			// `paused: false` deletes the key rather than storing it, so a resumed
			// schedule round-trips byte-identical to one that was never paused.
			if (schedule) {
				if (op.args.paused) schedule.paused = true
				else delete schedule.paused
			}
			break
		}
		case 'schedules.remove': {
			// validateOp proved it was already paused.
			next.schedules = {
				schedules: (next.schedules?.schedules ?? []).filter(
					(s) => s.id !== op.args.scheduleId,
				),
			}
			break
		}
		case 'sources.declare': {
			const source: SourceSpec = {
				...op.args.source,
				declaredAt: op.args.source.declaredAt ?? meta.appliedAt,
				provenance: op.args.source.provenance ?? defaultProvenance(meta),
			}
			next.sources = {
				sources: [...(next.sources?.sources ?? []), source],
			}
			break
		}
		case 'sources.setMapping': {
			const source = next.sources?.sources.find(
				(s) => s.id === op.args.sourceId,
			)
			if (source) source.mapping = op.args.mapping
			break
		}
		case 'sources.setLimits': {
			const source = next.sources?.sources.find(
				(s) => s.id === op.args.sourceId,
			)
			if (source) source.limits = op.args.limits
			break
		}
		case 'sources.pause': {
			const source = next.sources?.sources.find(
				(s) => s.id === op.args.sourceId,
			)
			// `paused: false` deletes the key rather than storing it, so a resumed
			// source round-trips byte-identical to one that was never paused.
			if (source) {
				if (op.args.paused) source.paused = true
				else delete source.paused
			}
			break
		}
		case 'sources.remove': {
			// validateOp proved it was already paused.
			next.sources = {
				sources: (next.sources?.sources ?? []).filter(
					(s) => s.id !== op.args.sourceId,
				),
			}
			break
		}
		case 'search.declare': {
			const index: SearchIndexSpec = {
				...op.args.index,
				declaredAt: op.args.index.declaredAt ?? meta.appliedAt,
				provenance: op.args.index.provenance ?? defaultProvenance(meta),
			}
			next.search = { indexes: [...(next.search?.indexes ?? []), index] }
			break
		}
		case 'search.setFields': {
			const index = next.search?.indexes.find((i) => i.id === op.args.indexId)
			if (index) index.fields = op.args.fields
			break
		}
		case 'search.setIndexing': {
			const index = next.search?.indexes.find((i) => i.id === op.args.indexId)
			if (index) index.indexed = op.args.indexed
			break
		}
		case 'search.remove': {
			// validateOp proved the physical index was already dropped.
			next.search = {
				indexes: (next.search?.indexes ?? []).filter(
					(i) => i.id !== op.args.indexId,
				),
			}
			break
		}
		case 'documents.declare': {
			const template: DocumentTemplateSpec = {
				...op.args.template,
				declaredAt: op.args.template.declaredAt ?? meta.appliedAt,
				provenance: op.args.template.provenance ?? defaultProvenance(meta),
			}
			next.documents = {
				templates: [...(next.documents?.templates ?? []), template],
			}
			break
		}
		case 'documents.setSections': {
			const template = next.documents?.templates.find(
				(t) => t.id === op.args.templateId,
			)
			if (template) template.sections = op.args.sections
			break
		}
		case 'documents.setDelivery': {
			const template = next.documents?.templates.find(
				(t) => t.id === op.args.templateId,
			)
			if (template) template.delivery = op.args.delivery
			break
		}
		case 'documents.remove': {
			// validateOp proved every delivery target was already off.
			next.documents = {
				templates: (next.documents?.templates ?? []).filter(
					(t) => t.id !== op.args.templateId,
				),
			}
			break
		}
		case 'imports.declare': {
			const importer: ImporterSpec = {
				...op.args.importer,
				declaredAt: op.args.importer.declaredAt ?? meta.appliedAt,
				provenance: op.args.importer.provenance ?? defaultProvenance(meta),
			}
			next.imports = {
				importers: [...(next.imports?.importers ?? []), importer],
			}
			break
		}
		case 'imports.setMapping': {
			const importer = next.imports?.importers.find(
				(i) => i.id === op.args.importerId,
			)
			if (importer) importer.columns = op.args.columns
			break
		}
		case 'imports.setUpsertKey': {
			const importer = next.imports?.importers.find(
				(i) => i.id === op.args.importerId,
			)
			// Assigned rather than deleted when null, unlike a source's optional
			// `paused`: `upsertFieldId` is required and *nullable*, so `null` is a
			// recorded decision and an absent key would decode as an importer nobody
			// ever decided about.
			if (importer) importer.upsertFieldId = op.args.upsertFieldId
			break
		}
		case 'imports.pause': {
			const importer = next.imports?.importers.find(
				(i) => i.id === op.args.importerId,
			)
			// Assigned in both directions for the same reason: `paused` is required
			// on an importer, so there is no "absent means running" state to fall back
			// to.
			if (importer) importer.paused = op.args.paused
			break
		}
		case 'imports.remove': {
			// validateOp proved it was already paused.
			next.imports = {
				importers: (next.imports?.importers ?? []).filter(
					(i) => i.id !== op.args.importerId,
				),
			}
			break
		}
		case 'portals.declare': {
			const portal: PortalSpec = {
				...op.args.portal,
				declaredAt: op.args.portal.declaredAt ?? meta.appliedAt,
				provenance: op.args.portal.provenance ?? defaultProvenance(meta),
			}
			next.portals = {
				portals: [...(next.portals?.portals ?? []), portal],
			}
			break
		}
		case 'portals.setFields': {
			const portal = next.portals?.portals.find(
				(p) => p.id === op.args.portalId,
			)
			if (portal) portal.readFields = op.args.readFields
			break
		}
		case 'portals.setWrites': {
			const portal = next.portals?.portals.find(
				(p) => p.id === op.args.portalId,
			)
			if (portal) portal.writes = op.args.writes
			break
		}
		case 'portals.pause': {
			const portal = next.portals?.portals.find(
				(p) => p.id === op.args.portalId,
			)
			// Assigned in both directions: `paused` is required on a portal, so there
			// is no "absent means reachable" state to fall back to — which would be
			// the worst possible default for this particular field.
			if (portal) portal.paused = op.args.paused
			break
		}
		case 'portals.remove': {
			// validateOp proved it was already paused.
			next.portals = {
				portals: (next.portals?.portals ?? []).filter(
					(p) => p.id !== op.args.portalId,
				),
			}
			break
		}
		case 'live.declare': {
			const subscription: LiveSubscriptionSpec = {
				...op.args.subscription,
				declaredAt: op.args.subscription.declaredAt ?? meta.appliedAt,
				provenance: op.args.subscription.provenance ?? defaultProvenance(meta),
			}
			next.live = {
				subscriptions: [...(next.live?.subscriptions ?? []), subscription],
			}
			break
		}
		case 'live.setFields': {
			const sub = next.live?.subscriptions.find(
				(l) => l.id === op.args.subscriptionId,
			)
			if (sub) sub.fields = op.args.fields
			break
		}
		case 'live.setLimits': {
			const sub = next.live?.subscriptions.find(
				(l) => l.id === op.args.subscriptionId,
			)
			// Both assigned together, never one at a time: they multiply into the
			// load this process carries, and a half-applied pair is a ceiling nobody
			// reviewed.
			if (sub) {
				sub.maxSubscribers = op.args.maxSubscribers
				sub.maxMessagesPerMinute = op.args.maxMessagesPerMinute
			}
			break
		}
		case 'live.pause': {
			const sub = next.live?.subscriptions.find(
				(l) => l.id === op.args.subscriptionId,
			)
			// Assigned in both directions: `paused` is required, so there is no
			// "absent means answering" state to fall back to.
			if (sub) sub.paused = op.args.paused
			break
		}
		case 'live.remove': {
			// validateOp proved it was already paused.
			next.live = {
				subscriptions: (next.live?.subscriptions ?? []).filter(
					(l) => l.id !== op.args.subscriptionId,
				),
			}
			break
		}
		case 'provenance.review': {
			// validateOp proved the target resolves; locate it again in the clone.
			const row = locateReviewTarget(next, op.args.target)
			const action = op.args.action
			const transition =
				action === 'accept' ? accept : action === 'reject' ? reject : unreview
			// Which rows this action is *allowed* to move. Accept/reject decide
			// undecided rows; reset (the undo) takes back settled ones.
			// Neither ever touches a `manual` row: un-deciding a hand-authored row
			// would not be an undo — nobody decided it — and it would strip the regen
			// protection `isAddedManually` exists to give.
			const movable = (state: ProvenanceState): boolean =>
				action === 'reset'
					? state === 'accepted' || state === 'rejected'
					: state === 'suggested'
			if (op.args.cascade) {
				// One decision covers the whole subtree: the target plus its nested
				// rows, each transitioned only while it is in a state this action may
				// move — so a cascade can never flip a manual row, and can never
				// overwrite a decision it was not taking back.
				for (const r of [row, ...locateReviewChildren(next, op.args.target)])
					if (r && movable(deriveProvenanceState(r.provenance)))
						r.provenance = transition(r.provenance)
			} else if (
				row &&
				(action !== 'reset' || movable(deriveProvenanceState(row.provenance)))
			) {
				// A non-cascading accept/reject may still re-decide a settled row (a
				// maintainer changing their mind is a real thing, and the trail records
				// both). A reset is the one action gated even without a cascade,
				// because resetting a manual row is never what anybody meant.
				row.provenance = transition(row.provenance)
			}
			break
		}
	}

	next.opLog.push({
		id: meta.id,
		op,
		origin: meta.origin,
		appliedAt: meta.appliedAt,
		diff: diffOp(op),
		actor: meta.actor,
	})
	return next
}

// ===========================================================================
// validateOpDryRun — the one validator suggest AND accept share
// ===========================================================================

/**
 * The full suggest→accept validator: the {@link validateOp}
 * preconditions plus a dry-run apply checked by
 * {@link collectSpecSystemErrors} — the exact system-level validator the disk
 * store runs before writing. Whatever this passes, `save` will accept, so
 * `propose_spec_change` can never bless a payload `apply_spec_change` then
 * rejects. Errors already present in the input system are subtracted, so an op
 * is only blamed for problems it introduces.
 */
export function validateOpDryRun(
	system: SpecSystem,
	op: SpecOp,
	origin: ApplyMeta['origin'],
): string[] {
	const errors = validateOp(system, op)
	if (errors.length) return errors
	let next: SpecSystem
	try {
		next = applyOp(system, op, {
			id: 'op-dry-run' as OpId,
			origin,
			appliedAt: '1970-01-01T00:00:00.000Z' as ISODate,
			// The dry run's actor is never persisted — `next` is thrown away below,
			// and that is the property `write-path.invariant.test.ts` pins: a
			// *validate* is not a write, so it needs no real attribution. The
			// surface is the one place the dry run and the real apply can differ
			// without consequence.
			actor: { surface: 'mcp', path: 'validate-op-dry-run' },
		})
	} catch (err) {
		return [err instanceof Error ? err.message : String(err)]
	}
	const preexisting = new Set(collectSpecSystemErrors(system))
	return collectSpecSystemErrors(next).filter((e) => !preexisting.has(e))
}
