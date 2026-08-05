/**
 * Example app: gymlog (a workout logger with an exercise library).
 *
 * PRD grounding via the compact `examplePRD` builder. A
 * time-series-shaped domain (exercises → workouts → dated log entries), mobile
 * and single-user like todotracker but with a different progression model.
 */

import { examplePRD } from './deps.ts'
import {
	addField,
	addPage,
	addRollup,
	addSlot,
	belongsTo,
	crudExample,
	ejectPage,
	entity,
	field,
	fillSlot,
	offSurface,
	page,
	retitle,
	slot,
	table,
} from './kit.ts'

/**
 * Estimated one-rep max per logged set — Epley, `weight × (1 + reps / 30)`.
 *
 * Declared on the entity rather than landed as a backlog change on purpose: a
 * set *has* an estimated 1RM the moment it is logged, the way an order line has
 * a subtotal. The backlog ask is the progression chart *over* these values, and
 * that ask is what `ch-1rm-charts` still is.
 */
const estimated1rm = {
	id: 'drv-logentry-1rm',
	name: 'estimated1rm',
	expr: {
		kind: 'binary',
		op: '*',
		left: { kind: 'field', field: 'fld-logentry-weight' },
		right: {
			kind: 'binary',
			op: '+',
			left: { kind: 'literal', value: 1 },
			right: {
				kind: 'binary',
				op: '/',
				left: { kind: 'field', field: 'fld-logentry-reps' },
				right: { kind: 'literal', value: 30 },
			},
		},
	},
} as const

const entities = [
	entity('e-workout', 'Workout', 'A dated training session.', [
		field('fld-workout-date', 'date', 'date', true),
		field('fld-workout-focus', 'focus', 'string'),
	]),
	entity('e-exercise', 'Exercise', 'A movement in the library.', [
		field('fld-exercise-name', 'name', 'string', true),
		field('fld-exercise-muscle', 'muscle', 'string'),
	]),
	// SPEC EDIT 2026-07-28: a logged set says which exercise it was
	// and when — the two things every lifting app stores on a set and this spec
	// never wrote down — plus the Epley estimate above. The backlog is untouched;
	// see docs/corpus/gymlog-set-relations.md.
	entity(
		'e-logentry',
		'LogEntry',
		'A set logged against an exercise.',
		[
			field('fld-logentry-reps', 'reps', 'number', true),
			field('fld-logentry-weight', 'weight', 'number'),
			field('fld-logentry-at', 'performedAt', 'date', true),
			belongsTo('fld-logentry-exercise', 'exerciseId', 'e-exercise'),
		],
		[estimated1rm],
	),
]

const workoutsPage = page({
	id: 'pg-workouts',
	name: 'Workouts',
	route: '/app/workouts',
	entityId: 'e-workout',
	blocks: [table('blk-workouts-table'), slot('blk-workouts-rest', 'restTimer')],
	e2eTests: [
		'A lifter can start a workout for today',
		'A finished workout shows its total volume',
	],
})

const exercisesPage = page({
	id: 'pg-exercises',
	name: 'Exercises',
	route: '/app/exercises',
	entityId: 'e-exercise',
	blocks: [
		table('blk-exercises-table'),
		slot('blk-exercises-actions', 'exerciseActions'),
	],
	e2eTests: [
		'A lifter can add an exercise to the library',
		'An unused exercise shows a zero-session count',
	],
})

const logPage = page({
	id: 'pg-logentries',
	name: 'Log',
	route: '/app/log',
	entityId: 'e-logentry',
	blocks: [table('blk-logentries-table')],
	e2eTests: [
		'A lifter can log a set with reps and weight',
		'The empty state shows before any sets are logged',
	],
})

export const gymlogExample = crudExample({
	id: 'gymlog',
	title: 'Gymlog — workouts & exercise library',
	prd: examplePRD({
		title: 'Gymlog — a workout logger',
		tldr: 'Log every set and watch the numbers go up over months.',
		problem:
			'Lifters track sets in a notes app and can’t see progress across sessions.',
		northStar: 'Weeks with three logged workouts',
		persona: 'Recreational lifter tracking progress',
		differentiation:
			'A fast log-a-set loop with a personal exercise library, not a social feed.',
	}),
	entities,
	pages: [workoutsPage, exercisesPage],
	changes: [
		addField(
			'ch-workout-notes',
			'Add a notes field to workouts (spec op).',
			'e-workout',
			'fld-workout-notes',
			'notes',
			'string',
		),
		addPage('ch-add-log', 'Add the Log page (spec op).', logPage),
		retitle(
			'ch-retitle-workouts',
			'Rename Workouts to “Workouts & Volume” (regeneration-as-diff).',
			'workout',
			'Workouts & Volume',
		),
		fillSlot(
			'ch-rest-timer-slot',
			'Fill the rest-timer slot on the Workouts page (slot fill).',
			'workout',
			'restTimer',
			[
				'// User-owned: a rest-between-sets countdown timer.',
				'export function restTimer() {',
				'\treturn <button type="button" aria-label="rest timer">Rest 90s</button>',
				'}',
			].join('\n'),
		),
		addField(
			'ch-exercise-equipment',
			'Add an equipment field to exercises (spec op).',
			'e-exercise',
			'fld-exercise-equipment',
			'equipment',
			'string',
		),
		addSlot(
			'ch-exercise-history-slot',
			'Open a per-exercise history slot on the Exercises page (spec op).',
			'pg-exercises',
			'blk-exercises-history',
			'exerciseHistory',
		),
		addField(
			'ch-logentry-rpe',
			'Add an RPE (rate of perceived exertion) field to log entries (spec op).',
			'e-logentry',
			'fld-logentry-rpe',
			'rpe',
			'number',
		),
		addField(
			'ch-workout-duration',
			'Add a session-duration field to workouts (spec op).',
			'e-workout',
			'fld-workout-duration',
			'durationMin',
			'number',
		),
		ejectPage(
			'ch-eject-log',
			'Eject the Log page for a bespoke set-by-set logger (eject).',
			'logentry',
		),
		addRollup(
			// RECLASSIFIED 2026-07-28 by issue #170, from off-surface/unexpressible.
			// `data.addRollup` is the op: the weekly peak of a computed 1RM per
			// exercise, bucketed and capped. See docs/corpus/gymlog-1rm-series.md.
			'ch-1rm-charts',
			'Progression charts of estimated 1-rep-max over time (spec op).',
			'e-exercise',
			{
				id: 'drv-exercise-1rm-series',
				name: 'oneRepMaxByWeek',
				over: 'e-logentry',
				via: 'fld-logentry-exercise',
				// The peak set of each week, not the average — a progression chart is
				// about the best a lifter hit, and `max` over a *computed* field is
				// the shape this ask forced the primitive to support.
				fn: 'max',
				field: 'drv-logentry-1rm',
				groupBy: { field: 'fld-logentry-at', bucket: 'week' },
				// A year of weeks; the cost bound the op requires a grouped rollup
				// to state out loud.
				limit: 52,
			},
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area and deliberately in the same shape: it is what a *series* still
			// cannot do. See docs/corpus/gymlog-auto-deload.md.
			'ch-auto-deload',
			'Detect a stalled lift and prescribe the next session — three failed attempts at a weight trigger a deload to 90% of the last success, and the program picks up from there — no op models a rule that reads a series and writes back a plan (off-surface, unexpressible).',
			'exercise',
			'unexpressible',
		),
		fillSlot(
			// RECLASSIFIED 2026-07-28 by issue #178, from off-surface/eject. The
			// platform did not learn to render exercise demos — that would be the
			// cage. It made the *row* a slot, so the bespoke media card replaces one
			// block and the page, routing, ordering and field derivation around it
			// keep regenerating. See docs/corpus/gymlog-exercise-demos-slot.md.
			'ch-exercise-demos',
			'Animated exercise demos with form cues, as a bespoke exercise row (slot fill).',
			'exercise',
			'exercise__row',
			[
				'// User-owned: the animated demo card. The platform hands over the',
				'// rendering and keeps the derivation — `props.columns` carries the',
				'// same field metadata the generated row reads.',
				"import type { RowSlotProps } from '@maxstack/ui'",
				'',
				'// The page-level slot this file already owned — one user-owned module',
				'// holds every slot for the resource, block-level and declared alike.',
				'export function exerciseActions() {',
				'\treturn null',
				'}',
				'',
				'export function exerciseHistory() {',
				'\treturn null',
				'}',
				'',
				'export function exercise__row(props: RowSlotProps) {',
				'\tvoid props',
				'\treturn null',
				'}',
			].join('\n'),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area and deliberately in a shape block slots cannot reach: it is not
			// a rendering ask at all. See docs/corpus/gymlog-supersets.md.
			'ch-supersets',
			'Supersets: two exercises logged as an alternating pair under one shared rest timer, so a set of A and a set of B interleave as a single unit that reorders, edits and deletes together — no op models a grouping that owns the log form across two entities (off-surface, eject).',
			'exercise',
			'eject',
		),
	],
})
