/**
 * Authoring helpers shared by the example specs. The two hand-authored
 * originals (taskly, todotracker) spell every field/block/provenance object out
 * inline; these helpers collapse that boilerplate so the set can grow toward 10
 * without each new example being 200 lines of repetition.
 *
 * The change-constructor helpers (`addPage`, `addField`, `addSlot`,
 * `addEntity`, `retitle`, `fillSlot`, `ejectPage`, `offSurface`) are the
 * granular vocabulary each example composes into its *own* distinct backlog
 *. Each returns one
 * {@link ExampleChange}; a example orders them into a realistic ~10–15
 * change story, deliberately including `offSurface` asks the platform has no op
 * or slot for, so the expressibility ratio becomes a number that can move.
 */

import {
	type BlockId,
	type BoardSpec,
	type CalendarSpec,
	type ComputedFieldSpec,
	type DocumentTemplateId,
	type DocumentTemplateSpec,
	type EntityId,
	type EntitySpec,
	type ExampleApp,
	type ExampleChange,
	type FieldId,
	type FieldType,
	type ImporterId,
	type ImporterSpec,
	type LiveId,
	type LiveSubscriptionSpec,
	manual,
	newSpecSystem,
	type OffSurfaceCluster,
	type PageId,
	type PageSpec,
	type PortalId,
	type PortalSpec,
	type PRD,
	type RollupSpec,
	type ScheduleId,
	type ScheduleSpec,
	type SearchIndexId,
	type SearchIndexSpec,
	type SourceId,
	type SourceSpec,
	type SpecSystem,
	suggested,
	type TimelineSpec,
} from './deps.ts'

/** Accepted-suggestion provenance — the example spec is the grounding set. */
export const p = () => ({ provenance: suggested({ autoAccept: true }) })

export function field(
	id: FieldId,
	name: string,
	type: FieldType,
	required = false,
): EntitySpec['fields'][number] {
	return { id, name, type, required, ...p() }
}

/**
 * A belongs-to foreign key.
 *
 * This helper is the reason it exists: until it landed, `field()` had no
 * `reference` parameter, so a example author literally **could not express a
 * relation** — and none of the eleven examples had a single one. Meanwhile
 * three of the corpus's off-surface asks ("aggregate ingredients across every
 * planned recipe", "per-org usage metering", "1RM over time") all presupposed
 * relations the specs never modelled. The corpus was under-specified relative to
 * its own backlog, which is a different failure from an expressibility gap and
 * had been invisible because nothing needed the graph until rollups did.
 *
 * `belongsTo` is deliberately its own function rather than a fifth positional
 * argument to `field()`: a reference field's *stored* type is the referenced id,
 * not the declared type, so `field(id, name, 'string', false, 'e-recipe')` reads
 * as though the column were a string. It is not.
 */
export function belongsTo(
	id: FieldId,
	name: string,
	reference: EntityId,
	required = false,
): EntitySpec['fields'][number] {
	return { id, name, type: 'string', required, reference, ...p() }
}

/**
 * `computed` is here for the values a row *has* rather than ones a backlog asks
 * for — gymlog's Epley 1RM is a property of a logged set, the way a subtotal is
 * a property of an order line. A derived value a change request actually asks
 * for belongs in the change set as {@link addComputed}, not here.
 */
export function entity(
	id: EntityId,
	name: string,
	description: string,
	fields: EntitySpec['fields'],
	computed?: readonly Omit<ComputedFieldSpec, 'provenance'>[],
): EntitySpec {
	return {
		id,
		name,
		description,
		fields,
		...(computed ? { computed: computed.map((c) => ({ ...c, ...p() })) } : {}),
		...p(),
	}
}

export function table(id: BlockId): PageSpec['blocks'][number] {
	return { id, type: 'table', ...p() }
}

export function slot(id: BlockId, name: string): PageSpec['blocks'][number] {
	return { id, type: `slot:${name}`, ...p() }
}

export function page(input: {
	id: PageId
	name: string
	route: string
	entityId: EntityId
	blocks: PageSpec['blocks']
	e2eTests: string[]
}): PageSpec {
	return { ...input, ...p() }
}

/**
 * Assemble a example from its grounding PRD, data entities, and the two pages
 * present at generation time, plus the parameters of the standard change set.
 */
export function crudExample(input: {
	id: string
	title: string
	prd: PRD
	autoAccept?: boolean
	entities: EntitySpec[]
	pages: PageSpec[]
	/**
	 * Schedules the app has declared at generation time. Part of the
	 * example's *spec*, not its backlog — declaring one is a `spec-edit` under
	 * `docs/corpus/`, and it changes what the app is rather than what is asked of
	 * it, so it does not touch the scored denominator.
	 */
	schedules?: ScheduleSpec[]
	/**
	 * External data sources the app has declared at generation time.
	 * Part of the example's *spec* on exactly the same terms as
	 * {@link crudExample}'s schedules: declaring an integration changes what the
	 * app **is**, and the backlog ask is what is *asked of it*. Adding one is a
	 * `spec-edit` under `docs/corpus/` and does not touch the scored denominator.
	 */
	sources?: SourceSpec[]
	/**
	 * Importers the app has declared at generation time. Part of the
	 * example's *spec* on the same terms as its schedules and sources: declaring
	 * a way IN to the data changes what the app **is**, and the backlog ask is
	 * what is *asked of it*. Adding one is a `spec-edit` under `docs/corpus/` and
	 * does not touch the scored denominator.
	 */
	imports?: ImporterSpec[]
	/**
	 * Live channels the app has declared at generation time. Part of
	 * the example's *spec* on the same terms as its schedules, sources and
	 * importers: declaring that a surface moves changes what the app **is**, and
	 * the backlog ask is what is *asked of it*. Adding one is a `spec-edit` under
	 * `docs/corpus/` and does not touch the scored denominator.
	 */
	live?: LiveSubscriptionSpec[]
	changes: ExampleChange[]
}): ExampleApp {
	const spec: SpecSystem = newSpecSystem(input.prd, {
		autoAccept: input.autoAccept ?? true,
	})
	spec.data.entities = input.entities
	spec.pages.pages = input.pages
	if (input.schedules) spec.schedules = { schedules: input.schedules }
	if (input.sources) spec.sources = { sources: input.sources }
	if (input.imports) spec.imports = { importers: input.imports }
	if (input.live) spec.live = { subscriptions: input.live }
	return { id: input.id, title: input.title, spec, changes: input.changes }
}

/** A declared schedule for a example spec. */
export function schedule(input: {
	id: ScheduleId
	key: string
	description: string
	timezone: string
	recurrence: ScheduleSpec['recurrence']
	runAs: ScheduleSpec['runAs']
	entityId?: EntityId
	declaredAt?: string
}): ScheduleSpec {
	return {
		id: input.id,
		key: input.key,
		description: input.description,
		timezone: input.timezone,
		recurrence: input.recurrence,
		runAs: input.runAs,
		...(input.entityId ? { entityId: input.entityId } : {}),
		declaredAt: (input.declaredAt ??
			'2026-07-27') as ScheduleSpec['declaredAt'],
		provenance: manual(),
	}
}

// ===========================================================================
// Change constructors — the granular backlog vocabulary
// ===========================================================================
//
// Each returns one `ExampleChange`. A example composes its own distinct
// ~10–15 change story from these, drawn from a real product backlog, rather
// than sharing one canned five-change set. Ordering rules the eval enforces:
//   - `fillSlot` a page's original single slot BEFORE adding a second slot to
//     it (a fill overwrites the whole slot file; a later `addSlot` re-scaffolds
//     the stub, so fill-then-add is byte-safe but add-then-fill dangles).
//   - `ejectPage` / `offSurface(..., 'eject')` a resource LAST among changes
//     that touch it, and eject each resource at most once.

/** `page.addPage` — introduce a whole new page (spec op, weight 1). */
export function addPage(
	id: string,
	description: string,
	added: PageSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'page.addPage', args: { page: added } },
	}
}

/** `data.addField` — a new column on an existing entity (spec op, weight 1). */
export function addField(
	id: string,
	description: string,
	entityId: EntityId,
	fieldId: FieldId,
	name: string,
	type: FieldType,
	required = false,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: {
			op: 'data.addField',
			args: { entityId, field: field(fieldId, name, type, required) },
		},
	}
}

/**
 * `data.addRollup` — an aggregate over a related entity's rows (spec op, weight
 * 1). With `groupBy` it yields a series and MUST carry a `limit`.
 */
export function addRollup(
	id: string,
	description: string,
	entityId: EntityId,
	rollup: Omit<RollupSpec, 'provenance'>,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: {
			op: 'data.addRollup',
			args: { entityId, rollup: { ...rollup, ...p() } },
		},
	}
}

/**
 * `data.addComputed` — a value derived from a row's own numeric fields (spec op,
 * weight 1).
 */
export function addComputed(
	id: string,
	description: string,
	entityId: EntityId,
	computed: Omit<ComputedFieldSpec, 'provenance'>,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: {
			op: 'data.addComputed',
			args: { entityId, computed: { ...computed, ...p() } },
		},
	}
}

/** `data.addEntity` — a whole new table, no page yet (spec op, weight 1). */
export function addEntity(
	id: string,
	description: string,
	ent: EntitySpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'data.addEntity', args: { entity: ent } },
	}
}

/** `page.addBlock` — open a new extension slot on a page (spec op, weight 1). */
export function addSlot(
	id: string,
	description: string,
	pageId: PageId,
	blockId: BlockId,
	slotName: string,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: {
			op: 'page.addBlock',
			args: { pageId, block: slot(blockId, slotName) },
		},
	}
}

/** A page retitle landed through regeneration-as-diff (spec op, weight 2). */
export function retitle(
	id: string,
	description: string,
	resource: string,
	title: string,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'regen-diff',
		edit: { resource, title },
	}
}

/** A user edit absorbed by a cross-file slot — no eject (slot fill, weight 3). */
export function fillSlot(
	id: string,
	description: string,
	resource: string,
	slotName: string,
	body: string,
): ExampleChange {
	return { id, description, kind: 'slot-fill', resource, slot: slotName, body }
}

/** Take whole-file ownership — the chosen escape hatch (eject, weight 5). */
export function ejectPage(
	id: string,
	description: string,
	resource: string,
): ExampleChange {
	return { id, description, kind: 'eject', resource }
}

/**
 * An ask with no op and no slot to express it (off-surface, weight 8) — the moat
 * gap. `resolution: 'eject'` = forced off the surface, landed by hand;
 * `resolution: 'unexpressible'` = the platform cannot land it at all.
 */
export function offSurface(
	id: string,
	description: string,
	resource: string,
	resolution: 'eject' | 'unexpressible',
	cluster?: OffSurfaceCluster,
): ExampleChange {
	return {
		id,
		description,
		kind: 'off-surface',
		resource,
		resolution,
		...(cluster ? { cluster } : {}),
	}
}

/**
 * `page.addCalendar` — the page's rows arranged by a date column, as a month or
 * week grid or a density heatmap (spec op, weight 1).
 */
export function addCalendar(
	id: string,
	description: string,
	pageId: PageId,
	blockId: BlockId,
	calendar: CalendarSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'page.addCalendar', args: { pageId, blockId, calendar, ...p() } },
	}
}

/**
 * `page.addTimeline` — the page's rows as bars across a start/end range, with
 * optional dependency arrows (spec op, weight 1).
 */
export function addTimeline(
	id: string,
	description: string,
	pageId: PageId,
	blockId: BlockId,
	timeline: TimelineSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'page.addTimeline', args: { pageId, blockId, timeline, ...p() } },
	}
}

/**
 * An `enum` field with its value list declared.
 *
 * `field(id, name, 'enum')` produces an enum with *no* options, which grounds to
 * a permissive text column — fine for a chip, useless for a board, whose columns
 * ARE the declared values. Its own helper rather than a fifth argument to
 * `field()` for the same reason `belongsTo` is: an enum with options and one
 * without are different columns, and reading `field(id, name, 'enum', true, [...])`
 * would not say so.
 */
export function enumField(
	id: FieldId,
	name: string,
	options: readonly string[],
	required = false,
): EntitySpec['fields'][number] {
	return {
		id,
		name,
		type: 'enum',
		required,
		options: options.map((value) => ({ label: value, value })),
		...p(),
	}
}

/**
 * A manual-ordering key — the column a board persists card order
 * in. Never required, never typed into: the database stamps it and a drag
 * rewrites it.
 */
export function rankField(
	id: FieldId,
	name: string,
): EntitySpec['fields'][number] {
	return { id, name, type: 'string', required: false, rank: true, ...p() }
}

/**
 * `page.addBoard` — the page's rows as cards in columns, grouped by an enum
 * column and moved between them by drag or keyboard (spec op, weight 1;
 * issue #172).
 */
export function addBoard(
	id: string,
	description: string,
	pageId: PageId,
	blockId: BlockId,
	board: BoardSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'page.addBoard', args: { pageId, blockId, board, ...p() } },
	}
}

/**
 * `data.setFieldLimits` — per-value row caps on an enum column, i.e. a Kanban
 * WIP limit, enforced on every write rather than drawn on the board (spec op,
 * weight 1).
 */
export function setFieldLimits(
	id: string,
	description: string,
	entityId: EntityId,
	fieldId: FieldId,
	limits: Record<string, number>,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'data.setFieldLimits', args: { entityId, fieldId, limits } },
	}
}

/**
 * A declared external data source for a example spec.
 *
 * The counterpart of {@link schedule}: an integration an app *has* rather than
 * one its backlog asks for. `declaredAt` defaults so the spec is a fixed value
 * and a example never depends on the day it was read.
 */
export function source(input: {
	id: SourceId
	key: string
	description: string
	mode: SourceSpec['mode']
	entityId: EntityId
	request: SourceSpec['request']
	auth?: SourceSpec['auth']
	mapping: SourceSpec['mapping']
	limits: SourceSpec['limits']
	triggers: SourceSpec['triggers']
	inputField?: FieldId
	collection?: SourceSpec['collection']
	refine?: boolean
	declaredAt?: string
}): SourceSpec {
	return {
		id: input.id,
		key: input.key,
		description: input.description,
		mode: input.mode,
		entityId: input.entityId,
		request: input.request,
		auth: input.auth ?? { kind: 'none' },
		mapping: input.mapping,
		limits: input.limits,
		triggers: input.triggers,
		...(input.inputField ? { inputField: input.inputField } : {}),
		...(input.collection ? { collection: input.collection } : {}),
		...(input.refine ? { refine: true } : {}),
		declaredAt: (input.declaredAt ?? '2026-07-28') as SourceSpec['declaredAt'],
		provenance: manual(),
	}
}

/**
 * `sources.declare` — an external endpoint, mapped onto entity fields
 * (spec op, weight 1).
 */
export function declareSource(
	id: string,
	description: string,
	declared: SourceSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'sources.declare', args: { source: declared } },
	}
}

/**
 * `search.declare` — a ranked full-text index over one entity's fields, with
 * per-field weighting (spec op, weight 1).
 *
 * `indexed` is required here exactly as it is in the op, and not defaulted to
 * `true` by the helper: a example that never states the write cost is a
 * example that would score identically whether or not the platform made the
 * cost declarable, which is the half of this primitive an operator cares about.
 */
export function declareSearchIndex(
	id: string,
	description: string,
	index: SearchIndexSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'search.declare', args: { index } },
	}
}

/** A declared search index, with provenance and `declaredAt` filled in. */
export function searchIndex(input: {
	id: SearchIndexId
	key: string
	description: string
	entityId: EntityId
	language: SearchIndexSpec['language']
	fields: SearchIndexSpec['fields']
	indexed: boolean
	declaredAt?: string
}): SearchIndexSpec {
	return {
		id: input.id,
		key: input.key,
		description: input.description,
		entityId: input.entityId,
		language: input.language,
		fields: input.fields,
		indexed: input.indexed,
		declaredAt: (input.declaredAt ??
			'2026-07-28') as SearchIndexSpec['declaredAt'],
		provenance: manual(),
	}
}

/**
 * `documents.declare` — a print-ready document template bound to one entity
 * (spec op, weight 1).
 *
 * `delivery` is required here exactly as it is in the op, and not defaulted by
 * the helper: a example that never states where the document goes would score
 * identically whether or not the platform made delivery declarable, and delivery
 * is the half that composes the storage and email bundles.
 */
export function declareDocument(
	id: string,
	description: string,
	template: DocumentTemplateSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'documents.declare', args: { template } },
	}
}

/** A declared document template, with provenance and `declaredAt` filled in. */
export function documentTemplate(input: {
	id: DocumentTemplateId
	key: string
	description: string
	entityId: EntityId
	pageSize: DocumentTemplateSpec['pageSize']
	sections: DocumentTemplateSpec['sections']
	delivery: DocumentTemplateSpec['delivery']
	declaredAt?: string
}): DocumentTemplateSpec {
	return {
		id: input.id,
		key: input.key,
		description: input.description,
		entityId: input.entityId,
		pageSize: input.pageSize,
		sections: input.sections,
		delivery: input.delivery,
		declaredAt: (input.declaredAt ??
			'2026-07-28') as DocumentTemplateSpec['declaredAt'],
		provenance: manual(),
	}
}

/**
 * A declared importer for a example spec.
 *
 * `upsertFieldId` and `paused` are required here exactly as they are in the op,
 * and neither is defaulted by the helper. That is the point rather than
 * pedantry: a example that never states its write posture would score
 * identically whether or not the platform made overwriting a declared,
 * reviewable decision — and that decision is the half of this primitive that
 * matters.
 */
export function importer(input: {
	id: ImporterId
	key: string
	description: string
	entityId: EntityId
	format: ImporterSpec['format']
	parserSlot?: string
	columns: ImporterSpec['columns']
	upsertFieldId: FieldId | null
	maxRows: number
	paused: boolean
	declaredAt?: string
}): ImporterSpec {
	return {
		id: input.id,
		key: input.key,
		description: input.description,
		entityId: input.entityId,
		format: input.format,
		...(input.parserSlot ? { parserSlot: input.parserSlot } : {}),
		columns: input.columns,
		upsertFieldId: input.upsertFieldId,
		maxRows: input.maxRows,
		paused: input.paused,
		declaredAt: (input.declaredAt ??
			'2026-07-28') as ImporterSpec['declaredAt'],
		provenance: manual(),
	}
}

/**
 * `imports.declare` — a file format, a column mapping and an explicit upsert
 * key (spec op, weight 1).
 */
export function declareImporter(
	id: string,
	description: string,
	declared: ImporterSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'imports.declare', args: { importer: declared } },
	}
}

/**
 * A declared portal for a example spec.
 *
 * Nothing is defaulted, and here that is not a style choice: `audience`,
 * `readFields`, `writes` and `paused` are each a decision about who can see
 * somebody's data, and a helper that filled any of them in would let a example
 * score a public surface it never actually described.
 */
export function portal(input: {
	id: PortalId
	key: string
	description: string
	entityId: EntityId
	audience: PortalSpec['audience']
	role?: string
	token?: PortalSpec['token']
	scope: PortalSpec['scope']
	readFields: FieldId[]
	filter?: PortalSpec['filter']
	writes: PortalSpec['writes']
	layout: PortalSpec['layout']
	paused: boolean
	declaredAt?: string
}): PortalSpec {
	return {
		id: input.id,
		key: input.key,
		description: input.description,
		entityId: input.entityId,
		audience: input.audience,
		...(input.role ? { role: input.role } : {}),
		...(input.token ? { token: input.token } : {}),
		scope: input.scope,
		readFields: input.readFields,
		...(input.filter ? { filter: input.filter } : {}),
		writes: input.writes,
		layout: input.layout,
		paused: input.paused,
		declaredAt: (input.declaredAt ?? '2026-07-29') as PortalSpec['declaredAt'],
		provenance: manual(),
	}
}

/**
 * `portals.declare` — a public, token-scoped or role-scoped surface over one
 * entity (spec op, weight 1).
 */
export function declarePortal(
	id: string,
	description: string,
	declared: PortalSpec,
): ExampleChange {
	return {
		id,
		description,
		kind: 'spec-op',
		via: 'apply-op',
		op: { op: 'portals.declare', args: { portal: declared } },
	}
}

/**
 * A user edit absorbed by an **import parser** slot (slot fill, weight 3;
 * issue #175) — the seam a `format: 'custom'` importer opens for a file the
 * platform genuinely cannot read.
 *
 * Its own constructor rather than a `fillSlot` with a prefixed name, for
 * {@link fillSourceRefiner}'s reason: the seam should be legible in a backlog.
 * `resource` is still carried because the change set's ordering rules are keyed
 * on it.
 */
/**
 * A declared live channel for a example spec.
 *
 * Nothing is defaulted, and here that is not a style choice: `maxSubscribers`,
 * `maxMessagesPerMinute`, `scope`, `slot` and `paused` are each a decision about
 * what the running app does to itself while people are watching, and a helper
 * that filled any of them in would let a example score a live surface whose
 * cost it never actually described — which is the half of this primitive an
 * operator cares about.
 */
export function live(input: {
	id: LiveId
	key: string
	description: string
	entityId: EntityId
	kind: LiveSubscriptionSpec['kind']
	fields: FieldId[]
	scope: LiveSubscriptionSpec['scope']
	maxSubscribers: number
	maxMessagesPerMinute: number
	presenceTtlSeconds?: number
	maxPresent?: number
	slot: boolean
	paused: boolean
	declaredAt?: string
}): LiveSubscriptionSpec {
	return {
		id: input.id,
		key: input.key,
		description: input.description,
		entityId: input.entityId,
		kind: input.kind,
		fields: input.fields,
		scope: input.scope,
		maxSubscribers: input.maxSubscribers,
		maxMessagesPerMinute: input.maxMessagesPerMinute,
		...(input.presenceTtlSeconds !== undefined
			? { presenceTtlSeconds: input.presenceTtlSeconds }
			: {}),
		...(input.maxPresent !== undefined ? { maxPresent: input.maxPresent } : {}),
		slot: input.slot,
		paused: input.paused,
		declaredAt: (input.declaredAt ??
			'2026-07-29') as LiveSubscriptionSpec['declaredAt'],
		provenance: manual(),
	}
}

/**
 * A user edit absorbed by a **bespoke live surface** slot (slot fill, weight 3;
 * issue #179) — the seam a `slot: true` channel opens for a surface a derived
 * list definitionally is not.
 *
 * Its own constructor rather than a `fillSlot` with a prefixed name, for
 * {@link fillSourceRefiner}'s reason: the seam should be legible in a backlog.
 * `resource` is still carried because the change set's ordering rules are keyed
 * on it.
 */
export function fillLiveSlot(
	id: string,
	description: string,
	resource: string,
	liveKey: string,
	body: string,
): ExampleChange {
	return {
		id,
		description,
		kind: 'slot-fill',
		resource,
		slot: `live:${liveKey}`,
		body,
	}
}

export function fillImportParser(
	id: string,
	description: string,
	resource: string,
	importerKey: string,
	body: string,
): ExampleChange {
	return {
		id,
		description,
		kind: 'slot-fill',
		resource,
		slot: `import:${importerKey}`,
		body,
	}
}

/**
 * A user edit absorbed by a **source refiner** slot (slot fill, weight 3;
 * issue #173) — the seam a `refine: true` source opens for the part of an
 * integration a response path cannot express.
 *
 * Its own constructor rather than a `fillSlot` with a prefixed name so the seam
 * is legible in a backlog; `resource` is still carried because the change set's
 * ordering rules are keyed on it.
 */
export function fillSourceRefiner(
	id: string,
	description: string,
	resource: string,
	sourceKey: string,
	body: string,
): ExampleChange {
	return {
		id,
		description,
		kind: 'slot-fill',
		resource,
		slot: `source:${sourceKey}`,
		body,
	}
}
