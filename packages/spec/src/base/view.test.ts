/**
 * The view layer — every refusal, named after the thing it prevents rather than
 * after the rule it enforces.
 *
 * One property is being pinned above all others, and it is a *blast radius*
 * rather than an exposure: an action is the only declaration in the vocabulary
 * where one click writes to many rows. So the tests are organized around the
 * four ways a run could do more than its declaration says — a wider selection
 * than was capped, a column the declaration did not name, a value outside the
 * declared options, and a caller who was never authorized for the batch — plus
 * the one property that keeps a new dangerous kind from arriving safe:
 * **`action` is not in bulk-review's `UNDERSTOOD_KINDS`, so an action
 * declaration cannot be swept into a review batch.**
 *
 * That last test is the load-bearing one. Every other refusal here is checked
 * by code somebody wrote deliberately; that one is checked by a default nobody
 * had to remember, and its test exists so that making it batchable has to be an
 * edit to a file that says why it must not be.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import { classifyReviewRisk, planBulkReview } from './bulk-review.ts'
import type { ActionId, EntityId, FieldId } from './ids.ts'
import { manual, suggested } from './provenance.ts'
import {
	type ActionSpecInput,
	type ApplyMeta,
	applyOp,
	diffOp,
	REVIEW_TARGET_KINDS,
	type SpecOp,
	validateOp,
} from './spec-ops.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'
import {
	ACTION_REVIEW_KIND,
	actionReport,
	actionsFor,
	activeActions,
	describeAction,
	findActionByKey,
	listActions,
	MAX_ACTION_SELECTION,
	MAX_ACTION_SET_FIELDS,
	summarizeActions,
} from './view.ts'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-act-${n}`,
	origin: 'human',
	appliedAt: '2026-08-11',
})

/** A triage-shaped app: tasks with a status enum, an assignee, a rank and an
 *  avatar — one field of each kind an action may not write. */
function baseSystem(): SpecSystem {
	const spec = newSpecSystem(tasklyPRD)
	spec.data.entities = [
		{
			id: 'e-task',
			name: 'Task',
			fields: [
				{
					id: 'fld-title',
					name: 'title',
					type: 'string',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-status',
					name: 'status',
					type: 'enum',
					required: true,
					options: [
						{ label: 'Open', value: 'open' },
						{ label: 'Archived', value: 'archived' },
						{ label: 'Doing', value: 'doing' },
					],
					provenance: manual(),
				},
				{
					id: 'fld-untyped-status',
					name: 'legacyStatus',
					type: 'enum',
					required: false,
					provenance: manual(),
				},
				{
					id: 'fld-assignee',
					name: 'assignee',
					type: 'string',
					required: false,
					provenance: manual(),
				},
				{
					id: 'fld-priority',
					name: 'priority',
					type: 'number',
					required: false,
					provenance: manual(),
				},
				{
					id: 'fld-order',
					name: 'order',
					type: 'string',
					required: false,
					rank: true,
					provenance: manual(),
				},
				{
					id: 'fld-avatar',
					name: 'avatar',
					type: 'file',
					required: false,
					provenance: manual(),
				},
				{
					id: 'fld-payload',
					name: 'payload',
					type: 'json',
					required: false,
					provenance: manual(),
				},
			],
			provenance: manual(),
		},
		{
			id: 'e-note',
			name: 'Note',
			fields: [
				{
					id: 'fld-note-body',
					name: 'body',
					type: 'string',
					required: true,
					provenance: manual(),
				},
			],
			provenance: manual(),
		},
	]
	return spec
}

/** A well-formed declaration; spread over it to break exactly one rule. */
function archiveAction(over: Partial<ActionSpecInput> = {}): ActionSpecInput {
	return {
		id: 'act-archive' as ActionId,
		key: 'archive',
		label: 'Archive',
		description: 'Move the ticked tasks out of the working list.',
		entityId: 'e-task' as EntityId,
		arity: 'selection',
		effect: { set: { 'fld-status': 'archived' } },
		maxSelection: 100,
		undoable: true,
		provenance: manual(),
		...over,
	}
}

const declare = (action: ActionSpecInput): SpecOp => ({
	op: 'view.addAction',
	args: { action },
})

/** Apply a sequence and return the resulting system, failing loudly on the
 *  first invalid op — a test that silently applied an invalid op would assert
 *  against a spec the validator would never have produced. */
function apply(spec: SpecSystem, ...ops: SpecOp[]): SpecSystem {
	let next = spec
	ops.forEach((op, i) => {
		const errors = validateOp(next, op)
		expect(errors, `op ${i} (${op.op}) should be valid`).toEqual([])
		next = applyOp(next, op, meta(i))
	})
	return next
}

const errorsFor = (spec: SpecSystem, op: SpecOp): string =>
	validateOp(spec, op).join(' | ')

describe('declaring an action', () => {
	it('lands in the view layer, stamped with when it was declared', () => {
		const spec = apply(baseSystem(), declare(archiveAction()))
		const [action] = listActions(spec)
		expect(action?.key).toBe('archive')
		expect(action?.declaredAt).toBe('2026-08-11')
		expect(findActionByKey(spec, 'archive')?.id).toBe('act-archive')
	})

	it('is absent from a spec that has never declared one — the correct default, because an action is the only declaration where one click writes many rows', () => {
		const spec = baseSystem()
		expect(spec.view).toBeUndefined()
		expect(listActions(spec)).toEqual([])
		expect(summarizeActions(actionReport(spec))).toContain(
			'No list actions declared',
		)
	})

	it('refuses a second action on the same key — a key is an endpoint', () => {
		const spec = apply(baseSystem(), declare(archiveAction()))
		expect(
			errorsFor(spec, declare(archiveAction({ id: 'act-other' as ActionId }))),
		).toContain('already exists')
	})

	it('refuses an unknown entity rather than declaring a button over nothing', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(archiveAction({ entityId: 'e-ghost' as EntityId })),
			),
		).toContain('unknown entity')
	})
})

describe('the cap — how many rows one click may rewrite', () => {
	it('is required, never defaulted', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(
					archiveAction({
						maxSelection: undefined as unknown as number,
					}),
				),
			),
		).toContain('maxSelection must be an integer')
	})

	it(`refuses a cap above ${MAX_ACTION_SELECTION} — past that a run is a job, not a request`, () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(archiveAction({ maxSelection: MAX_ACTION_SELECTION + 1 })),
			),
		).toContain('maxSelection must be an integer')
	})

	it('allows a cap of 1, which is how a row-arity action says "one row by construction"', () => {
		const spec = apply(
			baseSystem(),
			declare(archiveAction({ arity: 'row', maxSelection: 1 })),
		)
		expect(listActions(spec)[0]?.maxSelection).toBe(1)
	})
})

describe('the write — what a declaration may actually change', () => {
	it('refuses an action that writes nothing', () => {
		expect(
			errorsFor(baseSystem(), declare(archiveAction({ effect: { set: {} } }))),
		).toContain('an action must write something')
	})

	it('refuses a field belonging to ANOTHER entity, which resolves and would write somebody else’s column', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(archiveAction({ effect: { set: { 'fld-note-body': 'hi' } } })),
			),
		).toContain('is not a field of entity "e-task"')
	})

	it('refuses clearing a required field — null means unset, and a required column has no unset state', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(archiveAction({ effect: { set: { 'fld-title': null } } })),
			),
		).toContain('clears required field')
	})

	it('refuses a rank key — a fixed value would stack the whole selection at one position', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(archiveAction({ effect: { set: { 'fld-order': 'a0' } } })),
			),
		).toContain('is a rank key')
	})

	it('refuses a file field — a fixed storage key would point every row at one object', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(archiveAction({ effect: { set: { 'fld-avatar': 'k' } } })),
			),
		).toContain('holds a STORAGE KEY')
	})

	it('refuses a json field — a document written as a string literal is unreviewable', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(archiveAction({ effect: { set: { 'fld-payload': '{}' } } })),
			),
		).toContain('effect values are literals')
	})

	it('refuses an enum value outside the field’s declared options', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(archiveAction({ effect: { set: { 'fld-status': 'nope' } } })),
			),
		).toContain('not one of its declared options')
	})

	it('refuses a literal of the wrong type', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(
					archiveAction({
						effect: { set: { 'fld-priority': 'high' } },
					}),
				),
			),
		).toContain('but the field is a number')
	})

	it(`refuses more than ${MAX_ACTION_SET_FIELDS} written fields — past that it is a migration wearing a button`, () => {
		const set: Record<string, string> = {}
		for (let i = 0; i < MAX_ACTION_SET_FIELDS + 1; i++)
			set[`fld-made-up-${i}`] = 'x'
		expect(
			errorsFor(baseSystem(), declare(archiveAction({ effect: { set } }))),
		).toContain('exceeds the maximum')
	})
})

describe('the chosen field — a value picked at run time, still bounded by the spec', () => {
	const mover = (over: Partial<ActionSpecInput> = {}) =>
		archiveAction({
			id: 'act-move' as ActionId,
			key: 'move',
			label: 'Move',
			arity: 'row',
			maxSelection: 1,
			effect: { set: {}, choose: 'fld-status' as FieldId },
			...over,
		})

	it('accepts an enum field with declared options, and an empty set alongside it', () => {
		const spec = apply(baseSystem(), declare(mover()))
		expect(listActions(spec)[0]?.effect.choose).toBe('fld-status')
	})

	it('refuses a non-enum field — its options ARE the bound on what a run can produce', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(
					mover({ effect: { set: {}, choose: 'fld-assignee' as FieldId } }),
				),
			),
		).toContain('Only an enum field may be chosen')
	})

	it('refuses an enum with no options — free text wearing a dropdown', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(
					mover({
						effect: { set: {}, choose: 'fld-untyped-status' as FieldId },
					}),
				),
			),
		).toContain('which declares no options')
	})

	it('refuses a field that is both set and chosen — one would silently win', () => {
		expect(
			errorsFor(
				baseSystem(),
				declare(
					mover({
						effect: {
							set: { 'fld-status': 'open' },
							choose: 'fld-status' as FieldId,
						},
					}),
				),
			),
		).toContain('both written by effect.set and chosen')
	})
})

describe('editing and removing', () => {
	it('view.setActionEffect replaces the write wholesale and re-validates it against the entity', () => {
		const spec = apply(baseSystem(), declare(archiveAction()))
		const next = apply(spec, {
			op: 'view.setActionEffect',
			args: {
				actionId: 'act-archive' as ActionId,
				effect: { set: { 'fld-status': 'doing', 'fld-priority': 3 } },
			},
		})
		expect(listActions(next)[0]?.effect.set).toEqual({
			'fld-status': 'doing',
			'fld-priority': 3,
		})
	})

	it('view.setActionEffect refuses a write the declaration could not have made in the first place', () => {
		const spec = apply(baseSystem(), declare(archiveAction()))
		expect(
			errorsFor(spec, {
				op: 'view.setActionEffect',
				args: {
					actionId: 'act-archive' as ActionId,
					effect: { set: { 'fld-avatar': 'k' } },
				},
			}),
		).toContain('holds a STORAGE KEY')
	})

	it('view.removeAction needs no pause step — removing a button fails closed', () => {
		const spec = apply(baseSystem(), declare(archiveAction()))
		const next = apply(spec, {
			op: 'view.removeAction',
			args: { actionId: 'act-archive' as ActionId },
		})
		expect(listActions(next)).toEqual([])
	})

	it('refuses editing or removing an action that does not exist', () => {
		const spec = baseSystem()
		expect(
			errorsFor(spec, {
				op: 'view.removeAction',
				args: { actionId: 'act-ghost' as ActionId },
			}),
		).toContain('unknown action')
	})
})

describe('what is offered, and to whom', () => {
	it('offers only ACCEPTED actions — a suggestion must not appear in an end user’s toolbar', () => {
		const spec = apply(
			baseSystem(),
			declare(archiveAction({ provenance: suggested() })),
		)
		expect(listActions(spec)).toHaveLength(1)
		expect(activeActions(spec)).toEqual([])
		expect(actionsFor(spec, 'e-task' as EntityId, 'selection')).toEqual([])
	})

	it('an arity of "both" answers to either question; a narrow one does not', () => {
		const spec = apply(
			baseSystem(),
			declare(archiveAction()),
			declare(
				archiveAction({
					id: 'act-flag' as ActionId,
					key: 'flag',
					arity: 'both',
				}),
			),
		)
		expect(
			actionsFor(spec, 'e-task' as EntityId, 'selection').map((a) => a.key),
		).toEqual(['archive', 'flag'])
		// `archive` is selection-only, so it is not offered on a row.
		expect(
			actionsFor(spec, 'e-task' as EntityId, 'row').map((a) => a.key),
		).toEqual(['flag'])
	})

	it('does not offer another entity’s actions', () => {
		const spec = apply(baseSystem(), declare(archiveAction()))
		expect(actionsFor(spec, 'e-note' as EntityId, 'selection')).toEqual([])
	})
})

describe('review — an action arrives dangerous and has to be argued down', () => {
	it('is a review target at all, so an accepted-only layer can ever be turned on', () => {
		expect(REVIEW_TARGET_KINDS).toContain(ACTION_REVIEW_KIND)
	})

	it('is NOT batchable: risk is high because bulk-review does not understand the kind', () => {
		const spec = apply(
			baseSystem(),
			declare(archiveAction({ provenance: suggested() })),
		)
		const risk = classifyReviewRisk(spec, {
			kind: ACTION_REVIEW_KIND,
			id: 'act-archive',
		})
		expect(risk.level).toBe('high')
		expect(risk.batchable).toBe(false)
	})

	it('cannot be swept into a batch alongside understood kinds', () => {
		const spec = apply(
			baseSystem(),
			declare(archiveAction({ provenance: suggested() })),
		)
		const plan = planBulkReview(
			spec,
			[{ kind: ACTION_REVIEW_KIND, id: 'act-archive' }],
			'accept',
			'batch-1',
		)
		expect(plan.included).toEqual([])
		expect(plan.refused).toHaveLength(1)
	})
})

describe('the review artifact — what somebody approving this actually reads', () => {
	it('the diff names the write and the cap, not just the id', () => {
		const summary = diffOp(declare(archiveAction())).summary
		expect(summary).toContain('fld-status=archived')
		expect(summary).toContain('≤100 row(s)')
	})

	it('describeAction names a chosen field as chosen rather than as a value', () => {
		expect(
			describeAction({
				...archiveAction({
					effect: { set: {}, choose: 'fld-status' as FieldId },
				}),
				declaredAt: '2026-08-11',
				provenance: manual(),
			}),
		).toContain('fld-status=<chosen>')
	})

	it('the report includes UNACCEPTED actions and marks them — a suggested action is one review away from being a button', () => {
		const spec = apply(
			baseSystem(),
			declare(archiveAction({ provenance: suggested() })),
		)
		const report = actionReport(spec)
		expect(report).toHaveLength(1)
		expect(report[0]?.accepted).toBe(false)
		expect(summarizeActions(report)).toContain('none accepted yet')
	})

	it('the summary leads with the WORST case — a maximum, not a sum, because one person clicks one button', () => {
		const spec = apply(
			baseSystem(),
			declare(archiveAction({ maxSelection: 100 })),
			declare(
				archiveAction({
					id: 'act-triage' as ActionId,
					key: 'triage',
					maxSelection: 250,
					undoable: false,
				}),
			),
		)
		const summary = summarizeActions(actionReport(spec))
		expect(summary).toContain('up to 250 row(s)')
		expect(summary).not.toContain('350')
		expect(summary).toContain('1 of them not undoable')
	})
})
