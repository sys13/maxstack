/**
 * Does the `maxstack` on `PATH` match the CLI that's running?
 *
 * The scaffolded `.mcp.json` and `.claude/settings.json` invoke a bare
 * `maxstack` — deliberately, because both files are committed and an absolute
 * path would break for everyone else on the repo. The cost is that they resolve
 * to whatever global install the user happens to have, which may predate the
 * verbs they name.
 *
 * That failure is silent and total: an older global has no `mcp` verb, so the
 * MCP server never starts and the agent quietly has no `mcp__maxstack__*` tools
 * — indistinguishable from the cold-start bug the stdio switch was meant to
 * end. Same for `guard-edit`: the hook errors, and edits to generated files just
 * succeed.
 *
 * Resolution can't be fixed portably without an install step, so the fix is to
 * make the mismatch **loud at the two moments a human is looking**: `init`
 * (scaffold) and `dev` (the self-heal path for existing projects).
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { HUB_ROOT } from './paths.ts'

const run = promisify(execFile)

/** This CLI's own version — what a scaffolded project pins its toolchain to. */
export async function cliVersion(): Promise<string> {
	try {
		const pkg = JSON.parse(
			await readFile(resolve(HUB_ROOT, 'package.json'), 'utf8'),
		) as { version?: string }
		return pkg.version ?? '0.0.0'
	} catch {
		return '0.0.0'
	}
}

/**
 * The one package a scaffolded project pins tree-wide via `overrides`
 *. See `scaffoldOverrides` in `commands/init.ts` for why.
 */
export const PINNED_DEP = 'drizzle-orm'

/**
 * The range this CLI's own manifest declares for a third-party dependency, or
 * `null` when the manifest can't be read or doesn't declare it.
 *
 * Used to pin a scaffolded project's dependency overrides to the
 * exact copy the runtime ships. The CLI and `maxstack-runtime` are published in
 * lockstep from one workspace, so the CLI's own manifest is a faithful stand-in
 * for the runtime's — and it is on disk at scaffold time, which the runtime's
 * is not (nothing is installed yet when `init` writes package.json).
 */
export async function cliDependencyRange(
	name: string,
): Promise<string | null> {
	try {
		const pkg = JSON.parse(
			await readFile(resolve(HUB_ROOT, 'package.json'), 'utf8'),
		) as { dependencies?: Record<string, string> }
		return pkg.dependencies?.[name] ?? null
	} catch {
		return null
	}
}

export interface PathCliStatus {
	/** The version `maxstack --version` on PATH reports, or null if absent. */
	found: string | null
	/** Does it support the verbs the scaffolded config invokes? */
	usable: boolean
}

/**
 * Probe the `maxstack` on PATH. Never throws — a probe that fails is reported
 * as "absent", which is the conservative reading.
 */
export async function probePathCli(): Promise<PathCliStatus> {
	let found: string | null = null
	try {
		const { stdout } = await run('maxstack', ['--version'], { timeout: 10_000 })
		found = stdout.trim() || null
	} catch {
		return { found: null, usable: false }
	}
	// Version strings don't tell us which verbs exist (a fork or a local build
	// can report anything), so ask the binary what it can do. Note `maxstack mcp
	// --help` is NOT a usable probe: commander handles `--help` globally and
	// exits 0 with the top-level help even for a verb it doesn't have. The
	// command list in `--help` is the honest answer, and it has no side effects
	// — running `maxstack mcp` for real would start a server and hang.
	try {
		const { stdout } = await run('maxstack', ['--help'], { timeout: 10_000 })
		return { found, usable: listsVerb(stdout, 'mcp') }
	} catch {
		return { found, usable: false }
	}
}

/** Does commander's help list this verb? Matches the indented `  <verb> …` row
 * commander emits, not a bare mention inside some other command's description. */
function listsVerb(help: string, verb: string): boolean {
	return new RegExp(`^\\s+${verb}(\\s|$)`, 'm').test(help)
}

/**
 * The warning to print, or null when the PATH CLI is fine. `expected` is the
 * running CLI's own version, which is what the scaffold pins.
 */
export function pathCliWarning(
	status: PathCliStatus,
	expected: string,
): string | null {
	if (status.usable) return null
	const install = `npm install -g maxstack@${expected}`
	if (status.found === null) {
		return (
			'⚠ no `maxstack` on PATH.\n' +
			'  The scaffolded .mcp.json and .claude/settings.json invoke it by name, so\n' +
			'  agent sessions will have no mcp__maxstack__* tools and the edit guard\n' +
			'  will not run — both fail silently.\n' +
			`  Fix: ${install}`
		)
	}
	return (
		`⚠ the \`maxstack\` on PATH is ${status.found}, which predates the \`mcp\` verb.\n` +
		'  The scaffolded .mcp.json and .claude/settings.json invoke it by name, so\n' +
		'  agent sessions will have no mcp__maxstack__* tools and the edit guard\n' +
		'  will not run — both fail silently.\n' +
		`  Fix: ${install}`
	)
}

/** Probe + report in one step. Returns whether a warning was printed. */
export async function warnOnPathCliMismatch(): Promise<boolean> {
	const warning = pathCliWarning(await probePathCli(), await cliVersion())
	if (warning) console.log(`\n${warning}\n`)
	return warning !== null
}
