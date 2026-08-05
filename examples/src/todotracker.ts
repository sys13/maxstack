/**
 * Example app: todotracker (personal todos + forgiving habit streaks).
 *
 * The mobile, single-user counterpart to taskly: a different domain shape
 * (todos, habits, dated completions) so the pipeline isn’t overfit to one app
 *. Same three-layer `SpecSystem` + `e2eTests` + change-set contract.
 */

import {
	type ExampleApp,
	newSpecSystem,
	type PageSpec,
	suggested,
	todotrackerPRD,
} from './deps.ts'
import { addCalendar, addField, fillSlot, offSurface } from './kit.ts'

const p = () => ({ provenance: suggested({ autoAccept: true }) })

const spec = newSpecSystem(todotrackerPRD, { autoAccept: true })

spec.data.entities = [
	{
		id: 'e-todo',
		name: 'Todo',
		description: 'A one-off task to check off.',
		fields: [
			{
				id: 'fld-todo-text',
				name: 'text',
				type: 'string',
				required: true,
				...p(),
			},
			{
				id: 'fld-todo-done',
				name: 'done',
				type: 'boolean',
				required: false,
				...p(),
			},
		],
		...p(),
	},
	{
		id: 'e-habit',
		name: 'Habit',
		description: 'A recurring behavior tracked with a forgiving streak.',
		fields: [
			{
				id: 'fld-habit-name',
				name: 'name',
				type: 'string',
				required: true,
				...p(),
			},
			{
				id: 'fld-habit-schedule',
				name: 'schedule',
				type: 'string',
				required: true,
				...p(),
			},
			{
				id: 'fld-habit-archived',
				name: 'archived',
				type: 'boolean',
				required: false,
				...p(),
			},
		],
		...p(),
	},
	{
		id: 'e-completion',
		name: 'Completion',
		description: 'A dated record that a habit was done.',
		fields: [
			{
				id: 'fld-completion-date',
				name: 'date',
				type: 'date',
				required: true,
				...p(),
			},
			{
				id: 'fld-completion-habit',
				name: 'habit',
				type: 'string',
				required: true,
				...p(),
			},
		],
		...p(),
	},
]

const todosPage: PageSpec = {
	id: 'pg-todos',
	name: 'Todos',
	route: '/app/todos',
	entityId: 'e-todo',
	blocks: [
		{ id: 'blk-todos-table', type: 'table', ...p() },
		{ id: 'blk-todos-quickadd', type: 'slot:quickAdd', ...p() },
	],
	e2eTests: [
		'A user can add a todo in one tap and see it in the list',
		'Checking off a todo marks it done; unchecking restores it',
		'Deleting a todo removes it from the list',
	],
	...p(),
}

const habitsPage: PageSpec = {
	id: 'pg-habits',
	name: 'Habits',
	route: '/app/habits',
	entityId: 'e-habit',
	blocks: [
		{ id: 'blk-habits-table', type: 'table', ...p() },
		{ id: 'blk-habits-streak', type: 'slot:streakBadge', ...p() },
	],
	e2eTests: [
		'A user can create a habit with a repeat schedule',
		'Completing a habit increments its current streak',
		'A single missed day spends a grace day instead of breaking the streak',
	],
	...p(),
}

spec.pages.pages = [todosPage, habitsPage]

export const todotrackerExample: ExampleApp = {
	id: 'todotracker',
	title: 'Todotracker — todos + forgiving habit streaks',
	spec,
	changes: [
		{
			id: 'ch-add-stats-page',
			description: 'Add a weekly Stats page (spec op).',
			kind: 'spec-op',
			via: 'apply-op',
			op: {
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-stats',
						name: 'Stats',
						route: '/app/stats',
						entityId: 'e-completion',
						blocks: [{ id: 'blk-stats-table', type: 'table', ...p() }],
						e2eTests: [
							'A user sees a weekly completion chart',
							'The empty state shows before any data exists',
						],
						...p(),
					},
				},
			},
		},
		fillSlot(
			'ch-quick-add-slot',
			'Fill the quick-add slot on the Todos page (slot fill).',
			'todo',
			'quickAdd',
			[
				'// User-owned: the one-tap quick-add box.',
				'export function quickAdd() {',
				'\treturn <input aria-label="quick add todo" placeholder="Add a todo" />',
				'}',
			].join('\n'),
		),
		{
			id: 'ch-retitle-habits',
			description:
				'Rename the Habits page to “Habits & Streaks” (regeneration-as-diff).',
			kind: 'spec-op',
			via: 'regen-diff',
			edit: { resource: 'habit', title: 'Habits & Streaks' },
		},
		{
			id: 'ch-streak-badge-slot',
			description: 'Fill the streak-badge slot on the Habits page (slot fill).',
			kind: 'slot-fill',
			resource: 'habit',
			slot: 'streakBadge',
			body: [
				'// User-owned: the forgiving-streak badge.',
				'export function streakBadge() {',
				'\treturn <span aria-label="current streak">🔥 0</span>',
				'}',
			].join('\n'),
		},
		{
			id: 'ch-add-todo-filters-slot',
			description: 'Add a filters slot to the Todos page (spec op).',
			kind: 'spec-op',
			via: 'apply-op',
			op: {
				op: 'page.addBlock',
				args: {
					pageId: 'pg-todos',
					block: { id: 'blk-todos-filters', type: 'slot:todoFilters', ...p() },
				},
			},
		},
		addField(
			'ch-habit-reminder',
			'Add a reminder-time field to habits (spec op).',
			'e-habit',
			'fld-habit-reminder',
			'reminderTime',
			'string',
		),
		addField(
			'ch-todo-due',
			'Add a due-date field to todos (spec op).',
			'e-todo',
			'fld-todo-due',
			'dueDate',
			'date',
		),
		addField(
			'ch-completion-note',
			'Add a note field to completions (spec op).',
			'e-completion',
			'fld-completion-note',
			'note',
			'string',
		),
		{
			id: 'ch-eject-todos',
			description: 'Eject the Todos page for a bespoke mobile layout (eject).',
			kind: 'eject',
			resource: 'todo',
		},
		addCalendar(
			// RECLASSIFIED 2026-07-28 by issue #171, from off-surface/unexpressible.
			// `page.addCalendar` with display "heatmap" is the op: completions
			// bucketed per day, on the Stats page `ch-add-stats-page` added earlier
			// in this same backlog. The streak-freeze half of the original ask is
			// NOT absorbed and is carried out as its own ask below — see
			// docs/corpus/todotracker-completion-heatmap.md.
			'ch-streak-heatmap',
			'A calendar heatmap of habit completions (spec op).',
			'pg-stats',
			'blk-stats-heatmap',
			{
				dateField: 'date',
				display: 'heatmap',
				timezone: 'America/Los_Angeles',
			},
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — the half of the ask above
			// that a view primitive explicitly does not do, split out rather than
			// quietly dropped. See docs/corpus/todotracker-streak-freeze.md.
			'ch-streak-freeze',
			'Forgiving streaks: a missed day spends a grace day instead of breaking the streak, graces accrue weekly up to a cap, and the heatmap shades a frozen day differently from a completed one — no op models a value whose answer for today depends on the whole ordered history before it (off-surface, unexpressible).',
			'habit',
			'unexpressible',
			'calendar',
		),
		fillSlot(
			// RECLASSIFIED 2026-07-28 by issue #178, from off-surface/eject. The
			// widget stays hand-written — a platform that generated home-screen
			// widgets would be the cage. What changed is that owning that one
			// region no longer means owning the stats surface forever. See
			// docs/corpus/todotracker-home-widget-slot.md.
			'ch-home-widget',
			'A home-screen widget rendering today’s completions, in the completions list slot (slot fill).',
			'completion',
			'completion__list',
			[
				'// User-owned: the widget layout. Today’s rows arrive already loaded',
				'// and ordered; the surface around this component keeps regenerating.',
				"import type { ListSlotProps } from '@maxstack/ui'",
				'',
				'export function completion__list(props: ListSlotProps) {',
				'\tvoid props',
				'\treturn null',
				'}',
			].join('\n'),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area and deliberately not a rendering ask: it is about a row
			// generating its own successor. See docs/corpus/todotracker-recurrence.md.
			'ch-recurring-todos',
			'Recurring todos: completing one closes today’s occurrence and creates the next by rule ("every 3rd Tuesday", "2 days after it was last done"), while history, notes and the streak stay attached to one logical task — no op models a row that spawns its successor and keeps a shared identity across the series (off-surface, unexpressible).',
			'todo',
			'unexpressible',
		),
	],
}
