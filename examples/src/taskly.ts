/**
 * Example app: taskly (a shared team task tracker).
 *
 * Wraps the `tasklyPRD` fixture in a full three-layer
 * {@link SpecSystem}: entities, CRUD pages carrying natural-language `e2eTests`,
 * and `slot:` blocks marking the cross-file extension seams. The change set is
 * biased toward sustained change: add a page as a spec op, retitle a
 * page through regeneration-as-diff, fill a slot, add a block, and eject.
 */

import {
	type ExampleApp,
	newSpecSystem,
	type PageSpec,
	suggested,
	tasklyPRD,
} from './deps.ts'
import {
	addField,
	addSlot,
	addTimeline,
	fillLiveSlot,
	fillSlot,
	live,
	offSurface,
} from './kit.ts'

/** Accepted-suggestion provenance — the example spec is the grounding set. */
const p = () => ({ provenance: suggested({ autoAccept: true }) })

const spec = newSpecSystem(tasklyPRD, { autoAccept: true })

spec.data.entities = [
	{
		id: 'e-project',
		name: 'Project',
		description: 'A shared home for a team’s tasks.',
		fields: [
			{
				id: 'fld-project-name',
				name: 'name',
				type: 'string',
				required: true,
				...p(),
			},
			{
				id: 'fld-project-archived',
				name: 'archived',
				type: 'boolean',
				required: false,
				...p(),
			},
		],
		...p(),
	},
	{
		id: 'e-task',
		name: 'Task',
		description: 'A unit of work with an owner and a status.',
		fields: [
			{
				id: 'fld-task-title',
				name: 'title',
				type: 'string',
				required: true,
				...p(),
			},
			{
				id: 'fld-task-status',
				name: 'status',
				type: 'enum',
				required: true,
				...p(),
			},
			{
				id: 'fld-task-owner',
				name: 'owner',
				type: 'string',
				required: false,
				...p(),
			},
			// SPEC EDIT 2026-07-28: the two columns a shared task
			// tracker's own e2e tests already presuppose and this spec never wrote
			// down — when work starts, and which task it waits on. The backlog is
			// untouched.
			{
				id: 'fld-task-start',
				name: 'startDate',
				type: 'date',
				required: false,
				...p(),
			},
			{
				id: 'fld-task-blocked-by',
				name: 'blockedBy',
				type: 'string',
				required: false,
				reference: 'e-task',
				...p(),
			},
		],
		...p(),
	},
	{
		id: 'e-member',
		name: 'Member',
		description: 'A person on the team.',
		fields: [
			{
				id: 'fld-member-email',
				name: 'email',
				type: 'string',
				required: true,
				...p(),
			},
			{
				id: 'fld-member-name',
				name: 'name',
				type: 'string',
				required: false,
				...p(),
			},
		],
		...p(),
	},
]

// Members page ships as a spec-op change below, so it starts absent.
const projectsPage: PageSpec = {
	id: 'pg-projects',
	name: 'Projects',
	route: '/admin/projects',
	entityId: 'e-project',
	blocks: [
		{ id: 'blk-projects-table', type: 'table', ...p() },
		{ id: 'blk-projects-actions', type: 'slot:projectActions', ...p() },
	],
	e2eTests: [
		'A team lead can create a project and see it in the list',
		'Archiving a project removes it from the active list',
	],
	...p(),
}

const tasksPage: PageSpec = {
	id: 'pg-tasks',
	name: 'Tasks',
	route: '/admin/tasks',
	entityId: 'e-task',
	blocks: [
		{ id: 'blk-tasks-table', type: 'table', ...p() },
		{ id: 'blk-tasks-bulk', type: 'slot:bulkArchive', ...p() },
	],
	e2eTests: [
		'A contributor can create a task with a title and see it on the board',
		'An unassigned task is visually flagged until an owner is set',
		'Moving a task to done updates its status',
	],
	...p(),
}

spec.pages.pages = [projectsPage, tasksPage]

/**
 * SPEC EDIT 2026-07-29 — the two live channels the app declares.
 *
 * Declared as part of what the app *is*, on the terms schedules were in #181,
 * sources in #173 and importers in #175: the backlog ask below is what is *asked
 * of it*. Nothing new is modelled — both channels ride on `e-task` exactly as it
 * already stands, which is the bar the corpus policy sets for a spec edit
 * accompanying a reclassification.
 *
 * Three choices carry the argument, and each is the honest one rather than the
 * convenient one:
 *
 *  - `scope: {kind: 'all'}` on the board, under `maxSubscribers: 60`. taskly's
 *    `e-task` carries no project reference — the two entities are unrelated in
 *    this spec — so there is no column to bound on, and adding a foreign key to
 *    make the declaration look tidier would be inventing surface for the op to
 *    sit on. The honest spelling is the unfiltered one *under a team-sized cap*:
 *    a shared team tracker is exactly the "everyone who can see this is on the
 *    team" case `MAX_UNBOUNDED_SUBSCRIBERS` exists to permit, and 60 says so.
 *  - `maxMessagesPerMinute: 120`. Two a second is a board with several people
 *    moving cards at once. Past that a human cannot read the surface anyway, so
 *    the extra messages buy nothing and cost a shed connection.
 *  - The board declares `slot: true` and presence declares `slot: false`. A list
 *    of faces is a list of faces and needs no bespoke code; a drag-and-drop
 *    board is genuinely not a table, which is the whole reason the ask was
 *    frozen as an eject.
 */
spec.live = {
	subscriptions: [
		live({
			id: 'lv-task-board',
			key: 'task-board',
			description: 'Push task changes to whoever has the board open.',
			entityId: 'e-task',
			kind: 'query',
			fields: ['fld-task-title', 'fld-task-status', 'fld-task-owner'],
			scope: { kind: 'all' },
			maxSubscribers: 60,
			maxMessagesPerMinute: 120,
			slot: true,
			paused: false,
		}),
		live({
			id: 'lv-task-viewers',
			key: 'task-viewers',
			description: 'Who is looking at this task right now.',
			entityId: 'e-task',
			kind: 'presence',
			fields: [],
			scope: { kind: 'row' },
			maxSubscribers: 60,
			maxMessagesPerMinute: 30,
			presenceTtlSeconds: 30,
			maxPresent: 12,
			slot: false,
			paused: false,
		}),
	],
}

export const tasklyExample: ExampleApp = {
	id: 'taskly',
	title: 'Taskly — shared task tracking',
	spec,
	changes: [
		{
			id: 'ch-add-members-page',
			description: 'Add a Members admin page (spec op).',
			kind: 'spec-op',
			via: 'apply-op',
			op: {
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-members',
						name: 'Members',
						route: '/admin/members',
						entityId: 'e-member',
						blocks: [
							{ id: 'blk-members-table', type: 'table', ...p() },
							{ id: 'blk-members-actions', type: 'slot:memberActions', ...p() },
						],
						e2eTests: [
							'A team owner can invite a member by email',
							'Removing a member unassigns their tasks',
						],
						...p(),
					},
				},
			},
		},
		{
			id: 'ch-retitle-tasks',
			description:
				'Rename the Tasks page to “Task Board” (regeneration-as-diff).',
			kind: 'spec-op',
			via: 'regen-diff',
			edit: { resource: 'task', title: 'Task Board' },
		},
		{
			id: 'ch-bulk-archive-slot',
			description: 'Fill the bulk-archive slot on the Tasks page (slot fill).',
			kind: 'slot-fill',
			resource: 'task',
			slot: 'bulkArchive',
			body: [
				'// User-owned: the bulk-archive button (the canonical case).',
				'export function bulkArchive() {',
				'\treturn <button type="button">Archive selected</button>',
				'}',
			].join('\n'),
		},
		{
			id: 'ch-add-projects-filter-slot',
			description: 'Add a filters slot to the Projects page (spec op).',
			kind: 'spec-op',
			via: 'apply-op',
			op: {
				op: 'page.addBlock',
				args: {
					pageId: 'pg-projects',
					block: {
						id: 'blk-projects-filters',
						type: 'slot:projectFilters',
						...p(),
					},
				},
			},
		},
		addField(
			'ch-task-due',
			'Add a due-date field to tasks (spec op).',
			'e-task',
			'fld-task-due',
			'dueDate',
			'date',
		),
		addField(
			'ch-task-priority',
			'Add a priority field to tasks (spec op).',
			'e-task',
			'fld-task-priority',
			'priority',
			'enum',
		),
		fillSlot(
			'ch-member-actions-slot',
			'Fill the member-actions slot with invite/remove controls (slot fill).',
			'member',
			'memberActions',
			[
				'// User-owned: per-member invite + remove controls.',
				'export function memberActions() {',
				'\treturn <button type="button">Remove</button>',
				'}',
			].join('\n'),
		),
		addSlot(
			'ch-member-invite-slot',
			'Open a pending-invites slot on the Members page (spec op).',
			'pg-members',
			'blk-members-invites',
			'memberInvites',
		),
		{
			id: 'ch-eject-projects',
			description: 'Eject the Projects page for a bespoke layout (eject).',
			kind: 'eject',
			resource: 'project',
		},
		addTimeline(
			// RECLASSIFIED 2026-07-28 by issue #171, from off-surface/unexpressible.
			// `page.addTimeline` is the op: start → due as the bar, the declared
			// self-reference as the arrow. `dueDate` is the column `ch-task-due`
			// added earlier in this same backlog.
			'ch-gantt-timeline',
			'A Gantt timeline with dependency arrows between tasks (spec op).',
			'pg-tasks',
			'blk-tasks-timeline',
			{
				startField: 'startDate',
				endField: 'dueDate',
				timezone: 'America/New_York',
				titleField: 'title',
				dependsOn: 'blockedBy',
				reschedule: true,
			},
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area and deliberately in the same shape: it is the half of a Gantt
			// chart that a *view* cannot be.
			'ch-slip-cascade',
			'When a task slips, move every task that waits on it and re-flag the ones that now miss the milestone — dependents reschedule themselves, the chain recomputes, and the change is reviewable before it lands — no op models scheduling as a rule rather than a drawing (off-surface, unexpressible).',
			'task',
			'unexpressible',
			'calendar',
		),
		fillLiveSlot(
			// RECLASSIFIED 2026-07-29 by issue #179, from off-surface/eject — and
			// SPLIT rather than claimed whole. The ask says "real-time collaborative
			// board *with presence cursors*". The platform now absorbs the first two
			// thirds: the board's rows are pushed on change under a declared bound
			// and a declared ceiling, who is viewing a task is a bounded ephemeral
			// primitive, and the drag-and-drop surface has a typed slot the platform
			// promises never to overwrite. What it does NOT absorb is the cursors — a
			// per-pointer, per-frame ephemeral channel is exactly the free-form
			// payload the presence primitive refuses to carry, by the same recorded
			// decision (d-live-last-write-wins) that keeps co-editing out. That
			// residue returns at full weight as `ch-offline-board-merge`.
			'ch-realtime-board',
			'A real-time collaborative board: cards move under you as teammates work, and a task shows who else is looking at it, in the live channel’s bespoke surface slot (slot fill).',
			'task',
			'task-board',
			[
				'// User-owned: the drag-and-drop board. The platform declared the',
				'// channel and never rewrites this; the layout is ours to know.',
				'export default function TaskBoard(props: { rows: { id: string }[] }) {',
				'\tvoid props',
				'\treturn null',
				'}',
			].join('\n'),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-29 — carries back the residual
			// difficulty the split above did not absorb, in the same product area and
			// deliberately in the shape this issue's own decision record puts out of
			// scope: replication and convergent merge. What shipped is
			// last-write-wins over a live connection; this is two divergent local
			// histories that must reconcile without either losing work, plus the
			// per-pointer channel presence definitionally is not.
			'ch-offline-board-merge',
			'Two people edit the same board while one is offline on a plane, and both reconcile on reconnect with neither losing work — every move, rename and reassignment replays against the other’s, conflicting edits to one field resolve by intention rather than by arrival time, and while both are online each sees the other’s cursor and the card they are mid-drag — no op models replication, convergent merge, or a per-pointer ephemeral channel (off-surface, unexpressible).',
			'task',
			'unexpressible',
			// The `realtime` cluster keeps a carrier. Same product area, same
			// surface, reached from the half the shipped primitive definitionally
			// does not go: what happens when there is NO connection.
			'realtime',
		),
	],
}
