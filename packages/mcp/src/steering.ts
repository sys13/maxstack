/**
 * **Steering in the payload** — the `warnings` / `next` pair every platform tool
 * result carries.
 *
 * A tool *description* is read once, at session start, when the agent has no
 * project loaded and nothing to apply it to. A tool *result* is read at every
 * decision point, by an agent that is already parsing the JSON. So anything the
 * platform wants an agent to actually do belongs in the result, not the
 * description — and it has to be one uniform field across every tool, because a
 * field that appears on some replies is a field an agent learns to stop looking
 * for.
 *
 * Two lists, deliberately distinct:
 *
 *   - `warnings` — *what you just did is not what you think you did.* A spec-op
 *     that applied cleanly and changes nothing about the running application
 * is the archetype: `apply_spec_change` returns a spec-shaped
 *     diff, and a spec-shaped diff cannot say "this block is shadowed".
 *   - `next` — *the cheapest correct action from here.* Agents take the shortest
 *     path to a green signal, so the chain that ends in a real verification has
 * to be the one visible at the moment the agent picks. Declared
 *     `e2eTests` → `run_generator e2e-tests` → `run_checks` is strictly cheaper
 *     than hand-driving a browser, but only if the agent can see it exists.
 *
 * ## Both lists are always present, and both may be empty
 *
 * An empty `warnings` is a claim: *this host looked and found nothing.* That is
 * only honest for the rules this layer can evaluate from the spec alone. Facts
 * the host could not supply — whether the built app is behind the spec, which
 * slots are filled — are never guessed at and never silently dropped: an
 * unavailable fact simply produces no rule, and the rules that depend on it say
 * what they are conditional on. This is the same house rule the `workbench` tool
 * follows with its `unavailable` list.
 */

import {
	getAcceptedOrAll,
	type PageSpec,
	type SpecOp,
	type SpecSystem,
} from '@maxstack/spec'

// ===========================================================================
// Types
// ===========================================================================

export interface Steering {
	/** What just happened that the primary payload does not say. */
	warnings: string[]
	/** The cheapest correct next call(s), in order. */
	next: string[]
}

/** Disk facts a host can supply. Absent ⇒ the dependent rules do not fire. */
export interface SteeringFacts {
	/**
	 * How much of the op log the built application was generated from.
	 *
	 * `null` = nothing has ever been generated; `undefined` = this host cannot
	 * see disk, so staleness is *unknown* and is never reported as fine.
	 */
	generatedFromOpCount?: number | null
}

export interface SteeringInput {
	/** The tool that produced the result. */
	tool: string
	/**
	 * The app-shaped effect the call computed, when it computed one. Supplied so
	 * the *warning* can be raised where the payload only states a fact — an agent
	 * reads `warnings` for "that is not what you think you did", and an op that
	 * changed the document and nothing else is exactly that.
	 */
	effect?: { changesBuiltApp: boolean | null; note?: string | null } | null
	/** The op a mutating tool applied (or a proposal validated), when there is one. */
	op?: SpecOp | null
	/** Whether the call succeeded — a refused op gets repair steering, not build steering. */
	succeeded?: boolean
	facts?: SteeringFacts
}

/**
 * The tools that change the spec, and therefore can leave the build behind.
 *
 * `init` is here even though most calls to it write nothing: the staleness rule
 * asks whether the app on disk is behind the spec, and that is *more* worth
 * saying at session start than after a single op. An agent that opens on a spec
 * nothing has ever generated from should be told so before it starts building on
 * top of it, not fifty ops later.
 */
const MUTATING = new Set(['apply_spec_change', 'record_decision', 'init'])

/** How many rows a warning names before it summarizes the rest. */
const MAX_NAMED = 3

// ===========================================================================
// Rules
// ===========================================================================

/** The page an op targets, when it names one. */
function focusedPage(
	spec: SpecSystem,
	op: SpecOp | null | undefined,
): PageSpec | null {
	if (!op) return null
	const args = (op.args ?? {}) as Record<string, unknown>
	const page = args.page as { id?: unknown } | undefined
	const id =
		typeof args.pageId === 'string'
			? args.pageId
			: typeof page?.id === 'string'
				? page.id
				: null
	if (!id) return null
	return spec.pages.pages.find((p) => p.id === id) ?? null
}

/** A page's accepted `slot:*` block that renders *instead of* the default list. */
function replacingSlot(page: PageSpec): { id: string } | null {
	const block = getAcceptedOrAll(page.blocks).find(
		(b) => b.type.startsWith('slot:') && b.mode === 'replace',
	)
	return block ? { id: block.type.slice('slot:'.length) } : null
}

/**
 * Issue #263 — a list-tuning op on a page whose list is not what renders.
 *
 * `page.setBlockVariant` / `setBlockOrder` / `setBlockFields` all retune the
 * default list. A filled `mode: "replace"` slot renders instead of that list, so
 * the op applies, the diff is real, and the application does not change. The
 * diff cannot say this, because the diff is spec-shaped and the fact is
 * app-shaped.
 *
 * Whether the slot is *filled* is a disk fact this layer cannot see, so the
 * warning states the condition rather than asserting the outcome — an agent can
 * act on "if X then this did nothing"; it cannot act on silence.
 */
const LIST_TUNING_OPS = new Set([
	'page.setBlockVariant',
	'page.setBlockOrder',
	'page.setBlockFields',
	'page.setBlockEditable',
])

function shadowedListWarning(
	spec: SpecSystem,
	op: SpecOp | null | undefined,
): string[] {
	if (!op || !LIST_TUNING_OPS.has(op.op)) return []
	const page = focusedPage(spec, op)
	if (!page) return []
	const slot = replacingSlot(page)
	if (!slot) return []
	return [
		`${op.op} retunes the default list on "${page.name}" (${page.id}), but that page declares the replace-mode slot "${slot.id}". While that slot is filled it renders INSTEAD of the list, so this op changes the spec and changes nothing a user can see. Check \`query_spec {section:"slots"}\` for the slot, and either edit the owned component or set the block's mode to "append".`,
	]
}

/**
 * Issue #263 — the op landed and the application did not move.
 *
 * Only fires on `changesBuiltApp === false`, which `opEffect` sets only for ops
 * whose layer the derived-surface inventory actually models. `null` means the
 * inventory could not see that layer, and an unseen layer is never reported as
 * an inert op — that would turn a coverage gap into a false accusation, the
 * mirror image of the silence this issue opened about.
 *
 * The most common honest cause is the accepted-or-all grounding rule, so the
 * effect's own note is carried through rather than restated: an agent that reads
 * "changed nothing" without "because nothing in this collection is accepted yet"
 * will reach for a second op it does not need.
 */
function inertOpWarning(input: SteeringInput): string[] {
	if (input.succeeded === false) return []
	if (input.effect?.changesBuiltApp !== false) return []
	const what = input.op?.op ?? 'That op'
	const because = input.effect.note ? ` ${input.effect.note}` : ''
	return [
		`${what} changed the spec document and nothing about the built application — no table, column, route, form, REST payload, MCP tool or public field appears, changes or stops existing.${because} Do not report this as a change a user can see; check \`effect\` before summarizing what you shaped.`,
	]
}

/**
 * The read tools where the project's whole verification debt is on-topic. Every
 * other tool reports only the page its op touched — a mutation reply that
 * restates the entire backlog on every call is a reply an agent learns to skip.
 */
const APP_WIDE = new Set([
	'init',
	'query_spec',
	'list_acceptance_criteria',
	'workbench',
	'run_checks',
])

/**
 * Issue #265 — a page nothing verifies.
 *
 * Scoped to the page an op touched when there is one, and to the whole app on
 * the read tools that are already answering a whole-app question.
 */
function unverifiedPagesWarning(
	spec: SpecSystem,
	input: SteeringInput,
): { warnings: string[]; next: string[] } {
	const criteria = spec.product.requirements.reduce(
		(n, r) => n + r.acceptanceCriteria.length,
		0,
	)
	if (criteria === 0) return { warnings: [], next: [] }

	const focus = focusedPage(spec, input.op)
	const candidates = focus
		? [focus]
		: APP_WIDE.has(input.tool)
			? getAcceptedOrAll(spec.pages.pages)
			: []
	const bare = candidates.filter((p) => (p.e2eTests?.length ?? 0) === 0)
	if (bare.length === 0) return { warnings: [], next: [] }

	const named = bare
		.slice(0, MAX_NAMED)
		.map((p) => `"${p.name}" (${p.id})`)
		.join(', ')
	const rest =
		bare.length > MAX_NAMED ? ` and ${bare.length - MAX_NAMED} more` : ''
	return {
		warnings: [
			`This project declares ${criteria} acceptance criteria, but ${named}${rest} declare no e2eTests — nothing verifies ${bare.length === 1 ? 'it' : 'them'} automatically.`,
		],
		next: [
			`Declare them: apply_spec_change {op:"page.setE2ETests", args:{pageId:"${bare[0]?.id}", e2eTests:["…"]}} — one natural-language sentence per behaviour.`,
			'Then run_generator {generator:"e2e-tests"} to scaffold the Playwright specs, and run_checks {checks:["e2e"]} to run them. That chain is cheaper and more repeatable than driving a browser by hand.',
		],
	}
}

/**
 * The built app is behind the spec.
 *
 * Only fires when the host actually supplied a watermark: staleness this layer
 * cannot see is unknown, and unknown is never reported as up to date.
 */
function staleBuildWarning(
	spec: SpecSystem,
	input: SteeringInput,
): { warnings: string[]; next: string[] } {
	if (!MUTATING.has(input.tool) || input.succeeded === false)
		return { warnings: [], next: [] }
	const watermark = input.facts?.generatedFromOpCount
	if (watermark === undefined) return { warnings: [], next: [] }
	const behind = spec.opLog.length - (watermark ?? 0)
	if (behind <= 0) return { warnings: [], next: [] }
	return {
		warnings: [
			watermark === null
				? `The built application has never been generated from this spec — all ${spec.opLog.length} applied ops are unbuilt. The spec is not the app until a generator runs.`
				: `The built application is now ${behind} op(s) behind the spec. Code on disk does not reflect what you just applied.`,
		],
		next: ['run_generator {generator:"page"} to bring the app up to the spec.'],
	}
}

/** Tool-shaped next steps: the cheapest correct call from where the agent is. */
function toolNext(input: SteeringInput): string[] {
	switch (input.tool) {
		case 'init':
			// The cheapest correct move after orienting is to shape the spec in
			// batches, not one op per call — an agent that has just been handed the
			// whole vocabulary will otherwise reach for the singular tool it saw
			// first and pay fifty round trips for one entity.
			return input.succeeded === false
				? [
						'Fix the refused op and resend the WHOLE list — nothing was written.',
					]
				: [
						'init {ops:[…]} again to shape the spec in batches — it validates the chain as a unit, so an entity and all its fields are one call. Add {apply:true} once the merged `effect` is what you meant.',
					]
		case 'propose_spec_change':
			return input.succeeded
				? ['apply_spec_change with the same {op, args} — propose never writes.']
				: []
		case 'run_generator':
			return ['run_checks to confirm the generated code still passes the gate.']
		default:
			return []
	}
}

/**
 * Issue #266 — the ledger is not the defect tracker.
 *
 * Said on the way out rather than only in the tool description, because the
 * misfiling happens at exactly this moment: an agent that has just hit a
 * framework bug reaches for the only write-shaped tool in view. The entry is
 * already written by the time this is read, which is the point — the next one
 * goes to the right place, and the maintainer is told this one may need moving.
 */
function ledgerMisfileWarning(input: SteeringInput): string[] {
	if (input.tool !== 'record_decision' || input.succeeded === false) return []
	return [
		'This entry is permanent — the ledger is append-only. If what you just recorded is a maxstack DEFECT or a workaround for one rather than a choice this project made, it is in the wrong place: call report_defect with the same facts while you still have them, and say in the ledger that the entry should be withdrawn.',
	]
}

// ===========================================================================
// The fold
// ===========================================================================

/** Every rule this layer can evaluate, folded into the uniform pair. */
export function steer(spec: SpecSystem, input: SteeringInput): Steering {
	const unverified = unverifiedPagesWarning(spec, input)
	const stale = staleBuildWarning(spec, input)
	return {
		warnings: [
			...shadowedListWarning(spec, input.op),
			...inertOpWarning(input),
			...ledgerMisfileWarning(input),
			...unverified.warnings,
			...stale.warnings,
		],
		next: [...stale.next, ...unverified.next, ...toolNext(input)],
	}
}
