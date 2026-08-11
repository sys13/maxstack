/**
 * Declared list actions — the `view` layer.
 *
 * ## The gap this closes
 *
 * Of the sixty-three ops that existed before this layer, not one declared
 * something a *user* does to a list. `filter` appears throughout the vocabulary
 * — `portals.setFields`, `data.addRollup`, `live.setLimits` — but always as a
 * server-side bound the caller cannot widen. `page.setBlockFields` picks which
 * columns appear. That was the whole of the list-interaction vocabulary, which
 * is why "let me archive the ones I ticked" and "let me move this deal's stage
 * without opening it" were a slot or an eject.
 *
 * The cause breakdown behind epic #405 measured which of those asks are actually
 * common. Twelve of fifty-seven forced-ownership changes are interaction-layer,
 * and they cluster:
 *
 *   per-row action controls   5   (`ch-member-actions-slot`, `ch-card-actions-slot`,
 *                                  `ch-discussion-actions-slot`, `ch-stage-mover-slot`,
 *                                  `ch-contact-actions-slot`)
 *   bulk actions              2   (`ch-bulk-archive-slot`, `ch-bulk-triage-slot`)
 *   inline edit / create      3
 *   a filter                  1
 *   a moderation queue        1
 *
 * The largest cluster had no issue of its own, and issue #417 named only the
 * second-largest. **They are the same primitive at two arities.** "Suspend this
 * card" and "archive the fourteen I ticked" differ in how many ids arrive, not
 * in what happens to them — so {@link ActionSpec.arity} is a declared field
 * rather than two op families, and one declaration answers four of the twelve
 * corpus asks instead of two.
 *
 * The remaining three per-row asks — RSVP, log a call, invite a member — are
 * *not* covered, and are not quietly counted as covered: each creates a row in
 * another entity or sends mail, and that is a different primitive. See
 * "What this deliberately is not" below.
 *
 * ## Not a client-side loop
 *
 * React Admin's bulk action is a loop over `update` in the browser. That is the
 * natural implementation and it is the wrong one here: it has no single audit
 * record, no server-side authorization of the *batch*, and no origin
 * attribution — three properties this platform charges every other write for.
 *
 * A declared action is a **server operation**. It is the same argument
 * `FieldSpec.limits` already makes about WIP limits living on the field rather
 * than on the board: a rule the UI enforces is a rule an agent driving REST or
 * MCP walks straight past, and "it only holds if you came in through the screen"
 * is not a rule. So an action is declared per *entity*, not per page — a page
 * merely offers a button for one — and `POST /api/:resource/actions/:key`, the
 * per-entity MCP tool and the list toolbar are three doors onto one operation.
 *
 * ## The four refusals this layer is built out of
 *
 * 1. **The selection is the ids the caller sent — never "everything matching the
 *    current filter."** The second is the more useful and far more dangerous
 *    reading, and `planBulkReview` already refused exactly it for review
 *    batching: *"a select-all that grows silently as an agent proposes more is a
 *    rubber stamp with extra steps."* A filter-shaped selection has the same
 *    defect with rows instead of proposals — the operator approves a count they
 *    read a second ago, and the set is resolved server-side afterwards.
 * 2. **The cap is declared, never defaulted.** {@link ActionSpec.maxSelection}
 *    is required, on the argument `LiveSubscriptionSpec.maxSubscribers` makes:
 *    how much one request may do to somebody's database is a decision about
 *    their deployment, and a default is that decision made by whoever wrote the
 *    generator. Over it, the request is **refused whole** rather than truncated
 *    to the first N — #388's precedent, and truncation here would silently do
 *    part of what somebody asked for.
 * 3. **The write is stated in full.** {@link ActionEffect} is a field-set, not a
 *    payload the caller composes. An action that let its caller choose the
 *    fields would be `PATCH` with a button, and the declaration would say
 *    nothing a reviewer could act on.
 * 4. **Every row still goes through `opUpdate`.** Tenancy, soft-delete scope,
 *    portal bound, per-value limits, validation, the row audit entry and the
 *    live publish are not reimplemented here and cannot drift from the single-row
 *    path, because there is no second path. The batch adds authorization *of the
 *    batch* on top; it never replaces the per-row one.
 *
 * ## What this deliberately is not, and why each is out
 *
 *  - **No delete.** Bulk deletion is the single most destructive button a list
 *    can carry, and `bulk-review.ts`'s asymmetry — *"risk defaults to high, and
 *    every rule can only lower it"* — says that arrives as `high` and has to be
 *    argued down rather than shipped alongside a status flip. `/admin` already
 *    has a bulk delete behind the delete capability for the operator who needs
 *    one; making it *declarable*, so it lands in an end user's toolbar, is its
 *    own review.
 *  - **No create, and no side effect.** RSVP, "log a call" and "invite" all
 *    write a row somewhere else or send mail. Both are real asks; both need a
 *    target entity, a field mapping and — for mail — a template and a rate
 *    class. Squeezing them into a field-set write would mean an action whose
 *    declaration does not say what it does.
 *  - **No expression.** {@link ActionValue} is a literal. There is no "set
 *    `closedAt` to now()", no reference to the row's other columns, and no
 *    string DSL, for `ComputedExpr`'s reason: the moment a value is computed,
 *    the declaration stops being reviewable by reading it.
 *
 * ## Where authorization lives
 *
 * Not on the route. #186's finding stands — `/mcp` and the admin loaders reach
 * the data layer without passing a route-level gate, so a role check written at
 * the HTTP boundary is a check three of four callers skip. {@link ActionSpec.role}
 * is enforced inside the operation, next to the per-row `authorize` call it sits
 * in front of.
 */

import type { ActionId, EntityId, FieldId, ISODate } from './ids.ts'
import type { Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

// ===========================================================================
// The declaration
// ===========================================================================

/**
 * How many rows one run of an action may be aimed at.
 *
 *  `row`       one id, from a control on the row itself. "Suspend this card."
 *  `selection` many ids, from a toolbar over ticked rows. "Archive these."
 *  `both`      the same action offered in both places.
 *
 * A declared arity is what lets one op cover the corpus's two clusters at once,
 * and it is a *declaration* rather than an inference from `maxSelection` because
 * "this may be run on many rows" and "this should have a button on every row"
 * are different product decisions. An action that is destructive-but-quick is
 * plausibly `selection` only (you should have to tick something first); an
 * action that is cheap and per-row is plausibly `row` only.
 */
export type ActionArity = 'row' | 'selection' | 'both'

/** Runtime guard for {@link ActionArity} — same rationale as `FIELD_TYPES`:
 *  the union is erased, and an action arriving as JSON through the MCP apply
 *  tool needs something to check against. */
export const ACTION_ARITIES: readonly ActionArity[] = [
	'row',
	'selection',
	'both',
]

/**
 * A value an action may write. Literals only — see "No expression" above.
 *
 * `null` is included and means *clear this column*, which is a real ask ("unset
 * the assignee on these") and is not expressible any other way. It is refused on
 * a required field by the validator rather than by the database, so the refusal
 * names the field.
 */
export type ActionValue = string | number | boolean | null

/**
 * What an action writes.
 *
 * Two halves, and at least one of them must contribute:
 *
 *  - {@link set} — fields written to fixed values. The whole of "archive these"
 *    (`{fld-status: "archived"}`).
 *  - {@link choose} — at most **one** `enum` field whose value the operator
 *    picks when they run it, from that field's own declared options. This is
 *    what makes `ch-stage-mover-slot` — *"move a deal's stage without opening
 *    it"* — one declaration instead of one per stage.
 *
 * `choose` is confined to a single enum field on purpose. Its options are the
 * field's declared ones, so the set of values an action can produce is still
 * finite, still stated in the spec, and still checked server-side; widening it
 * to free text or to several fields would turn the declaration back into a
 * caller-composed payload, which is refusal 3.
 */
export interface ActionEffect {
	/** `fieldId → literal`. May be empty only when {@link choose} is present. */
	set: Record<string, ActionValue>
	/** An `enum` field whose value the operator picks at run time. */
	choose?: FieldId
}

/**
 * One declared action over one entity.
 *
 * Provenanced like every other declaration, so an agent proposing one lands in
 * the review queue rather than in the app. It arrives at `high` risk and
 * unbatchable — see {@link ACTION_REVIEW_KIND}.
 */
export interface ActionSpec extends Provenanced {
	id: ActionId
	/**
	 * The name in the URL (`/api/:resource/actions/<key>`), in the audit row, in
	 * the MCP tool name and in the metric label — the string a person types and
	 * an incident report quotes. Separate from {@link label} for the reason every
	 * other layer separates them: the label is prose somebody will reword, and a
	 * reworded button must not move an endpoint.
	 */
	key: string
	/** The button text. */
	label: string
	/**
	 * What this action is for, in one line. Printed beside the write in the
	 * action report, and required for `LiveSubscriptionSpec.description`'s
	 * reason: a button that changes fourteen rows and that nobody can explain is
	 * one nobody can decide to remove.
	 */
	description: string
	entityId: EntityId
	arity: ActionArity
	effect: ActionEffect
	/**
	 * The role a caller must hold, in addition to being allowed to update the
	 * entity at all. Absent means no *extra* role — the per-row update check is
	 * the whole gate, which is the honest default for "archive the ones I ticked"
	 * on rows the caller could already have edited one at a time.
	 *
	 * Absent is therefore not a hole: an action can never do something its caller
	 * could not do row by row. What a role adds is the *batch* being privileged
	 * even when the individual writes are not.
	 */
	role?: string
	/**
	 * The most rows one run may touch. Required, never defaulted, and at most
	 * {@link MAX_ACTION_SELECTION}. See refusal 2 — over it the run is refused
	 * whole, not truncated.
	 *
	 * `1` is meaningful and is the right value for a `row`-arity action: it says
	 * the operation is per-row by construction, so a caller posting twelve ids to
	 * the endpoint is refused by the declaration rather than by the UI not having
	 * offered a checkbox.
	 */
	maxSelection: number
	/**
	 * Whether the run records what it overwrote.
	 *
	 * `true` makes the batch audit entry carry the **prior value of exactly the
	 * fields written**, per row, which is what makes the run reversible — the
	 * undo replays those values back through `opUpdate`, so it is an ordinary
	 * authorized, audited, published write rather than a privileged rollback.
	 *
	 * Required and never defaulted, because it is a *storage* decision as much as
	 * a product one: the record is proportional to the selection, and an
	 * always-on before-image on a five-hundred-row batch is a cost somebody
	 * should choose. `false` is honest — the run is not reversible and the
	 * toolbar does not offer to reverse it.
	 */
	undoable: boolean
	/** When the action entered the spec — stamped by the applier. */
	declaredAt: ISODate
}

/** The `view` layer as it sits in the spec system. */
export interface ViewSpec {
	actions: ActionSpec[]
}

// ===========================================================================
// Bounds
// ===========================================================================

/** Keys are URL segments, audit labels and MCP tool-name fragments. */
export const ACTION_KEY_RE = /^[a-z][a-z0-9-]*$/

/** Long enough for `mark-as-awaiting-customer`, short enough to read in a log. */
export const MAX_ACTION_KEY_LENGTH = 48

/**
 * The ceiling a declared {@link ActionSpec.maxSelection} may not exceed.
 *
 * Five hundred, and the number comes from the execution model rather than from
 * taste: each row is a separate `opUpdate` — its own read-back, its own
 * authorize, its own validate, its own audit row and its own live publish —
 * because sharing a fast path with the single-row write is worth more than
 * batching is. Five hundred of those is already a request that holds a
 * connection for a noticeable time; five thousand is a request that should have
 * been a job. When somebody needs five thousand, the answer is the schedules
 * layer, not a bigger number here.
 */
export const MAX_ACTION_SELECTION = 500

/**
 * The most fields one action may write.
 *
 * A bound rather than a limit anybody will meet: "triage these" sets a status,
 * a priority and an assignee. An action writing sixteen columns is a migration
 * wearing a button, and the declaration should be read as one.
 */
export const MAX_ACTION_SET_FIELDS = 8

/**
 * The review-target kind an action declaration is reviewed as.
 *
 * Deliberately **absent** from `bulk-review.ts`'s `UNDERSTOOD_KINDS`, and that
 * absence is the design working rather than an omission: the default-high rule
 * refuses a new kind a place in a review batch without anybody writing a rule
 * for it. An op that grants a button the power to rewrite five hundred rows is
 * exactly the thing that must not ride into production inside a batch of twenty
 * field additions. `view.test.ts` pins it, so making it batchable has to be a
 * deliberate edit to a test that says why it is there.
 */
export const ACTION_REVIEW_KIND = 'action' as const

// ===========================================================================
// Reading the layer
// ===========================================================================

/** Every declared action, or `[]` for a spec that has never declared one. */
export function listActions(spec: Pick<SpecSystem, 'view'>): ActionSpec[] {
	return spec.view?.actions ?? []
}

/**
 * The actions a runtime will actually offer and answer on: **accepted only**.
 *
 * `activePortals`' departure from the accepted-else-all convention rather than
 * `activeLiveSubscriptions`' adherence to it, and the asymmetry is the same one
 * stated the other way round. A live channel reaches nobody a read op would not
 * already reach, so an unreviewed suggestion there costs performance. An action
 * *writes*, in bulk, from a button — so the worst case of the fallback is an
 * agent's unreviewed suggestion appearing in an end user's toolbar and changing
 * five hundred rows. Accepted-only means a spec whose actions are all still
 * suggested offers none, which is the correct reading of "nobody has approved
 * this yet".
 */
export function activeActions(spec: Pick<SpecSystem, 'view'>): ActionSpec[] {
	return listActions(spec).filter((a) => a.provenance.isAccepted === true)
}

/** The declared action with this key, if any. Keys are unique spec-wide. */
export function findActionByKey(
	spec: Pick<SpecSystem, 'view'>,
	key: string,
): ActionSpec | undefined {
	return listActions(spec).find((a) => a.key === key)
}

/** The accepted actions over one entity, at an arity that would offer them
 *  here. `both` answers to either question, which is the point of it. */
export function actionsFor(
	spec: Pick<SpecSystem, 'view'>,
	entityId: EntityId,
	arity: 'row' | 'selection',
): ActionSpec[] {
	return activeActions(spec).filter(
		(a) => a.entityId === entityId && (a.arity === arity || a.arity === 'both'),
	)
}

/**
 * One line of prose for an action — the diff summary, the toolbar caption, the
 * workbench row.
 *
 * It always names **what is written** and **how many rows at once**, because
 * those are the two facts that decide whether a declaration is a convenience or
 * an incident, and neither is reconstructible from an id.
 */
export function describeAction(action: ActionSpec): string {
	const writes = Object.entries(action.effect.set).map(
		([field, value]) => `${field}=${value === null ? 'null' : String(value)}`,
	)
	if (action.effect.choose) writes.push(`${action.effect.choose}=<chosen>`)
	const gate = action.role ? `, role "${action.role}"` : ''
	const undo = action.undoable ? ', undoable' : ''
	return `${action.arity} action "${action.key}" on ${action.entityId} — sets ${writes.join(', ')}, ≤${action.maxSelection} row(s) per run${gate}${undo}`
}

// ===========================================================================
// The action report — the review artifact
// ===========================================================================

/**
 * One action's declared blast radius, flattened for review.
 *
 * The question a reviewer is actually asking before approving a
 * `view.addAction` is "**how many rows can one click change, and into what?**".
 * That is answered by a flat table, not by reading a nested declaration — the
 * same argument `liveLoadReport` makes about ceilings.
 */
export interface ActionReportRow {
	key: string
	entityId: EntityId
	arity: ActionArity
	/** The fields written, as `field=value`, including the chosen one. */
	writes: string[]
	maxSelection: number
	/** The extra role required, or `null` for "whoever may update the entity". */
	role: string | null
	undoable: boolean
	/** Whether an operator has approved this action existing at all. */
	accepted: boolean
}

/**
 * Every declared action's blast radius, sorted by key.
 *
 * Unaccepted actions are included and marked, on `portalExposureReport`'s rule:
 * a suggested action is one review away from being a button, and a report that
 * hid it would answer "what could this app do to its own rows" with "what it
 * does today".
 */
export function actionReport(
	spec: Pick<SpecSystem, 'view'>,
): ActionReportRow[] {
	return listActions(spec)
		.map((a) => {
			const writes = Object.entries(a.effect.set).map(
				([field, value]) =>
					`${field}=${value === null ? 'null' : String(value)}`,
			)
			if (a.effect.choose) writes.push(`${a.effect.choose}=<chosen>`)
			return {
				key: a.key,
				entityId: a.entityId,
				arity: a.arity,
				writes,
				maxSelection: a.maxSelection,
				role: a.role ?? null,
				undoable: a.undoable,
				accepted: a.provenance.isAccepted === true,
			}
		})
		.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * The reviewable paragraph — what the workbench prints above the table.
 *
 * It leads with the **worst case**: the largest number of rows any single click
 * in this app can change. That is the number somebody skimming needs, and it is
 * a maximum rather than a sum because one person clicks one button — summing
 * the caps would describe a coordinated attack rather than a mistake, and the
 * mistake is what review is for.
 *
 * It says "no actions declared" in words rather than printing an empty table:
 * an empty report and a missing one look identical and mean opposite things.
 */
export function summarizeActions(report: readonly ActionReportRow[]): string {
	if (report.length === 0)
		return 'No list actions declared — every write in this app goes through a form, one row at a time.'
	const live = report.filter((r) => r.accepted)
	const worst = live.reduce((n, r) => Math.max(n, r.maxSelection), 0)
	const pending = report.length - live.length
	const entities = new Set(report.map((r) => r.entityId))
	const irreversible = live.filter((r) => !r.undoable).length
	return (
		`${report.length} action(s) over ${entities.size} entit(y/ies): ` +
		(live.length === 0
			? 'none accepted yet, so none is offered'
			: `one click may change up to ${worst} row(s)`) +
		(irreversible > 0
			? `, ${irreversible} of them not undoable — the run records nothing it overwrote`
			: '') +
		(pending > 0 ? `, ${pending} awaiting review` : '') +
		'. Every row is written through the ordinary update path, so tenant scope, per-value limits and the row audit entry apply unchanged.'
	)
}
