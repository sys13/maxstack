/**
 * Bulk review — clearing a queue without stopping reading it.
 *
 * ## The problem this solves, stated honestly
 *
 * With real agent throughput, forty pending proposals is the normal case. If
 * clearing forty means forty individual decisions, people stop reviewing and start
 * rubber-stamping — and at that moment "the maintainer stays in charge of every
 * change" becomes a technicality rather than a guarantee, without a single line of
 * code changing. Review has to stay cheap or it stops happening.
 *
 * But a bulk accept is also the most dangerous button in the product, because it is
 * the one that makes not-looking efficient. So the model here is built around one
 * asymmetry: **make the safe majority cheap, and make the dangerous minority
 * impossible to sweep along with it.**
 *
 * ## Conservative by construction
 *
 * Risk classification defaults to `high`, not `low`. Every rule below *lowers* a
 * proposal's risk by recognising it as something understood; anything unrecognised
 * stays high and is refused a place in a bulk batch. That direction is the whole
 * design:
 *
 *   > A risk signal that under-reports is worse than no signal at all, because it
 *   > manufactures false confidence.
 *
 * A new op family, a new review target kind, a new exposure surface — each arrives
 * as `high` until somebody deliberately teaches this file why it is safe. The
 * failure mode is a reviewer being asked to look at something they did not need to,
 * which costs a few seconds. The opposite failure mode is a permission change
 * riding into production inside a batch of twenty field additions.
 *
 * ## What is deliberately NOT here
 *
 * No "accept everything" affordance, at any risk level. {@link planBulkReview}
 * takes an explicit list of targets, and a caller that wants all of them has to
 * enumerate them. A select-all that grows silently as an agent proposes more is a
 * rubber stamp with extra steps.
 */

import type { OpActor } from './actor.ts'
import type { ISODate, OpId } from './ids.ts'
import { listImporters } from './imports.ts'
import { listLiveSubscriptions } from './live.ts'
import {
	deriveProvenanceState,
	type Provenance,
	type ProvenanceState,
} from './provenance.ts'
import { listSchedules } from './schedules.ts'
import { listSources } from './sources.ts'
import {
	applyOp,
	locateReviewTarget,
	type ReviewActionName,
	type ReviewTarget,
	type ReviewTargetKind,
	reviewTargetLayer,
	type SpecOp,
} from './spec-ops.ts'
import type { SpecSystem } from './spec-system.ts'

// ===========================================================================
// Risk
// ===========================================================================

/**
 * How much attention a proposal needs.
 *
 *   `low`    understood, reversible, and touches nothing anybody outside the
 *            project can see. Safe to clear in a batch.
 *   `medium` structural and worth a glance, but not a change to who can see or do
 *            what. Allowed in a batch; surfaced with its reason.
 *   `high`   touches access, exposure, deletion, or something this file does not
 *            recognise. **Refused a place in a batch** — individual review only.
 */
export type RiskLevel = 'low' | 'medium' | 'high'

const RISK_ORDER: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 }

/** Why a proposal was classified as it was — always populated, including for
 *  `low`, so a reviewer can see the reasoning rather than trusting a badge. */
export interface RiskFinding {
	level: RiskLevel
	/** Short, specific, and written for the person deciding. */
	reason: string
}

export interface RiskAssessment {
	level: RiskLevel
	findings: RiskFinding[]
	/** Whether this proposal may be cleared as part of a batch. */
	batchable: boolean
}

/**
 * Review target kinds this file understands well enough to say something other
 * than "high" about. Everything else — including every kind added after this was
 * written — is high by default.
 *
 * `flag`, `schedule`, `source` and `portal` are absent on purpose and are not
 * oversights: a flag gates what users can see, a schedule runs unattended code on
 * a clock, a source pulls data in from outside, and a portal puts a table on the
 * public internet. None of those is something to accept twenty of without reading.
 *
 * `portal` became reviewable in #248, and it stays out of this list for free —
 * the default-high rule refuses it a batch without anybody writing a rule for it.
 * That is the asymmetry above working as designed: the new kind arrives dangerous
 * and has to be argued down, rather than arriving safe and having to be caught.
 */
const UNDERSTOOD_KINDS: readonly ReviewTargetKind[] = [
	'entity',
	'field',
	'page',
	'block',
	'tier',
]

/**
 * Field-name fragments that mean access control. Matched case-insensitively
 * against the field's *name*, which is a heuristic — and heuristics are only
 * acceptable here because they run in the conservative direction: a match forces
 * high, so a false positive costs a reviewer a look and a false negative costs
 * nothing (the field is already high unless another rule lowered it).
 */
const ACCESS_FRAGMENTS: readonly string[] = [
	'role',
	'permission',
	'scope',
	'admin',
	'owner',
	'public',
	'visib',
	'password',
	'secret',
	'token',
	'apikey',
	'api_key',
	'auth',
	'acl',
	'grant',
	'privile',
]

function looksLikeAccessControl(name: string): boolean {
	const lower = name.toLowerCase()
	return ACCESS_FRAGMENTS.some((f) => lower.includes(f))
}

/** Every entity id a declared portal exposes — the public-exposure surface. */
function publiclyExposedEntities(spec: SpecSystem): Set<string> {
	const out = new Set<string>()
	for (const portal of spec.portals?.portals ?? []) {
		out.add(portal.entityId as string)
	}
	return out
}

/** Every entity id a declared live channel pushes to subscribers. */
function liveEntities(spec: SpecSystem): Set<string> {
	const out = new Set<string>()
	for (const sub of spec.live?.subscriptions ?? []) {
		out.add(sub.entityId as string)
	}
	return out
}

/**
 * Facts about the project that raise risk but do not live in the spec, supplied by
 * the host.
 *
 * Ownership is the one #199 names and the one the spec genuinely cannot see: which
 * routes the maintainer has ejected is a fact about the ownership manifest on disk.
 * A field added to an entity whose page the maintainer *owns* is not a routine
 * column — the generated form they no longer receive will not have it, so accepting
 * it in a batch means quietly diverging their own file from the spec it came from.
 *
 * Absent means "the host could not tell us", not "nothing is owned" — so this
 * raises risk when supplied and never lowers it when omitted. That asymmetry is
 * why it is an option rather than a required argument: a caller with no filesystem
 * (the browser-side view model, a unit test) still gets a conservative answer.
 */
export interface RiskContext {
	/** Entity ids whose generated surfaces the maintainer has taken ownership of. */
	ownedEntityIds?: readonly string[]
	/** Page ids the maintainer has ejected. */
	ownedPageIds?: readonly string[]
	/**
	 * Did the caller actually **read** the ownership manifest?
	 *
	 * This exists because the obvious default is unsafe, and the first version of
	 * this file got it wrong in prose before a test caught it. Ownership facts here
	 * only ever *raise* risk — owning a surface is what makes a change to it
	 * unbatchable — so an empty `RiskContext` does not mean "conservative", it means
	 * "nothing is owned", which is the most permissive possible answer and exactly
	 * what a host reports when its manifest read just failed.
	 *
	 * So absence is treated as **unknown, therefore assume owned**: with this unset
	 * or false, every proposal that could land in a surface someone owns is refused
	 * a place in a batch. A host that genuinely knows nothing is owned says so by
	 * passing `true` with empty lists.
	 */
	ownershipKnown?: boolean
}

/**
 * Build a {@link RiskContext} from an ownership drift report's owned-file ids.
 *
 * Shared by every host that has a manifest, because the alternative was two hosts
 * doing this mapping separately — and they immediately disagreed. Driven against a
 * real project, the workbench refused a batch the CLI happily offered, for the same
 * five proposals, purely because only one of them had been taught to read the
 * manifest. A risk model that gives two answers about one project is not a risk
 * model, so the derivation lives here and both hosts call it.
 *
 * `resourceOf` is the caller's, because the *key* the manifest records
 * (`story`, `comment`) is minted by the generator, not by the spec — the host that
 * owns the generator passes the same function it used to mint them, rather than this
 * file pattern-matching ids and silently failing to match, which is the direction
 * that would *lower* risk.
 *
 * # Every seam, not only pages
 *
 * This walked the manifest and mapped `family: 'page'`, dropping the other four
 * families on the floor. So an entity that only owned *source* or *schedule* code
 * reads was classified as if nothing owned it, and could be swept into a batch.
 *
 * The gap ran in the direction the model was built to avoid, and silently: absent
 * ownership never *raises* risk, it just fails to lower the bar. Owned page code is
 * not the only owned code that breaks when a field moves underneath it — a source's
 * mapping and a schedule's job body read the same entities and break the same way.
 *
 * Two things make the other four cheaper to resolve than pages, and they are worth
 * stating because the asymmetry looks like an inconsistency:
 *
 *   - **Their key is a spec fact.** `ScheduleSpec.key`, `SourceSpec.key`,
 *     `ImporterSpec.key`, `LiveSubscriptionSpec.key` are declared, not minted by a
 *     generator, so there is nothing for a host to pass and no derivation to drift
 *     from. Only pages need `resourceOf`.
 *   - **They name their entity directly.** A source, an importer and a live
 *     subscription each carry a required `entityId`; a schedule carries an optional
 *     one. Nothing has to be inferred.
 *
 * A **registry** file (`schedules:registry`, `sources:registry`, …) is folded in as
 * the whole family, deliberately. That file enumerates and wires every declaration
 * in its seam, so owning it means every entity that seam reads is reachable from
 * code the platform will not update. It is the broadest read available and it is
 * the conservative one; the alternative is a maintainer who hand-wired all their
 * sources being offered a batch that changes what those sources read.
 */
export function riskContextFromOwnership(
	spec: SpecSystem,
	owned: readonly { id: string; family: string }[],
	resourceOf: (page: SpecSystem['pages']['pages'][number]) => string,
): RiskContext {
	const byResource = new Map(spec.pages.pages.map((p) => [resourceOf(p), p]))
	const ownedEntityIds = new Set<string>()
	const ownedPageIds = new Set<string>()

	/** Declarations of one seam, by their declared key. */
	const seams = new Map<
		string,
		readonly { key: string; entityId?: string | undefined }[]
	>([
		['schedule', listSchedules(spec)],
		['source', listSources(spec)],
		['import', listImporters(spec)],
		['live', listLiveSubscriptions(spec)],
	])

	for (const entry of owned) {
		if (entry.family === 'page') {
			// `<resource>` for the route file, `<resource>:slot` for its slot file.
			const page = byResource.get(entry.id.split(':')[0] ?? '')
			if (!page) continue
			ownedPageIds.add(page.id)
			// The entity too: a field added to it lands in a form the maintainer now
			// owns and will not receive, which is the silent divergence the rule
			// exists to catch.
			if (page.entityId) ownedEntityIds.add(page.entityId)
			continue
		}

		const declarations = seams.get(entry.family)
		if (!declarations) continue
		// `<family>:<key>`, `<family>:<key>:slot`, or `<family>s:registry`.
		const key = entry.id.slice(entry.id.indexOf(':') + 1).split(':')[0] ?? ''
		// The registry wires the whole seam, so owning it owns everything in it.
		const reached =
			key === 'registry'
				? declarations
				: declarations.filter((d) => d.key === key)
		for (const declaration of reached)
			if (declaration.entityId) ownedEntityIds.add(declaration.entityId)
	}

	return {
		ownedEntityIds: [...ownedEntityIds],
		ownedPageIds: [...ownedPageIds],
		// The manifest was read. Only a caller that got this far may claim it, which
		// is why the flag is set here rather than being the default on the type: a
		// host whose read threw has no business asserting that nothing is owned.
		ownershipKnown: true,
	}
}

/**
 * Classify one proposal.
 *
 * Reads the spec rather than only the target because risk is contextual: the same
 * `data.addField` is routine on an internal entity and a disclosure decision on one
 * a portal already publishes to the world.
 */
export function classifyReviewRisk(
	spec: SpecSystem,
	target: ReviewTarget,
	context: RiskContext = {},
): RiskAssessment {
	const findings: RiskFinding[] = []
	const row = locateReviewTarget(spec, target)

	// An unresolvable target is the most conservative case there is: we cannot say
	// anything about a row we cannot find, so we say "look at it".
	if (!row) {
		return {
			level: 'high',
			findings: [
				{
					level: 'high',
					reason: `no ${target.kind} "${target.id}" in the spec — it may have been landed or removed since the queue was derived`,
				},
			],
			batchable: false,
		}
	}

	if (!UNDERSTOOD_KINDS.includes(target.kind)) {
		findings.push({
			level: 'high',
			// A portal gets its consequence named rather than the generic sentence.
			// Accepting one is the single most consequential decision in the
			// vocabulary — it is the op that makes a table readable by anyone with
			// the URL — and "changes what runs or what users can see" understates
			// that to the point of being misleading.
			reason:
				target.kind === 'portal'
					? 'accepting this publishes an entity at a public URL, readable by anyone who has it — never a batch decision, and worth reading the audience and token policy before deciding'
					: `a ${target.kind} declaration changes what runs or what users can see — bulk review does not cover it`,
		})
	}

	const exposed = publiclyExposedEntities(spec)
	const live = liveEntities(spec)
	const owningEntity = target.kind === 'field' ? target.parentId : target.id

	if (target.kind === 'field' || target.kind === 'entity') {
		if (owningEntity && exposed.has(owningEntity)) {
			findings.push({
				level: 'high',
				reason: `"${owningEntity}" is published by a portal — anything added to it is potentially visible outside the project`,
			})
		} else if (owningEntity && live.has(owningEntity)) {
			findings.push({
				level: 'high',
				reason: `"${owningEntity}" is pushed to live subscribers — a new column reaches every connected client`,
			})
		}
	}

	if (target.kind === 'field') {
		const name = fieldName(spec, target)
		if (name && looksLikeAccessControl(name)) {
			findings.push({
				level: 'high',
				reason: `"${name}" reads as access control — who can see or do what is never a batch decision`,
			})
		}
	}

	// Ejected territory: the maintainer owns the surface this would land in, so the
	// platform will not regenerate it for them. Accepting it in a batch diverges
	// their own file from the spec it derives from, silently.
	//
	// When the caller could not read the manifest at all, every one of these lands:
	// see `RiskContext.ownershipKnown` for why unknown has to mean "assume owned"
	// rather than "nothing owned".
	const known = context.ownershipKnown === true
	const ownedEntities = new Set(context.ownedEntityIds ?? [])
	const ownedPages = new Set(context.ownedPageIds ?? [])
	if (!known) {
		findings.push({
			level: 'high',
			reason:
				'nobody could tell us which surfaces you own, so this cannot be batched — a change to a surface you own is one the platform will not update for you. Run `maxstack drift` to see whether the manifest is readable',
		})
	}
	if (known && owningEntity && ownedEntities.has(owningEntity)) {
		findings.push({
			level: 'high',
			reason: `you own the generated surface for "${owningEntity}" — the platform will not add this to it for you, so accepting it in a batch diverges your file from the spec`,
		})
	}
	const owningPage = target.kind === 'block' ? target.parentId : target.id
	if (
		known &&
		(target.kind === 'page' || target.kind === 'block') &&
		owningPage &&
		ownedPages.has(owningPage)
	) {
		findings.push({
			level: 'high',
			reason: `you have ejected "${owningPage}" — this change lands in a file the platform is not allowed to touch`,
		})
	}

	// Structural-but-understood: worth a glance, not a disclosure decision.
	if (findings.length === 0) {
		switch (target.kind) {
			case 'entity':
				findings.push({
					level: 'medium',
					reason:
						'a new entity adds a table and a REST/MCP surface for it — structural, but internal',
				})
				break
			case 'page':
				findings.push({
					level: 'medium',
					reason: 'a new page adds a route — structural, but internal',
				})
				break
			case 'tier':
				findings.push({
					level: 'medium',
					reason: 'a pricing tier is customer-facing copy and a billing shape',
				})
				break
			case 'field':
				findings.push({
					level: 'low',
					reason: 'a column on an entity nothing publishes',
				})
				break
			case 'block':
				findings.push({
					level: 'low',
					reason: 'a block arranges rows already on the page',
				})
				break
			default:
				// Unreachable given UNDERSTOOD_KINDS above, and still handled: a kind
				// added to that list without a case here must not silently become low.
				findings.push({
					level: 'high',
					reason: `no risk rule for ${target.kind} — classified high until one exists`,
				})
		}
	}

	const level = findings.reduce<RiskLevel>(
		(worst, f) => (RISK_ORDER[f.level] < RISK_ORDER[worst] ? f.level : worst),
		'low',
	)
	return { level, findings, batchable: level !== 'high' }
}

/** The declared name of a field target, for the access-control heuristic. */
function fieldName(spec: SpecSystem, target: ReviewTarget): string | null {
	const entity = spec.data.entities.find((e) => e.id === target.parentId)
	return entity?.fields.find((f) => f.id === target.id)?.name ?? null
}

// ===========================================================================
// Grouping
// ===========================================================================

/**
 * One group of proposals a reviewer can act on together. Grouped by the axes #199
 * names — kind, owning entity, author, and risk — because those are the axes along
 * which a reviewer's *attention* actually varies: twenty field additions from one
 * agent run on one entity is one thought, and the three that touch access control
 * are three.
 */
export interface BulkReviewGroup {
	/** Stable key: what the group is, so a UI can address it across reloads. */
	key: string
	label: string
	kind: ReviewTargetKind
	/** The entity/page the group's rows hang off, when they share one. */
	parentId?: string
	/** Worst risk in the group. */
	risk: RiskLevel
	/**
	 * Whether **every** member may be batched. Descriptive, not a gate: a group
	 * with one access-control field among twenty routine ones is `false` here, and
	 * offering it is still exactly right — the twenty go in one action and the one
	 * is left behind.
	 *
	 * Gating a group on this was the first shape and it was wrong: it meant a
	 * single risky field made its twenty harmless neighbours individually
	 * reviewable, which is the cost bulk review exists to remove. Use
	 * {@link BulkReviewGroup.batchableCount} to decide whether to offer the group,
	 * and each member's own `risk.batchable` to decide whether to offer the member.
	 */
	batchable: boolean
	/** How many members may be batched — the number to offer, and to show. */
	batchableCount: number
	targets: ReviewTarget[]
	assessments: RiskAssessment[]
}

/** A proposal awaiting review, with its risk. */
export interface PendingProposal {
	target: ReviewTarget
	label: string
	state: ProvenanceState
	risk: RiskAssessment
}

/**
 * Every undecided row in the spec, with its risk — the population bulk review acts
 * on. Only `suggested` rows: a settled row is not a pending proposal, and a manual
 * row was never anybody's to review.
 */
export function pendingProposals(
	spec: SpecSystem,
	context: RiskContext = {},
): PendingProposal[] {
	const out: PendingProposal[] = []
	const add = (
		target: ReviewTarget,
		label: string,
		provenance: Provenance,
	): void => {
		const state = deriveProvenanceState(provenance)
		if (state !== 'suggested') return
		out.push({
			target,
			label,
			state,
			risk: classifyReviewRisk(spec, target, context),
		})
	}

	for (const entity of spec.data.entities) {
		add({ kind: 'entity', id: entity.id }, entity.name, entity.provenance)
		for (const field of entity.fields) {
			add(
				{ kind: 'field', id: field.id, parentId: entity.id },
				`${entity.name}.${field.name}`,
				field.provenance,
			)
		}
	}
	for (const page of spec.pages.pages) {
		add({ kind: 'page', id: page.id }, page.name, page.provenance)
		for (const block of page.blocks) {
			add(
				{ kind: 'block', id: block.id, parentId: page.id },
				`${page.name} · ${block.type}`,
				block.provenance,
			)
		}
	}
	for (const tier of spec.pricing.tiers) {
		add({ kind: 'tier', id: tier.id }, tier.name, tier.provenance)
	}
	for (const flag of spec.flags?.flags ?? []) {
		add({ kind: 'flag', id: flag.id }, flag.key, flag.provenance)
	}
	for (const schedule of spec.schedules?.schedules ?? []) {
		add(
			{ kind: 'schedule', id: schedule.id },
			schedule.key,
			schedule.provenance,
		)
	}
	for (const source of spec.sources?.sources ?? []) {
		add({ kind: 'source', id: source.id }, source.key, source.provenance)
	}
	// Portals. Enumerated here and not only made *decidable* in
	// `REVIEW_TARGET_KINDS`, because a decision needs somewhere to be taken: a
	// suggested portal that never reaches the queue is unacceptable in the same
	// way one the op validator refuses is, just further along. The queue is the
	// only place a reviewer finds out it is waiting.
	//
	// Labelled with the key rather than the id — `/p/<key>` is the thing that
	// would become a URL, and it is what a reviewer needs to see to decide.
	for (const portal of spec.portals?.portals ?? []) {
		add({ kind: 'portal', id: portal.id }, portal.key, portal.provenance)
	}
	return out
}

/**
 * A review-target kind, pluralised. `${kind}s` printed "entitys" on the group
 * heading — small, but it is the heading of a list the reader is being asked to
 * approve in one click, and nothing else on the page has to look right for that
 * one to matter.
 */
function pluralKind(kind: string): string {
	return kind.endsWith('y') ? `${kind.slice(0, -1)}ies` : `${kind}s`
}

/**
 * Group pending proposals for review. Ordered worst-risk-first, so the three
 * proposals that need real attention are at the top of the list rather than
 * buried under twenty that do not — which is the difference between a queue that
 * gets read and one that gets cleared.
 */
export function groupForBulkReview(
	proposals: readonly PendingProposal[],
): BulkReviewGroup[] {
	const groups = new Map<string, BulkReviewGroup>()
	for (const p of proposals) {
		// Nested kinds group under their parent; top-level kinds group by kind. A
		// field on `e-order` and a field on `e-invoice` are two thoughts, not one.
		const parentId = p.target.parentId
		const key = parentId ? `${p.target.kind}:${parentId}` : `${p.target.kind}:*`
		const existing = groups.get(key)
		if (existing) {
			existing.targets.push(p.target)
			existing.assessments.push(p.risk)
			if (RISK_ORDER[p.risk.level] < RISK_ORDER[existing.risk]) {
				existing.risk = p.risk.level
			}
			existing.batchable = existing.batchable && p.risk.batchable
			if (p.risk.batchable) existing.batchableCount++
			continue
		}
		groups.set(key, {
			key,
			label: parentId
				? `${pluralKind(p.target.kind)} on ${parentId}`
				: pluralKind(p.target.kind),
			kind: p.target.kind,
			parentId,
			risk: p.risk.level,
			batchable: p.risk.batchable,
			batchableCount: p.risk.batchable ? 1 : 0,
			targets: [p.target],
			assessments: [p.risk],
		})
	}
	return [...groups.values()].sort(
		(a, b) =>
			RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.key.localeCompare(b.key),
	)
}

// ===========================================================================
// Planning — what a batch would do, before it does it
// ===========================================================================

/** A target a batch refused to include, and why. */
export interface BulkRefusal {
	target: ReviewTarget
	reason: string
	risk: RiskLevel
}

export interface BulkReviewPlan {
	action: ReviewActionName
	/** The batch id, stamped on every op's actor so the entries are one unit in
	 * the trail while staying per-artifact. Caller-supplied — this module
	 *  is pure and has no clock or randomness. */
	batchId: string
	/** The ops to apply, in order, one per included target. */
	ops: SpecOp[]
	/** What each included target is, with its risk — the review surface's rows. */
	included: PendingProposal[]
	/** Targets left out, each with a reason. Never silently dropped. */
	refused: BulkRefusal[]
	/** The combined structural effect, as one summary rather than N to read. */
	combined: CombinedEffect
}

/**
 * What a whole batch does *together* — the thing #199 asks for and the reason a
 * batch can be reviewed at all. N individual previews is N things to read, which
 * is the cost bulk review exists to remove.
 */
export interface CombinedEffect {
	/** Proposals the batch would settle. */
	proposals: number
	/** Per-layer counts — where in the app this batch lands. */
	byLayer: Record<string, number>
	/** Per-kind counts. */
	byKind: Partial<Record<ReviewTargetKind, number>>
	/** Entities and pages the batch touches, by id — the blast radius. */
	touches: string[]
	/** Worst risk included. */
	risk: RiskLevel
	/** One line, for a confirmation the reviewer actually reads. */
	summary: string
}

function combine(
	action: ReviewActionName,
	included: readonly PendingProposal[],
): CombinedEffect {
	const byLayer: Record<string, number> = {}
	const byKind: Partial<Record<ReviewTargetKind, number>> = {}
	const touches = new Set<string>()
	let risk: RiskLevel = 'low'
	for (const p of included) {
		const layer = reviewTargetLayer(p.target.kind)
		byLayer[layer] = (byLayer[layer] ?? 0) + 1
		byKind[p.target.kind] = (byKind[p.target.kind] ?? 0) + 1
		touches.add(p.target.parentId ?? p.target.id)
		if (RISK_ORDER[p.risk.level] < RISK_ORDER[risk]) risk = p.risk.level
	}
	const verb =
		action === 'accept' ? 'Accept' : action === 'reject' ? 'Reject' : 'Reset'
	const kinds = Object.entries(byKind)
		.map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`)
		.join(', ')
	return {
		proposals: included.length,
		byLayer,
		byKind,
		touches: [...touches].sort(),
		risk,
		summary:
			included.length === 0
				? 'nothing to apply'
				: `${verb} ${included.length} proposal${included.length === 1 ? '' : 's'}` +
					`${kinds ? ` (${kinds})` : ''} across ${touches.size} node${touches.size === 1 ? '' : 's'}` +
					` · worst risk ${risk}`,
	}
}

/**
 * Plan a bulk decision over `targets`.
 *
 * Refuses — rather than silently skips — anything it will not include, so the
 * count a reviewer confirms is the count that lands. Three reasons a target is
 * refused, and none of them is recoverable by retrying:
 *
 *   - **high risk.** Individual review only. This is the point of the feature.
 *   - **not pending.** Already settled or manual: not a proposal, so a batch
 *     "accepting" it would be logging a decision nobody made.
 *   - **unresolvable.** Landed or removed since the queue rendered.
 *
 * Nothing is applied here; `applyBulkReview` does that, and does it atomically.
 */
export function planBulkReview(
	spec: SpecSystem,
	targets: readonly ReviewTarget[],
	action: ReviewActionName,
	batchId: string,
	context: RiskContext = {},
): BulkReviewPlan {
	const included: PendingProposal[] = []
	const refused: BulkRefusal[] = []
	const pending = new Map(
		pendingProposals(spec, context).map((p) => [targetKey(p.target), p]),
	)
	const seen = new Set<string>()

	for (const target of targets) {
		const key = targetKey(target)
		// A duplicate is not an error and not a second proposal — dedupe quietly, or
		// a double-submitted form would inflate the batch count the reviewer saw.
		if (seen.has(key)) continue
		seen.add(key)

		if (action === 'reset') {
			// Reset works on *settled* rows — it is the undo — so the pending map is
			// the wrong population for it.
			const row = locateReviewTarget(spec, target)
			const state = row ? deriveProvenanceState(row.provenance) : null
			if (state === 'accepted' || state === 'rejected') {
				included.push({
					target,
					label: target.id,
					state,
					risk: classifyReviewRisk(spec, target, context),
				})
			} else {
				refused.push({
					target,
					risk: 'high',
					reason:
						state === null
							? `no ${target.kind} "${target.id}" in the spec`
							: `${target.kind} "${target.id}" is ${state} — only a settled decision can be taken back`,
				})
			}
			continue
		}

		const proposal = pending.get(key)
		if (!proposal) {
			const row = locateReviewTarget(spec, target)
			refused.push({
				target,
				risk: 'high',
				reason: row
					? `${target.kind} "${target.id}" is already ${deriveProvenanceState(row.provenance)} — not a pending proposal`
					: `no ${target.kind} "${target.id}" in the spec — landed or removed since the queue was derived`,
			})
			continue
		}
		if (!proposal.risk.batchable) {
			refused.push({
				target,
				risk: proposal.risk.level,
				reason: `high risk — needs individual review: ${proposal.risk.findings
					.filter((f) => f.level === 'high')
					.map((f) => f.reason)
					.join('; ')}`,
			})
			continue
		}
		included.push(proposal)
	}

	return {
		action,
		batchId,
		// One op per artifact — never a single op covering the batch. Provenance is
		// per-artifact, and a batch-shaped op would make the trail say a
		// reviewer decided "a batch" rather than which rows.
		// No `cascade`: a batch's membership is exactly what the reviewer selected,
		// and a cascade would settle rows they never saw.
		ops: included.map((p) => ({
			op: 'provenance.review' as const,
			args: { target: p.target, action },
		})),
		included,
		refused,
		combined: combine(action, included),
	}
}

/** A stable string key for a target, for dedupe and lookup. */
function targetKey(target: ReviewTarget): string {
	return `${target.kind}:${target.parentId ?? ''}:${target.id}`
}

// ===========================================================================
// Landing — atomic, and per-artifact in the trail
// ===========================================================================

/**
 * Apply a planned batch, all or nothing.
 *
 * #199's gating line: *"a batch must be all-or-nothing at the point of landing —
 * a half-applied batch that leaves the spec in a state no one reviewed is worse
 * than a tedious queue."*
 *
 * Atomicity here is structural rather than transactional, and that is stronger:
 * `applyOp` returns a **new** system and never mutates its input, so the batch is
 * folded onto a private chain and the caller's `spec` is untouched until this
 * returns. If any op throws, the partial chain is garbage-collected and the
 * caller still holds exactly what it had. There is no window in which a
 * half-applied spec exists anywhere, so there is nothing to roll back.
 *
 * The caller must still persist the *returned* system in one write — an atomic
 * fold followed by two saves would give the atomicity back. The hosts do; the
 * invariant suite pins it.
 *
 * Every op is stamped with the batch id in `actor.session`, which is what makes
 * the trail per-artifact *and* legible as one unit of work: N entries,
 * one per row decided, all sharing a session — rather than one entry saying
 * somebody reviewed "a batch".
 */
export function applyBulkReview(
	spec: SpecSystem,
	plan: BulkReviewPlan,
	meta: {
		origin: 'ai' | 'human'
		appliedAt: string
		actor: Omit<OpActor, 'session'>
		/** Op ids, one per planned op. Injected so this stays pure/deterministic. */
		opId: (index: number) => string
	},
): SpecSystem {
	let next = spec
	for (const [i, op] of plan.ops.entries()) {
		next = applyOp(next, op, {
			id: meta.opId(i) as OpId,
			origin: meta.origin,
			appliedAt: meta.appliedAt as ISODate,
			actor: { ...meta.actor, session: plan.batchId },
		})
	}
	return next
}

// ===========================================================================
// Undo
// ===========================================================================

/**
 * Plan the undo for a landed batch: read the batch's own op-log entries back and
 * emit a `reset` for each row it settled.
 *
 * Derived from the trail rather than from a stored snapshot, which is what makes it
 * trustworthy: the undo can only take back what the log says the batch actually
 * did. A snapshot could be stale, could be missing, and would be a second source of
 * truth about a decision the op log already records.
 *
 * Ops the batch landed that are no longer reversible (the row was re-decided since,
 * or is now manual) are left out — `applyOp` would refuse them, and a plan that
 * included them would report an undo bigger than the one that happened.
 */
export function planBulkUndo(
	spec: SpecSystem,
	batchId: string,
): { ops: SpecOp[]; batchId: string; skipped: BulkRefusal[] } {
	const ops: SpecOp[] = []
	const skipped: BulkRefusal[] = []
	for (const entry of spec.opLog) {
		if (entry.actor?.session !== batchId) continue
		if (entry.op.op !== 'provenance.review') continue
		if (entry.op.args.action === 'reset') continue // undoing an undo is a redo
		const target = entry.op.args.target
		const row = locateReviewTarget(spec, target)
		const state = row ? deriveProvenanceState(row.provenance) : null
		if (state === 'accepted' || state === 'rejected') {
			ops.push({
				op: 'provenance.review',
				args: { target, action: 'reset' },
			})
		} else {
			skipped.push({
				target,
				risk: 'medium',
				reason:
					state === null
						? `no ${target.kind} "${target.id}" in the spec any more`
						: `${target.kind} "${target.id}" is now ${state} — something changed it after the batch, so the batch's decision is not the one being taken back`,
			})
		}
	}
	return { ops, batchId, skipped }
}

/**
 * Whether a batch is still undoable — nothing has been generated from it yet.
 *
 * `hasGenerated` is the caller's fact, not the spec's: the spec does not record
 * regeneration, so this module cannot know it and does not pretend to. The web and
 * CLI hosts each answer it from what they can see (a manifest write, a `gen` run),
 * and pass it in.
 *
 * The rule is `undoable = the batch landed && nothing generated since`, because an
 * undo after generation would leave code on disk derived from a decision the spec
 * no longer records — which is worse than no undo at all.
 */
export function isBatchUndoable(
	spec: SpecSystem,
	batchId: string,
	hasGenerated: boolean,
): boolean {
	if (hasGenerated) return false
	return spec.opLog.some(
		(e) => e.actor?.session === batchId && e.op.op === 'provenance.review',
	)
}

/**
 * Turn a host's generation watermark into `isBatchUndoable`'s `hasGenerated`
 *.
 *
 * The watermark is how much of the op log the last generation run consumed — a
 * prefix length, recorded on disk in the ownership manifest, because the spec
 * itself has no idea whether anything was ever derived from it. This is the
 * comparison that makes it mean something: the batch was generated from if and
 * only if the last op it landed falls inside that prefix.
 *
 * A length rather than a time, so the answer does not depend on clocks. The CLI
 * stamps `appliedAt` to the day, so a same-day compare could not tell a batch
 * from the generate that followed it thirty seconds later — which is precisely
 * the interval this has to be right about.
 *
 * Two "no"s that are deliberately not "unknown":
 *   - **no watermark** (`null`) — nothing has ever been generated, so nothing
 *     was generated from this batch;
 *   - **no such batch** — there is nothing to undo, and `isBatchUndoable` will
 *     refuse it anyway on its own terms.
 */
export function hasGeneratedSinceBatch(
	spec: SpecSystem,
	batchId: string,
	generatedFromOpCount: number | null | undefined,
): boolean {
	if (generatedFromOpCount == null) return false
	let last = -1
	for (let i = spec.opLog.length - 1; i >= 0; i--) {
		const entry = spec.opLog[i]
		if (
			entry?.actor?.session === batchId &&
			entry.op.op === 'provenance.review'
		) {
			last = i
			break
		}
	}
	if (last < 0) return false
	// The watermark is a length: ops `0..count-1` were generated from.
	return generatedFromOpCount > last
}

/** Count the entries a batch landed — the number a UI puts on its undo button. */
export function batchSize(spec: SpecSystem, batchId: string): number {
	return spec.opLog.filter(
		(e) => e.actor?.session === batchId && e.op.op === 'provenance.review',
	).length
}
