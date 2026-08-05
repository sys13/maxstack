/**
 * The host half of the intent flow — the write path
 * `web-record-intent`.
 *
 * The reasoning about *what* an intent is and why it is a product-layer
 * requirement lives in {@link ./intent.ts}, which is pure. This file is the part
 * that touches the platform: load, draft, apply, save.
 *
 * What it deliberately does not do:
 *
 *   - **No model call.** Not from the loader (that rule is `ai-cluster.server.ts`'s
 *     whole module note) and not from this action either. Turning prose into ops is
 *     the agent's job, and the agent is on the other side of the handoff. This
 *     records what you said, verbatim, attributed to you.
 *   - **It does not accept anything.** `canAccept: false` in the registry, and the
 *     invariant suite asserts it: the op log grows by exactly one
 *     `prd.addRequirement` and no row's `isAccepted` moves. This is the only write
 *     on this surface a person reaches without first being shown a row to decide
 *     about, which is exactly why that has to be pinned rather than assumed.
 *
 * Registry: `scripts/write-paths.config.json` → `web-record-intent`. Policy:
 * `docs/write-paths.md`. Covered by `write-path.invariant.test.ts`.
 */

import { applyOp } from '@maxstack/spec'
import { getPlatform } from '~/sprout.server'
import { draftIntent, type IntentView, intentView } from './intent'

/**
 * The write path's id, stamped as `actor.path` on every op it lands so a log entry
 * points back at its declaration.
 */
export const INTENT_ACTOR = {
	surface: 'web' as const,
	path: 'web-record-intent',
}

/** Every recorded intent, newest first, flagged with which ones are the
 *  maintainer's own words rather than the PRD's. */
export async function loadIntents(): Promise<IntentView> {
	return intentView(await getPlatform().spec.load(), INTENT_ACTOR.path)
}

/**
 * Record one intent.
 *
 * Lands `prd.addRequirement` through the platform's own spec store, stamped
 * `origin: 'human'` — the maintainer typed this, and the trail says so rather than
 * attributing their goal to whichever agent later writes the code for it.
 */
export async function submitIntent(form: FormData): Promise<{ id: string }> {
	const platform = getPlatform()
	const spec = await platform.spec.load()
	const draft = draftIntent(spec, form.get('story'))
	if (!draft.ok) throw new Response(draft.message, { status: 400 })

	await platform.spec.save(
		applyOp(
			spec,
			{ op: 'prd.addRequirement', args: { requirement: draft.requirement } },
			{
				id: platform.nextOpId(),
				origin: 'human',
				appliedAt: platform.now(),
				actor: INTENT_ACTOR,
			},
		),
	)
	return { id: draft.requirement.id }
}
