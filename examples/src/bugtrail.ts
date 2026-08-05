/**
 * Example app: bugtrail (a lightweight issue tracker with sprints).
 *
 * PRD grounding via the compact `examplePRD` builder. The canonical
 * long-lived app under sustained change: an issue tracker is exactly
 * the kind of tool that grows new fields, views, and workflows over months.
 */

import { examplePRD } from './deps.ts'
import {
	addBoard,
	addField,
	addPage,
	addSlot,
	crudExample,
	ejectPage,
	entity,
	enumField,
	field,
	fillSlot,
	offSurface,
	page,
	rankField,
	retitle,
	setFieldLimits,
	slot,
	table,
} from './kit.ts'

const entities = [
	entity('e-issue', 'Issue', 'A bug or task to be worked.', [
		field('fld-issue-title', 'title', 'string', true),
		// SPEC EDIT 2026-07-28: the status values are now declared,
		// and the issue carries a manual-ordering key. Both are properties of the
		// tracker itself — an issue tracker whose workflow states are undeclared is
		// under-specified — and both are prerequisites the board ask presupposed.
		// See docs/corpus/bugtrail-workflow-columns.md.
		enumField(
			'fld-issue-status',
			'status',
			['open', 'in-progress', 'in-review', 'closed'],
			true,
		),
		field('fld-issue-priority', 'priority', 'enum'),
		rankField('fld-issue-rank', 'boardRank'),
	]),
	entity('e-sprint', 'Sprint', 'A time-boxed batch of issues.', [
		field('fld-sprint-name', 'name', 'string', true),
		field('fld-sprint-starts', 'starts', 'date', true),
	]),
	entity('e-label', 'Label', 'A tag that groups issues.', [
		field('fld-label-name', 'name', 'string', true),
		field('fld-label-color', 'color', 'string'),
	]),
]

const issuesPage = page({
	id: 'pg-issues',
	name: 'Issues',
	route: '/app/issues',
	entityId: 'e-issue',
	blocks: [table('blk-issues-table'), slot('blk-issues-bulk', 'bulkTriage')],
	e2eTests: [
		'A maintainer can file an issue and see it on the board',
		'Closing an issue moves it out of the open column',
	],
})

const sprintsPage = page({
	id: 'pg-sprints',
	name: 'Sprints',
	route: '/app/sprints',
	entityId: 'e-sprint',
	blocks: [
		table('blk-sprints-table'),
		slot('blk-sprints-actions', 'sprintActions'),
	],
	e2eTests: [
		'A lead can start a sprint with a name and date',
		'An empty sprint shows a prompt to pull in issues',
	],
})

const labelsPage = page({
	id: 'pg-labels',
	name: 'Labels',
	route: '/app/labels',
	entityId: 'e-label',
	blocks: [table('blk-labels-table')],
	e2eTests: [
		'A maintainer can create a colored label',
		'The empty state shows before any labels exist',
	],
})

export const bugtrailExample = crudExample({
	id: 'bugtrail',
	title: 'Bugtrail — issues & sprints',
	prd: examplePRD({
		title: 'Bugtrail — a lightweight issue tracker',
		tldr: 'File, triage, and sprint-plan issues without the weight of a full project suite.',
		problem:
			'Small teams either overpay for a heavy tracker or lose issues in a chat channel.',
		northStar: 'Issues closed per week',
		persona: 'Maintainer of a small project',
		differentiation:
			'Just issues and sprints — no epics, portfolios, or per-seat pricing.',
	}),
	entities,
	pages: [issuesPage, sprintsPage],
	changes: [
		addField(
			'ch-issue-assignee',
			'Add an assignee field to issues (spec op).',
			'e-issue',
			'fld-issue-assignee',
			'assignee',
			'string',
		),
		addField(
			'ch-issue-estimate',
			'Add a point estimate to issues (spec op).',
			'e-issue',
			'fld-issue-estimate',
			'estimate',
			'number',
		),
		addPage('ch-add-labels', 'Add the Labels page (spec op).', labelsPage),
		retitle(
			'ch-retitle-issues',
			'Rename Issues to “Issue Board” (regeneration-as-diff).',
			'issue',
			'Issue Board',
		),
		fillSlot(
			'ch-bulk-triage-slot',
			'Fill the bulk-triage toolbar on the Issues page (slot fill).',
			'issue',
			'bulkTriage',
			[
				'// User-owned: the bulk-triage toolbar (assign/label selected).',
				'export function bulkTriage() {',
				'\treturn <button type="button">Triage selected</button>',
				'}',
			].join('\n'),
		),
		addSlot(
			'ch-sprint-burndown-slot',
			'Open a burndown-chart slot on the Sprints page (spec op).',
			'pg-sprints',
			'blk-sprints-burndown',
			'sprintBurndown',
		),
		addField(
			'ch-sprint-goal',
			'Add a goal field to sprints (spec op).',
			'e-sprint',
			'fld-sprint-goal',
			'goal',
			'string',
		),
		addField(
			'ch-issue-reopened',
			'Track how many times an issue was reopened (spec op).',
			'e-issue',
			'fld-issue-reopened',
			'reopenedCount',
			'number',
		),
		addField(
			'ch-sprint-capacity',
			'Add a capacity field to sprints (spec op).',
			'e-sprint',
			'fld-sprint-capacity',
			'capacity',
			'number',
		),
		ejectPage(
			'ch-eject-labels',
			'Eject the Labels page for a bespoke color grid (eject).',
			'label',
		),
		addBoard(
			// RECLASSIFIED 2026-07-28 by issue #172, from off-surface/unexpressible.
			// The ask is two sentences and both are now ops: this one is the board
			// (columns = the status values, order within a column = the rank key,
			// drag and keyboard both writing status), and `ch-wip-limits` below is
			// the per-column limit. See docs/corpus/bugtrail-kanban-board.md.
			'ch-kanban-board',
			'A Kanban board of issues with drag-between-columns (spec op).',
			'pg-issues',
			'blk-issues-board',
			{
				groupField: 'status',
				rankField: 'boardRank',
				titleField: 'title',
				cardFields: ['priority'],
				move: true,
			},
		),
		setFieldLimits(
			// RECLASSIFIED 2026-07-28 by issue #172 — the second half of
			// `ch-kanban-board`'s ask, split out because it is a second op and not
			// because it got easier: the limit is declared on the *field*, so it is
			// enforced on every write rather than drawn on the board.
			'ch-wip-limits',
			'Cap the in-progress and in-review columns at three issues each (spec op).',
			'e-issue',
			'fld-issue-status',
			{ 'in-progress': 3, 'in-review': 3 },
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — the board shape the
			// primitive explicitly does not reach. See
			// docs/corpus/bugtrail-swimlane-policy.md.
			'ch-swimlane-policy',
			'Split the board into per-assignee swimlanes with a WIP limit on each (assignee, column) pair, and block a drop that would break someone else’s limit with a reason naming the card that has to move first — no op models a limit scoped to anything narrower than the table (off-surface, unexpressible).',
			'issue',
			'unexpressible',
			'board',
		),
	],
})
