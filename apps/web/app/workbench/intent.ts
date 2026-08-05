/**
 * "What are you trying to build?", as a pure fold.
 *
 * # The complaint
 *
 * #256's last unanswered line: *"it's not really asking me high-level intent about
 * what I'm trying to do."* The rebuild's answer was the per-node agent handoff — a
 * copyable sentence that already names the thing you are looking at. That is a real
 * improvement and it is not this. It starts from a node you already found; the
 * person arriving has a goal and no node.
 *
 * The close also named the reason it was left: doing it properly *"means an intent
 * flow that owns a write path"*. A box that takes a sentence and does nothing with
 * it is worse than no box — it looks like the product heard you. So there is one:
 * `web-record-intent`, in {@link ./intent.server.ts}.
 *
 * # Why an intent is a requirement
 *
 * A sentence about what you are trying to build lands as a **requirement in the
 * product layer** — `prd.addRequirement`, the vocabulary that already exists for
 * exactly this. No new op, no new spec concept, nothing for the codec, the
 * generators or the op vocabulary to learn. That matters beyond tidiness: because
 * it is an ordinary requirement, every surface that already reads the product layer
 * sees it *for free*. `query_spec {section:"product"}` returns it, so an agent
 * asked "what is this person trying to build" reads the answer out of the spec
 * rather than being told it in a prompt that vanishes with the conversation.
 *
 * The intent is the durable half; the handoff sentence is the disposable half.
 *
 * It also means this pane adds no browser-only capability, which forbids:
 * `prd.addRequirement` is already reachable from `maxstack op` and from
 * `apply_spec_change`. What the browser adds is the *question* — and the
 * attribution, since an intent recorded here is stamped `human` on the `web`
 * surface rather than landing as one more thing an agent wrote.
 *
 * This module is the part with no IO in it: what a valid intent is, what id it
 * gets, and how the product layer reads back as a list. Split out so the invariant
 * suite can exercise the op this path lands without booting a platform.
 */

import type { Requirement, RequirementId, SpecSystem } from '@maxstack/spec'

/**
 * The rung a recorded intent lands on.
 *
 * `Requirement.priority` is required and has no "unset" member, so something has to
 * be written. P1 rather than P0: P0 in this vocabulary means the release does not
 * ship without it, and nobody said that — they said what they are trying to build.
 * The form deliberately offers no priority control, precisely so this cannot be
 * mistaken for a choice somebody made.
 */
export const DEFAULT_PRIORITY = 'P1' as const

/** Longest sentence we will store. Not a validation ritual: an unbounded field
 *  written straight into the spec file is a way to make the spec unreadable. */
export const MAX_INTENT_LENGTH = 2000

// ===========================================================================
// Read
// ===========================================================================

export interface RecordedIntent {
	id: RequirementId
	story: string
	/** Was this recorded here, by a person, through this write path? Anything else
	 *  in `product.requirements` came from the PRD or from an agent, and saying
	 *  "you told us this" about those would be a small lie in the one place the
	 *  surface is claiming to reflect the maintainer back at them. */
	yours: boolean
	/** When this path landed it, from the op log. `null` for everything else. */
	at: string | null
}

export interface IntentView {
	intents: RecordedIntent[]
	/** How many the maintainer recorded here — the empty state hinges on this, not
	 *  on the total, because a PRD-seeded project is not a project whose owner has
	 *  said what they want. */
	yoursCount: number
}

/** Which requirement ids the given write path landed, and when. */
function recordedBy(spec: SpecSystem, path: string): Map<string, string> {
	const out = new Map<string, string>()
	for (const entry of spec.opLog) {
		if (entry.op.op !== 'prd.addRequirement') continue
		if (entry.actor?.path !== path) continue
		out.set(entry.op.args.requirement.id, entry.appliedAt)
	}
	return out
}

/**
 * Every requirement in the product layer, newest first.
 *
 * Reversed rather than sorted by date: `appliedAt` is a date, not a timestamp, so
 * two intents recorded in one sitting sort arbitrarily by it. Declaration order is
 * the real arrival order and it is already recorded.
 */
export function intentView(spec: SpecSystem, path: string): IntentView {
	const mine = recordedBy(spec, path)
	const intents = spec.product.requirements
		.map((r) => ({
			id: r.id,
			story: r.userStory,
			yours: mine.has(r.id),
			at: mine.get(r.id) ?? null,
		}))
		.reverse()
	return { intents, yoursCount: intents.filter((i) => i.yours).length }
}

// ===========================================================================
// Write — the shape of the op, not the landing of it
// ===========================================================================

/**
 * A readable id derived from the sentence, disambiguated against what is already
 * there. `prd.addRequirement` refuses a duplicate id, so this has to be unique or
 * the maintainer gets an op error for having said a similar thing twice.
 */
export function intentId(
	story: string,
	taken: ReadonlySet<string>,
): RequirementId {
	const stem =
		story
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.split('-')
			.filter(Boolean)
			.slice(0, 5)
			.join('-') || 'intent'
	let id = `r-${stem}` as RequirementId
	for (let n = 2; taken.has(id); n++) id = `r-${stem}-${n}` as RequirementId
	return id
}

export type IntentDraft =
	| { ok: true; requirement: Requirement }
	| { ok: false; message: string }

/**
 * Turn a typed sentence into the requirement this path would land.
 *
 * A result rather than a throw, and pure rather than server-only, so the refusals
 * are testable next to the op they guard — the host turns a refusal into a 400.
 */
export function draftIntent(spec: SpecSystem, raw: unknown): IntentDraft {
	const story = typeof raw === 'string' ? raw.trim() : ''
	if (story.length === 0)
		return { ok: false, message: 'say what you are trying to build' }
	if (story.length > MAX_INTENT_LENGTH)
		return {
			ok: false,
			message: `that is ${story.length} characters; keep an intent under ${MAX_INTENT_LENGTH}`,
		}
	return {
		ok: true,
		requirement: {
			id: intentId(story, new Set(spec.product.requirements.map((r) => r.id))),
			userStory: story,
			// Empty rather than invented. An acceptance criterion the maintainer did
			// not write is a test the agent will happily satisfy instead of the thing
			// they actually meant.
			acceptanceCriteria: [],
			edgeCasesAndErrorStates: [],
			priority: DEFAULT_PRIORITY,
		},
	}
}
