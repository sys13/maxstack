/**
 * Example app: crmlite (a solo-founder’s contacts + deal pipeline).
 *
 * PRD grounding via the compact `examplePRD` builder. A pipeline
 * domain with a stage lifecycle (contacts → deals → activities) — the tenth
 * example rounds out a set of ten apps biased toward sustained change.
 */

import { examplePRD } from './deps.ts'
import {
	addBoard,
	addField,
	addPage,
	belongsTo,
	crudExample,
	ejectPage,
	entity,
	enumField,
	field,
	fillSlot,
	fillSourceRefiner,
	offSurface,
	page,
	rankField,
	retitle,
	schedule,
	slot,
	source,
	table,
} from './kit.ts'

const entities = [
	entity('e-deal', 'Deal', 'An opportunity moving through the pipeline.', [
		field('fld-deal-name', 'name', 'string', true),
		// SPEC EDIT 2026-07-28: the pipeline stages are now declared,
		// and a deal carries a manual-ordering key. A CRM whose pipeline stages are
		// undeclared is under-specified — the stage lifecycle is the product — and
		// both were prerequisites the pipeline-board ask presupposed. See
		// docs/corpus/crmlite-pipeline-stages.md.
		enumField(
			'fld-deal-stage',
			'stage',
			['lead', 'qualified', 'proposal', 'won', 'lost'],
			true,
		),
		field('fld-deal-value', 'value', 'number'),
		rankField('fld-deal-rank', 'pipelineRank'),
	]),
	entity('e-contact', 'Contact', 'A person in the network.', [
		field('fld-contact-name', 'name', 'string', true),
		field('fld-contact-email', 'email', 'string'),
	]),
	entity('e-activity', 'Activity', 'A dated touchpoint with a contact.', [
		field('fld-activity-kind', 'kind', 'enum', true),
		field('fld-activity-date', 'date', 'date', true),
	]),
	// SPEC EDIT 2026-07-28: the inbox a founder syncs has to land
	// somewhere, and "somewhere" is a modelled entity with a stable remote id —
	// without one, every sync run appends the same messages again. The `contact`
	// FK is the thing the ask calls *threading*; it is declared here and resolved
	// in the refiner, because matching an address to a contact is a lookup against
	// local rows and not a path into a response.
	// See docs/corpus/crmlite-inbox-source.md.
	entity('e-message', 'Message', 'An email message synced from the inbox.', [
		field('fld-message-remote-id', 'remoteId', 'string', true),
		field('fld-message-subject', 'subject', 'string', true),
		field('fld-message-from', 'fromEmail', 'string'),
		field('fld-message-sent', 'sentAt', 'date'),
		belongsTo('fld-message-contact', 'contact', 'e-contact'),
	]),
]

/**
 * SPEC EDIT 2026-07-28 — the inbox poll and the source it drives.
 *
 * Declared as part of what the app *is*, on the same terms schedules were in
 * #181: the backlog ask below is what is *asked of it*. The source declares
 * `refine: true` because the threading half of that ask genuinely is code.
 * See docs/corpus/crmlite-inbox-source.md.
 */
const schedules = [
	schedule({
		id: 'sch-inbox-poll',
		key: 'inbox.poll',
		description: 'Pull new messages from the connected mailbox.',
		timezone: 'UTC',
		recurrence: { kind: 'interval', everyMinutes: 15 },
		runAs: { kind: 'service', role: 'integrations' },
		entityId: 'e-message',
		declaredAt: '2026-07-28',
	}),
]

const sources = [
	source({
		id: 'src-inbox',
		key: 'inbox.sync',
		description: 'Sync the connected mailbox into the message log.',
		mode: 'sync',
		entityId: 'e-message',
		request: { url: 'https://api.mailprovider.example/v1/messages' },
		// The credential is NAMED, never held. This is the line the whole primitive
		// is built around: a spec is committed, diffed and handed to agents.
		auth: { kind: 'bearer', secretName: 'MAILBOX_TOKEN' },
		mapping: [
			{ from: 'subject', to: 'fld-message-subject' },
			{ from: 'from.email', to: 'fld-message-from' },
			{ from: 'sent_at', to: 'fld-message-sent' },
		],
		limits: {
			requestsPerMinute: 20,
			timeoutMs: 10_000,
			maxAttempts: 5,
			backoffMs: 2000,
		},
		triggers: [{ kind: 'schedule', scheduleKey: 'inbox.poll' }],
		collection: {
			path: 'messages',
			idPath: 'id',
			idField: 'fld-message-remote-id',
			maxRecords: 200,
		},
		refine: true,
	}),
]

const dealsPage = page({
	id: 'pg-deals',
	name: 'Deals',
	route: '/app/deals',
	entityId: 'e-deal',
	blocks: [table('blk-deals-table'), slot('blk-deals-stage', 'stageMover')],
	e2eTests: [
		'A founder can add a deal to the pipeline',
		'Moving a deal to won removes it from the open column',
	],
})

const contactsPage = page({
	id: 'pg-contacts',
	name: 'Contacts',
	route: '/app/contacts',
	entityId: 'e-contact',
	blocks: [
		table('blk-contacts-table'),
		slot('blk-contacts-actions', 'contactActions'),
	],
	e2eTests: [
		'A founder can add a contact with an email',
		'A contact with no deals shows an empty pipeline',
	],
})

const activitiesPage = page({
	id: 'pg-activities',
	name: 'Activities',
	route: '/app/activities',
	entityId: 'e-activity',
	blocks: [table('blk-activities-table')],
	e2eTests: [
		'A founder can log a call against a contact',
		'The empty state shows before any activity is logged',
	],
})

export const crmliteExample = crudExample({
	id: 'crmlite',
	title: 'CRMlite — contacts & deal pipeline',
	prd: examplePRD({
		title: 'CRMlite — a solo-founder’s CRM',
		tldr: 'Track who you’re talking to and what’s in the pipeline — nothing more.',
		problem:
			'Founders lose deals in a spreadsheet and forget to follow up with warm contacts.',
		northStar: 'Deals advanced per week',
		persona: 'Solo founder running sales',
		differentiation:
			'A pipeline and a contact list that fit in your head, not a sales platform.',
	}),
	entities,
	pages: [dealsPage, contactsPage],
	schedules,
	sources,
	changes: [
		addField(
			'ch-deal-close',
			'Add an expected-close-date field to deals (spec op).',
			'e-deal',
			'fld-deal-close',
			'closeDate',
			'date',
		),
		addField(
			'ch-deal-probability',
			'Add a win-probability field to deals (spec op).',
			'e-deal',
			'fld-deal-probability',
			'probability',
			'number',
		),
		addPage(
			'ch-add-activities',
			'Add the Activities log page (spec op).',
			activitiesPage,
		),
		retitle(
			'ch-retitle-deals',
			'Rename Deals to “Pipeline” (regeneration-as-diff).',
			'deal',
			'Pipeline',
		),
		fillSlot(
			'ch-stage-mover-slot',
			'Fill the stage-mover slot on the Deals page (slot fill).',
			'deal',
			'stageMover',
			[
				'// User-owned: quick buttons to advance a deal’s stage.',
				'export function stageMover() {',
				'\treturn <button type="button">Advance stage</button>',
				'}',
			].join('\n'),
		),
		fillSlot(
			'ch-contact-actions-slot',
			'Fill the contact-actions slot with log-call controls (slot fill).',
			'contact',
			'contactActions',
			[
				'// User-owned: quick "log a call" controls on a contact row.',
				'export function contactActions() {',
				'\treturn <button type="button">Log call</button>',
				'}',
			].join('\n'),
		),
		addField(
			'ch-deal-source',
			'Add a lead-source field to deals (spec op).',
			'e-deal',
			'fld-deal-source',
			'source',
			'string',
		),
		addField(
			'ch-contact-company',
			'Add a company field to contacts (spec op).',
			'e-contact',
			'fld-contact-company',
			'company',
			'string',
		),
		ejectPage(
			'ch-eject-activities',
			'Eject the Activities page for a bespoke timeline (eject).',
			'activity',
		),
		addBoard(
			// RECLASSIFIED 2026-07-28 by issue #172, from off-surface/unexpressible.
			// The stages are the columns, the rank key is the order within one, and
			// a drop is an update of `stage` through the deal's own edit route. See
			// docs/corpus/crmlite-kanban-pipeline.md.
			'ch-kanban-pipeline',
			'Drag deals between pipeline stages on a Kanban board (spec op).',
			'pg-deals',
			'blk-deals-board',
			{
				groupField: 'stage',
				rankField: 'pipelineRank',
				titleField: 'name',
				cardFields: ['value'],
				move: true,
			},
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — what a pipeline board is
			// bought for and a view primitive is definitionally not. See
			// docs/corpus/crmlite-stage-automation.md.
			'ch-stage-automation',
			'Make the pipeline stages themselves rows a founder can add, rename and reorder, and fire the work each one implies on entry — a proposal deal schedules a follow-up, a won deal creates an invoice and stops the follow-ups — no op models a column set that is data, nor anything happening *because* a value changed (off-surface, unexpressible).',
			'deal',
			'unexpressible',
			'board',
		),
		fillSourceRefiner(
			// RECLASSIFIED 2026-07-28 by issue #173, from off-surface/eject. The sync
			// half is the declaration; the threading half is fifteen lines in the
			// refiner slot the source opened — no page is ejected, and the contacts
			// surface keeps receiving regeneration.
			// See docs/corpus/crmlite-inbox-sync.md.
			'ch-inbox-sync',
			'Sync an email inbox and thread messages per contact (slot fill).',
			'message',
			'inbox.sync',
			[
				'// User-owned: attach each synced message to the contact it came from.',
				'// The declared mapping cannot do this — matching an address to a',
				'// contact is a lookup against local rows, not a path into a response.',
				"import type { SourceRefineContext } from '@maxstack/features/sources'",
				'',
				'export default function refine(ctx: SourceRefineContext) {',
				"	const from = String(ctx.values['fld-message-from'] ?? '')",
				'	const contact = lookupContactByEmail(from)',
				'	return contact',
				"		? { ...ctx.values, 'fld-message-contact': contact.id }",
				'		: ctx.values',
				'}',
			].join('\n'),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — the half of an inbox
			// integration that a *read-only pull* is definitionally not.
			// See docs/corpus/crmlite-inbox-writeback.md.
			'ch-inbox-writeback',
			'Reply to a synced message from inside the CRM and have the reply appear in the same thread, with the thread staying consistent when the same message is moved, read or deleted on the mail provider’s side between two polls — no op models a write back to a third party, a bidirectional reconciliation, or a remote deletion that must not delete the local row (off-surface, unexpressible).',
			'message',
			'unexpressible',
			'external-data',
		),
	],
})
