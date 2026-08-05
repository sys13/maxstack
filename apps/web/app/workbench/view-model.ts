/**
 * Workbench view-model — the pure fold from a {@link SpecSystem} into the three
 * review-first panes.
 *
 * Phase 5 is entered under a hedge: the design decision #11 (is the workbench a
 * product, or is the agent the interface?) is not yet resolved — it closes on
 * the Phase 2.5 dogfood (docs/history/workbench-sufficiency-test.md). So this slice
 * builds *only* the intersection of both outcomes: the review-queue / spec-zoom
 * / decision surface that the plan says the workbench "shrinks to" even if H₀
 * (agent-is-sufficient) holds. No three-pane canvas on spec, no interaction
 * research instrument — just the provenance-driven review surface, which is the
 * platform's "review is a first-class activity, not just generation" thesis
 * (§1) made visible.
 *
 * Everything here is a *pure* function of the spec so it is unit-testable
 * without a browser or a store — the route layer only loads the spec, calls
 * these, and renders. Accept/reject drives {@link accept}/{@link reject} from
 * the provenance module (settled transitions, §0 rule 2) rather than inventing
 * a new spec-op: provenance decisions are distinct from structural spec-ops.
 */

import {
	type ApplyMeta,
	applyOp,
	type DecisionLedger,
	deriveProvenanceState,
	effectiveDecisions,
	flagGates,
	type LedgerEntry,
	type Provenance,
	type ProvenanceState,
	type ReviewTarget,
	type ReviewTargetKind,
	type SpecSystem,
} from '@maxstack/spec'

/**
 * One entry in a target's per-node audit trail — structurally a
 * `@maxstack/ui` `HistoryEntry` (kept as a local type so this package stays
 * UI-library free; `<History>` accepts it unchanged).
 */
export interface TargetHistoryEntry {
	userId: string
	action: string
	resourceId?: string
	metadata?: Record<string, unknown>
	createdAt: string
}

// ===========================================================================
// Locators — how a review action names a provenanced entity across layers
// ===========================================================================

/** The provenanced entity kinds the review queue can act on. */
export type ReviewKind = ReviewTargetKind

/**
 * A stable locator for one provenanced entity anywhere in the spec — the spec
 * package's {@link ReviewTarget}, which is also what the `provenance.review`
 * op takes, so a queue row's hidden inputs are exactly the op's target.
 */
export type ReviewRef = ReviewTarget

/** A row in the review queue / spec tree — a locator plus its display facts. */
export interface ReviewItem extends ReviewRef {
	/** Layer for grouping/badging: data | page | pricing. */
	layer: 'data' | 'page' | 'pricing' | 'flags'
	/** Human label (entity/page/tier name, field name, block type). */
	label: string
	/** The accepted or suggested prose, whichever the state implies. */
	description: string | null
	state: ProvenanceState
	priority: Provenance['priority']
}

// ===========================================================================
// Walk the spec → a flat list of every provenanced entity
// ===========================================================================

/**
 * Every provenanced row in the system, in a stable layer-then-declaration
 * order. The single traversal both the queue and the tree fold over, so they
 * can never disagree about what exists.
 */
export function collectReviewItems(spec: SpecSystem): ReviewItem[] {
	const items: ReviewItem[] = []

	for (const entity of spec.data.entities) {
		items.push({
			kind: 'entity',
			id: entity.id,
			layer: 'data',
			label: entity.name,
			description: describe(entity.provenance, entity.description ?? null),
			state: deriveProvenanceState(entity.provenance),
			priority: entity.provenance.priority,
		})
		for (const field of entity.fields)
			items.push({
				kind: 'field',
				id: field.id,
				parentId: entity.id,
				layer: 'data',
				label: `${field.name}: ${field.type}${field.required ? '' : '?'}`,
				description: describe(field.provenance, null),
				state: deriveProvenanceState(field.provenance),
				priority: field.provenance.priority,
			})
	}

	for (const page of spec.pages.pages) {
		items.push({
			kind: 'page',
			id: page.id,
			layer: 'page',
			label: `${page.name} (${page.route})`,
			description: describe(page.provenance, null),
			state: deriveProvenanceState(page.provenance),
			priority: page.provenance.priority,
		})
		for (const block of page.blocks)
			items.push({
				kind: 'block',
				id: block.id,
				parentId: page.id,
				layer: 'page',
				label: block.type,
				description: describe(block.provenance, null),
				state: deriveProvenanceState(block.provenance),
				priority: block.provenance.priority,
			})
	}

	// Flags are provenanced rows like everything else, so a declared flag is
	// reviewable and countable rather than a thing only the spec file knows
	//. The label carries the gate count because "what does this
	// gate?" is the question a reviewer actually has.
	for (const flag of spec.flags?.flags ?? []) {
		const gates = flagGates(spec, flag.key).length
		items.push({
			kind: 'flag',
			id: flag.id,
			layer: 'flags',
			label: `${flag.key} — ${flag.default ? 'on' : 'off'} by default, gates ${gates} surface${gates === 1 ? '' : 's'}`,
			description: describe(flag.provenance, flag.description),
			state: deriveProvenanceState(flag.provenance),
			priority: flag.provenance.priority,
		})
	}

	for (const tier of spec.pricing.tiers)
		items.push({
			kind: 'tier',
			id: tier.id,
			layer: 'pricing',
			label: `${tier.name} ($${tier.priceMonthly}/mo)`,
			description: describe(tier.provenance, tier.features.join(', ') || null),
			state: deriveProvenanceState(tier.provenance),
			priority: tier.provenance.priority,
		})

	return items
}

/** Prefer the accepted prose; fall back to the AI draft while undecided. */
function describe(p: Provenance, accepted: string | null): string | null {
	if (accepted) return accepted
	return p.suggestedDescription
}

// ===========================================================================
// The three panes
// ===========================================================================

export interface ProvenanceCounts {
	suggested: number
	accepted: number
	rejected: number
	manual: number
	total: number
}

/** A layer node in the spec-zoom tree, with per-layer provenance counts. */
export interface SpecTreeLayer {
	layer: 'product' | 'data' | 'page' | 'pricing' | 'flags'
	label: string
	counts: ProvenanceCounts
	/** Top-level items (entities / pages / tiers); product carries a summary row. */
	items: SpecTreeNode[]
}

export interface SpecTreeNode extends ReviewItem {
	children: ReviewItem[]
}

export interface DecisionPane {
	pending: LedgerEntry[]
	resolved: LedgerEntry[]
}

/**
 * A row in the review inbox: one top-level node (entity / page / tier) that
 * folds its still-undecided nested rows (fields / blocks) into a single
 * decision. The maintainer accepts a *shape*, not every column — the buttons
 * submit with cascade, and drill-in (spec zoom) keeps per-field control for
 * the rare case that needs it.
 */
export interface QueueRow extends ReviewItem {
	/** Undecided nested rows this row's decision also covers (via cascade). */
	pendingChildren: ReviewItem[]
}

export interface WorkbenchView {
	/** Undecided suggestions, highest priority first — the maintainer's inbox. */
	queue: QueueRow[]
	tree: SpecTreeLayer[]
	decisions: DecisionPane
	counts: ProvenanceCounts
}

/** The one entry point the route calls: fold a spec into all three panes. */
export function buildWorkbench(spec: SpecSystem): WorkbenchView {
	const items = collectReviewItems(spec)
	return {
		queue: buildQueue(items),
		tree: buildTree(spec, items),
		decisions: buildDecisions(spec.ledger),
		counts: countStates(items),
	}
}

/**
 * The review inbox, grouped at the altitude a human decides at: one row per
 * top-level node (entity / page / tier), folding its undecided fields/blocks
 * into the same decision (per-field accept/reject was too fine for routine
 * review). A row appears when the node itself is undecided OR it has undecided
 * nested rows (e.g. a new field suggested on an already-accepted entity). High
 * priority rises, ties keep declaration order (stable). Settled and manual
 * rows never enter the queue.
 */
export function buildQueue(items: ReviewItem[]): QueueRow[] {
	return items
		.filter((i) => i.parentId === undefined)
		.map((item) => ({
			...item,
			pendingChildren: items.filter(
				(c) => c.parentId === item.id && c.state === 'suggested',
			),
		}))
		.filter((r) => r.state === 'suggested' || r.pendingChildren.length > 0)
		.map((item, index) => ({ item, index }))
		.sort(
			(a, b) =>
				priorityRank(b.item) - priorityRank(a.item) || a.index - b.index,
		)
		.map(({ item }) => item)
}

function priorityRank(row: QueueRow): number {
	return row.priority === 'high' ||
		row.pendingChildren.some((c) => c.priority === 'high')
		? 1
		: 0
}

function buildTree(spec: SpecSystem, items: ReviewItem[]): SpecTreeLayer[] {
	const top = (kind: ReviewKind) => items.filter((i) => i.kind === kind)
	const childrenOf = (parentId: string, kind: ReviewKind) =>
		items.filter((i) => i.kind === kind && i.parentId === parentId)

	const dataItems = top('entity').map((e) => ({
		...e,
		children: childrenOf(e.id, 'field'),
	}))
	const pageItems = top('page').map((p) => ({
		...p,
		children: childrenOf(p.id, 'block'),
	}))
	const tierItems = top('tier').map((t) => ({ ...t, children: [] }))
	const flagItems = top('flag').map((f) => ({ ...f, children: [] }))

	return [
		{
			layer: 'product',
			label: spec.product.meta.title,
			counts: emptyCounts(),
			items: [],
		},
		{
			layer: 'data',
			label: 'Data',
			counts: countStates(items.filter((i) => i.layer === 'data')),
			items: dataItems,
		},
		{
			layer: 'page',
			label: 'Pages',
			counts: countStates(items.filter((i) => i.layer === 'page')),
			items: pageItems,
		},
		{
			layer: 'pricing',
			label: 'Pricing',
			counts: countStates(items.filter((i) => i.layer === 'pricing')),
			items: tierItems,
		},
		{
			layer: 'flags',
			label: 'Flags',
			counts: countStates(items.filter((i) => i.layer === 'flags')),
			items: flagItems,
		},
	]
}

function buildDecisions(ledger: DecisionLedger): DecisionPane {
	const effective = effectiveDecisions(ledger)
	return {
		pending: effective.filter((d) => d.status === 'pending'),
		resolved: effective.filter((d) => d.status === 'resolved'),
	}
}

// ===========================================================================
// Counts
// ===========================================================================

function emptyCounts(): ProvenanceCounts {
	return { suggested: 0, accepted: 0, rejected: 0, manual: 0, total: 0 }
}

export function countStates(items: ReviewItem[]): ProvenanceCounts {
	const counts = emptyCounts()
	for (const item of items) {
		counts[item.state]++
		counts.total++
	}
	return counts
}

// ===========================================================================
// Spec zoom — focus one node, see its detail and where it reaches
// ===========================================================================

/** A labelled fact row in the detail pane (field, block, feature, link…). */
export interface DetailRow {
	label: string
	state?: ProvenanceState
	sub?: string
	/** When set, this row is individually reviewable (the per-field drill-in). */
	ref?: ReviewRef
}

/**
 * The focused-node detail: the altitude the maintainer zoomed to. `derivedPages`
 * / `acceptanceCriteria` are the cross-layer links (§3-L1) — an entity knows the
 * pages built from it; a page carries the acceptance criteria (`e2eTests`) that
 * are its contract and the entity it renders. `canPreview` says the live-preview
 * pane can run the code generator for this node (only pages emit app code).
 */
export interface FocusDetail {
	kind: ReviewKind
	id: string
	title: string
	state: ProvenanceState
	subtitle?: string
	rows: DetailRow[]
	/** For an entity: the pages derived from it (the spec→UI link). */
	derivedPages: DetailRow[]
	/** For a page: the natural-language acceptance criteria (the oracle). */
	acceptanceCriteria: string[]
	/** The page id the live preview can generate code for (page focus only). */
	previewPageId?: string
}

/**
 * Build the detail for a focused top-level node (entity / page / tier). Returns
 * `null` for an unknown id (a stale focus link renders the queue instead of
 * throwing — a read is softer than a write).
 */
export function buildDetail(
	spec: SpecSystem,
	focusId: string | null | undefined,
): FocusDetail | null {
	if (!focusId) return null

	const entity = spec.data.entities.find((e) => e.id === focusId)
	if (entity) {
		return {
			kind: 'entity',
			id: entity.id,
			title: entity.name,
			state: deriveProvenanceState(entity.provenance),
			subtitle: entity.description,
			rows: entity.fields.map((f) => ({
				label: `${f.name}: ${f.type}${f.required ? '' : '?'}`,
				state: deriveProvenanceState(f.provenance),
				ref: { kind: 'field' as const, id: f.id, parentId: entity.id },
			})),
			derivedPages: spec.pages.pages
				.filter((p) => p.entityId === entity.id)
				.map((p) => ({
					label: `${p.name} (${p.route})`,
					state: deriveProvenanceState(p.provenance),
				})),
			acceptanceCriteria: [],
		}
	}

	const page = spec.pages.pages.find((p) => p.id === focusId)
	if (page) {
		const entityName = page.entityId
			? spec.data.entities.find((e) => e.id === page.entityId)?.name
			: undefined
		return {
			kind: 'page',
			id: page.id,
			title: page.name,
			state: deriveProvenanceState(page.provenance),
			subtitle: page.route,
			rows: [
				...(page.entityId
					? [{ label: `renders entity: ${entityName ?? page.entityId}` }]
					: []),
				...page.blocks.map((b) => ({
					label: `block: ${b.type}`,
					state: deriveProvenanceState(b.provenance),
					ref: { kind: 'block' as const, id: b.id, parentId: page.id },
				})),
			],
			derivedPages: [],
			acceptanceCriteria: page.e2eTests ?? [],
			previewPageId: page.id,
		}
	}

	const tier = spec.pricing.tiers.find((t) => t.id === focusId)
	if (tier) {
		return {
			kind: 'tier',
			id: tier.id,
			title: tier.name,
			state: deriveProvenanceState(tier.provenance),
			subtitle: `$${tier.priceMonthly}/mo`,
			rows: tier.features.map((f) => ({ label: f })),
			derivedPages: [],
			acceptanceCriteria: [],
		}
	}

	return null
}

/**
 * The focused node's per-target audit trail — every op in `spec.opLog` whose
 * diff names this id as its target OR its parent (so an entity's history also
 * shows its fields' accepts), most-recent first. Pure fold over the op log
 * (the free win from #12: the workbench gets `<History>` today only on
 * `/admin`, and here it's the review trail behind every accept/reject, not
 * just record CRUD).
 */
export function buildTargetHistory(
	spec: SpecSystem,
	focusId: string | null | undefined,
): TargetHistoryEntry[] {
	if (!focusId) return []
	return spec.opLog
		.filter(
			(op) => op.diff.targetId === focusId || op.diff.parentId === focusId,
		)
		.map((op) => ({
			userId: op.origin,
			action: op.diff.summary,
			resourceId: op.diff.targetId,
			metadata: { op: op.diff.op, change: op.diff.change },
			createdAt: op.appliedAt,
		}))
		.reverse()
}

// ===========================================================================
// Review actions — accept / reject a suggestion, immutably
// ===========================================================================

export type ReviewAction = 'accept' | 'reject'

/**
 * Apply a review decision to one provenanced entity, returning a NEW system
 * (immutably, same discipline as every spec-op — because it IS one now). The
 * decision goes through the `provenance.review` op, so beyond the settled
 * accept/reject provenance transition it also lands in the spec's op log as a
 * recorded, diffable **audit entry** (who decided what, when) — the full audit
 * trail the workbench doc deferred, landed.
 *
 * With `cascade` (what the queue's grouped rows submit) the decision also
 * covers the target's still-undecided nested rows — see the op's contract:
 * a cascade only ever touches `suggested` rows, never settled or manual ones.
 *
 * Throws if the ref resolves to nothing (op validation), so a stale UID from a
 * concurrently regenerated spec fails loudly instead of silently no-op'ing.
 */
export function applyReviewAction(
	spec: SpecSystem,
	ref: ReviewRef,
	action: ReviewAction,
	meta: ApplyMeta,
	cascade = false,
): SpecSystem {
	return applyOp(
		spec,
		{ op: 'provenance.review', args: { target: ref, action, cascade } },
		meta,
	)
}
