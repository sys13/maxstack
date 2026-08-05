/**
 * Who authored a spec op — the value stamped as `origin` on every op-log entry.
 *
 * `origin` is meant to record the *author* (a person vs an agent), not the
 * transport that carried the change. Before issue #141 the CLI hardcoded
 * `'human'` on every write verb, so an agent that shelled out to
 * `maxstack add-entity` — which the docs actively encourage — silently logged
 * its own work as human-authored, while the same op over MCP logged `'ai'`.
 * The provenance ledger is a first-class concept here (accept/reject review,
 * audit), so a label that tracks the wire rather than the author is a bug.
 *
 * Resolution order, most explicit first:
 *   1. `--origin ai|human` on the command
 *   2. `MAXSTACK_ORIGIN=ai|human` in the environment
 *   3. agent-environment detection (see {@link AGENT_ENV_VARS})
 *   4. `'human'`
 *
 * Detection is deliberately a *last* resort and deliberately narrow: only env
 * vars a harness sets for itself, never a guess from TTY-ness or CI. Harnesses
 * we don't know about set `MAXSTACK_ORIGIN` instead of us inventing signatures
 * for them.
 *
 * Issue #200 added {@link resolveActor} alongside: `origin` answers what *kind*
 * of author landed an op, and that one bit turned out not to be enough to review
 * with. The richer record lives next to it rather than replacing it — see
 * `@maxstack/spec`'s `OpActor` for why the two stay separate facts.
 */

import type { OpActor } from '@maxstack/spec'

export type OpOrigin = 'ai' | 'human'

const ORIGINS: readonly OpOrigin[] = ['ai', 'human']

/**
 * The agent names we can recognise, keyed by the env var that proves it. Same
 * discipline as {@link AGENT_ENV_VARS}: only vars a harness sets for *itself*,
 * so the name in the audit trail is one the tool claimed rather than one we
 * inferred. Anything else sets `MAXSTACK_AGENT`.
 */
const AGENT_NAMES: readonly (readonly [string, string])[] = [
	['CLAUDECODE', 'claude-code'],
	['CLAUDE_CODE_ENTRYPOINT', 'claude-code'],
]

/**
 * Env vars that mean "an agent is driving this shell". `CLAUDECODE=1` and
 * `CLAUDE_CODE_ENTRYPOINT` are both set by Claude Code itself.
 */
const AGENT_ENV_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const

/** Treat the usual "explicitly off" spellings as absent. */
function isSet(value: string | undefined): boolean {
	if (value === undefined) return false
	const v = value.trim().toLowerCase()
	return v !== '' && v !== '0' && v !== 'false'
}

function parse(value: string, source: string): OpOrigin {
	const v = value.trim().toLowerCase()
	if ((ORIGINS as readonly string[]).includes(v)) return v as OpOrigin
	throw new Error(
		`invalid ${source} "${value}" — expected one of: ${ORIGINS.join(' | ')}`,
	)
}

/**
 * Resolve the `origin` to stamp on ops this invocation lands. `env` is
 * injectable so the resolution order is testable without mutating the process.
 */
export function resolveOrigin(
	explicit?: string,
	env: NodeJS.ProcessEnv = process.env,
): OpOrigin {
	if (explicit !== undefined) return parse(explicit, '--origin')
	const fromEnv = env.MAXSTACK_ORIGIN
	if (fromEnv !== undefined && fromEnv.trim() !== '') {
		return parse(fromEnv, 'MAXSTACK_ORIGIN')
	}
	if (AGENT_ENV_VARS.some((name) => isSet(env[name]))) return 'ai'
	return 'human'
}

/**
 * Resolve the full {@link OpActor} to stamp on ops this invocation lands — the
 * `cli` surface plus whatever the environment actually identified.
 *
 * `resolveOrigin` answers *what kind* of author; this answers *which*. It is a
 * separate function rather than a wider return type because `origin` is a
 * settled concept with many callers, and because the two have genuinely
 * different failure modes: an unresolvable origin is a hard error (the CLI
 * refuses an invalid `--origin`), while an unidentifiable agent is simply an
 * absent field.
 *
 * Every value is read from the environment or the flags, never inferred:
 *   - `agent`   `--agent`, else `MAXSTACK_AGENT`, else a recognised harness
 *   - `session` `MAXSTACK_SESSION` — an opaque id the caller chooses, so a batch
 *               of ops from one agent run can be reviewed as one piece of work
 * - `keyId` `MAXSTACK_KEY_ID` — the api-key row id, never the secret
 */
export function resolveActor(
	opts: { path: string; agent?: string },
	env: NodeJS.ProcessEnv = process.env,
): OpActor {
	const trimmed = (value: string | undefined): string | undefined => {
		const v = value?.trim()
		return v ? v : undefined
	}
	const detected = AGENT_NAMES.find(([name]) => isSet(env[name]))?.[1]
	const actor: OpActor = { surface: 'cli', path: opts.path }
	const agent = trimmed(opts.agent) ?? trimmed(env.MAXSTACK_AGENT) ?? detected
	if (agent) actor.agent = agent
	const session = trimmed(env.MAXSTACK_SESSION)
	if (session) actor.session = session
	const keyId = trimmed(env.MAXSTACK_KEY_ID)
	if (keyId) actor.keyId = keyId
	return actor
}
