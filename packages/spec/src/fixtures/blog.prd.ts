/**
 * Blog — a compact worked PRD (v3): a minimal multi-author blogging platform.
 *
 * Authors write and publish posts under a shared publication; readers browse and
 * read. Authored fresh in house style; passes runtime referential-integrity
 * validation.
 */
import type { PRD } from '../prd/prd.types.ts'

export const blogPRD: PRD = {
	schemaVersion: '3.0.0',
	estimateUnit: 'story-points',

	meta: {
		title: 'Blog — A Minimal Multi-Author Publishing Platform',
		author: 'D. Osei, Product',
		status: 'draft',
		version: '0.1',
		lastUpdated: '2026-04-02',
		approvers: [
			{
				id: 'sh-osei',
				name: 'D. Osei',
				role: 'Product Lead',
				involvement: 'approver',
			},
			{
				id: 'sh-lin',
				name: 'W. Lin',
				role: 'Eng Lead',
				involvement: 'approver',
			},
		],
		stakeholders: [
			{
				id: 'sh-design',
				name: 'Design',
				role: 'Editor + reading UX',
				involvement: 'responsible',
			},
			{
				id: 'sh-growth',
				name: 'Growth',
				role: 'Reader acquisition',
				involvement: 'responsible',
			},
		],
	},

	context: {
		tldr: 'Small teams and communities want a shared blog without wrestling a CMS. Blog gives multiple authors a clean editor and readers a fast, distraction-free reading experience.',
		background:
			'General-purpose CMSes are heavy; single-author tools do not model multiple contributors. A focused multi-author platform sits in between.',
	},

	problem: {
		statement:
			'Groups that want to publish together lack a lightweight tool: existing options are either single-author or overweight CMSes.',
		costOfInaction:
			'Teams stall on setup, publish inconsistently, or scatter posts across personal accounts.',
		painkillerOrVitamin: 'vitamin',
	},

	discovery: {
		activities: [
			{
				id: 'a-interview',
				description: 'Interview 10 people who run small group blogs today',
				type: 'user_research',
				status: 'done',
				outcome:
					'Editing friction and author management are the main pain points.',
			},
			{
				id: 'a-proto',
				description: 'Prototype editor and publication home',
				type: 'prototyping',
				status: 'planned',
			},
		],
		researchMethod: {
			approach: 'Interviews',
			sampleSize: 10,
			whoWasResearched: 'Operators of small multi-author blogs',
		},
	},

	audience: {
		personas: [
			{
				name: 'Nadia, the editor',
				description:
					'Runs a community publication with a handful of contributors.',
				contextOfUse: 'Reviews and publishes posts weekly on desktop.',
				goals: ['Invite authors easily', 'Keep a consistent look'],
				frustrations: ['CMS complexity', 'Managing author access'],
				relationshipToProduct: 'primary_user',
			},
			{
				name: 'Theo, the reader',
				description: 'Follows a few publications and reads on mobile.',
				contextOfUse: 'Reads posts from links shared in chat.',
				goals: ['Read without clutter', 'Load fast'],
				frustrations: ['Ad-heavy, slow blog pages'],
				relationshipToProduct: 'secondary_user',
			},
		],
		jobsToBeDone: [
			'When I have contributors, I want to give them a place to write and publish, so our work lives together.',
			'When I open a post, I want a fast, clean read, so I actually finish it.',
		],
		currentWorkarounds: [
			'WordPress',
			'Shared Google Docs',
			'Personal Medium accounts',
		],
	},

	market: {
		competitors: [
			{
				name: 'WordPress',
				type: 'direct',
				strengths: ['Powerful', 'Plugins'],
				weaknesses: ['Complex', 'Maintenance burden'],
			},
			{
				name: 'Medium',
				type: 'indirect',
				strengths: ['Clean reading', 'No setup'],
				weaknesses: ['Weak custom publications', 'Paywall friction'],
			},
		],
		differentiation:
			'Multi-author by default, clean reading experience, and near-zero setup — without CMS overhead.',
	},

	goals: {
		northStarMetric: {
			id: 'm-published-posts',
			name: 'Weekly Published Posts',
			definition: 'Posts published across all publications in a given week.',
			baseline: 0,
			target: '2,000/week by year end',
			timeframe: '1 year',
			measuredByEventIds: ['ev-post-published'],
			ownerId: 'sh-growth',
		},
		businessGoals: [
			{
				id: 'bg-pubs',
				statement: 'Reach 5,000 active publications in year one.',
			},
			{ id: 'bg-readers', statement: 'Grow to 1M monthly readers.' },
		],
		userGoals: [
			{ id: 'ug-publish', statement: 'Publish together with minimal setup.' },
			{ id: 'ug-read', statement: 'Read posts fast and clutter-free.' },
		],
		goalAlignment: [
			{
				businessGoalId: 'bg-readers',
				userGoalId: 'ug-read',
				tension:
					'Growth tactics (interstitials, prompts) can degrade the reading experience.',
				resolution:
					'Keep the reading page clean; growth surfaces live off the reading path.',
			},
		],
		supportingMetrics: [
			{
				id: 'm-firstpost',
				name: 'First-Post Activation',
				definition:
					'Share of new publications that publish a post within a week.',
				baseline: 0,
				target: '50%+',
				measuredByEventIds: ['ev-post-published'],
				ownerId: 'sh-growth',
			},
			{
				id: 'm-read',
				name: 'Read Completion',
				definition: 'Share of opened posts scrolled to the end.',
				baseline: 0,
				target: '45%+',
				measuredByEventIds: ['ev-post-read'],
				ownerId: 'sh-design',
			},
		],
		guardrailMetrics: [
			{
				id: 'm-ttfb',
				name: 'Post Load Time',
				definition: 'p95 time to first meaningful paint on a post page.',
				baseline: 0,
				target: '< 1.2s',
				measuredByEventIds: ['ev-post-opened'],
				ownerId: 'sh-lin',
			},
		],
	},

	scope: {
		mustHave: [
			{
				id: 's-pub',
				description: 'Create a publication and invite authors',
				realizedByRequirementId: 'r-pub',
				rationale: { reasoning: 'The multi-author container.' },
			},
			{
				id: 's-editor',
				description: 'Write and edit posts in a clean editor',
				realizedByRequirementId: 'r-editor',
				rationale: { reasoning: 'Authoring is the core job.' },
			},
			{
				id: 's-publish',
				description: 'Publish and unpublish posts',
				realizedByRequirementId: 'r-publish',
				rationale: { reasoning: 'Publishing is the payoff.' },
			},
			{
				id: 's-read',
				description: 'Public reading pages for posts',
				realizedByRequirementId: 'r-read',
				rationale: { reasoning: 'Readers are the audience.' },
			},
		],
		shouldHave: [
			{
				id: 's-comments',
				description: 'Reader comments on posts',
				realizedByRequirementId: 'r-comments',
				rationale: { reasoning: 'Engagement; not required for core value.' },
			},
		],
		couldHave: [
			{
				id: 's-custom',
				description: 'Custom domain per publication',
				realizedByRequirementId: 'r-custom',
				rationale: { reasoning: 'Branding delight for serious publications.' },
			},
		],
		wontHave: [
			{
				id: 's-store',
				description: 'E-commerce / paid subscriptions',
				rationale: { reasoning: 'Out of scope for the minimal platform.' },
			},
		],
		nonGoals: [
			'A full CMS with plugins',
			'Newsletter/email delivery',
			'Paywalls',
		],
	},

	requirements: [
		{
			id: 'r-pub',
			userStory:
				'As an editor, I want to create a publication and invite authors, so we publish together.',
			acceptanceCriteria: [
				'Create a publication with name and description',
				'Invite authors by email',
				'Roles: editor and author',
			],
			priority: 'P0',
			estimate: { effort: 3, impact: 8, confidence: 0.8 },
			servesMetricIds: ['m-firstpost'],
			edgeCasesAndErrorStates: [
				'Invite to an existing member',
				'Removing the last editor',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-editor',
			userStory: 'As an author, I want a clean editor, so writing is pleasant.',
			acceptanceCriteria: [
				'Rich-text editing with headings, links, images',
				'Autosave drafts',
				'Preview before publish',
			],
			priority: 'P0',
			estimate: { effort: 5, impact: 9, confidence: 0.7 },
			servesMetricIds: ['m-published-posts'],
			edgeCasesAndErrorStates: [
				'Lost connection mid-edit (recover draft)',
				'Large image upload',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-publish',
			userStory:
				'As an author, I want to publish and unpublish posts, so I control what is live.',
			acceptanceCriteria: [
				'Publish a draft',
				'Unpublish/revert to draft',
				'Show published date and author',
			],
			priority: 'P0',
			estimate: { effort: 2, impact: 8, confidence: 0.8 },
			servesMetricIds: ['m-published-posts', 'm-firstpost'],
			edgeCasesAndErrorStates: [
				'Publishing an empty post',
				'Two authors editing the same post',
			],
			ownerId: 'sh-lin',
		},
		{
			id: 'r-read',
			userStory:
				'As a reader, I want fast, clean reading pages, so I finish posts.',
			acceptanceCriteria: [
				'Distraction-free post layout',
				'Mobile-responsive',
				'Shareable canonical URL',
			],
			priority: 'P0',
			estimate: { effort: 3, impact: 9, confidence: 0.75 },
			servesMetricIds: ['m-read', 'm-ttfb'],
			edgeCasesAndErrorStates: [
				'Unpublished post accessed by old link (404)',
				'Very long posts',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-comments',
			userStory: 'As a reader, I want to comment, so I can respond to posts.',
			acceptanceCriteria: [
				'Post a comment when signed in',
				'Editors can moderate/remove',
				'Comments off per-post',
			],
			priority: 'P1',
			estimate: { effort: 5, impact: 6, confidence: 0.6 },
			servesMetricIds: ['m-read'],
			edgeCasesAndErrorStates: [
				'Spam floods',
				'Comment on an unpublished post',
			],
			enhancesRequirementIds: ['r-read'],
			ownerId: 'sh-growth',
		},
		{
			id: 'r-custom',
			userStory:
				'As an editor, I want a custom domain, so the publication feels like ours.',
			acceptanceCriteria: [
				'Connect a custom domain',
				'Automatic HTTPS',
				'Fallback to default subdomain',
			],
			priority: 'P2',
			estimate: { effort: 5, impact: 5, confidence: 0.55 },
			servesMetricIds: ['m-firstpost'],
			edgeCasesAndErrorStates: [
				'DNS misconfiguration',
				'Certificate provisioning delay',
			],
			enhancesRequirementIds: ['r-pub'],
			ownerId: 'sh-lin',
		},
	],

	experience: {
		criticalUserFlows: [
			{
				name: 'Start a publication',
				steps: ['Create publication', 'Invite authors', 'Write first post'],
				requirementIds: ['r-pub', 'r-editor'],
			},
			{
				name: 'Publish a post',
				steps: ['Draft in editor', 'Preview', 'Publish'],
				requirementIds: ['r-editor', 'r-publish'],
			},
			{
				name: 'Read a post',
				steps: ['Open shared link', 'Read', 'Share'],
				requirementIds: ['r-read'],
			},
		],
		firstRunExperience:
			'A new editor creates a publication and lands directly in the editor with a starter post to publish immediately.',
		informationArchitecture:
			'Publication -> Authors + Posts; Post -> Draft/Published states; public reading pages per published post.',
		accessibility: {
			standard: 'WCAG 2.2 AA',
			considerations: [
				'Semantic headings in reading view',
				'Editor keyboard shortcuts',
				'Sufficient contrast',
			],
		},
	},

	technical: {
		platforms: ['web'],
		platformStrategy:
			'Server-rendered reading pages for speed and SEO; SPA editor for authoring.',
		dataModel:
			'Publication 1—* Membership (author/editor); Publication 1—* Post; Post has draft/published state; Post 1—* Comment.',
		integrations: [
			{ name: 'Object storage', purpose: 'Store uploaded images' },
			{ name: 'Email provider', purpose: 'Send author invites' },
		],
	},

	nonFunctional: {
		performanceTargets: [
			'Post page FMP < 1.2s p95',
			'Editor autosave within 2s of a pause',
		],
		scalability:
			'Reading traffic served from cache/CDN; authoring load is modest.',
		security: [
			'Role-based access per publication',
			'Sanitize post HTML',
			'Rate-limit comments',
		],
		availability: '99.9% for reading pages',
		offlineSupport: false,
	},

	constraints: {
		budget: 'Lean; rely on managed storage and CDN.',
		timeline: 'MVP in one quarter.',
		teamCapacity: '2 eng, 1 designer.',
	},

	assumptions: [
		{
			id: 'as-multi',
			statement:
				'Teams want a multi-author tool distinct from single-author blogs.',
			confidence: 0.6,
			impactIfWrong: 0.8,
			validatedByActivityId: 'a-interview',
			ownerId: 'sh-osei',
		},
		{
			id: 'as-clean',
			statement:
				'A clean reading experience meaningfully improves completion and sharing.',
			confidence: 0.6,
			impactIfWrong: 0.6,
			validatedByActivityId: 'a-proto',
			ownerId: 'sh-design',
		},
	],

	risks: [
		{
			id: 'rk-incumbents',
			description:
				'WordPress and Medium dominate; hard to pull publications away.',
			type: 'market_risk',
			likelihood: 0.6,
			impact: 0.8,
			threatensAssumptionIds: ['as-multi'],
			mitigation:
				'Target the underserved small multi-author niche; near-zero setup; import tooling later.',
			validatedByActivityId: 'a-interview',
			ownerId: 'sh-osei',
		},
		{
			id: 'rk-spam',
			description: 'Comments and public pages attract spam and abuse.',
			type: 'operational_risk',
			likelihood: 0.5,
			impact: 0.6,
			mitigation:
				'Sign-in to comment, moderation tools, rate limits, per-post disable.',
			ownerId: 'sh-growth',
		},
		{
			id: 'rk-perf',
			description:
				'Reading pages fail the load-time guardrail under traffic spikes.',
			type: 'technical_risk',
			likelihood: 0.4,
			impact: 0.6,
			mitigation:
				'Static-render + CDN cache published posts; invalidate on publish/unpublish.',
			ownerId: 'sh-lin',
		},
	],

	validation: {
		isGate: true,
		goCriteria:
			'Prototype publications invite authors and publish a first post; readers rate the reading experience above their current tool.',
		noGoCriteria:
			'If teams see no advantage over WordPress/Medium, or setup still stalls, rethink positioning.',
		experiments: ['Interviews (a-interview)', 'Prototype test (a-proto)'],
		blocksPhaseId: 'p-mvp',
	},

	roadmap: {
		phases: [
			{
				id: 'p-mvp',
				name: 'MVP',
				goal: 'A team can create a publication, write, publish, and readers can read.',
				featureRequirementIds: ['r-pub', 'r-editor', 'r-publish', 'r-read'],
				estimate: { effort: 0, impact: 9, confidence: 0.7 },
			},
			{
				id: 'p-v1',
				name: 'v1',
				goal: 'Engagement and branding.',
				featureRequirementIds: ['r-comments', 'r-custom'],
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
				date: '2026-06-15',
				deliverable: 'End-to-end publish and read flow',
				deliversRequirementIds: ['r-pub', 'r-editor', 'r-publish', 'r-read'],
				ownerId: 'sh-lin',
			},
			{
				id: 'ms-beta',
				name: 'Public beta',
				date: '2026-08-01',
				deliverable: 'Beta with comments and custom domains',
				deliversRequirementIds: ['r-comments', 'r-custom'],
				ownerId: 'sh-osei',
			},
		],
		launchPlan: {
			softLaunch: {
				audience: 'Invited publications from research',
				successCriteria:
					'First-Post Activation >= 45% and positive reading feedback.',
			},
			generalAvailability: {
				criteria:
					'Post load p95 < 1.2s and weekly published posts trending up.',
			},
			rolloutStrategy: 'Invite-gated beta, then open publication creation.',
		},
		analyticsEvents: [
			{
				id: 'ev-post-published',
				name: 'post_published',
				description: 'A post is published.',
			},
			{
				id: 'ev-post-opened',
				name: 'post_opened',
				description: 'A reader opens a post page.',
			},
			{
				id: 'ev-post-read',
				name: 'post_read',
				description: 'A reader scrolls a post to the end.',
			},
		],
		qualityBar:
			'Reading pages tested for performance and SEO; editor tested across browsers; HTML sanitization verified.',
		userCommunicationPlan:
			'Onboarding for editors, changelog, reader-facing help.',
	},

	coexistence: {
		permissionsAndRoles: [
			'Editors manage members and moderate',
			'Authors write and publish their own posts',
		],
		featureInteractions: [
			'Comments can be disabled per post',
			'Custom domains fall back to default subdomain',
		],
		dependencies: ['Object storage', 'Email provider', 'CDN'],
		vendorRisks: [
			{
				vendor: 'Object storage',
				whatItProvides: 'Image hosting',
				contingency:
					'Abstract storage interface; enforce size limits; swap providers if needed.',
			},
			{
				vendor: 'CDN',
				whatItProvides: 'Cached reading-page delivery',
				contingency:
					'Origin can serve directly at reduced performance; multi-CDN later.',
			},
		],
	},

	postLaunch: {
		ownership:
			'Growth owns activation and readers; Eng owns performance and reliability; Design owns editor and reading UX.',
		killCriteria: [
			{
				metricId: 'm-firstpost',
				threshold: 'First-Post Activation < 20% sustained through beta',
				action: 'pivot',
			},
			{
				metricId: 'm-published-posts',
				threshold: 'Weekly Published Posts flat for two months post-GA',
				action: 'reassess',
			},
		],
		rollbackPlan:
			'Feature-flag comments/custom domains off; core publish and read remain available.',
		dataRetention:
			'Posts retained until deleted by an editor; images purged on post deletion; export on request.',
	},

	openQuestions: [
		{
			question: 'Do we offer post version history in v1?',
			owner: 'Product',
			blocking: false,
		},
		{
			question: 'How do we handle author departure — reassign or keep byline?',
			owner: 'Product/Legal',
			blocking: false,
		},
	],
}
