/**
 * Cardstack — a worked PRD using the v3 types.
 *
 * You tell Cardstack about the people in your life and their occasions; it
 * generates a personalized card per occasion and ships you one organized stack
 * for the year, labeled by send-date. You sign and mail; it nudges you when.
 *
 * Ported verbatim in content from the autofactory worked example, adapted only
 * to house style (tabs, single quotes, no semicolons) and the v3 import path.
 */
import type { PRD } from '../prd/prd.types.ts'

export const cardstackPRD: PRD = {
	schemaVersion: '3.0.0',
	estimateUnit: 'person-days',

	meta: {
		title: 'Cardstack — Your Whole Year of Cards, Done in One Sitting',
		author: 'J. Rivera, Product',
		status: 'in_review',
		version: '0.4',
		lastUpdated: '2026-06-20',
		approvers: [
			{
				id: 'sh-okafor',
				name: 'A. Okafor',
				role: 'Head of Product',
				involvement: 'approver',
			},
			{
				id: 'sh-tan',
				name: 'L. Tan',
				role: 'Eng Lead',
				involvement: 'approver',
			},
		],
		stakeholders: [
			{
				id: 'sh-schwartz',
				name: 'M. Schwartz',
				role: 'Ops/Fulfillment',
				involvement: 'consulted',
			},
			{
				id: 'sh-design',
				name: 'Design',
				role: 'Card systems & flow',
				involvement: 'responsible',
			},
			{
				id: 'sh-content',
				name: 'Content/Trust',
				role: 'Generation quality & tone',
				involvement: 'responsible',
			},
			{
				id: 'sh-growth',
				name: 'Growth PM',
				role: 'Activation & renewal',
				involvement: 'responsible',
			},
		],
		revisionHistory: [
			{
				version: '0.1',
				date: '2026-05-02',
				author: 'J. Rivera',
				summary: 'Initial problem + scope.',
			},
			{
				version: '0.2',
				date: '2026-05-28',
				author: 'J. Rivera',
				summary: 'Added fulfillment risks, kill criteria.',
			},
			{
				version: '0.3',
				date: '2026-06-20',
				author: 'J. Rivera',
				summary: 'Wired metrics to requirements; gated build on concierge.',
			},
			{
				version: '0.4',
				date: '2026-06-20',
				author: 'J. Rivera',
				summary:
					'Recipient persona + hollowness risk; promoted scope to requirements; trust requirement; real unit economics.',
			},
		],
	},

	context: {
		tldr: 'Thoughtful people consistently miss cards they meant to send. Cardstack turns a year of occasions into one ~30-minute setup, generates a personalized card per occasion, and mails you the whole stack pre-organized by send-date. You sign and mail; we remind you when.',
		background:
			'Card-sending is high-intent but low-follow-through. The planning cost is paid per-occasion all year. Batching it into a single session is the unlock.',
	},

	problem: {
		statement:
			"People who want to keep up with cards for everyone in their life can't reliably do it: the effort is scattered across the year and each occasion is a fresh scramble.",
		costOfInaction:
			'Missed occasions quietly erode relationships and produce guilt; the user keeps paying for fragmented last-minute fixes that cost more and feel less personal.',
		painkillerOrVitamin: 'painkiller',
	},

	discovery: {
		activities: [
			{
				id: 'a-interview',
				description: '1:1 interviews with 12 people who send 10+ cards/year',
				type: 'user_research',
				status: 'done',
				outcome:
					'Strong intent + chronic follow-through failure; most plan ad hoc, not a year ahead.',
			},
			{
				id: 'a-prototype',
				description:
					'Clickable prototype of people -> occasions -> stack preview',
				type: 'prototyping',
				status: 'in_progress',
			},
			{
				id: 'a-printspike',
				description:
					'Print/fulfillment vendor spike for quality + per-unit cost',
				type: 'technical_spike',
				status: 'planned',
			},
			{
				id: 'a-concierge',
				description:
					"Concierge MVP: hand-build & ship 5 households' full-year stacks",
				type: 'experiment',
				status: 'planned',
			},
			{
				id: 'a-recipient',
				description:
					'Blind test: do recipients perceive AI-assisted cards as less heartfelt?',
				type: 'experiment',
				status: 'planned',
			},
		],
		researchMethod: {
			approach: '1:1 semi-structured interviews',
			sampleSize: 12,
			whoWasResearched: 'Adults sending 10+ physical cards/year',
		},
	},

	audience: {
		personas: [
			{
				name: 'Maya, thoughtful-but-swamped',
				description: '37, full-time job, large family and close friend group.',
				contextOfUse:
					'Sets up on a laptop one evening; gets phone nudges through the year.',
				goals: ['Never miss someone who matters', 'Have it feel personal'],
				frustrations: ['Remembers two days too late', 'Drugstore aisle at 9pm'],
				relationshipToProduct: 'primary_user',
			},
			{
				name: 'Dev, the spreadsheet gifter',
				description:
					'44, already tracks birthdays in a spreadsheet, buys multipacks.',
				contextOfUse:
					'Wants to replace his manual system with one that also writes the cards.',
				goals: ['Consolidate his system', 'Cut per-card effort'],
				frustrations: [
					'His spreadsheet writes nothing',
					'Still scrambles to mail',
				],
				relationshipToProduct: 'primary_user',
			},
			{
				name: 'Priya, the recipient',
				description:
					"Maya's aunt. Doesn't use Cardstack; receives a card from someone who does.",
				contextOfUse: 'Opens a physical card on her birthday.',
				goals: ['Feel genuinely thought of'],
				frustrations: [
					'A card that reads generic or machine-written would feel worse than none',
				],
				relationshipToProduct: 'affected_party',
			},
		],
		jobsToBeDone: [
			'When someone I love has an occasion coming up, I want a personal card ready to go, so I can show I care without scrambling.',
			'When I set things up once, I want the whole year handled, so I stop having to pay attention.',
		],
		currentWorkarounds: [
			'Birthday spreadsheet + phone reminders',
			'Drugstore aisle, last minute',
			'Amazon multipacks',
			'Paperless Post e-cards',
		],
		researchEvidence: [
			'Interview notes (a-interview)',
			'Waitlist survey n=210',
		],
	},

	market: {
		competitors: [
			{
				name: 'Punkpost / Postable',
				type: 'direct',
				strengths: ['On-demand personal cards', 'Handwriting'],
				weaknesses: ['Per-card effort', 'No year-ahead batch'],
			},
			{
				name: 'Paperless Post',
				type: 'indirect',
				strengths: ['Cheap, instant'],
				weaknesses: ['Digital — no keepsake'],
			},
			{
				name: 'Drugstore aisle',
				type: 'indirect',
				strengths: ['Immediate, tactile'],
				weaknesses: ['Last-minute, impersonal, you must remember'],
			},
		],
		differentiation:
			'The only option that batches the whole year, personalizes every card, and ships you a physical, send-date-organized stack you keep control of. Rivals are per-card and on-demand.',
	},

	goals: {
		northStarMetric: {
			id: 'm-coverage',
			name: 'On-Time Occasion Coverage',
			definition:
				"Share of a household's tracked occasions for which a card was mailed on time. NOTE: measured via self-reported mark-as-mailed (ev-card-mailed), so its integrity depends on reminder adoption — see rk-selfreport.",
			baseline: 0,
			target: '70%+ by end of first full cycle',
			timeframe: '1 year',
			measuredByEventIds: ['ev-card-mailed'],
			ownerId: 'sh-growth',
		},
		businessGoals: [
			{
				id: 'bg-revenue',
				statement:
					'Reach 10,000 paying households in year one at positive contribution margin.',
			},
			{ id: 'bg-renewal', statement: 'Achieve 60%+ annual renewal.' },
		],
		userGoals: [
			{
				id: 'ug-nomiss',
				statement: "Never miss an important person's occasion.",
			},
			{
				id: 'ug-effort',
				statement: 'Spend ~30 minutes for the year and still feel personal.',
			},
		],
		goalAlignment: [
			{
				businessGoalId: 'bg-revenue',
				userGoalId: 'ug-effort',
				tension:
					'Revenue tempts upsells and per-card add-ons; users want a simple flat price.',
				resolution:
					'One generous flat annual plan covering a typical household; add-ons never required for core value.',
			},
		],
		supportingMetrics: [
			{
				id: 'm-activation',
				name: 'First-Stack Completion',
				definition:
					'Share of new users who finish setup and approve their stack.',
				baseline: 0,
				target: '55%+',
				measuredByEventIds: ['ev-stack-approved'],
				ownerId: 'sh-growth',
			},
			{
				id: 'm-renewal',
				name: 'Annual Renewal Rate',
				definition: 'Share of households who renew for a second year.',
				baseline: 0,
				target: '60%+',
				measuredByEventIds: ['ev-renewed'],
				ownerId: 'sh-growth',
			},
			{
				id: 'm-accept',
				name: 'Personalization Acceptance',
				definition: 'Share of generated cards sent with only light edits.',
				baseline: 0,
				target: '75%+',
				measuredByEventIds: ['ev-card-approved'],
				ownerId: 'sh-content',
			},
			{
				id: 'm-recipient',
				name: 'Recipient Warmth',
				definition:
					'Share of blind-tested recipients rating the card as heartfelt as a hand-picked one.',
				baseline: 0,
				target: '>= parity with control',
				measuredByEventIds: ['ev-recipient-rating'],
				ownerId: 'sh-content',
			},
		],
		guardrailMetrics: [
			{
				id: 'm-defect',
				name: 'Print Defect Rate',
				definition: 'Share of shipped cards with a print/quality defect.',
				baseline: 0,
				target: '< 1%',
				measuredByEventIds: ['ev-defect-reported'],
				ownerId: 'sh-schwartz',
			},
			{
				id: 'm-late',
				name: 'Stack Lateness',
				definition: 'Share of stacks delivered after the first send-date.',
				baseline: 0,
				target: '< 2%',
				measuredByEventIds: ['ev-stack-delivered'],
				ownerId: 'sh-schwartz',
			},
		],
		horizonViews: [
			{
				horizon: '3 months',
				whatSuccessLooksLike:
					'Concierge households approve, pay, and would reorder; recipients rate cards at parity; print clears quality.',
			},
			{
				horizon: '1 year',
				whatSuccessLooksLike:
					'Coverage above 70% for active households; renewal trending to target.',
			},
		],
	},

	scope: {
		mustHave: [
			{
				id: 's-people',
				description: 'Add the people in your life with relationship context',
				realizedByRequirementId: 'r-people',
				rationale: {
					reasoning: 'Nothing to personalize without people.',
					heuristicApplied: 'Remove it and core problem unsolved -> must.',
				},
			},
			{
				id: 's-occasions',
				description: 'Capture recurring occasions per person',
				realizedByRequirementId: 'r-occasions',
				rationale: {
					reasoning: 'Occasions are what the stack is built from.',
					heuristicApplied: 'Core value -> must.',
				},
			},
			{
				id: 's-generate',
				description: 'Generate a personalized card per occasion',
				realizedByRequirementId: 'r-generate',
				rationale: {
					reasoning: 'Personalization is the differentiation.',
					heuristicApplied: 'Core value -> must.',
				},
			},
			{
				id: 's-review',
				description: 'Review/approve the stack before printing',
				realizedByRequirementId: 'r-review',
				rationale: {
					reasoning: "Users must trust what's mailed in their name.",
					heuristicApplied: 'Core value -> must.',
				},
			},
			{
				id: 's-fulfill',
				description: 'Print and ship one send-date-organized stack',
				realizedByRequirementId: 'r-fulfill',
				rationale: {
					reasoning: 'The physical stack IS the product.',
					heuristicApplied: 'Core value -> must.',
				},
			},
			{
				id: 's-remind',
				description: 'Remind the user when to mail each card',
				realizedByRequirementId: 'r-remind',
				rationale: {
					reasoning: 'On-time coverage depends on nudges.',
					heuristicApplied: 'Drives north-star -> must.',
				},
			},
			{
				id: 's-trust',
				description:
					"Consent, data minimization, and protection for intimate + minors' data",
				realizedByRequirementId: 'r-trust',
				rationale: {
					reasoning:
						"The product's whole value is holding personal data about your relationships.",
					heuristicApplied: 'Trust failure kills retention -> must.',
				},
			},
		],
		shouldHave: [
			{
				id: 's-import',
				description: 'Import people/dates from phone contacts',
				realizedByRequirementId: 'r-import',
				rationale: {
					reasoning: 'Cuts setup effort; manual entry works without it.',
					heuristicApplied:
						'Improves activation, not required for value -> should.',
				},
			},
			{
				id: 's-themes',
				description: 'Multiple card themes and tone control',
				realizedByRequirementId: 'r-themes',
				rationale: {
					reasoning: 'Raises acceptance; one good default suffices for v1.',
				},
			},
		],
		couldHave: [
			{
				id: 's-handwriting',
				description: 'Handwriting-style signature option',
				realizedByRequirementId: 'r-handwriting',
				rationale: { reasoning: 'Delight, orthogonal to core flow.' },
			},
		],
		wontHave: [
			{
				id: 's-automail',
				description: 'Mail cards to recipients on your behalf',
				rationale: {
					reasoning:
						'Needs every recipient address, perfect timing, and trust; you can already mail them.',
					heuristicApplied:
						'Removing it still solves the core problem -> defer.',
				},
			},
			{
				id: 's-intl',
				description: 'International shipping',
				rationale: {
					reasoning: 'Fulfillment complexity; focus v1 on one market.',
				},
			},
		],
		nonGoals: [
			'A gifting marketplace',
			'An e-card / digital-only product',
			'A general-purpose reminders app',
		],
	},

	requirements: [
		{
			id: 'r-people',
			userStory:
				'As a user, I want to add the people in my life with context, so cards can be personalized.',
			acceptanceCriteria: [
				'Add/edit/remove a person',
				'Capture relationship and personal notes',
				'Dedupe against imported contacts',
			],
			priority: 'P0',
			priorityRationale: {
				reasoning: 'Foundation for everything downstream.',
				heuristicApplied: 'Blocks all value -> P0.',
			},
			estimate: { effort: 5, impact: 9, confidence: 0.8 },
			servesMetricIds: ['m-activation', 'm-coverage'],
			edgeCasesAndErrorStates: [
				'Duplicate on import',
				'No notes (warm generic fallback)',
				'Person deleted after cards generated',
			],
			interactionsWithExisting: [
				'Contacts import (r-import) must reconcile with manual entries',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-occasions',
			userStory:
				'As a user, I want recurring occasions per person, so the year fills itself in.',
			acceptanceCriteria: [
				'Add recurring occasions with dates',
				'Support shared holidays across people',
				'Edit/skip a single instance',
			],
			priority: 'P0',
			estimate: { effort: 5, impact: 8, confidence: 0.75 },
			servesMetricIds: ['m-activation', 'm-coverage'],
			edgeCasesAndErrorStates: [
				'Leap-day birthdays',
				'Occasion already past this cycle',
				'Two occasions same week for one person',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-generate',
			userStory:
				"As a user, I want a personalized card generated per occasion, so I don't write each from scratch.",
			acceptanceCriteria: [
				'Generate copy + design from person context and occasion type',
				'Always editable before approval; one-tap regenerate',
				'Tone-safety: sympathy/loss, estrangement, and religious-sensitivity occasions use restricted, reviewed templates and never humor',
				'No fabricated specifics (no invented names, dates, or events not supplied by the user)',
				'Reading-level and warmth checks pass before a card is shown',
				'Output that fails safety checks is regenerated, never surfaced',
			],
			priority: 'P0',
			priorityRationale: {
				reasoning:
					'Highest impact and lowest confidence — the make-or-break, so it carries the most acceptance criteria.',
				heuristicApplied: 'Core value + top risk -> most detail.',
			},
			estimate: { effort: 13, impact: 10, confidence: 0.55 },
			servesMetricIds: ['m-accept', 'm-recipient', 'm-coverage'],
			edgeCasesAndErrorStates: [
				'Generation timeout (retry + safe template)',
				'Sensitive relationship mis-tagged',
				"Near-duplicate copy across a user's cards",
			],
			interactionsWithExisting: ['Tone control (r-themes) feeds the generator'],
			ownerId: 'sh-content',
		},
		{
			id: 'r-review',
			userStory:
				"As a user, I want to review and approve the whole stack before printing, so I trust what's mailed in my name.",
			acceptanceCriteria: [
				'Preview every card',
				'Bulk-approve with per-card edits',
				'Lock the stack on approval (no silent changes)',
			],
			priority: 'P0',
			estimate: { effort: 5, impact: 8, confidence: 0.7 },
			servesMetricIds: ['m-accept', 'm-activation'],
			edgeCasesAndErrorStates: [
				'Abandon mid-review (save progress)',
				'Edit after stack is in fulfillment (block + explain)',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-fulfill',
			userStory:
				'As a user, I want my stack printed and shipped organized by send-date, so I just sign and mail in order.',
			acceptanceCriteria: [
				'Print at quality bar',
				'Order/label by send-date',
				'Tracking + delivery confirmation',
			],
			priority: 'P0',
			estimate: { effort: 13, impact: 9, confidence: 0.5 },
			servesMetricIds: ['m-coverage', 'm-defect', 'm-late'],
			edgeCasesAndErrorStates: [
				'Print defect (reprint policy)',
				'Lost/damaged in transit',
				'Late-added occasion after ship (top-up shipment)',
			],
			interactionsWithExisting: [
				'Vendor dependency — see coexistence.vendorRisks',
			],
			ownerId: 'sh-schwartz',
		},
		{
			id: 'r-remind',
			userStory:
				"As a user, I want nudges when to mail each card, so coverage doesn't depend on memory.",
			acceptanceCriteria: [
				'Per-card mail-by reminder',
				'Mark-as-mailed',
				'Snooze/reschedule',
			],
			priority: 'P0',
			estimate: { effort: 3, impact: 8, confidence: 0.8 },
			servesMetricIds: ['m-coverage'],
			edgeCasesAndErrorStates: [
				'OS notifications off (email fallback)',
				'Marked mailed late (counts but flags coverage)',
			],
			interactionsWithExisting: [
				'Must not double-fire with OS calendar reminders',
			],
			ownerId: 'sh-design',
		},
		{
			id: 'r-trust',
			userStory:
				'As a user, I want clear control over the personal data I share, so I trust Cardstack with my relationships.',
			acceptanceCriteria: [
				'Explicit consent for storing personal notes and contacts at setup',
				'Data minimization: store only what personalization needs',
				"Special handling for minors' data (kids' birthdays): minimize, never use for marketing",
				'One-tap export and delete of all household data',
			],
			priority: 'P0',
			priorityRationale: {
				reasoning:
					"Intimate + minors' data is the core asset; a trust failure ends retention.",
				heuristicApplied: 'Trust is existential -> P0.',
			},
			estimate: { effort: 8, impact: 7, confidence: 0.7 },
			servesMetricIds: ['m-renewal'],
			edgeCasesAndErrorStates: [
				'Consent withdrawn mid-cycle',
				'Deletion request while a stack is in fulfillment',
			],
			ownerId: 'sh-content',
		},

		// ---- enhancement requirements (v1/v2) ----
		{
			id: 'r-import',
			userStory:
				'As a user, I want to import people and dates from contacts, so setup is faster.',
			acceptanceCriteria: [
				'Import from Google/Apple contacts',
				'Map birthdays to occasions',
				'Reconcile/merge with manual entries',
			],
			priority: 'P1',
			estimate: { effort: 8, impact: 6, confidence: 0.6 },
			servesMetricIds: ['m-activation'],
			edgeCasesAndErrorStates: [
				'Partial permissions granted',
				'Malformed/missing dates in contacts',
			],
			enhancesRequirementIds: ['r-people', 'r-occasions'],
			ownerId: 'sh-design',
		},
		{
			id: 'r-themes',
			userStory:
				'As a user, I want card themes and tone control, so cards match my relationships.',
			acceptanceCriteria: [
				'Selectable visual themes',
				'Per-person tone (warm/playful/formal)',
				'Tone feeds the generator',
			],
			priority: 'P2',
			estimate: { effort: 8, impact: 6, confidence: 0.6 },
			servesMetricIds: ['m-accept', 'm-recipient'],
			edgeCasesAndErrorStates: ['Theme unavailable for an occasion type'],
			enhancesRequirementIds: ['r-generate'],
			ownerId: 'sh-content',
		},
		{
			id: 'r-handwriting',
			userStory:
				'As a user, I want a handwriting-style signature, so cards feel more personal.',
			acceptanceCriteria: [
				'Choose a handwriting style',
				'Apply to signature line',
			],
			priority: 'P3',
			estimate: { effort: 5, impact: 4, confidence: 0.5 },
			servesMetricIds: ['m-recipient'],
			edgeCasesAndErrorStates: ['Long names overflow the signature area'],
			enhancesRequirementIds: ['r-fulfill'],
			ownerId: 'sh-design',
		},
	],

	experience: {
		criticalUserFlows: [
			{
				name: 'First-run setup',
				steps: [
					'Add people',
					'Add occasions',
					'Preview year stack',
					'Approve',
					'Checkout',
				],
				requirementIds: ['r-people', 'r-occasions', 'r-generate', 'r-review'],
			},
			{
				name: 'Mail a card',
				steps: ['Receive nudge', 'Sign & mail', 'Mark as mailed'],
				requirementIds: ['r-remind'],
			},
			{
				name: 'Edit a generated card',
				steps: ['Open card', 'Edit or regenerate', 'Re-approve'],
				requirementIds: ['r-generate', 'r-review'],
			},
		],
		firstRunExperience:
			"Within minutes of adding real people, the user sees a previewed year of cards for those actual relationships — the 'oh, it's basically done' moment.",
		informationArchitecture:
			'Household -> People -> (each) Occasions -> (each) Card. The annual order is the Stack collecting all approved cards.',
		designLinks: ['https://prototype.example/cardstack-setup'],
		accessibility: {
			standard: 'WCAG 2.2 AA',
			considerations: [
				'Keyboard-navigable review',
				'Contrast on preview UI',
				'Screen-reader labels for stack ordering',
			],
		},
		localization: {
			languages: ['en'],
			considerations: ['Date formats', 'Region-specific holiday sets (later)'],
		},
	},

	technical: {
		platforms: ['web', 'ios'],
		platformStrategy:
			'Web-first for setup-heavy flow; mobile for reminders and mark-as-mailed.',
		dataModel:
			'Household 1—* Person; Person *—* Relationship; Person 1—* Occasion (recurrence rule); Occasion 1—1 Card (copy, design, sendByDate); Stack 1—* Card; Stack 1—1 FulfillmentOrder.',
		integrations: [
			{ name: 'Contacts (Google/Apple)', purpose: 'Import people and dates' },
			{ name: 'Anthropic API', purpose: 'Generate personalized card copy' },
			{
				name: 'Print/fulfillment vendor',
				purpose: 'Print, organize, ship the stack',
			},
			{ name: 'Stripe', purpose: 'Annual subscription billing' },
			{
				name: 'Address validation',
				purpose: "Validate the user's shipping address",
			},
		],
		dataMigration:
			'Greenfield; main migration is one-time contacts import. Relationships/occasions persist year over year (that persistence is the value).',
	},

	nonFunctional: {
		performanceTargets: [
			'Stack preview renders a card in < 2s',
			'Setup usable on mid-tier mobile',
		],
		scalability:
			'Severe seasonal spike (Nov–Dec) plus a spring signup wave; fulfillment and generation must absorb 5–10x baseline. Tracked as rk-season.',
		security: [
			'Encrypt PII at rest (relationships, notes, address)',
			'Scoped access per household',
			'No card content shared across households',
		],
		compliance: [
			'GDPR/CCPA',
			"Heightened care for minors' data (kids' birthdays)",
		],
		availability: '99.9%',
		offlineSupport: false,
	},

	businessModel: {
		type: 'subscription',
		unitEconomics: {
			revenuePerCustomer: 79,
			costLineItems: [
				{ label: 'Card stock (avg 15/yr)', amount: 9 },
				{ label: 'Printing', amount: 12 },
				{ label: 'Postage to user (one stack)', amount: 7 },
				{ label: 'Generation (AI)', amount: 3 },
			],
			customerAcquisitionCost: 28,
			currency: 'USD',
			notes:
				'Illustrative. Contribution margin ~ $79 - $31 COGS - $28 CAC = ~$20 yr1, improving on renewal (no repeat CAC). Margin is volume-sensitive because fulfillment is per-unit.',
		},
		pricingNotes:
			'Flat annual plan covers a typical household; extra cards and premium stock are optional add-ons.',
	},

	constraints: {
		budget: 'Seed-stage; concierge before any fulfillment automation.',
		timeline:
			'Validate by Q3, build Q4, soft launch spring (beta users get a real full year).',
		teamCapacity: '2 eng, 1 designer (shared), 1 ops/fulfillment.',
		regulatoryOrPolicy: [
			'Postal norms',
			'Data-protection law',
			"Extra care for minors' data",
		],
		resourcingCaveats: [
			'Designer split across projects',
			'Vendor lead times constrain print iteration speed',
		],
	},

	assumptions: [
		{
			id: 'as-plan',
			statement: 'People will plan a year ahead in one sitting.',
			confidence: 0.5,
			impactIfWrong: 0.9,
			validatedByActivityId: 'a-concierge',
			ownerId: 'sh-growth',
		},
		{
			id: 'as-trust',
			statement:
				'AI-personalized copy is good enough that people send with only light edits.',
			confidence: 0.6,
			impactIfWrong: 0.8,
			validatedByActivityId: 'a-concierge',
			ownerId: 'sh-content',
		},
		{
			id: 'as-recipient',
			statement:
				"Recipients can't tell (or don't mind) that a card was AI-assisted; it still feels heartfelt.",
			confidence: 0.5,
			impactIfWrong: 0.95,
			validatedByActivityId: 'a-recipient',
			ownerId: 'sh-content',
		},
		{
			id: 'as-selfreport',
			statement:
				'Users will mark-as-mailed reliably enough for coverage to be a trustworthy metric.',
			confidence: 0.5,
			impactIfWrong: 0.6,
			validatedByActivityId: 'a-concierge',
			ownerId: 'sh-growth',
		},
	],

	risks: [
		{
			id: 'rk-lastminute',
			description:
				'People are inherently last-minute, so the year-ahead batch model under-converts.',
			type: 'market_risk',
			likelihood: 0.5,
			impact: 0.9,
			threatensAssumptionIds: ['as-plan'],
			mitigation:
				"Position as 'set once, we nudge you'; allow rolling additions; test conversion in concierge.",
			validatedByActivityId: 'a-interview',
			ownerId: 'sh-growth',
		},
		{
			id: 'rk-hollow',
			description:
				'Recipients perceive AI-assisted cards as impersonal, collapsing the emotional value.',
			type: 'market_risk',
			likelihood: 0.4,
			impact: 0.95,
			threatensAssumptionIds: ['as-recipient', 'as-trust'],
			mitigation:
				"Blind recipient testing (m-recipient); no fabricated specifics; heavy user editing encouraged; lead with user's own words.",
			validatedByActivityId: 'a-recipient',
			ownerId: 'sh-content',
		},
		{
			id: 'rk-fulfill',
			description:
				'Print quality + per-unit cost at the quality bar may not pencil out.',
			type: 'technical_risk',
			likelihood: 0.5,
			impact: 0.8,
			mitigation:
				'Vendor spike with real proofs and costed unit economics before committing.',
			validatedByActivityId: 'a-printspike',
			ownerId: 'sh-schwartz',
		},
		{
			id: 'rk-season',
			description:
				'Holiday fulfillment crush causes late stacks, breaching the lateness guardrail.',
			type: 'operational_risk',
			likelihood: 0.5,
			impact: 0.7,
			mitigation:
				'Earlier send-by cutoffs in Q4; pre-build capacity with vendor; stagger generation; monitor m-late.',
			ownerId: 'sh-schwartz',
		},
		{
			id: 'rk-margin',
			description:
				'Per-unit fulfillment cost erodes contribution margin as volume grows.',
			type: 'operational_risk',
			likelihood: 0.4,
			impact: 0.8,
			mitigation:
				'Negotiate volume print pricing; cap included cards; price add-ons above marginal cost; watch unit economics monthly.',
			ownerId: 'sh-okafor',
		},
		{
			id: 'rk-vendor',
			description:
				'Single print/fulfillment vendor and a single AI text provider.',
			type: 'dependency_risk',
			likelihood: 0.4,
			impact: 0.7,
			mitigation:
				'Qualify a backup printer; keep generation prompts provider-portable.',
			ownerId: 'sh-tan',
		},
		{
			id: 'rk-selfreport',
			description:
				"Users don't reliably mark-as-mailed, so the north-star under-reports real coverage.",
			type: 'operational_risk',
			likelihood: 0.5,
			impact: 0.6,
			threatensAssumptionIds: ['as-selfreport'],
			mitigation:
				'Frictionless one-tap mark; gentle follow-up nudge; consider a delivery-side proxy later.',
			ownerId: 'sh-growth',
		},
	],

	validation: {
		isGate: true,
		goCriteria:
			'From the concierge + recipient tests: a majority of households approve and pay AND express reorder intent; recipients rate cards at parity with hand-picked; the print spike clears quality at a viable unit cost.',
		noGoCriteria:
			"If households won't commit a year up front, recipients can tell and rate cards worse, or print cost/quality can't hit the bar, stop or pivot to an on-demand per-occasion model.",
		experiments: [
			'Landing-page waitlist',
			'Concierge MVP (a-concierge)',
			'Recipient blind test (a-recipient)',
			'Print spike (a-printspike)',
			'Prototype (a-prototype)',
		],
		blocksPhaseId: 'p-mvp',
	},

	roadmap: {
		phases: [
			{
				id: 'p-mvp',
				name: 'MVP',
				goal: 'One household: set up, approve a generated stack, receive it, get mail nudges, with trust controls.',
				featureRequirementIds: [
					'r-people',
					'r-occasions',
					'r-generate',
					'r-review',
					'r-fulfill',
					'r-remind',
					'r-trust',
				],
				estimate: { effort: 0, impact: 10, confidence: 0.55 },
			},
			{
				id: 'p-v1',
				name: 'v1',
				goal: 'Reduce setup friction and raise acceptance.',
				featureRequirementIds: ['r-import', 'r-themes'],
				estimate: { effort: 0, impact: 7, confidence: 0.6 },
				dependsOnPhaseIds: ['p-mvp'],
			},
			{
				id: 'p-v2',
				name: 'v2',
				goal: 'Delight + optional auto-mailing.',
				featureRequirementIds: ['r-handwriting'],
				estimate: { effort: 0, impact: 6, confidence: 0.4 },
				dependsOnPhaseIds: ['p-v1'],
			},
		],
	},

	execution: {
		milestones: [
			{
				id: 'ms-concierge',
				name: 'Concierge stacks shipped',
				date: '2026-08-15',
				deliverable: '5 hand-built stacks + reorder intent + recipient ratings',
				ownerId: 'sh-growth',
			},
			{
				id: 'ms-alpha',
				name: 'Internal alpha',
				date: '2026-11-01',
				deliverable: 'End-to-end flow for dogfooding',
				deliversRequirementIds: [
					'r-people',
					'r-occasions',
					'r-generate',
					'r-review',
					'r-trust',
				],
				ownerId: 'sh-tan',
			},
			{
				id: 'ms-beta',
				name: 'Soft-launch beta',
				date: '2027-03-01',
				deliverable: 'Waitlist beta receives real stacks',
				deliversRequirementIds: ['r-fulfill', 'r-remind'],
				ownerId: 'sh-tan',
			},
			{
				id: 'ms-ga',
				name: 'General availability',
				date: '2027-05-15',
				deliverable: 'Public launch ahead of summer occasions',
				ownerId: 'sh-okafor',
			},
		],
		launchPlan: {
			softLaunch: {
				audience: 'Waitlist beta, ~200 households',
				successCriteria:
					'First-Stack Completion >= 45% and no systemic print/late failures. 30–45% -> iterate before GA (not kill); < 30% sustained -> trigger kill criterion.',
			},
			generalAvailability: {
				criteria:
					'Beta guardrails hold (defect < 1%, lateness < 2%), recipient ratings at parity, renewal-intent positive.',
			},
			rolloutStrategy:
				'Feature-flagged; timed for spring so beta users see a full annual cycle; staged % ramp.',
		},
		analyticsEvents: [
			{
				id: 'ev-person-added',
				name: 'person_added',
				description: 'User adds a person.',
			},
			{
				id: 'ev-occasion-added',
				name: 'occasion_added',
				description: 'User adds an occasion.',
			},
			{
				id: 'ev-stack-approved',
				name: 'stack_approved',
				description: 'User approves their stack (activation).',
			},
			{
				id: 'ev-card-approved',
				name: 'card_approved',
				description:
					'User approves an individual card, with edit-distance from the draft.',
			},
			{
				id: 'ev-stack-delivered',
				name: 'stack_delivered',
				description: 'Carrier confirms stack delivered to user.',
			},
			{
				id: 'ev-card-mailed',
				name: 'card_marked_mailed',
				description: 'User marks a card as mailed (feeds coverage).',
			},
			{
				id: 'ev-recipient-rating',
				name: 'recipient_rating',
				description: 'Blind-test recipient warmth rating.',
			},
			{
				id: 'ev-defect-reported',
				name: 'defect_reported',
				description: 'User reports a print/quality defect.',
			},
			{
				id: 'ev-renewed',
				name: 'renewed',
				description: 'Household renews for another year.',
			},
		],
		qualityBar:
			'Print proof QA on every template; flows tested on iOS + mobile web; load test for 10x holiday spike before GA.',
		userCommunicationPlan:
			'Onboarding sequence, in-app nudges, shipping/tracking notifications, changelog for new themes.',
		internalEnablement:
			"Support scripts for late/damaged stacks and reprints; FAQ on the 'you sign and mail' model vs auto-mailing.",
	},

	coexistence: {
		permissionsAndRoles: [
			'Primary account holder edits everything',
			'Optional shared household viewer can preview but not approve/checkout',
		],
		featureInteractions: [
			'Contacts import must dedupe against manual people',
			'App reminders must not double-fire with OS calendar entries',
		],
		dependencies: [
			'Print/fulfillment vendor',
			'AI text provider',
			'Stripe billing',
			'Address validation',
		],
		vendorRisks: [
			{
				vendor: 'Print/fulfillment vendor',
				whatItProvides: 'Printing, send-date organization, shipping',
				contingency:
					'Qualify a second printer; abstract the fulfillment interface so vendors are swappable.',
			},
			{
				vendor: 'AI text provider',
				whatItProvides: 'Card copy generation',
				contingency:
					'Keep prompts provider-portable; cache approved copy so an outage never blocks an in-flight stack.',
			},
		],
	},

	postLaunch: {
		ownership:
			'Growth PM owns coverage + renewal; Ops owns defect/lateness; Content owns acceptance + recipient warmth; on-call eng owns generation/fulfillment incidents.',
		killCriteria: [
			{
				metricId: 'm-activation',
				threshold: 'First-Stack Completion < 30% sustained through beta',
				action: 'pivot',
			},
			{
				metricId: 'm-recipient',
				threshold:
					'Recipients consistently rate cards below hand-picked control',
				action: 'pivot',
			},
			{
				metricId: 'm-renewal',
				threshold: 'Annual Renewal < 35% after first full cycle',
				action: 'reassess',
			},
		],
		rollbackPlan:
			'Feature-flag new templates/flows off; freeze new generation while honoring already-approved stacks in fulfillment.',
		costOverTime: [
			{ scale: '1k households', estimatedMonthlyCost: 9000, currency: 'USD' },
			{
				scale: '100k households',
				estimatedMonthlyCost: 700000,
				currency: 'USD',
			},
		],
		dataRetention:
			'Relationships/occasions retained across years (the core value) until the user deletes; addresses retained only as needed; full export + delete on request.',
	},

	openQuestions: [
		{
			question: 'Do we ever store recipient addresses, given v2 auto-mailing?',
			owner: 'Legal/Product',
			blocking: false,
		},
		{
			question: 'Exact tone guardrails for sympathy/loss occasions?',
			owner: 'Content/Design',
			blocking: true,
		},
		{
			question: 'Minimum viable holiday set for v1?',
			owner: 'Product',
			blocking: false,
		},
	],

	decisions: [
		{
			id: 'd-shipmodel',
			decision: 'How cards reach recipients',
			chosenOption:
				'Ship the organized stack to the user; they sign and mail it.',
			rejectedAlternatives: [
				{
					option: 'Auto-mail to each recipient',
					whyRejected:
						'Requires every recipient address, flawless timing, and high trust; large logistics + privacy surface. Deferred to v2.',
				},
				{
					option: 'Digital/e-cards',
					whyRejected:
						'Loses the physical keepsake gesture that is the entire emotional value.',
				},
			],
			date: '2026-05-28',
		},
	],

	glossary: [
		{
			term: 'Stack',
			definition:
				"The user's full annual set of approved cards, organized by send-date.",
		},
		{
			term: 'Occasion',
			definition: 'A dated, usually recurring event for a person.',
		},
		{
			term: 'Household',
			definition: 'The account unit; people and occasions belong to it.',
		},
	],
}
