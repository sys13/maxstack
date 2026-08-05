/**
 * Runtime validation for a PRD.
 *
 * The TypeScript types give category-safe IDs (you can't pass a requirement id
 * where a metric id is wanted) but they cannot guarantee a referenced id
 * actually EXISTS, that dates are well-formed, or that 0–1 fields are in range.
 * This module closes those gaps at runtime.
 *
 * Design choice: rather than re-declaring every descriptive field in Zod (which
 * would duplicate the commented interface and drift from it), we validate the
 * primitives that have invariants (ids, dates, ranges) and then run a thorough
 * referential-integrity pass. Purely descriptive content is passed through.
 *
 * Lifted from autofactory alongside prd.types.ts (see the lift-vs-reimplement
 *;
 * adapted to house style and to Zod 4's `z.flattenError`-era API surface.
 */
import { z } from 'zod'
import type { PRD } from './prd.types.ts'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')

const unit = z.number().min(0).max(1)

/**
 * Validate a PRD object. Returns the same object typed as PRD on success;
 * throws an Error listing every problem on failure.
 */
export function validatePRD(prd: PRD): PRD {
	const errors: string[] = []

	// ---- collect declared ids -------------------------------------------------
	const metricIds = new Set<string>([
		prd.goals.northStarMetric.id,
		...prd.goals.supportingMetrics.map((m) => m.id),
		...(prd.goals.guardrailMetrics ?? []).map((m) => m.id),
	])
	const reqIds = new Set<string>(prd.requirements.map((r) => r.id))
	const phaseIds = new Set<string>(prd.roadmap.phases.map((p) => p.id))
	const activityIds = new Set<string>(prd.discovery.activities.map((a) => a.id))
	const assumptionIds = new Set<string>(prd.assumptions.map((a) => a.id))
	const goalIds = new Set<string>(
		[...prd.goals.businessGoals, ...prd.goals.userGoals].map((g) => g.id),
	)
	const eventIds = new Set<string>(
		prd.execution.analyticsEvents.map((e) => e.id),
	)
	const stakeholderIds = new Set<string>([
		...prd.meta.approvers.map((s) => s.id),
		...(prd.meta.stakeholders ?? []).map((s) => s.id),
	])

	const need = (ok: boolean, msg: string) => {
		if (!ok) errors.push(msg)
	}
	const ref = (set: Set<string>, id: string | undefined, ctx: string) => {
		if (id !== undefined) need(set.has(id), `${ctx} -> unknown id "${id}"`)
	}

	// ---- primitive ranges & formats ------------------------------------------
	if (!isoDate.safeParse(prd.meta.lastUpdated).success)
		errors.push(`meta.lastUpdated "${prd.meta.lastUpdated}" is not YYYY-MM-DD`)

	for (const a of prd.assumptions) {
		if (!unit.safeParse(a.confidence).success)
			errors.push(`assumption ${a.id}: confidence out of 0–1`)
		if (!unit.safeParse(a.impactIfWrong).success)
			errors.push(`assumption ${a.id}: impactIfWrong out of 0–1`)
		ref(
			activityIds,
			a.validatedByActivityId,
			`assumption ${a.id}.validatedByActivityId`,
		)
		ref(stakeholderIds, a.ownerId, `assumption ${a.id}.ownerId`)
	}

	for (const r of prd.risks) {
		if (!unit.safeParse(r.likelihood).success)
			errors.push(`risk ${r.id}: likelihood out of 0–1`)
		if (!unit.safeParse(r.impact).success)
			errors.push(`risk ${r.id}: impact out of 0–1`)
		for (const a of r.threatensAssumptionIds ?? [])
			ref(assumptionIds, a, `risk ${r.id}.threatensAssumptionIds`)
		ref(
			activityIds,
			r.validatedByActivityId,
			`risk ${r.id}.validatedByActivityId`,
		)
		ref(stakeholderIds, r.ownerId, `risk ${r.id}.ownerId`)
	}

	// ---- requirements ---------------------------------------------------------
	for (const req of prd.requirements) {
		for (const m of req.servesMetricIds ?? [])
			ref(metricIds, m, `requirement ${req.id}.servesMetricIds`)
		for (const e of req.enhancesRequirementIds ?? [])
			ref(reqIds, e, `requirement ${req.id}.enhancesRequirementIds`)
		ref(stakeholderIds, req.ownerId, `requirement ${req.id}.ownerId`)
	}

	// ---- metrics --------------------------------------------------------------
	for (const m of [
		prd.goals.northStarMetric,
		...prd.goals.supportingMetrics,
		...(prd.goals.guardrailMetrics ?? []),
	]) {
		for (const e of m.measuredByEventIds ?? [])
			ref(eventIds, e, `metric ${m.id}.measuredByEventIds`)
		ref(stakeholderIds, m.ownerId, `metric ${m.id}.ownerId`)
	}

	// ---- goal tensions --------------------------------------------------------
	for (const t of prd.goals.goalAlignment) {
		ref(goalIds, t.businessGoalId, 'goalAlignment.businessGoalId')
		ref(goalIds, t.userGoalId, 'goalAlignment.userGoalId')
	}

	// ---- scope realization ----------------------------------------------------
	for (const bucket of [
		prd.scope.mustHave,
		prd.scope.shouldHave,
		prd.scope.couldHave,
		prd.scope.wontHave,
	])
		for (const s of bucket)
			ref(
				reqIds,
				s.realizedByRequirementId,
				`scope ${s.id}.realizedByRequirementId`,
			)

	// ---- roadmap --------------------------------------------------------------
	for (const ph of prd.roadmap.phases) {
		for (const r of ph.featureRequirementIds)
			ref(reqIds, r, `phase ${ph.id}.featureRequirementIds`)
		for (const d of ph.dependsOnPhaseIds ?? [])
			ref(phaseIds, d, `phase ${ph.id}.dependsOnPhaseIds`)
	}
	ref(phaseIds, prd.validation.blocksPhaseId, 'validation.blocksPhaseId')

	// ---- execution ------------------------------------------------------------
	for (const ms of prd.execution.milestones) {
		if (!isoDate.safeParse(ms.date).success)
			errors.push(`milestone ${ms.id}: date "${ms.date}" not YYYY-MM-DD`)
		for (const r of ms.deliversRequirementIds ?? [])
			ref(reqIds, r, `milestone ${ms.id}.deliversRequirementIds`)
		ref(stakeholderIds, ms.ownerId, `milestone ${ms.id}.ownerId`)
	}

	// ---- experience flows -----------------------------------------------------
	for (const f of prd.experience.criticalUserFlows)
		for (const r of f.requirementIds ?? [])
			ref(reqIds, r, `flow "${f.name}".requirementIds`)

	// ---- post-launch ----------------------------------------------------------
	for (const k of prd.postLaunch.killCriteria)
		ref(metricIds, k.metricId, 'killCriteria.metricId')

	if (errors.length)
		throw new Error(
			`PRD validation failed (${errors.length}):\n- ${errors.join('\n- ')}`,
		)
	return prd
}
