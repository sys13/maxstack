/**
 * How was this CLI launched, and therefore what command should the files we
 * scaffold use to invoke it again?
 *
 * Every project this CLI scaffolds contains two files that re-invoke the CLI
 * *later*, from a process we don't control:
 *
 *   - `.mcp.json` — the agent client spawns it to get `mcp__maxstack__*`.
 *   - `.claude/settings.json` — the PreToolUse hook that keeps agents off
 *     generated files spawns `maxstack guard-edit`.
 *
 * Both shipped a bare `maxstack`, which is correct exactly when the user has a
 * global install — the thing issue #190 exists to stop asking for. Under
 * `npx maxstack init` there is no `maxstack` on PATH at all, so the scaffold
 * came out *pre-broken*: the MCP server never starts, the edit guard never
 * runs, and both fail silently. The scaffold then printed a warning telling the
 * user to `npm install -g maxstack`, i.e. the global install we just claimed
 * they didn't need.
 *
 * The fix is to write down the invocation that actually works for the way the
 * CLI is installed *right now*. Under npx that is a version-pinned
 * `npx -y maxstack@<version>`: no global state, reproducible for the next
 * person who opens the repo, and warm — it resolves out of the same `_npx`
 * cache entry the user's own command just populated.
 *
 * Deliberately two modes, not four. A local devDependency install and a global
 * install both put `maxstack` somewhere PATH-shaped and are unchanged by this;
 * inventing a distinct config for each would be config surface with no failing
 * case behind it.
 */

import { HUB_ROOT } from './paths.ts'

export type LaunchMode = 'npx' | 'direct'

/**
 * How the running CLI was launched.
 *
 * The durable signal is *where we are installed*: npm's `npx` unpacks into a
 * cache entry under a `_npx` directory, and that stays true no matter how many
 * times the process re-executes. The `npm_command` env var agrees but is only
 * set in the immediate child of `npm exec`, so it is a corroborating hint
 * rather than the test.
 */
export function launchMode(
	selfPath: string = HUB_ROOT,
	env: Record<string, string | undefined> = process.env,
): LaunchMode {
	if (/[/\\]_npx[/\\]/.test(selfPath)) return 'npx'
	// `npx` on a package that is *already* installed locally re-uses
	// `node_modules` rather than a `_npx` entry, in which case `maxstack` is on
	// PATH for the duration of that one command but not afterwards — so trust
	// the env only when the path gives us nothing.
	if (env.npm_command === 'exec' && /[/\\]node_modules[/\\]/.test(selfPath))
		return 'npx'
	return 'direct'
}

/** A command line for spawning the CLI, split the way a JSON config wants it. */
export interface CliInvocation {
	command: string
	/** Arguments that precede the verb (`['-y', 'maxstack@0.11.6']` under npx). */
	prefix: string[]
	/** The same thing as one shell-pasteable string, for hook configs and prose. */
	shell: string
}

/**
 * The invocation to write into a scaffolded config, for a CLI launched in
 * `mode` at `version`.
 *
 * The npx form pins the version on purpose. `npx maxstack mcp` unpinned would
 * drift to whatever is `latest` months from now and pair a new CLI with a spec
 * written by an old one; worse, it is the form that makes npm *prompt* for
 * install consent, and a config that blocks on a prompt inside a client's stdio
 * handshake looks exactly like a hung server.
 */
export function cliInvocation(
	mode: LaunchMode,
	version: string,
): CliInvocation {
	if (mode === 'npx') {
		const spec = `maxstack@${version}`
		return {
			command: 'npx',
			prefix: ['-y', spec],
			shell: `npx -y ${spec}`,
		}
	}
	return { command: 'maxstack', prefix: [], shell: 'maxstack' }
}

/** The invocation for the CLI as it is running now. */
export async function currentInvocation(): Promise<CliInvocation> {
	const { cliVersion } = await import('./cli-resolution.ts')
	return cliInvocation(launchMode(), await cliVersion())
}
