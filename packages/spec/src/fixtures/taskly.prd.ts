/**
 * Taskly — a compact worked PRD (v3): a simple team task-tracker.
 *
 * Teams create shared projects, add tasks, assign owners, and track status on a
 * board. Authored fresh in house style; passes runtime referential-integrity
 * validation.
 */
import type { PRD } from '../prd/prd.types.ts'

export const tasklyPRD: PRD = {
	schemaVersion: '3.0.0',
	estimateUnit: 'story-points',

	meta: {
		title: 'Taskly — Shared Task Tracking for Small Teams',
		author: 'R. Nolan, Product',
		status: 'draft',
		version: '0.1',
		lastUpdated: '2026-03-14',
		approvers: [
			{
				id: 'sh-nolan',
				name: 'R. Nolan',
				role: 'Product Lead',
				involvement: 'approver',
			},
			{
				id: 'sh-park',
				name: 'S. Park',
				role: 'Eng Lead',
				involvement: 'approver',
			},
		],
		stakeholders: [
			{
				id: 'sh-design',
				name: 'Design',
				role: 'Board UX',
				involvement: 'responsible',
			},
			{
				id: 'sh-growth',
				name: 'Growth',
				role: 'Activation',
				involvement: 'responsible',
			},
		],
	},

	context: {
		tldr: 'Small teams juggle tasks in chat and spreadsheets and lose track of who owns what. Taskly gives them one shared board with tasks, owners, and status.',
		background:
			'Existing trackers are heavyweight and expensive for a five-person team; most fall back to ad hoc tools that do not show ownership at a glance.',
	},

	problem: {
		statement:
			'Small teams cannot see, at a glance, who owns which task and what is in progress, so work stalls silently.',
		costOfInaction:
			'Dropped tasks, duplicated effort, and status meetings that exist only to reconstruct what everyone is doing.',
		painkillerOrVitamin: 'painkiller',
	},

	discovery: {
		activities: [
			{
				id: 'a-interview',
				description:
					'Interview 8 small-team leads about how they track work today',
				type: 'user_research',
				status: 'done',
				outcome:
					'Ownership visibility is the top unmet need; heavyweight tools abandoned.',
			},
			{
				id: 'a-proto',
				description: 'Clickable board prototype tested with 3 teams',
				type: 'prototyping',
				status: 'planned',
			},
		],
		researchMethod: {
			approach: 'Semi-structured interviews',
			sampleSize: 8,
			whoWasResearched: 'Leads of 3–8 person teams',
		},
	},

	audience: {
		personas: [
			{
				name: 'Ana, team lead',
				description:
					'Runs a 6-person team, wants visibility without micromanaging.',
				contextOfUse: 'Checks the board each morning on desktop.',
				goals: ['See what everyone is working on', 'Spot stalled tasks'],
				frustrations: [
					'Status is scattered across chat',
					'Spreadsheets go stale',
				],
				relationshipToProduct: 'primary_user',
			},
			{
				name: 'Ben, contributor',
				description: 'An engineer who just wants to know what to do next.',
				contextOfUse: 'Updates task status a few times a day.',
				goals: ['Know my next task', 'Update status quickly'],
				frustrations: ['Being asked for status repeatedly'],
				relationshipToProduct: 'primary_user',
			},
		],
		jobsToBeDone: [
			'When work comes in, I want to capture it as a task with an owner, so nothing is dropped.',
			'When I check in, I want to see status at a glance, so I do not have to ask around.',
		],
		currentWorkarounds: ['Shared spreadsheet', 'Chat threads', 'Sticky notes'],
	},

	market: {
		competitors: [
			{
				name: 'Trello',
				type: 'direct',
				strengths: ['Simple boards', 'Free tier'],
				weaknesses: ['Gets cluttered', 'Weak ownership view'],
			},
			{
				name: 'Spreadsheets',
				type: 'indirect',
				strengths: ['Flexible', 'Everyone has one'],
				weaknesses: ['No workflow', 'Go stale'],
			},
		],
		differentiation:
			'Opinionated, ownership-first board that stays legible for small teams without configuration.',
	},

	goals: {
		northStarMetric: {
			id: 'm-active-boards',
			name: 'Weekly Active Boards',
			definition: 'Boards with at least one task update in the last 7 days.',
			baseline: 0,
			target: '500 by end of year',
			timeframe: '1 year',
			measuredByEventIds: ['ev-task-updated'],
			ownerId: 'sh-growth',
		},
		businessGoals: [
			{ id: 'bg-teams', statement: 'Reach 1,000 active teams in year one.' },
			{ id: 'bg-retain', statement: 'Achieve 40%+ week-4 team retention.' },
		],
		userGoals: [
			{ id: 'ug-visibility', statement: 'See who owns what without asking.' },
			{ id: 'ug-fast', statement: 'Capture and update a task in seconds.' },
		],
		goalAlignment: [
			{
				businessGoalId: 'bg-retain',
				userGoalId: 'ug-fast',
				tension:
					'Retention features tempt added complexity; users want speed and simplicity.',
				resolution:
					'Keep the core loop one-click; ship depth as optional, off by default.',
			},
		],
		supportingMetrics: [
			{
				id: 'm-activation',
				name: 'First-Task Activation',
				definition:
					'Share of new teams that create 3+ tasks in their first session.',
				baseline: 0,
				target: '60%+',
				measuredByEventIds: ['ev-task-created'],
				ownerId: 'sh-growth',
			},
			{
				id: 'm-assign',
				name: 'Assignment Rate',
				definition: 'Share of tasks that have an owner.',
				baseline: 0,
				target: '80%+',
				measuredByEventIds: ['ev-task-assigned'],
				ownerId: 'sh-design',
			},
		],
		guardrailMetrics: [
			{
				id: 'm-load',
				name: 'Board Load Time',
				definition: 'p95 time to render a board.',
				baseline: 0,
				target: '< 1s',
				measuredByEventIds: ['ev-board-loaded'],
				ownerId: 'sh-park',
			},
		],
	},

	scope: {
		mustHave: [
			{
				id: 's-projects',
				description: 'Create shared projects',
				realizedByRequirementId: 'r-projects',
				rationale: { reasoning: 'Tasks need a home.' },
			},
			{
				id: 's-tasks',
				description: 'Create and edit tasks',
				realizedByRequirementId: 'r-tasks',
				rationale: { reasoning: 'Core unit of work.' },
			},
			{
				id: 's-assign',
				description: 'Assign owners to tasks',
				realizedByRequirementId: 'r-assign',
				rationale: { reasoning: 'Ownership is the differentiation.' },
			},
			{
				id: 's-board',
				description: 'View tasks on a status board',
				realizedByRequirementId: 'r-board',
				rationale: { reasoning: 'At-a-glance visibility.' },
			},
		],
		shouldHave: [
			{
				id: 's-notify',
				description: 'Notify owners of assignments and changes',
				realizedByRequirementId: 'r-notify',
				rationale: {
					reasoning: 'Keeps owners aware; not required for core value.',
				},
			},
		],
		couldHave: [
			{
				id: 's-filter',
				description: 'Filter the board by owner or status',
				realizedByRequirementId: 'r-filter',
				rationale: { reasoning: 'Helps larger boards.' },
			},
		],
		wontHave: [
			{
				id: 's-gantt',
				description: 'Gantt charts and dependencies',
				rationale: { reasoning: 'Heavyweight; against the simple-first bet.' },
			},
		],
		nonGoals: [
			'A full project-management suite',
			'Time tracking',
			'Billing/invoicing',
		],
	},

	requirements: [
		{
			id: 'r-projects',
			userStory:
				'As a team lead, I want to create a shared project, so my team has one place for its tasks.',
			acceptanceCriteria: [
				'Create/rename/archive a project',
				'Invite teammates by email',
				'Members see the same board',
			],
			priority: 'P0',
			estimate: { effort: 3, impact: 8, confidence: 0.8 },
			servesMetricIds: ['m-activation'],
			edgeCasesAndErrorStates: [
				'Duplicate project name',
				'Invite to an already-member email',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-tasks',
			userStory:
				'As a contributor, I want to create and edit tasks, so work is captured.',
			acceptanceCriteria: [
				'Create a task with title and description',
				'Edit and delete a task',
				'Set status (todo/doing/done)',
			],
			priority: 'P0',
			estimate: { effort: 3, impact: 9, confidence: 0.8 },
			servesMetricIds: ['m-activation', 'm-active-boards'],
			edgeCasesAndErrorStates: [
				'Empty title',
				'Editing a task another member just deleted',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-assign',
			userStory:
				'As a team lead, I want to assign an owner to each task, so responsibility is clear.',
			acceptanceCriteria: [
				'Assign one owner from team members',
				'Reassign an owner',
				'Unassigned tasks are visually flagged',
			],
			priority: 'P0',
			estimate: { effort: 2, impact: 9, confidence: 0.85 },
			servesMetricIds: ['m-assign'],
			edgeCasesAndErrorStates: [
				'Owner removed from team',
				'Assigning to an invited-but-not-joined member',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-board',
			userStory:
				'As a team lead, I want a status board, so I can see all work at a glance.',
			acceptanceCriteria: [
				'Columns by status',
				'Drag a task between columns',
				'Show owner on each card',
			],
			priority: 'P0',
			estimate: { effort: 5, impact: 9, confidence: 0.7 },
			servesMetricIds: ['m-active-boards', 'm-load'],
			edgeCasesAndErrorStates: [
				'Very long task lists (virtualize)',
				'Concurrent moves by two members',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-notify',
			userStory:
				'As a contributor, I want to be notified when I am assigned a task, so I know to act.',
			acceptanceCriteria: [
				'Email/in-app notification on assignment',
				'Notification on status change of my tasks',
				'Mute per-project',
			],
			priority: 'P1',
			estimate: { effort: 3, impact: 6, confidence: 0.6 },
			servesMetricIds: ['m-active-boards'],
			edgeCasesAndErrorStates: [
				'Notification storm on bulk edits',
				'Muted user still assigned',
			],
			enhancesRequirementIds: ['r-assign'],
			ownerId: 'sh-growth',
		},
		{
			id: 'r-filter',
			userStory:
				'As a team lead, I want to filter the board, so I can focus on one owner or status.',
			acceptanceCriteria: [
				'Filter by owner',
				'Filter by status',
				'Clear all filters',
			],
			priority: 'P2',
			estimate: { effort: 2, impact: 5, confidence: 0.7 },
			servesMetricIds: ['m-active-boards'],
			edgeCasesAndErrorStates: ['Filter yields empty board (explain)'],
			enhancesRequirementIds: ['r-board'],
			ownerId: 'sh-design',
		},
	],

	experience: {
		criticalUserFlows: [
			{
				name: 'Set up a board',
				steps: ['Create project', 'Invite team', 'Add first tasks'],
				requirementIds: ['r-projects', 'r-tasks'],
			},
			{
				name: 'Track work',
				steps: ['Assign owner', 'Move task across board', 'See status'],
				requirementIds: ['r-assign', 'r-board'],
			},
		],
		firstRunExperience:
			'A new team lands on a starter board with example columns and can add their first task in one click.',
		informationArchitecture:
			'Team -> Project -> Board -> Tasks (each with owner + status).',
		accessibility: {
			standard: 'WCAG 2.2 AA',
			considerations: [
				'Keyboard drag-and-drop alternative',
				'Color-independent status indicators',
			],
		},
	},

	technical: {
		platforms: ['web'],
		platformStrategy: 'Responsive web first; native apps deferred.',
		dataModel:
			'Team 1—* Project; Project 1—* Task; Task *—1 Member (owner); Task has status enum.',
		integrations: [
			{ name: 'Email provider', purpose: 'Send invites and notifications' },
		],
	},

	nonFunctional: {
		performanceTargets: [
			'Board renders in < 1s p95',
			'Task update reflects in < 300ms',
		],
		scalability:
			'Designed for teams up to ~50 members and thousands of tasks per project.',
		security: ['Scoped access per team', 'Encrypt data at rest'],
		availability: '99.5%',
		offlineSupport: false,
	},

	constraints: {
		budget: 'Bootstrapped; keep infra lean.',
		timeline: 'MVP in one quarter.',
		teamCapacity: '2 eng, 1 designer.',
	},

	assumptions: [
		{
			id: 'as-visibility',
			statement:
				'Ownership visibility is the primary reason small teams would switch.',
			confidence: 0.6,
			impactIfWrong: 0.8,
			validatedByActivityId: 'a-interview',
			ownerId: 'sh-nolan',
		},
		{
			id: 'as-simple',
			statement:
				'Teams prefer an opinionated simple board over a configurable one.',
			confidence: 0.55,
			impactIfWrong: 0.7,
			validatedByActivityId: 'a-proto',
			ownerId: 'sh-design',
		},
	],

	risks: [
		{
			id: 'rk-crowded',
			description: 'Crowded market; simple boards are commoditized.',
			type: 'market_risk',
			likelihood: 0.6,
			impact: 0.7,
			threatensAssumptionIds: ['as-visibility'],
			mitigation:
				'Lead with ownership-first UX and speed; target teams underserved by heavyweight tools.',
			validatedByActivityId: 'a-interview',
			ownerId: 'sh-nolan',
		},
		{
			id: 'rk-toosimple',
			description:
				'Opinionated simplicity turns away teams that need a bit more structure.',
			type: 'market_risk',
			likelihood: 0.4,
			impact: 0.6,
			threatensAssumptionIds: ['as-simple'],
			mitigation:
				'Add optional depth (filters, later fields) without cluttering the default.',
			validatedByActivityId: 'a-proto',
			ownerId: 'sh-design',
		},
		{
			id: 'rk-realtime',
			description: 'Concurrent board edits create sync conflicts.',
			type: 'technical_risk',
			likelihood: 0.4,
			impact: 0.6,
			mitigation:
				'Last-write-wins with optimistic UI and conflict toasts; server-authoritative order.',
			ownerId: 'sh-park',
		},
	],

	validation: {
		isGate: true,
		goCriteria:
			'Prototype teams reach First-Task Activation >= 50% and report clearer ownership than their current tool.',
		noGoCriteria:
			'If teams do not activate or see no ownership benefit over spreadsheets, rethink the wedge.',
		experiments: ['Interviews (a-interview)', 'Prototype test (a-proto)'],
		blocksPhaseId: 'p-mvp',
	},

	roadmap: {
		phases: [
			{
				id: 'p-mvp',
				name: 'MVP',
				goal: 'A team can create a board, add tasks, assign owners, and track status.',
				featureRequirementIds: ['r-projects', 'r-tasks', 'r-assign', 'r-board'],
				estimate: { effort: 0, impact: 9, confidence: 0.7 },
			},
			{
				id: 'p-v1',
				name: 'v1',
				goal: 'Keep owners aware and boards navigable.',
				featureRequirementIds: ['r-notify', 'r-filter'],
				estimate: { effort: 0, impact: 6, confidence: 0.6 },
				dependsOnPhaseIds: ['p-mvp'],
			},
		],
	},

	execution: {
		milestones: [
			{
				id: 'ms-alpha',
				name: 'Internal alpha',
				date: '2026-05-15',
				deliverable: 'End-to-end board flow',
				deliversRequirementIds: [
					'r-projects',
					'r-tasks',
					'r-assign',
					'r-board',
				],
				ownerId: 'sh-park',
			},
			{
				id: 'ms-beta',
				name: 'Public beta',
				date: '2026-07-01',
				deliverable: 'Beta with notifications and filters',
				deliversRequirementIds: ['r-notify', 'r-filter'],
				ownerId: 'sh-nolan',
			},
		],
		launchPlan: {
			softLaunch: {
				audience: 'Prototype teams and waitlist',
				successCriteria:
					'First-Task Activation >= 50% and positive ownership feedback.',
			},
			generalAvailability: {
				criteria:
					'Board load p95 < 1s and week-4 retention trending to target.',
			},
			rolloutStrategy: 'Waitlist-gated ramp, then open signup.',
		},
		analyticsEvents: [
			{
				id: 'ev-task-created',
				name: 'task_created',
				description: 'A task is created.',
			},
			{
				id: 'ev-task-assigned',
				name: 'task_assigned',
				description: 'A task is assigned an owner.',
			},
			{
				id: 'ev-task-updated',
				name: 'task_updated',
				description: 'A task status or field is updated.',
			},
			{
				id: 'ev-board-loaded',
				name: 'board_loaded',
				description: 'A board finishes rendering.',
			},
		],
		qualityBar:
			'Core flows tested on desktop and mobile web; load test boards with 1k tasks.',
		userCommunicationPlan: 'Onboarding checklist, changelog, in-app tips.',
	},

	coexistence: {
		permissionsAndRoles: [
			'Team owner manages members',
			'Members create and edit tasks',
		],
		featureInteractions: [
			'Notifications respect per-project mute',
			'Filters do not change underlying data',
		],
		dependencies: ['Email provider'],
		vendorRisks: [
			{
				vendor: 'Email provider',
				whatItProvides: 'Invites and notifications',
				contingency:
					'Abstract the mailer; queue and retry; swap providers if deliverability drops.',
			},
		],
	},

	postLaunch: {
		ownership:
			'Growth owns activation and retention; Eng owns board performance; Design owns board UX.',
		killCriteria: [
			{
				metricId: 'm-activation',
				threshold: 'First-Task Activation < 25% sustained through beta',
				action: 'pivot',
			},
			{
				metricId: 'm-active-boards',
				threshold: 'Weekly Active Boards flat for two months post-GA',
				action: 'reassess',
			},
		],
		rollbackPlan:
			'Feature-flag new board features off; core CRUD remains available.',
		dataRetention:
			'Task data retained until a team deletes its project; export on request.',
	},

	openQuestions: [
		{
			question: 'Do we support multiple owners per task later?',
			owner: 'Product',
			blocking: false,
		},
		{
			question: 'What is the free-tier task limit?',
			owner: 'Product/Growth',
			blocking: false,
		},
	],
}
