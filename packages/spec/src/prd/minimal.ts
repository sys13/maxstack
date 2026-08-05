/**
 * `minimalPRD` — a compact, valid `PRD` from a handful of product strings.
 *
 * A full PRD has dozens of referentially-linked fields; most callers that only
 * need *valid grounding* (a benchmark's inert product layer, a freshly
 * `maxstack init`'d project) don't want to author all of them. This builder
 * fills every required field with a self-consistent minimal skeleton — every
 * cross-reference (metric → kill criterion, requirement → phase, goal tension →
 * goals) wired to ids minted here — so the caller supplies only its distinctive
 * prose and `validatePRD` still passes.
 *
 * The benchmark set re-exports this as `benchmarkPRD`; `maxstack init` seeds a
 * new project's spec from it.
 */

import type { PRD } from './prd.types.ts'

export interface MinimalPrdInput {
	/** Product title, e.g. "Recipebox — a shared recipe & meal-plan keeper". */
	title: string
	/** One-line elevator pitch (PRD.context.tldr). */
	tldr: string
	/** The problem this product solves (PRD.problem.statement). */
	problem: string
	/** North-star metric name, e.g. "Weekly plans cooked". */
	northStar: string
	/** Primary persona label, e.g. "Home cook planning the week". */
	persona: string
	/** How it differs from the alternatives (PRD.market.differentiation). */
	differentiation: string
	/** PRD author (meta.author). Defaults to a neutral "Product owner". */
	author?: string
	/** Context background (PRD.context.background). Defaults to neutral prose. */
	background?: string
	/** meta.lastUpdated (ISO date). Defaults to a fixed placeholder; callers that
	 * seed a real project (e.g. `maxstack init`) should pass today's date. */
	lastUpdated?: string
	/** execution.milestones[0].date (ISO date). Defaults to a fixed placeholder;
	 * callers that seed a real project should pass a real target date. */
	milestoneDate?: string
}

/**
 * Build a valid minimal PRD from a handful of product-specific strings. Every
 * cross-reference (metric → kill criterion, requirement → phase, goal tension →
 * goals) is wired to the ids minted here so `validatePRD` passes.
 */
export function minimalPRD(input: MinimalPrdInput): PRD {
	return {
		schemaVersion: '3.0.0',
		estimateUnit: 'story-points',
		meta: {
			title: input.title,
			author: input.author ?? 'Product owner',
			status: 'draft',
			version: '0.1',
			lastUpdated: input.lastUpdated ?? '2026-07-09',
			approvers: [
				{
					id: 'sh-owner',
					name: 'Product',
					role: 'Owner',
					involvement: 'approver',
				},
			],
		},
		context: {
			tldr: input.tldr,
			background:
				input.background ??
				'Seeded from a minimal spec skeleton; the background fills in as the product grows change-by-change.',
		},
		problem: {
			statement: input.problem,
			costOfInaction:
				'Users keep the data in scattered notes and spreadsheets, and it rots.',
			painkillerOrVitamin: 'vitamin',
		},
		discovery: {
			activities: [
				{
					id: 'a-interview',
					description: 'Talk to a handful of target users about the workflow.',
					type: 'user_research',
					status: 'done',
				},
			],
		},
		audience: {
			personas: [
				{
					name: input.persona,
					description: `${input.persona} — the primary user this product serves.`,
					contextOfUse: 'Uses the app regularly and evolves it over months.',
					goals: ['Keep the data organized', 'Change the app as needs shift'],
					frustrations: ['Generic tools do not fit the domain'],
					relationshipToProduct: 'primary_user',
				},
			],
			jobsToBeDone: ['Track the domain data', 'Adapt the app over time'],
			currentWorkarounds: ['Spreadsheets', 'Sticky notes'],
		},
		market: {
			competitors: [
				{
					name: 'A general-purpose spreadsheet',
					type: 'indirect',
					strengths: ['Flexible', 'Familiar'],
					weaknesses: ['No domain model', 'No safe evolution'],
				},
			],
			differentiation: input.differentiation,
		},
		goals: {
			northStarMetric: {
				id: 'm-north-star',
				name: input.northStar,
				definition: `${input.northStar} — the one number that says the product is working.`,
				baseline: 0,
			},
			businessGoals: [{ id: 'bg-retain', statement: 'Retain active users.' }],
			userGoals: [
				{ id: 'ug-fit', statement: 'A tool that fits the workflow.' },
			],
			goalAlignment: [
				{
					businessGoalId: 'bg-retain',
					userGoalId: 'ug-fit',
					tension: 'Retention pressure can bloat the app past the user’s need.',
					resolution: 'Keep the core small; grow only where the user asks.',
				},
			],
			supportingMetrics: [
				{
					id: 'm-weekly-active',
					name: 'Weekly active users',
					definition:
						'Distinct users who took a core action in the last 7 days.',
					baseline: 0,
				},
			],
		},
		scope: {
			mustHave: [
				{
					id: 's-core',
					description: 'The core CRUD workflow.',
					realizedByRequirementId: 'r-core',
				},
			],
			shouldHave: [],
			couldHave: [],
			wontHave: [],
			nonGoals: ['Anything outside the core domain in v1.'],
		},
		requirements: [
			{
				id: 'r-core',
				userStory: 'As the primary user, I can manage the core domain data.',
				acceptanceCriteria: [
					'I can create, read, update, and delete the core records.',
					'The list reflects my changes immediately.',
				],
				priority: 'P0',
				edgeCasesAndErrorStates: ['Empty state', 'Validation error'],
				servesMetricIds: ['m-north-star'],
			},
		],
		experience: {
			criticalUserFlows: [
				{
					name: 'Manage core records',
					steps: ['Open the app', 'Create a record', 'See it in the list'],
					requirementIds: ['r-core'],
				},
			],
			firstRunExperience: 'An empty state that invites the first record.',
			accessibility: {
				standard: 'WCAG 2.1 AA',
				considerations: ['Keyboard navigation', 'Sufficient contrast'],
			},
		},
		technical: {
			platforms: ['web'],
			dataModel: 'A small relational model over the core entities.',
			integrations: [],
		},
		nonFunctional: {
			performanceTargets: ['Interactions feel instant on a modern laptop.'],
			scalability: 'Single-tenant scale; hundreds of records per user.',
			security: ['Authenticated access only.'],
		},
		constraints: {},
		assumptions: [
			{
				id: 'as-fit',
				statement: 'The domain model fits the user’s real workflow.',
				confidence: 0.7,
				impactIfWrong: 0.8,
				validatedByActivityId: 'a-interview',
			},
		],
		risks: [
			{
				id: 'rk-overfit',
				description: 'The app overfits one workflow and resists change.',
				type: 'technical_risk',
				likelihood: 0.3,
				impact: 0.6,
				threatensAssumptionIds: ['as-fit'],
				mitigation: 'Bias the design toward safe change over time.',
			},
		],
		validation: {
			isGate: false,
			goCriteria: 'The core flow works end-to-end.',
			experiments: ['Dogfood the core flow for a week.'],
			blocksPhaseId: 'p-mvp',
		},
		roadmap: {
			phases: [
				{
					id: 'p-mvp',
					name: 'MVP',
					goal: 'Ship the core CRUD workflow.',
					featureRequirementIds: ['r-core'],
				},
			],
		},
		execution: {
			milestones: [
				{
					id: 'ms-mvp',
					name: 'MVP live',
					date: input.milestoneDate ?? '2026-08-01',
					deliverable: 'The core flow works end-to-end.',
					deliversRequirementIds: ['r-core'],
				},
			],
			launchPlan: {
				generalAvailability: { criteria: 'The core flow is stable.' },
			},
			analyticsEvents: [
				{
					id: 'ev-record-created',
					name: 'record_created',
					description: 'A core record was created.',
				},
			],
			qualityBar: 'Green validate gate; regen-safety 100%.',
			userCommunicationPlan: 'Release notes on each change.',
		},
		coexistence: {
			permissionsAndRoles: ['Owner'],
			featureInteractions: [],
			dependencies: [],
			vendorRisks: [],
		},
		postLaunch: {
			ownership: 'The solo maintainer.',
			killCriteria: [
				{
					metricId: 'm-north-star',
					threshold: 'Flat for two months after launch.',
					action: 'reassess',
				},
			],
			rollbackPlan: 'Revert to the previous generated version.',
		},
		openQuestions: [],
	}
}
