/**
 * Declared list actions at run time — the plan a route looks up, and the shape
 * of what one run did.
 *
 * The declaration lives in `@maxstack/spec` (`view.ts`); this is its
 * column-grounded form, resolved by the caller exactly as `SearchIndexPlan`,
 * `DocumentPlan` and `ImportPlanShape` are. Nothing here reaches a database:
 * running an action is `opRunAction` in `operations.ts`, which sits at the
 * depth `authorize()` guards.
 *
 * ## Why the plan is on the registry rather than in a route
 *
 * Issue #186's finding, in the write direction. `/mcp` and the admin loaders
 * reach the data layer without passing a route-level gate, so an action whose
 * cap, role and write set were assembled per route would be enforced on exactly
 * one of the three surfaces that can run it. Carried here, the endpoint, the MCP
 * tool and the list toolbar all look the plan up at the same depth, and the
 * enforcement is below all three.
 */

import type { Row } from './store.ts'

/** A literal an action may write. `null` clears the column. */
export type ActionValue = string | number | boolean | null

/** How many rows one run may be aimed at. Mirrors `ActionArity` in the spec. */
export type ActionArity = 'row' | 'selection' | 'both'

/**
 * One declared action, with the spec's field ids already resolved to column
 * names by the caller.
 *
 * `choose` carries its **options** rather than only its column, and that is
 * load-bearing: the options are the entire bound on what a run can produce, and
 * a plan that named the column alone would push the check back onto whoever
 * built the request.
 */
export interface ActionPlan {
	key: string
	label: string
	description: string
	arity: ActionArity
	/** `columnName → literal`. May be empty only when {@link choose} is set. */
	set: Record<string, ActionValue>
	choose?: { column: string; options: string[] }
	/** An extra role the caller must hold, beyond `update` on the resource. */
	role?: string
	maxSelection: number
	undoable: boolean
}

/** One row a run tried to write, and what happened to it. */
export interface ActionRowOutcome {
	id: string
	/**
	 * The prior values of exactly the fields written — present only on a
	 * successful row of an `undoable` action. This is what makes the run
	 * reversible, and it is a *record* rather than a rollback log: the undo
	 * replays it through the ordinary update path.
	 */
	before?: Row
	/** Absent on success. The refusal, in the words the single-row path used. */
	error?: string
}

/**
 * What one run did — **never a bare count**.
 *
 * A batch is executed row by row (see `opRunAction`), so a partial result is a
 * real state rather than an edge case, and the report is the honest shape for
 * it. `applied` and `failed` are both enumerated by id: "412 of 500 succeeded"
 * with no way to learn which 88 did not is a report that makes somebody re-read
 * the whole list.
 */
export interface ActionRunResult {
	action: string
	/** Correlates the batch audit entry with the per-row ones. */
	batchId: string
	/** How many ids the caller sent — so a caller can see nothing was dropped. */
	requested: number
	applied: ActionRowOutcome[]
	failed: ActionRowOutcome[]
	/** The value the operator picked, when the action declares `choose`. */
	chosen?: string
}

/** Find a resource's declared action by key. */
export function findActionPlan(
	plans: readonly ActionPlan[] | undefined,
	key: string,
): ActionPlan | undefined {
	return plans?.find((p) => p.key === key)
}

/** The actions a surface should offer at one arity. `both` answers to either. */
export function actionPlansFor(
	plans: readonly ActionPlan[] | undefined,
	arity: 'row' | 'selection',
): ActionPlan[] {
	return (plans ?? []).filter((p) => p.arity === arity || p.arity === 'both')
}

/**
 * The full write one run performs on every row — the declared fixed values plus
 * the operator's choice.
 *
 * Exported and pure because it is the one place the two halves of an
 * {@link ActionPlan} become a single payload, and `opRunAction` and the undo
 * path must agree on which columns that is. Two callers composing it separately
 * is how an undo comes to restore a subset of what the run overwrote.
 */
export function actionWrite(
	plan: ActionPlan,
	chosen: string | undefined,
): Record<string, ActionValue> {
	const write: Record<string, ActionValue> = { ...plan.set }
	if (plan.choose && chosen !== undefined) write[plan.choose.column] = chosen
	return write
}
