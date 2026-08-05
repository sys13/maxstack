/**
 * Who made a change — the structured half of an op-log entry's attribution
 *.
 *
 * `AppliedOp.origin` has always answered *what kind* of author landed an op
 * (`'ai'` vs `'human'`), and that one bit carries the whole provenance story the
 * platform tells. It is not enough to review with. Two entries both stamped
 * `'ai'` may be a coding agent driving MCP in a session the maintainer was
 * watching and a scheduled job holding a long-lived API key — the same label on
 * two changes a reviewer would treat completely differently.
 *
 * So `origin` keeps its meaning (the author *kind*, unchanged and still the
 * thing provenance grounding reads) and an {@link OpActor} rides alongside it
 * carrying *which* author: the surface the write arrived through, the agent that
 * named itself, the session that groups a batch of work, and the API key that
 * authorized it. Nothing here is derived from `origin` and `origin` is not
 * restated here — one fact, one home (the single-derivation rule).
 *
 * ## Why this is a record and not a gate
 *
 * The load-bearing sentence of the positioning is that the maintainer stays in
 * charge of every change. That is served by every change being **attributable,
 * visible and revertible**, not by every change being blocked pending approval —
 * a review step that blocks an agent's applied op would either be bypassed or
 * would stop the agent loop working at all, and issue #70 already settled that
 * MCP-applied rows land accepted so the running app can see them.
 *
 * The invariant this type exists to make testable is therefore:
 *
 *   > **No write path may land a change without recorded attribution.**
 *
 * Which is enforced two ways, deliberately belt-and-braces:
 *   - {@link ApplyMeta.actor} is **required**, so a new write path cannot forget
 *     it — the typechecker refuses the call;
 *   - `scripts/check-write-paths.mjs` refuses a write path that is not declared
 *     in `scripts/write-paths.config.json` and covered by a named invariant
 *     test, so silence is a failure rather than a pass.
 *
 * ## Privacy
 *
 * Every field is an identifier of a *machine or a surface*, never of a person:
 * `agent` is a tool name, `session` is an opaque per-invocation id, `keyId` is
 * the api-key row id and never the secret. A human author is recorded as
 * `origin: 'human'` plus the surface they used, and that is all — the spec is a
 * file in the maintainer's repo, and it is not the place to accumulate a record
 * of who was at the keyboard.
 */

import { z } from 'zod'

// ===========================================================================
// The surface vocabulary
// ===========================================================================

/**
 * The surface a spec write arrived through — the *transport*, deliberately
 * distinct from `origin`'s *author kind*, because the two are independent: a
 * human runs the CLI and so does an agent, and both drive the web
 * workbench.
 *
 * This union IS the write-path registry's vocabulary: `check-write-paths.mjs`
 * reads it out of this file and refuses a registry entry naming a surface that
 * is not listed here, so adding a write path is a two-file change that cannot
 * be half-done.
 *
 *   `mcp`      the platform MCP tools — `apply_spec_change` / `record_decision`
 *   `cli`      the `maxstack` write verbs — `op`, `add-entity`, `add-field`, …
 *   `web`      the workbench and the sprout server, in-browser writes
 *   `bundle`   a feature-bundle install lowering its runtime into spec ops
 *   `codemod`  a bundle upgrade's codemod rewriting an installed declaration
 *   `harness`  the eval / long-lived / fixture-capture rigs, never a real project
 */
export const OP_SURFACES = [
	'mcp',
	'cli',
	'web',
	'bundle',
	'codemod',
	'harness',
] as const

export type OpSurface = (typeof OP_SURFACES)[number]

// ===========================================================================
// The actor
// ===========================================================================

/**
 * Which author landed an op. Only {@link OpActor.surface} is required: it is the
 * one field every write path knows about itself without being told, so a
 * required-but-unknowable field would just get a placeholder — and a placeholder
 * in a provenance record is worse than an absent value, because it reads as an
 * answer.
 */
export interface OpActor {
	/** The transport the write arrived through. Always known. */
	surface: OpSurface
	/**
	 * The agent or tool that drove the write, when it named itself —
	 * `'claude-code'`, `'maxstack-cli'`. Absent when nothing identified itself;
	 * never guessed from the environment (see `resolveOrigin`'s narrowness).
	 */
	agent?: string
	/**
	 * An opaque id grouping every op from one invocation or conversation, so a
	 * reviewer can see "these eleven changes are one piece of work" rather than
	 * eleven unrelated rows. Not a user id and not stable across sessions.
	 */
	session?: string
	/**
	 * The api-key row id that authorized the write — the key's
	 * identity, never its secret. Present on writes that arrived holding a key
	 * (a scheduled job, a webhook receiver, a remote agent) and absent on an
	 * interactive one.
	 */
	keyId?: string
	/**
	 * The write path's registry id from `scripts/write-paths.config.json`. This is
	 * what ties a landed op back to the declared, test-covered path that produced
	 * it, and what makes an op-log entry from an *undeclared* path identifiable
	 * after the fact rather than only at CI time.
	 */
	path?: string
}

export const opActorSchema = z.object({
	surface: z.enum(OP_SURFACES),
	agent: z.string().min(1).optional(),
	session: z.string().min(1).optional(),
	keyId: z.string().min(1).optional(),
	path: z.string().min(1).optional(),
}) satisfies z.ZodType<OpActor>

// ===========================================================================
// Display
// ===========================================================================

/**
 * A one-line human label for an actor, for the workbench and the CLI. Takes
 * `origin` alongside because the author kind lives there — this is the one place
 * the two halves are read together, and reading them together is exactly what a
 * reviewer needs ("ai via mcp · claude-code").
 */
export function describeActor(
	origin: 'ai' | 'human',
	actor: OpActor | undefined,
): string {
	if (!actor) return origin
	const parts = [`${origin} via ${actor.surface}`]
	if (actor.agent) parts.push(actor.agent)
	if (actor.keyId) parts.push(`key ${actor.keyId}`)
	return parts.join(' · ')
}
