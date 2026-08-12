/**
 * The on-disk codec for a {@link SpecSystem} — the split-and-compact form the
 * disk store reads and writes.
 *
 * A real `spec.json` grew "way too long" for two structural reasons, both of
 * which this module removes at the serialization boundary (the in-memory
 * `SpecSystem` is never changed):
 *
 *   1. **Provenance boilerplate.** Every row carried the full 5-key
 *      {@link Provenance} object. Here each is compacted to a one-letter code
 *      (or omitted when it's the `manual()` default) via {@link encodeProvenance}.
 *   2. **The op log re-inlined everything.** Every `add` op stored a verbatim
 *      copy of the entity/page it added — a second copy of state that the app
 *      never replays (state is the source of truth; the log is an audit trail).
 *      Here those redundant payloads are dropped and reconstructed from state on
 *      load ({@link reconstructAddOp}); only the small, non-redundant ops keep
 *      their `op` inline.
 *
 * On top of that the document is **split by layer** into a directory of files —
 * `product.json`, `data.json`, `pages.json`, `pricing.json`, `ledger.json`,
 * `oplog.jsonl`, plus a tiny `meta.json` (format version + the `autoAccept`
 * policy). This module is pure: it encodes to / decodes from a filename→contents
 * map; `spec-store.ts` (the Node side) does the actual directory IO.
 */

import { minimalPRD } from '../prd/minimal.ts'
import type { PRD } from '../prd/prd.types.ts'
import type { OpActor } from './actor.ts'
import type { DecisionLedger } from './decision-ledger.ts'
import type { DocumentsSpec, DocumentTemplateSpec } from './documents.ts'
import type { FlagSpec, FlagsSpec } from './flags.ts'
import type { ImporterSpec, ImportsSpec } from './imports.ts'
import type { LiveSpec, LiveSubscriptionSpec } from './live.ts'
import type { PortalSpec, PortalsSpec } from './portals.ts'
import {
	decodeProvenance,
	type EncodedProvenance,
	encodeProvenance,
	type Provenanced,
} from './provenance.ts'
import type { ScheduleSpec, SchedulesSpec } from './schedules.ts'
import type { SearchIndexSpec, SearchSpec } from './search.ts'
import type { SourceSpec, SourcesSpec } from './sources.ts'
import type { AppliedOp, MoscowBucket, SpecDiff, SpecOp } from './spec-ops.ts'
import type {
	BlockSpec,
	ComputedFieldSpec,
	DataSpec,
	EntitySpec,
	FieldSpec,
	PageSpec,
	PagesSpec,
	PricingSpec,
	PricingTier,
	RollupSpec,
	SpecSystem,
} from './spec-system.ts'
import type { ActionSpec, ViewSpec } from './view.ts'

/**
 * The on-disk format version. v1 is the original single monolithic `spec.json`
 * (no compaction); v2 is this split + compacted directory form.
 */
export const SPEC_FORMAT_VERSION = 2

/** The files that make up a spec directory, in a stable order (`meta.json`
 * carries the format version + policy and is written LAST by the store, so its
 * presence signals a complete directory). */
export const SPEC_DIR_FILES = {
	meta: 'meta.json',
	product: 'product.json',
	data: 'data.json',
	pages: 'pages.json',
	pricing: 'pricing.json',
	ledger: 'ledger.json',
	oplog: 'oplog.jsonl',
	/** Written only once a `theme.set` has landed; absent = zinc default. */
	theme: 'theme.json',
	/** Written only once a flag has been declared; absent = no flags. */
	flags: 'flags.json',
	/** Written only once a schedule has been declared; absent = none. */
	schedules: 'schedules.json',
	/** Written only once an external source has been declared; absent = none. */
	sources: 'sources.json',
	/** Written only once a search index has been declared; absent = none. */
	search: 'search.json',
	/** Written only once a document template has been declared; absent = none. */
	documents: 'documents.json',
	/** Written only once an importer has been declared; absent = none. */
	imports: 'imports.json',
	/**
	 * Written only once a portal has been declared; absent = none.
	 *
	 * The absence is load-bearing rather than tidy: a spec dir with no
	 * `portals.json` has no outside at all, so every project that predates this
	 * layer reads as fully private without anybody having to write that down.
	 */
	portals: 'portals.json',
	/**
	 * Written only once a live subscription has been declared; absent = none
	 *.
	 *
	 * The absence is load-bearing on `portals.json`'s terms: a spec dir with no
	 * `live.json` holds no connection open, so every project that predates this
	 * layer reads as fully snapshot-based without anybody having to write that
	 * down — and, more usefully, without any of them growing a background
	 * fan-out table they never asked for.
	 */
	live: 'live.json',
	/**
	 * Written only once a list action has been declared; absent = none.
	 *
	 * The absence is load-bearing on `portals.json`'s terms rather than
	 * `theme.json`'s: a spec dir with no `view.json` has no way to change a row
	 * except through its form, one at a time. So every project that predates this
	 * layer reads as having no bulk write path at all without anybody having to
	 * write that down — which is the correct default, because the alternative is
	 * a button somebody never reviewed sitting above a list.
	 */
	view: 'view.json',
	/**
	 * Written only once a `site.set` has landed; absent = no public identity.
	 *
	 * The absence is load-bearing on `portals.json`'s terms rather than
	 * `theme.json`'s: a spec dir with no `site.json` has no canonical, no OG card
	 * and no sitemap, and every route it derives emits `noindex`. So every
	 * project that predates this layer reads as claiming no public identity
	 * without anybody having to write that down — which is the correct default,
	 * because the alternative is a guessed domain appearing in a canonical tag on
	 * every page.
	 */
	site: 'site.json',
} as const

/**
 * The spec-dir files that may legitimately be absent, and what an absence means.
 *
 * This list is load-bearing in two places that are easy to update separately and
 * catastrophic to get out of step — `readSpecDir` (where a missed entry makes the
 * ENOENT escape as "this is not a spec directory", so **every project on disk
 * reads as having no spec at all**) and `writeSpecDir` (where a missed entry
 * materializes an empty file and quietly breaks the absence-means-default rule).
 * Issue #187 shipped that bug by adding `flags.json` to one and not the other.
 * It is a constant here so a new optional layer file cannot repeat it.
 *
 * `oplog.jsonl` is in the list because an empty op log is a legitimate state;
 * it decodes to `''` rather than being skipped.
 */
export const OPTIONAL_SPEC_DIR_FILES: readonly string[] = [
	SPEC_DIR_FILES.oplog,
	SPEC_DIR_FILES.theme,
	SPEC_DIR_FILES.flags,
	SPEC_DIR_FILES.schedules,
	SPEC_DIR_FILES.sources,
	SPEC_DIR_FILES.search,
	SPEC_DIR_FILES.documents,
	SPEC_DIR_FILES.imports,
	SPEC_DIR_FILES.portals,
	SPEC_DIR_FILES.live,
	SPEC_DIR_FILES.view,
	SPEC_DIR_FILES.site,
]

/** A spec directory as a filename→contents map (the codec's IO-free unit). */
export type SpecDir = Record<string, string>

interface SpecMeta {
	formatVersion: number
	autoAccept: boolean
}

// ===========================================================================
// Provenance-aware row compaction (data / page / pricing layers)
// ===========================================================================
//
// Each helper drops the `provenance` key when it compacts to nothing (the
// `manual()` default) and otherwise stores the compact code; decode fills the
// full object back in. Key order is preserved so diffs stay legible.

/** Attach an encoded provenance to a plain object, omitting it when default. */
function withEncodedProvenance<T extends object>(
	base: T,
	encoded: EncodedProvenance,
): T & { provenance?: EncodedProvenance } {
	return encoded === undefined ? base : { ...base, provenance: encoded }
}

function encodeField(field: FieldSpec): unknown {
	const { provenance, ...rest } = field
	return withEncodedProvenance(rest, encodeProvenance(provenance))
}

function decodeField(raw: Record<string, unknown>): FieldSpec {
	const { provenance, ...rest } = raw
	return {
		...(rest as Omit<FieldSpec, 'provenance'>),
		provenance: decodeProvenance(provenance as EncodedProvenance),
	}
}

/**
 * A derived value — a computed field or a rollup. Encoded exactly
 * like a stored field: the body passes through verbatim (the `expr` AST and the
 * rollup's aggregate keys are already plain JSON) and only `provenance` is
 * compacted. Without this the two derived arrays would round-trip with their
 * provenance in the full 5-key shape while every sibling used the compact
 * encoding — correct on re-read, but an inconsistent wire format that the next
 * reader of a `.maxstack` file would reasonably call a bug.
 */
function encodeDerived<T extends Provenanced>(derived: T): unknown {
	const { provenance, ...rest } = derived
	return withEncodedProvenance(rest, encodeProvenance(provenance))
}

function decodeDerived<T extends Provenanced>(raw: Record<string, unknown>): T {
	const { provenance, ...rest } = raw
	return {
		...(rest as Omit<T, 'provenance'>),
		provenance: decodeProvenance(provenance as EncodedProvenance),
	} as T
}

function encodeEntity(entity: EntitySpec): unknown {
	const { provenance, fields, computed, rollups, ...rest } = entity
	return {
		...withEncodedProvenance(rest, encodeProvenance(provenance)),
		fields: fields.map(encodeField),
		// Omitted entirely when absent, so an entity with no derived values encodes
		// byte-identically to how it did before #170 — old files stay readable and
		// re-encoding one doesn't produce a spurious diff.
		...(computed ? { computed: computed.map(encodeDerived) } : {}),
		...(rollups ? { rollups: rollups.map(encodeDerived) } : {}),
	}
}

function decodeEntity(raw: Record<string, unknown>): EntitySpec {
	const { provenance, fields, computed, rollups, ...rest } = raw
	return {
		...(rest as Omit<
			EntitySpec,
			'provenance' | 'fields' | 'computed' | 'rollups'
		>),
		provenance: decodeProvenance(provenance as EncodedProvenance),
		fields: (fields as Record<string, unknown>[]).map(decodeField),
		...(computed
			? {
					computed: (computed as Record<string, unknown>[]).map(
						decodeDerived<ComputedFieldSpec>,
					),
				}
			: {}),
		...(rollups
			? {
					rollups: (rollups as Record<string, unknown>[]).map(
						decodeDerived<RollupSpec>,
					),
				}
			: {}),
	}
}

function encodeData(data: DataSpec): unknown {
	return { entities: data.entities.map(encodeEntity) }
}

function decodeData(raw: Record<string, unknown>): DataSpec {
	return {
		entities: (raw.entities as Record<string, unknown>[]).map(decodeEntity),
	}
}

function encodeBlock(block: BlockSpec): unknown {
	const { provenance, ...rest } = block
	return withEncodedProvenance(rest, encodeProvenance(provenance))
}

function decodeBlock(raw: Record<string, unknown>): BlockSpec {
	const { provenance, ...rest } = raw
	return {
		...(rest as Omit<BlockSpec, 'provenance'>),
		provenance: decodeProvenance(provenance as EncodedProvenance),
	}
}

function encodePage(page: PageSpec): unknown {
	const { provenance, blocks, ...rest } = page
	return {
		...withEncodedProvenance(rest, encodeProvenance(provenance)),
		blocks: blocks.map(encodeBlock),
	}
}

function decodePage(raw: Record<string, unknown>): PageSpec {
	const { provenance, blocks, ...rest } = raw
	return {
		...(rest as Omit<PageSpec, 'provenance' | 'blocks'>),
		provenance: decodeProvenance(provenance as EncodedProvenance),
		blocks: (blocks as Record<string, unknown>[]).map(decodeBlock),
	}
}

function encodePages(pages: PagesSpec): unknown {
	return { pages: pages.pages.map(encodePage) }
}

function decodePages(raw: Record<string, unknown>): PagesSpec {
	return { pages: (raw.pages as Record<string, unknown>[]).map(decodePage) }
}

function encodeTier(tier: PricingTier): unknown {
	const { provenance, ...rest } = tier
	return withEncodedProvenance(rest, encodeProvenance(provenance))
}

function decodeTier(raw: Record<string, unknown>): PricingTier {
	const { provenance, ...rest } = raw
	return {
		...(rest as Omit<PricingTier, 'provenance'>),
		provenance: decodeProvenance(provenance as EncodedProvenance),
	}
}

function encodePricing(pricing: PricingSpec): unknown {
	return { tiers: pricing.tiers.map(encodeTier) }
}

function decodePricing(raw: Record<string, unknown>): PricingSpec {
	return { tiers: (raw.tiers as Record<string, unknown>[]).map(decodeTier) }
}

/**
 * Flags — provenance is compacted exactly like every other
 * provenanced row; the rest of the declaration is already plain JSON.
 */
function encodeFlags(flags: FlagsSpec): unknown {
	return { flags: flags.flags.map(encodeDerived) }
}

function decodeFlags(raw: Record<string, unknown>): FlagsSpec {
	return {
		flags: ((raw.flags ?? []) as Record<string, unknown>[]).map((f) =>
			decodeDerived<FlagSpec>(f),
		),
	}
}

/** Schedules — same rule as flags: only provenance is compacted. */
function encodeSchedules(schedules: SchedulesSpec): unknown {
	return { schedules: schedules.schedules.map(encodeDerived) }
}

function decodeSchedules(raw: Record<string, unknown>): SchedulesSpec {
	return {
		schedules: ((raw.schedules ?? []) as Record<string, unknown>[]).map((s) =>
			decodeDerived<ScheduleSpec>(s),
		),
	}
}

/** Sources — same rule again: only provenance is compacted. */
function encodeSources(sources: SourcesSpec): unknown {
	return { sources: sources.sources.map(encodeDerived) }
}

function decodeSources(raw: Record<string, unknown>): SourcesSpec {
	return {
		sources: ((raw.sources ?? []) as Record<string, unknown>[]).map((s) =>
			decodeDerived<SourceSpec>(s),
		),
	}
}

/** Search indexes — same rule again: only provenance is compacted. */
function encodeSearch(search: SearchSpec): unknown {
	return { indexes: search.indexes.map(encodeDerived) }
}

function decodeSearch(raw: Record<string, unknown>): SearchSpec {
	return {
		indexes: ((raw.indexes ?? []) as Record<string, unknown>[]).map((i) =>
			decodeDerived<SearchIndexSpec>(i),
		),
	}
}

/** Document templates — same rule again: only provenance is compacted. */
function encodeDocuments(documents: DocumentsSpec): unknown {
	return { templates: documents.templates.map(encodeDerived) }
}

function decodeDocuments(raw: Record<string, unknown>): DocumentsSpec {
	return {
		templates: ((raw.templates ?? []) as Record<string, unknown>[]).map((t) =>
			decodeDerived<DocumentTemplateSpec>(t),
		),
	}
}

/** Portals — same rule again: only provenance is compacted. The
 * declaration is otherwise written out verbatim, because this is the one layer
 * whose file a reviewer is most likely to read directly. */
function encodePortals(portals: PortalsSpec): unknown {
	return { portals: portals.portals.map(encodeDerived) }
}

function decodePortals(raw: Record<string, unknown>): PortalsSpec {
	return {
		portals: ((raw.portals ?? []) as Record<string, unknown>[]).map((p) =>
			decodeDerived<PortalSpec>(p),
		),
	}
}

/** Live subscriptions — same rule again: only provenance is
 * compacted. The bound and both ceilings are written out verbatim, because this
 * is a file somebody reads when the app is slow and they want to know what is
 * holding connections open. */
function encodeLive(live: LiveSpec): unknown {
	return { subscriptions: live.subscriptions.map(encodeDerived) }
}

function decodeLive(raw: Record<string, unknown>): LiveSpec {
	return {
		subscriptions: ((raw.subscriptions ?? []) as Record<string, unknown>[]).map(
			(s) => decodeDerived<LiveSubscriptionSpec>(s),
		),
	}
}

/** List actions — same rule again: only provenance is compacted. */
function encodeView(view: ViewSpec): unknown {
	return { actions: view.actions.map(encodeDerived) }
}

function decodeView(raw: Record<string, unknown>): ViewSpec {
	return {
		actions: ((raw.actions ?? []) as Record<string, unknown>[]).map((a) =>
			decodeDerived<ActionSpec>(a),
		),
	}
}

/** Importers — same rule again: only provenance is compacted. */
function encodeImports(imports: ImportsSpec): unknown {
	return { importers: imports.importers.map(encodeDerived) }
}

function decodeImports(raw: Record<string, unknown>): ImportsSpec {
	return {
		importers: ((raw.importers ?? []) as Record<string, unknown>[]).map((i) =>
			decodeDerived<ImporterSpec>(i),
		),
	}
}

// ===========================================================================
// Op-log slimming — drop the payloads that duplicate state
// ===========================================================================

/**
 * The `add` ops whose payload is a verbatim copy of a row that also lives in
 * state, keyed by its diff's `targetId`/`parentId`. For these the on-disk log
 * entry stores no `op` at all — {@link reconstructAddOp} rebuilds it from state
 * on load. This spans every additive layer: the data/page/pricing rows AND the
 * product-layer rows (a requirement lives in `product.requirements`, a decision
 * in `ledger`, …). Only ops whose args are NOT recoverable from final state keep
 * their `op` inline — the `set` mutations (`page.setBlockOrder`,
 * `page.setBlockVariant`, `page.setBlockFields`, `theme.set`, `flags.*`, `schedules.*`,
 * `sources.*`, `search.*`, `documents.*`, `imports.*`, `portals.*`, `live.*` —
 * earlier last-wins payloads are not
 * recoverable from final state) and `provenance.review` (accept/reject +
 * cascade can't be read back off the row).
 *
 * `flags.declare` is deliberately absent even though it is an `add`: a flag can
 * be *removed* (the one non-additive op), so the row a historical
 * declare created may no longer exist. Reconstruction would then throw on a
 * perfectly valid log. Its payload stays inline.
 */
const REDUNDANT_ADD_OPS: ReadonlySet<string> = new Set([
	'prd.addRequirement',
	'prd.addScopeItem',
	'prd.addRisk',
	'prd.addMetric',
	'prd.recordDecision',
	'data.addEntity',
	'data.addField',
	'page.addPage',
	'page.addBlock',
	'pricing.addTier',
])

/** The slim on-disk shape of one applied op. `op` is present only for the
 * non-redundant ops; the redundant `add` ops carry just their diff. */
interface EncodedAppliedOp {
	id: string
	origin: 'ai' | 'human'
	appliedAt: string
	diff: SpecDiff
	op?: SpecOp
	/**
	 * The attribution record, written verbatim.
	 *
	 * Deliberately *not* compacted the way `provenance` is. The provenance codec
	 * pays for itself because five known columns repeat on every one of hundreds
	 * of rows; an actor is a handful of short optional keys on op-log entries
	 * only, so a code table would buy a few bytes an entry and cost the one
	 * property an audit record has to have — that what is on disk is legible
	 * without a decoder. Absent on entries written before #200.
	 */
	actor?: OpActor
}

function encodeAppliedOp(applied: AppliedOp): EncodedAppliedOp {
	const base: EncodedAppliedOp = {
		id: applied.id,
		origin: applied.origin,
		appliedAt: applied.appliedAt,
		diff: applied.diff,
	}
	if (applied.actor) base.actor = applied.actor
	if (REDUNDANT_ADD_OPS.has(applied.op.op)) return base
	return { ...base, op: applied.op }
}

/**
 * Rebuild a dropped `add` op from its diff and the already-decoded state. Safe
 * because every structural op is additive in v1 (no remove/rename), so the row
 * an old `add` op created is still present — located by the diff's ids. Throws
 * if it isn't (a corrupt or hand-edited log), rather than silently inventing one.
 *
 * The rebuilt payload reflects the row's CURRENT state, which may differ from
 * the op's original input: authored provenance the op omitted gets stamped, and
 * a later `provenance.review` mutates the row's provenance in place. This is by
 * design — the faithful audit record is the entry's {@link SpecDiff} (preserved
 * exactly on disk, and what every consumer reads); the reconstructed `op` is a
 * convenience pointer at the live row, never a byte-exact replay of the input.
 */
function reconstructAddOp(diff: SpecDiff, state: SpecSystem): SpecOp {
	const missing = (what: string): never => {
		throw new Error(
			`Cannot reconstruct op-log entry: ${what} for "${diff.targetId}" not found in state`,
		)
	}
	switch (diff.op) {
		case 'prd.addRequirement': {
			const requirement = state.product.requirements.find(
				(r) => r.id === diff.targetId,
			)
			if (!requirement) return missing('requirement')
			// `intoPhaseId` (when the requirement was filed into a roadmap phase) is
			// preserved as the diff's parentId.
			return {
				op: 'prd.addRequirement',
				args: diff.parentId
					? { requirement, intoPhaseId: diff.parentId }
					: { requirement },
			}
		}
		case 'prd.addScopeItem': {
			// The MoSCoW bucket is the diff's parentId; the item lives in it.
			const bucket = diff.parentId as MoscowBucket | undefined
			const item = bucket
				? state.product.scope[bucket]?.find((i) => i.id === diff.targetId)
				: undefined
			if (!bucket || !item) return missing('scope item')
			return { op: 'prd.addScopeItem', args: { bucket, item } }
		}
		case 'prd.addRisk': {
			const risk = state.product.risks.find((r) => r.id === diff.targetId)
			if (!risk) return missing('risk')
			return { op: 'prd.addRisk', args: { risk } }
		}
		case 'prd.addMetric': {
			const metric = state.product.goals.supportingMetrics.find(
				(m) => m.id === diff.targetId,
			)
			if (!metric) return missing('metric')
			return { op: 'prd.addMetric', args: { metric } }
		}
		case 'prd.recordDecision': {
			// The ledger is append-only and a decision id may be re-recorded; the
			// latest entry is the current state this convenience pointer reflects.
			const matches = state.ledger.filter((e) => e.id === diff.targetId)
			const entry = matches[matches.length - 1]
			if (!entry) return missing('ledger entry')
			return { op: 'prd.recordDecision', args: { entry } }
		}
		case 'data.addEntity': {
			const entity = state.data.entities.find((e) => e.id === diff.targetId)
			if (!entity) return missing('entity')
			return { op: 'data.addEntity', args: { entity } }
		}
		case 'data.addField': {
			const entity = state.data.entities.find((e) => e.id === diff.parentId)
			const field = entity?.fields.find((f) => f.id === diff.targetId)
			if (!entity || !field) return missing('entity/field')
			return { op: 'data.addField', args: { entityId: entity.id, field } }
		}
		case 'page.addPage': {
			const page = state.pages.pages.find((p) => p.id === diff.targetId)
			if (!page) return missing('page')
			return { op: 'page.addPage', args: { page } }
		}
		case 'page.addBlock': {
			const page = state.pages.pages.find((p) => p.id === diff.parentId)
			const block = page?.blocks.find((b) => b.id === diff.targetId)
			if (!page || !block) return missing('page/block')
			return { op: 'page.addBlock', args: { pageId: page.id, block } }
		}
		case 'pricing.addTier': {
			const tier = state.pricing.tiers.find((t) => t.id === diff.targetId)
			if (!tier) return missing('tier')
			return { op: 'pricing.addTier', args: { tier } }
		}
		default:
			throw new Error(
				`Op-log entry for "${diff.op}" is missing its inline op (only redundant add-ops may drop it)`,
			)
	}
}

function decodeAppliedOp(raw: EncodedAppliedOp, state: SpecSystem): AppliedOp {
	const op = raw.op ?? reconstructAddOp(raw.diff, state)
	const decoded: AppliedOp = {
		id: raw.id as AppliedOp['id'],
		origin: raw.origin,
		appliedAt: raw.appliedAt as AppliedOp['appliedAt'],
		diff: raw.diff,
		op,
	}
	// Left absent rather than defaulted: an entry written before #200 has no
	// attribution, and a synthesized one would be a fabricated audit record.
	if (raw.actor) decoded.actor = raw.actor
	return decoded
}

// ===========================================================================
// PRD empty-container pruning (product.json)
// ===========================================================================
//
// A real PRD is dotted with empty containers — `"shouldHave": []`,
// `"constraints": {}`, `"openQuestions": []` — pure noise on disk. We drop them
// on encode and refill on decode against a canonical PRD skeleton, so the
// in-memory PRD is ALWAYS complete (every consumer + `validatePRD`, which
// dereferences these paths directly, sees the full shape). Pruning stops at
// array boundaries (element interiors are left intact) so refill never has to
// guess an array element's shape — this trims the top-level containers, not the
// nested-in-array ones, keeping the transform simple and safe.

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Drop empty-array / empty-object properties recursively through plain objects.
 * Arrays are passed through whole (not descended). */
function pruneEmptyContainers(value: unknown): unknown {
	if (!isPlainObject(value)) return value
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value)) {
		const pv = pruneEmptyContainers(v)
		if (Array.isArray(pv) && pv.length === 0) continue
		if (isPlainObject(pv) && Object.keys(pv).length === 0) continue
		out[k] = pv
	}
	return out
}

/**
 * Restore the empty containers {@link pruneEmptyContainers} dropped, guided by a
 * reference skeleton. Preserves the pruned object's key order (so a re-encode is
 * stable) and appends only the missing containers; scalars are never injected
 * from the reference. A container the reference doesn't know about simply stays
 * absent — safe, because those are the optional (guarded) PRD fields; every
 * required container is present in the reference (it's a valid PRD).
 */
function refillEmptyContainers(pruned: unknown, reference: unknown): unknown {
	if (isPlainObject(reference)) {
		const src = isPlainObject(pruned) ? pruned : {}
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(src))
			out[k] = k in reference ? refillEmptyContainers(v, reference[k]) : v
		for (const [k, refv] of Object.entries(reference)) {
			if (k in out) continue
			if (Array.isArray(refv)) out[k] = []
			else if (isPlainObject(refv))
				out[k] = refillEmptyContainers(undefined, refv)
			// a missing scalar is an absent optional — never inject the reference's
		}
		return out
	}
	if (pruned !== undefined) return pruned
	return Array.isArray(reference) ? [] : reference
}

/** A canonical, complete PRD skeleton (all required containers present) used as
 * the refill reference. Built lazily so the module has no load-time work. */
let prdSkeletonCache: PRD | undefined
function prdSkeleton(): PRD {
	prdSkeletonCache ??= minimalPRD({
		title: 'x',
		tldr: 'x',
		problem: 'x',
		northStar: 'x',
		persona: 'x',
		differentiation: 'x',
	})
	return prdSkeletonCache
}

// ===========================================================================
// The whole system ⇄ a directory of files
// ===========================================================================

const jsonFile = (value: unknown): string =>
	`${JSON.stringify(value, null, '\t')}\n`

/** Encode a spec system into its on-disk directory (filename → contents). */
export function encodeSpecSystem(spec: SpecSystem): SpecDir {
	const meta: SpecMeta = {
		formatVersion: SPEC_FORMAT_VERSION,
		autoAccept: spec.autoAccept,
	}
	const oplog = spec.opLog
		.map((applied) => JSON.stringify(encodeAppliedOp(applied)))
		.join('\n')
	const dir: SpecDir = {
		[SPEC_DIR_FILES.meta]: jsonFile(meta),
		[SPEC_DIR_FILES.product]: jsonFile(pruneEmptyContainers(spec.product)),
		[SPEC_DIR_FILES.data]: jsonFile(encodeData(spec.data)),
		[SPEC_DIR_FILES.pages]: jsonFile(encodePages(spec.pages)),
		[SPEC_DIR_FILES.pricing]: jsonFile(encodePricing(spec.pricing)),
		[SPEC_DIR_FILES.ledger]: jsonFile(spec.ledger),
		[SPEC_DIR_FILES.oplog]: oplog ? `${oplog}\n` : '',
	}
	// theme.json exists only once a theme has been set — untouched projects grow
	// no new file, and pre-theme directories round-trip byte-identical.
	if (spec.theme !== undefined) dir[SPEC_DIR_FILES.theme] = jsonFile(spec.theme)
	// Same absence rule as theme.json: a project that has never declared a flag
	// grows no flags.json, so pre-#187 directories round-trip byte-identical.
	if (spec.flags !== undefined)
		dir[SPEC_DIR_FILES.flags] = jsonFile(encodeFlags(spec.flags))
	// Same absence rule again.
	if (spec.schedules !== undefined)
		dir[SPEC_DIR_FILES.schedules] = jsonFile(encodeSchedules(spec.schedules))
	if (spec.sources !== undefined)
		dir[SPEC_DIR_FILES.sources] = jsonFile(encodeSources(spec.sources))
	if (spec.search !== undefined)
		dir[SPEC_DIR_FILES.search] = jsonFile(encodeSearch(spec.search))
	if (spec.documents !== undefined)
		dir[SPEC_DIR_FILES.documents] = jsonFile(encodeDocuments(spec.documents))
	if (spec.imports !== undefined)
		dir[SPEC_DIR_FILES.imports] = jsonFile(encodeImports(spec.imports))
	if (spec.portals !== undefined)
		dir[SPEC_DIR_FILES.portals] = jsonFile(encodePortals(spec.portals))
	if (spec.live !== undefined)
		dir[SPEC_DIR_FILES.live] = jsonFile(encodeLive(spec.live))
	if (spec.view !== undefined)
		dir[SPEC_DIR_FILES.view] = jsonFile(encodeView(spec.view))
	// Same absence rule again, and no encoder: a site is whole-document
	// last-wins state with no provenance to compact, exactly like theme.json.
	if (spec.site !== undefined) dir[SPEC_DIR_FILES.site] = jsonFile(spec.site)
	return dir
}

/** Whether a directory map looks like a spec directory (has our `meta.json`). */
export function isSpecDir(dir: SpecDir): boolean {
	return typeof dir[SPEC_DIR_FILES.meta] === 'string'
}

const readJson = <T>(dir: SpecDir, name: string): T => {
	const raw = dir[name]
	if (raw === undefined) throw new Error(`Spec directory is missing "${name}"`)
	return JSON.parse(raw) as T
}

/** Decode a spec directory (filename → contents) back into a spec system. The
 * op log is decoded last, against the already-materialized state it references. */
export function decodeSpecSystem(dir: SpecDir): SpecSystem {
	const meta = readJson<SpecMeta>(dir, SPEC_DIR_FILES.meta)
	const state: SpecSystem = {
		product: refillEmptyContainers(
			readJson(dir, SPEC_DIR_FILES.product),
			prdSkeleton(),
		) as PRD,
		data: decodeData(readJson(dir, SPEC_DIR_FILES.data)),
		pages: decodePages(readJson(dir, SPEC_DIR_FILES.pages)),
		pricing: decodePricing(readJson(dir, SPEC_DIR_FILES.pricing)),
		ledger: readJson<DecisionLedger>(dir, SPEC_DIR_FILES.ledger),
		opLog: [],
		autoAccept: meta.autoAccept,
	}
	// Absence-tolerant: pre-#127 directories have no theme.json (still v2). An
	// empty file is treated as absent too, not as corrupt JSON.
	const themeRaw = dir[SPEC_DIR_FILES.theme]
	if (themeRaw !== undefined && themeRaw.trim().length > 0)
		state.theme = JSON.parse(themeRaw) as SpecSystem['theme']
	const flagsRaw = dir[SPEC_DIR_FILES.flags]
	if (flagsRaw !== undefined && flagsRaw.trim().length > 0)
		state.flags = decodeFlags(JSON.parse(flagsRaw) as Record<string, unknown>)
	const schedulesRaw = dir[SPEC_DIR_FILES.schedules]
	if (schedulesRaw !== undefined && schedulesRaw.trim().length > 0)
		state.schedules = decodeSchedules(
			JSON.parse(schedulesRaw) as Record<string, unknown>,
		)
	const sourcesRaw = dir[SPEC_DIR_FILES.sources]
	if (sourcesRaw !== undefined && sourcesRaw.trim().length > 0)
		state.sources = decodeSources(
			JSON.parse(sourcesRaw) as Record<string, unknown>,
		)
	const searchRaw = dir[SPEC_DIR_FILES.search]
	if (searchRaw !== undefined && searchRaw.trim().length > 0)
		state.search = decodeSearch(
			JSON.parse(searchRaw) as Record<string, unknown>,
		)
	const documentsRaw = dir[SPEC_DIR_FILES.documents]
	if (documentsRaw !== undefined && documentsRaw.trim().length > 0)
		state.documents = decodeDocuments(
			JSON.parse(documentsRaw) as Record<string, unknown>,
		)
	const importsRaw = dir[SPEC_DIR_FILES.imports]
	if (importsRaw !== undefined && importsRaw.trim().length > 0)
		state.imports = decodeImports(
			JSON.parse(importsRaw) as Record<string, unknown>,
		)
	const portalsRaw = dir[SPEC_DIR_FILES.portals]
	if (portalsRaw !== undefined && portalsRaw.trim().length > 0)
		state.portals = decodePortals(
			JSON.parse(portalsRaw) as Record<string, unknown>,
		)
	const liveRaw = dir[SPEC_DIR_FILES.live]
	if (liveRaw !== undefined && liveRaw.trim().length > 0)
		state.live = decodeLive(JSON.parse(liveRaw) as Record<string, unknown>)
	const viewRaw = dir[SPEC_DIR_FILES.view]
	if (viewRaw !== undefined && viewRaw.trim().length > 0)
		state.view = decodeView(JSON.parse(viewRaw) as Record<string, unknown>)
	const siteRaw = dir[SPEC_DIR_FILES.site]
	if (siteRaw !== undefined && siteRaw.trim().length > 0)
		state.site = JSON.parse(siteRaw) as SpecSystem['site']
	const oplogRaw = dir[SPEC_DIR_FILES.oplog] ?? ''
	state.opLog = oplogRaw
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => decodeAppliedOp(JSON.parse(line) as EncodedAppliedOp, state))
	return state
}
