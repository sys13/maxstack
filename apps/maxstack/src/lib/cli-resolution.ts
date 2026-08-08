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
	// can report anything), so ask the binary what it can do.
	const verbs = await Promise.all(PROBED_VERBS.map((verb) => hasVerb(verb)))
	return { found, usable: verbs.every(Boolean) }
}

/** The two verbs the scaffolded config invokes — the ones whose absence is
 * silent. Both are registered `hidden`, so neither appears in `--help`. */
const PROBED_VERBS = ['mcp', 'guard-edit'] as const

/**
 * Does the PATH CLI have this verb?
 *
 * Two probes have been wrong here, both in the same direction — reading an
 * exit code or a command list that commander doesn't populate the way it looks
 * like it does:
 *
 * - `maxstack <verb> --help` **exit status** says nothing: commander answers an
 *   unknown verb with the top-level help and exits 0.
 * - the `--help` **command list** omits `mcp` and `guard-edit` entirely, because
 *   both are registered `{ hidden: true }`. Scanning it made the probe
 *   always-false, so every install was told it "predates the `mcp` verb".
 *
 * The usage line is the honest signal: commander prints `Usage: maxstack mcp …`
 * for a verb it has (hidden or not) and `Usage: maxstack [options] [command]`
 * for one it doesn't. `--help` short-circuits before the action runs, so this
 * neither starts the MCP server nor blocks reading the hook event on stdin.
 */
async function hasVerb(verb: string): Promise<boolean> {
	try {
		const { stdout } = await run('maxstack', [verb, '--help'], {
			timeout: 10_000,
		})
		return new RegExp(`^Usage: \\S+ ${verb}(\\s|$)`, 'm').test(stdout)
	} catch {
		return false
	}
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
	// A PATH copy reporting *our own* version yet missing the verbs is not a
	// stale global — it is a broken or shadowed install, and telling someone to
	// install the version they already have reads as a no-op instruction.
	const cause =
		status.found === expected
			? `reports ${status.found} — this CLI's own version — but has no \`mcp\` verb.`
			: `is ${status.found}, which has no \`mcp\` verb.`
	const fix =
		status.found === expected
			? `${install} --force   # the copy on PATH is broken or shadowed`
			: install
	return (
		`⚠ the \`maxstack\` on PATH ${cause}\n` +
		'  The scaffolded .mcp.json and .claude/settings.json invoke it by name, so\n' +
		'  agent sessions will have no mcp__maxstack__* tools and the edit guard\n' +
		'  will not run — both fail silently.\n' +
		`  Fix: ${fix}`
	)
}

/** Probe + report in one step. Returns whether a warning was printed. */
export async function warnOnPathCliMismatch(): Promise<boolean> {
	const warning = pathCliWarning(await probePathCli(), await cliVersion())
	if (warning) console.log(`\n${warning}\n`)
	return warning !== null
}
