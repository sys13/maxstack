/**
 * Todotracker — a compact worked PRD (v3): a personal todo + habit app.
 *
 * A single person captures todos and recurring habits, checks them off, and
 * watches their streaks. Authored fresh in house style; passes runtime
 * referential-integrity validation.
 */
import type { PRD } from '../prd/prd.types.ts'

export const todotrackerPRD: PRD = {
	schemaVersion: '3.0.0',
	estimateUnit: 'story-points',

	meta: {
		title: 'Todotracker — Personal Todos and Habits That Stick',
		author: 'K. Vance, Product',
		status: 'draft',
		version: '0.1',
		lastUpdated: '2026-02-20',
		approvers: [
			{
				id: 'sh-vance',
				name: 'K. Vance',
				role: 'Founder/PM',
				involvement: 'approver',
			},
			{
				id: 'sh-idris',
				name: 'H. Idris',
				role: 'Eng Lead',
				involvement: 'approver',
			},
		],
		stakeholders: [
			{
				id: 'sh-design',
				name: 'Design',
				role: 'Mobile UX',
				involvement: 'responsible',
			},
		],
	},

	context: {
		tldr: 'People start habit apps and quit. Todotracker combines quick todos with lightweight habit streaks so daily follow-through feels rewarding, not like a chore.',
		background:
			'Todo apps ignore recurring behavior; habit apps feel heavy. A single fast list that also tracks streaks fills the gap.',
	},

	problem: {
		statement:
			'Individuals struggle to keep up daily habits alongside one-off todos, and lose momentum when tools make either feel like work.',
		costOfInaction:
			'Abandoned habits, forgotten tasks, and a graveyard of half-used apps.',
		painkillerOrVitamin: 'vitamin',
	},

	discovery: {
		activities: [
			{
				id: 'a-survey',
				description: 'Survey 120 people on habit-app abandonment',
				type: 'user_research',
				status: 'done',
				outcome:
					'Friction and guilt-heavy design drive churn; streaks motivate but must forgive slips.',
			},
			{
				id: 'a-proto',
				description: 'Prototype the combined list + streak view',
				type: 'prototyping',
				status: 'planned',
			},
		],
		researchMethod: {
			approach: 'Online survey + 5 follow-up interviews',
			sampleSize: 120,
			whoWasResearched: 'Adults who tried a habit app in the last year',
		},
	},

	audience: {
		personas: [
			{
				name: 'Sam, the restarter',
				description:
					'29, has abandoned three habit apps, wants something that forgives a missed day.',
				contextOfUse: 'Checks the app on their phone morning and night.',
				goals: ['Build a couple of habits', 'Not feel guilty after a slip'],
				frustrations: [
					'Broken streaks feel punishing',
					'Too many features to configure',
				],
				relationshipToProduct: 'primary_user',
			},
		],
		jobsToBeDone: [
			'When I plan my day, I want to jot todos and see my habits together, so I only open one app.',
			'When I miss a day, I want to recover gracefully, so I keep going instead of quitting.',
		],
		currentWorkarounds: [
			'Notes app',
			'Paper journal',
			'A separate habit tracker they stopped using',
		],
	},

	market: {
		competitors: [
			{
				name: 'Habitica',
				type: 'direct',
				strengths: ['Gamified', 'Community'],
				weaknesses: ['Complex', 'Overwhelming for casual users'],
			},
			{
				name: 'Apple Reminders',
				type: 'indirect',
				strengths: ['Built in', 'Simple todos'],
				weaknesses: ['No habit streaks', 'No motivation loop'],
			},
		],
		differentiation:
			'One fast list for todos and habits with forgiving streaks — motivating without the guilt or configuration.',
	},

	goals: {
		northStarMetric: {
			id: 'm-dau-checkins',
			name: 'Daily Check-ins',
			definition:
				'Users who complete at least one todo or habit on a given day.',
			baseline: 0,
			target: '10,000 DAU by year end',
			timeframe: '1 year',
			measuredByEventIds: ['ev-item-completed'],
			ownerId: 'sh-vance',
		},
		businessGoals: [
			{ id: 'bg-users', statement: 'Reach 100,000 installs in year one.' },
			{ id: 'bg-d30', statement: 'Achieve 25%+ day-30 retention.' },
		],
		userGoals: [
			{
				id: 'ug-momentum',
				statement: 'Keep habits going without feeling punished.',
			},
			{ id: 'ug-oneapp', statement: 'Manage todos and habits in one place.' },
		],
		goalAlignment: [
			{
				businessGoalId: 'bg-d30',
				userGoalId: 'ug-momentum',
				tension:
					'Aggressive streak mechanics boost engagement but can create guilt that drives churn.',
				resolution:
					'Forgiving streaks (grace days) that reward consistency without punishing a single miss.',
			},
		],
		supportingMetrics: [
			{
				id: 'm-firsthabit',
				name: 'First-Habit Setup',
				definition:
					'Share of new users who create a habit in their first session.',
				baseline: 0,
				target: '55%+',
				measuredByEventIds: ['ev-habit-created'],
				ownerId: 'sh-design',
			},
			{
				id: 'm-streak7',
				name: '7-Day Streak Rate',
				definition: 'Share of active users with a 7-day streak on any habit.',
				baseline: 0,
				target: '30%+',
				measuredByEventIds: ['ev-streak-reached'],
				ownerId: 'sh-vance',
			},
		],
		guardrailMetrics: [
			{
				id: 'm-uninstall',
				name: 'Early Uninstall Rate',
				definition: 'Share of installs uninstalled within 3 days.',
				baseline: 0,
				target: '< 40%',
				measuredByEventIds: ['ev-app-opened'],
				ownerId: 'sh-vance',
			},
		],
	},

	scope: {
		mustHave: [
			{
				id: 's-todos',
				description: 'Create and complete one-off todos',
				realizedByRequirementId: 'r-todos',
				rationale: { reasoning: 'Baseline utility.' },
			},
			{
				id: 's-habits',
				description: 'Create recurring habits',
				realizedByRequirementId: 'r-habits',
				rationale: { reasoning: 'The recurring behavior we track.' },
			},
			{
				id: 's-streaks',
				description: 'Track forgiving streaks per habit',
				realizedByRequirementId: 'r-streaks',
				rationale: { reasoning: 'The motivation loop and differentiation.' },
			},
		],
		shouldHave: [
			{
				id: 's-remind',
				description: 'Daily reminders for habits',
				realizedByRequirementId: 'r-remind',
				rationale: {
					reasoning: 'Nudges follow-through; not required for core value.',
				},
			},
		],
		couldHave: [
			{
				id: 's-stats',
				description: 'Weekly stats and history view',
				realizedByRequirementId: 'r-stats',
				rationale: {
					reasoning: 'Reflection delight, orthogonal to core loop.',
				},
			},
		],
		wontHave: [
			{
				id: 's-social',
				description: 'Social/community features',
				rationale: { reasoning: 'Against the simple, personal-first bet.' },
			},
		],
		nonGoals: [
			'Team collaboration',
			'Gamified RPG mechanics',
			'Calendar replacement',
		],
	},

	requirements: [
		{
			id: 'r-todos',
			userStory:
				'As a user, I want to add and check off todos, so I remember one-off tasks.',
			acceptanceCriteria: [
				'Add a todo in one tap',
				'Check off / uncheck a todo',
				'Delete a todo',
			],
			priority: 'P0',
			estimate: { effort: 2, impact: 7, confidence: 0.85 },
			servesMetricIds: ['m-dau-checkins'],
			edgeCasesAndErrorStates: [
				'Empty todo text',
				'Rapid double-tap completion',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-habits',
			userStory:
				'As a user, I want to create recurring habits, so daily behaviors show up automatically.',
			acceptanceCriteria: [
				'Create a habit with a repeat schedule',
				'Habit appears on scheduled days',
				'Edit or archive a habit',
			],
			priority: 'P0',
			estimate: { effort: 3, impact: 9, confidence: 0.8 },
			servesMetricIds: ['m-firsthabit', 'm-dau-checkins'],
			edgeCasesAndErrorStates: [
				'Timezone change shifts the day boundary',
				'Habit archived mid-streak',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-streaks',
			userStory:
				'As a user, I want forgiving streaks, so a single missed day does not make me quit.',
			acceptanceCriteria: [
				'Increment streak on completion',
				'Grace day before a streak breaks',
				'Show current and best streak',
			],
			priority: 'P0',
			priorityRationale: {
				reasoning: 'The core motivation loop and the differentiation.',
				heuristicApplied: 'Core value -> P0.',
			},
			estimate: { effort: 5, impact: 9, confidence: 0.65 },
			servesMetricIds: ['m-streak7', 'm-dau-checkins'],
			edgeCasesAndErrorStates: [
				'Retroactive completion',
				'Clock tampering to fake streaks',
			],
			ownerId: 'sh-idris',
		},
		{
			id: 'r-remind',
			userStory: 'As a user, I want daily reminders, so I remember my habits.',
			acceptanceCriteria: [
				'Set a reminder time per habit',
				'Local push notification',
				'Snooze or disable reminders',
			],
			priority: 'P1',
			estimate: { effort: 3, impact: 6, confidence: 0.6 },
			servesMetricIds: ['m-dau-checkins'],
			edgeCasesAndErrorStates: [
				'Notifications disabled at OS level',
				'Reminder after habit already done',
			],
			enhancesRequirementIds: ['r-habits'],
			ownerId: 'sh-design',
		},
		{
			id: 'r-stats',
			userStory: 'As a user, I want weekly stats, so I can see my progress.',
			acceptanceCriteria: [
				'Weekly completion chart',
				'Per-habit history',
				'Personal best highlights',
			],
			priority: 'P2',
			estimate: { effort: 5, impact: 5, confidence: 0.6 },
			servesMetricIds: ['m-streak7'],
			edgeCasesAndErrorStates: ['No data yet (empty state)'],
			enhancesRequirementIds: ['r-streaks'],
			ownerId: 'sh-design',
		},
	],

	experience: {
		criticalUserFlows: [
			{
				name: 'First habit',
				steps: ['Open app', 'Create a habit', 'Complete it today'],
				requirementIds: ['r-habits', 'r-streaks'],
			},
			{
				name: 'Daily loop',
				steps: ['Open app', 'Check off todos and habits', 'See streak update'],
				requirementIds: ['r-todos', 'r-streaks'],
			},
		],
		firstRunExperience:
			'A new user is guided to create one habit and complete it immediately, earning a day-1 streak.',
		informationArchitecture:
			'Today list (todos + due habits) -> Habit detail (streak, history).',
		accessibility: {
			standard: 'WCAG 2.2 AA',
			considerations: [
				'Large tap targets',
				'VoiceOver labels for check state',
				'Reduced-motion streak animations',
			],
		},
	},

	technical: {
		platforms: ['ios', 'android'],
		platformStrategy: 'Mobile-first, offline-capable; sync when online.',
		dataModel:
			'User 1—* Todo; User 1—* Habit; Habit 1—* Completion (dated); Streak derived from completions.',
		integrations: [
			{ name: 'Push notification service', purpose: 'Deliver habit reminders' },
		],
	},

	nonFunctional: {
		performanceTargets: [
			'App cold start < 1.5s',
			'Check-off feels instant (< 100ms)',
		],
		scalability:
			'Local-first storage; sync scales per-user, no shared write hotspots.',
		security: ['Encrypt local store', 'Optional passcode lock'],
		availability: '99% for sync (app usable offline)',
		offlineSupport: true,
	},

	constraints: {
		budget: 'Solo-founder budget; keep backend minimal.',
		timeline: 'MVP in 8 weeks.',
		teamCapacity: '1 eng, 1 designer (part-time).',
	},

	assumptions: [
		{
			id: 'as-forgive',
			statement: 'Forgiving streaks retain users better than strict streaks.',
			confidence: 0.6,
			impactIfWrong: 0.8,
			validatedByActivityId: 'a-survey',
			ownerId: 'sh-vance',
		},
		{
			id: 'as-combined',
			statement: 'Users want todos and habits in one app rather than two.',
			confidence: 0.55,
			impactIfWrong: 0.7,
			validatedByActivityId: 'a-proto',
			ownerId: 'sh-design',
		},
	],

	risks: [
		{
			id: 'rk-churn',
			description: 'Habit apps have notoriously high early churn.',
			type: 'market_risk',
			likelihood: 0.6,
			impact: 0.8,
			threatensAssumptionIds: ['as-forgive'],
			mitigation:
				'Fast onboarding to a day-1 win; forgiving streaks; minimal configuration.',
			validatedByActivityId: 'a-survey',
			ownerId: 'sh-vance',
		},
		{
			id: 'rk-blur',
			description: 'Combining todos and habits confuses the mental model.',
			type: 'market_risk',
			likelihood: 0.4,
			impact: 0.6,
			threatensAssumptionIds: ['as-combined'],
			mitigation:
				'Clear visual distinction; test the combined view in prototype.',
			validatedByActivityId: 'a-proto',
			ownerId: 'sh-design',
		},
		{
			id: 'rk-sync',
			description:
				'Offline-first sync produces conflicting completion records.',
			type: 'technical_risk',
			likelihood: 0.4,
			impact: 0.6,
			mitigation:
				'Idempotent dated completions; conflict-free merge by day; server clock authority for streaks.',
			ownerId: 'sh-idris',
		},
	],

	validation: {
		isGate: true,
		goCriteria:
			'Prototype users create a habit and return day 2; forgiving streaks preferred over strict in A/B.',
		noGoCriteria:
			'If users do not return after day 1 or find the combined model confusing, rethink the concept.',
		experiments: ['Survey (a-survey)', 'Prototype test (a-proto)'],
		blocksPhaseId: 'p-mvp',
	},

	roadmap: {
		phases: [
			{
				id: 'p-mvp',
				name: 'MVP',
				goal: 'A user can track todos and forgiving habit streaks in one app.',
				featureRequirementIds: ['r-todos', 'r-habits', 'r-streaks'],
				estimate: { effort: 0, impact: 9, confidence: 0.65 },
			},
			{
				id: 'p-v1',
				name: 'v1',
				goal: 'Reminders and reflection.',
				featureRequirementIds: ['r-remind', 'r-stats'],
				estimate: { effort: 0, impact: 6, confidence: 0.6 },
				dependsOnPhaseIds: ['p-mvp'],
			},
		],
	},

	execution: {
		milestones: [
			{
				id: 'ms-alpha',
				name: 'TestFlight alpha',
				date: '2026-04-10',
				deliverable: 'Todos + habits + streaks on iOS',
				deliversRequirementIds: ['r-todos', 'r-habits', 'r-streaks'],
				ownerId: 'sh-idris',
			},
			{
				id: 'ms-launch',
				name: 'Store launch',
				date: '2026-06-01',
				deliverable: 'Public release with reminders',
				deliversRequirementIds: ['r-remind'],
				ownerId: 'sh-vance',
			},
		],
		launchPlan: {
			softLaunch: {
				audience: 'TestFlight/beta cohort',
				successCriteria: 'First-Habit Setup >= 50% and day-2 return positive.',
			},
			generalAvailability: {
				criteria:
					'Early uninstall rate under guardrail and 7-day streak rate trending up.',
			},
			rolloutStrategy: 'Beta cohort, then public app-store launch.',
		},
		analyticsEvents: [
			{
				id: 'ev-app-opened',
				name: 'app_opened',
				description: 'User opens the app.',
			},
			{
				id: 'ev-habit-created',
				name: 'habit_created',
				description: 'User creates a habit.',
			},
			{
				id: 'ev-item-completed',
				name: 'item_completed',
				description: 'User completes a todo or habit.',
			},
			{
				id: 'ev-streak-reached',
				name: 'streak_reached',
				description: 'A habit reaches a streak milestone.',
			},
		],
		qualityBar:
			'Tested on iOS and Android; offline completion and sync verified; streak logic unit-tested across timezone edges.',
		userCommunicationPlan: 'Onboarding, gentle reminder copy, release notes.',
	},

	coexistence: {
		permissionsAndRoles: ['Single-user accounts; no sharing'],
		featureInteractions: [
			'Reminders respect OS notification settings',
			'Stats read from completion history only',
		],
		dependencies: ['Push notification service'],
		vendorRisks: [
			{
				vendor: 'Push notification service',
				whatItProvides: 'Reminder delivery',
				contingency: 'Fall back to local notifications scheduled on-device.',
			},
		],
	},

	postLaunch: {
		ownership:
			'Founder owns retention and streaks; Eng owns sync and reliability; Design owns onboarding.',
		killCriteria: [
			{
				metricId: 'm-firsthabit',
				threshold: 'First-Habit Setup < 25% sustained',
				action: 'pivot',
			},
			{
				metricId: 'm-dau-checkins',
				threshold: 'Daily Check-ins decline for two months post-launch',
				action: 'reassess',
			},
		],
		rollbackPlan:
			'Feature-flag reminders/stats off; core local todo+habit tracking remains.',
		dataRetention:
			'All data local by default; deleted on uninstall; cloud sync data deleted on account deletion.',
	},

	openQuestions: [
		{
			question: 'How many grace days before a streak breaks?',
			owner: 'Product',
			blocking: true,
		},
		{
			question: 'Do we add a paid tier for stats history?',
			owner: 'Product',
			blocking: false,
		},
	],
}
