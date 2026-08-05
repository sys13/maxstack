/**
 * Preflight — the checks that run *before* `init` and `dev`, so a first-run
 * failure names its cause and its fix instead of producing a stack trace
 *.
 *
 * `maxstack doctor` already knows how to diagnose nearly all of
 * this. The gap it left is one of *timing*: doctor is a verb you run after you
 * are already confused, and the surface where a first-time user gives up is
 * exactly the surface they reach before they know that verb exists. So the
 * cheap subset of those checks runs automatically at the two moments something
 * is about to be created or started.
 *
 * Three rules shape what belongs here, and they are what keep this from
 * becoming a second doctor:
 *
 *   - **Cheap only.** Preflight is inside the sixty-second cold-start budget
 *, so no network probe, no MCP handshake, no process spawn:
 *     filesystem reads, a `PATH` scan, and two loopback `bind` attempts. The
 *     expensive probes stay behind `doctor`, and preflight points at it.
 *   - **Never block on a soft condition.** A staleness warning is not a
 *     refusal. The only hard refusals are conditions that would corrupt state
 *     or cannot possibly succeed: a Node too old to run the code at all, a port
 *     already taken, a second writer against a single-writer store (the pglite
 *     precedent from issue #123), an unresolvable runtime.
 *   - **Every finding names a fix.** A finding without a `fix` is a finding
 *     that leaves the reader where they started, so the shape is enforced by a
 *     test rather than by good intentions.
 *
 * Findings reuse `DoctorCheck` deliberately: the same record, with the same
 * section/status/fix fields, so `--preflight-json` and `doctor --json` are one
 * artifact shape for an agent to read rather than two.
 */

import { readFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { pgliteLockFile, pidAlive } from '@maxstack/core/backend'
import type { DoctorCheck } from '../commands/doctor.ts'
import { pathExists } from '../fsx.ts'
import { cliVersion } from './cli-resolution.ts'
import { devServerFile, readDevServerRecord } from './dev-server.ts'
import { cliInvocation, launchMode } from './invocation.ts'
import { readMcpRegistration } from './mcp-config.ts'
import { portInUse } from './net.ts'
import { CONFIG_FILENAME, type Project } from './project.ts'
import { RUNTIME_PACKAGE, resolveRuntime } from './runtime.ts'

/** The lowest Node this codebase runs on (`engines.node` in both packages). */
export const NODE_MIN_MAJOR = 22

/** Which command preflight is running ahead of. */
export type PreflightPhase = 'init' | 'dev'

/**
 * One preflight finding. A `DoctorCheck` plus the one thing doctor has no need
 * for: whether it stops the command. `blocking` is only ever set on `error`.
 */
export interface PreflightFinding extends DoctorCheck {
	blocking?: boolean
}

/** Thrown when a blocking finding stops the command. */
export class PreflightError extends Error {
	readonly findings: PreflightFinding[]
	constructor(findings: PreflightFinding[]) {
		const blocking = findings.filter((f) => f.blocking)
		super(
			blocking
				.map((f) => `${f.detail}${f.fix ? `\n${indent(f.fix)}` : ''}`)
				.join('\n\n'),
		)
		this.name = 'PreflightError'
		this.findings = findings
	}
}

function indent(text: string): string {
	return text
		.split('\n')
		.map((l) => `  ${l}`)
		.join('\n')
}

export interface PreflightOptions {
	/** The port `dev` is about to bind. */
	port?: string
	/** Emit findings as JSON instead of the human report. */
	json?: boolean
	/** Test seam: the Node version to judge (default `process.versions.node`). */
	nodeVersion?: string
	/** Test seam: the loaded project, when the caller already has one. */
	project?: Project
}

// --- individual checks -------------------------------------------------------

/**
 * Node's own version. First in the report and first to block, because a Node
 * below the floor is the one condition under which *nothing else* in the report
 * can be trusted — the CLI bundle may not even parse, and the failure a user
 * actually sees is a `SyntaxError` in a file they have never heard of.
 */
export function nodeVersionFinding(
	version: string = process.versions.node,
): PreflightFinding {
	const major = Number.parseInt(version.split('.')[0] ?? '0', 10)
	if (major >= NODE_MIN_MAJOR) {
		return {
			section: 'preflight',
			name: 'node',
			status: 'ok',
			detail: `v${version}`,
		}
	}
	return {
		section: 'preflight',
		name: 'node',
		status: 'error',
		blocking: true,
		detail: `Node v${version} is too old — maxstack needs Node ${NODE_MIN_MAJOR} or newer.`,
		fix:
			`Both maxstack packages declare "engines": { "node": ">=${NODE_MIN_MAJOR}" }, and the\n` +
			`runtime bundle uses syntax v${major} cannot parse — so this fails as a\n` +
			'SyntaxError in a file you did not write rather than as a version error.\n' +
			`  nvm install ${NODE_MIN_MAJOR} && nvm use ${NODE_MIN_MAJOR}     # or your platform's Node ${NODE_MIN_MAJOR}+ package`,
	}
}

/** Is the `init` target already a project? Creating over one would write a
 * second spec into a tree that has its own — refuse, and say which verb the
 * user probably wanted. */
async function initTargetFinding(dir: string): Promise<PreflightFinding> {
	const root = resolve(dir)
	const configPath = join(root, CONFIG_FILENAME)
	if (!(await pathExists(configPath))) {
		return {
			section: 'preflight',
			name: 'target',
			status: 'ok',
			detail: root,
		}
	}
	return {
		section: 'preflight',
		name: 'target',
		status: 'error',
		blocking: true,
		detail: `Already a maxstack project: ${configPath}`,
		fix:
			'Scaffolding over it would write a second spec into a tree that already\n' +
			'has one. To work on the existing project, or to start a fresh one:\n' +
			`  cd ${root} && maxstack dev        # the project that is already here\n` +
			'  maxstack init <other-dir>       # a new project somewhere else',
	}
}

/** The port `dev` is about to bind. A silent fallback to another port is the
 * failure this refusal exists to prevent — `.mcp.json`, a demo seed and any
 * open tab all hard-point at the canonical one. */
async function portFinding(port: string): Promise<PreflightFinding> {
	const n = Number(port)
	if (!(await portInUse(n))) {
		return {
			section: 'preflight',
			name: 'port',
			status: 'ok',
			detail: `${port} is free`,
		}
	}
	return {
		section: 'preflight',
		name: 'port',
		status: 'error',
		blocking: true,
		detail: `port ${port} is already in use.`,
		fix:
			'A silent fallback to another port would leave anything pointed at\n' +
			`${port} — bookmarks, a demo seed, a browser tab — talking to nothing.\n` +
			`  maxstack dev --port <n>          # serve somewhere else\n` +
			`  maxstack doctor                  # report what holds ${port}\n` +
			'(The MCP tools are unaffected: they run over stdio, not this port.)',
	}
}

/**
 * A second `maxstack dev` for the same project.
 *
 * On pglite both servers open the SAME on-disk data dir, and pglite is
 * single-writer: the second writer silently diverges the store, so rows created
 * in one server are invisible in the other. That is a refusal, symmetric with
 * the port one. (The pre-#123 warning claimed each server "gets its own separate
 * store" — wrong for an on-disk dir, and a non-fatal log line was invisible
 * anyway.)
 *
 * Liveness is judged by the recorded *pid* when the record has one: a second
 * `dev` can start before the first has bound its port, so a port probe alone
 * would miss it. The port stays as the fallback for pid-less older records.
 *
 * Postgres is genuinely safe to share (one server-side database), so it gets an
 * informational finding. The `.lock` in the data dir is the enforcement
 * chokepoint either way; this exists to fail with a good message before anything
 * spawns.
 */
export async function devServerFinding(
	dataDir: string,
	backend: Project['config']['backend'],
	probes: {
		alive?: (pid: number) => boolean
		portBusy?: (port: number) => Promise<boolean>
	} = {},
): Promise<PreflightFinding> {
	const record = await readDevServerRecord(dataDir)
	if (!record) {
		return {
			section: 'preflight',
			name: 'dev server',
			status: 'ok',
			detail: 'none running for this project',
		}
	}
	const holderAlive =
		record.pid !== null
			? (probes.alive ?? pidAlive)(record.pid)
			: await (probes.portBusy ?? portInUse)(Number(record.port))
	if (!holderAlive) {
		// A stale record (the previous `dev` was killed) — `dev` overwrites it.
		return {
			section: 'preflight',
			name: 'dev server',
			status: 'ok',
			detail: `stale record for port ${record.port} — will be replaced`,
		}
	}
	const who =
		record.pid !== null
			? `pid ${record.pid}, port ${record.port}`
			: `port ${record.port}`
	if (backend === 'postgres') {
		return {
			section: 'preflight',
			name: 'dev server',
			status: 'info',
			detail: `another dev server for this project is running (${who}).`,
			fix:
				'With the postgres backend both share one server-side database, so this is\n' +
				'safe — but `maxstack demo` seeds through the most recently started server.',
		}
	}
	return {
		section: 'preflight',
		name: 'dev server',
		status: 'error',
		blocking: true,
		detail: `another \`maxstack dev\` for this project is already running (${who}).`,
		fix:
			'The pglite backend is single-writer: a second dev server would open the\n' +
			'SAME on-disk store and silently corrupt it — rows created in one server\n' +
			'are invisible in the other.\n' +
			`  kill ${record.pid ?? '<pid>'}                       # stop the other server\n` +
			'Or switch this project to a Postgres backend (DATABASE_URL), which is safe\n' +
			`to share. If the other server is truly gone (a recycled pid), delete\n` +
			`  ${devServerFile(dataDir)}`,
	}
}

/**
 * The pglite single-writer lock, independent of the dev-server
 * record.
 *
 * `devServerFinding` catches a second `maxstack dev`, but the record it reads is
 * only written by `dev`. A live holder with no record is a *different* writer — a
 * `maxstack demo` seeding in-process, a wedged orphan, an editor plugin — and it
 * is exactly as fatal.
 */
async function pgliteLockFinding(
	dataDir: string,
	alive: (pid: number) => boolean = pidAlive,
): Promise<PreflightFinding> {
	const lockFile = pgliteLockFile(resolve(dataDir, 'db'))
	let holder: { pid?: unknown; startedAt?: unknown } | null = null
	try {
		holder = JSON.parse(await readFile(lockFile, 'utf8'))
	} catch {
		holder = null
	}
	if (!holder) {
		return {
			section: 'preflight',
			name: 'store lock',
			status: 'ok',
			detail: 'free',
		}
	}
	const pid = typeof holder.pid === 'number' ? holder.pid : null
	if (pid === process.pid || pid === null || !alive(pid)) {
		// A dead holder is reclaimed by the next open — a warning, never a refusal.
		return {
			section: 'preflight',
			name: 'store lock',
			status: pid === null || pid === process.pid ? 'ok' : 'warn',
			detail:
				pid === null || pid === process.pid
					? 'free'
					: `stale — recorded pid ${pid} is gone`,
			...(pid === null || pid === process.pid
				? {}
				: {
						fix:
							'Starting anyway is safe: the next open reclaims a lock whose holder is\n' +
							'gone. Only remove it by hand if that fails:\n' +
							`  rm ${lockFile}`,
					}),
		}
	}
	return {
		section: 'preflight',
		name: 'store lock',
		status: 'error',
		blocking: true,
		detail: `another process (pid ${pid}) holds this project's store${
			typeof holder.startedAt === 'string' ? `, since ${holder.startedAt}` : ''
		}.`,
		fix:
			'The pglite backend is single-writer: opening it twice makes the two views\n' +
			'diverge silently — rows written in one are invisible in the other.\n' +
			`  kill ${pid}                       # stop the other writer\n` +
			'  maxstack doctor                  # what it is, and what it holds\n' +
			'(A Postgres backend is safe to share — set DATABASE_URL and switch\n' +
			`"backend" in ${CONFIG_FILENAME}.)`,
	}
}

/** Can the web runtime be resolved at all? Without it `dev` has nothing to
 * serve, and the failure otherwise surfaces from deep inside resolution. */
async function runtimeFinding(project: Project): Promise<PreflightFinding> {
	try {
		const runtime = await resolveRuntime(project.root)
		if (runtime.mode === 'checkout') {
			return {
				section: 'preflight',
				name: 'runtime',
				status: 'ok',
				detail: `maxstack checkout at ${runtime.root}`,
			}
		}
		const cli = await cliVersion()
		if (cli !== runtime.version) {
			return {
				section: 'preflight',
				name: 'runtime',
				status: 'warn',
				detail: `cli ${cli} · ${RUNTIME_PACKAGE} ${runtime.version} — these ship in lockstep`,
				fix:
					'A CLI can write a spec the paired runtime cannot read. Starting anyway is\n' +
					'fine for a patch-level gap; pin both to one version if the app misbehaves:\n' +
					`  npx maxstack@${runtime.version} dev      # match the CLI to the runtime`,
			}
		}
		return {
			section: 'preflight',
			name: 'runtime',
			status: 'ok',
			detail: `${RUNTIME_PACKAGE} ${runtime.version}`,
		}
	} catch (err) {
		return {
			section: 'preflight',
			name: 'runtime',
			status: 'error',
			blocking: true,
			detail: `could not locate the maxstack web runtime.`,
			fix:
				`${RUNTIME_PACKAGE} ships as a dependency of the CLI, so this means the\n` +
				'install is partial or the project pins a runtime it never installed.\n' +
				`  npm install ${RUNTIME_PACKAGE}   # into this project\n` +
				'  maxstack doctor                  # which runtime resolves, and why\n' +
				`(resolution said: ${(err as Error).message.split('\n')[0]})`,
		}
	}
}

/**
 * Does the command `.mcp.json` names actually exist?
 *
 * This is the failure mode with the worst signal-to-consequence ratio in the
 * whole first run: the config is syntactically perfect, the agent session starts
 * clean, and the `mcp__maxstack__*` tools are simply absent — so the agent
 * silently falls back to hand-writing files in a project whose entire premise is
 * that it doesn't. Under `npx` with no global install a bare
 * `maxstack` registration is *always* this case.
 *
 * A `PATH` scan rather than a spawn: preflight is inside the cold-start budget,
 * and `doctor` already does the real handshake.
 */
async function mcpCommandFinding(project: Project): Promise<PreflightFinding> {
	const registration = await readMcpRegistration(project.root)
	if (!registration) {
		return {
			section: 'preflight',
			name: 'mcp',
			status: 'warn',
			detail: 'no `maxstack` server registered in .mcp.json',
			fix:
				'Agent sessions get no mcp__maxstack__* tools; `maxstack dev` writes the\n' +
				'registration on start, so this normally self-heals in a moment.',
		}
	}
	if (await onPath(registration.command)) {
		return {
			section: 'preflight',
			name: 'mcp',
			status: 'ok',
			detail: `${registration.command} ${registration.args.join(' ')}`,
		}
	}
	const suggested = cliInvocation(launchMode(), await cliVersion())
	return {
		section: 'preflight',
		name: 'mcp',
		status: 'warn',
		detail: `.mcp.json runs \`${registration.command}\`, which is not on PATH`,
		fix:
			'Agent sessions will have no mcp__maxstack__* tools and the edit guard will\n' +
			'not run — both fail silently, and an agent with no tools writes files by\n' +
			'hand into a project that regenerates them.\n' +
			`  ${suggested.shell} mcp        # the invocation that resolves here\n` +
			'Set that as .mcp.json\'s command/args, or install the CLI on PATH:\n' +
			`  npm install -g maxstack@${await cliVersion()}`,
	}
}

/** Is `command` resolvable on `PATH`? A path-shaped command (`./x`, `/usr/x`)
 * is checked directly. No spawn — this is a stat, not an execution. */
async function onPath(
	command: string,
	env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
	if (command.includes('/') || command.includes('\\')) {
		return pathExists(command)
	}
	const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
	for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
		for (const ext of exts) {
			if (await pathExists(join(dir, command + ext))) return true
		}
	}
	return false
}

// --- collection + reporting --------------------------------------------------

/**
 * Every finding for a phase, in report order. Never throws: a check that cannot
 * answer reports what it found, because a preflight that crashes is strictly
 * worse than the stack trace it was added to replace.
 */
export async function collectPreflight(
	phase: PreflightPhase,
	dir: string,
	opts: PreflightOptions = {},
): Promise<PreflightFinding[]> {
	const findings: PreflightFinding[] = [nodeVersionFinding(opts.nodeVersion)]
	// A Node below the floor invalidates everything after it — the checks run in
	// this process, on this runtime. Report it alone rather than trailing it with
	// findings that may be artifacts of the wrong Node.
	if (findings[0]?.blocking) return findings

	if (phase === 'init') {
		findings.push(await initTargetFinding(dir))
		return findings
	}

	const project = opts.project
	if (!project) return findings
	const dataDir = resolve(project.root, project.config.dataDir)
	findings.push(await runtimeFinding(project))
	if (opts.port) findings.push(await portFinding(opts.port))
	findings.push(await devServerFinding(dataDir, project.config.backend))
	if (project.config.backend === 'pglite') {
		findings.push(await pgliteLockFinding(dataDir))
	}
	findings.push(await mcpCommandFinding(project))
	return findings
}

/**
 * The human report: only what the reader has to act on. A clean preflight prints
 * nothing at all — silence on the happy path is the whole point of running this
 * before every `dev` rather than on request.
 *
 * Blocking findings are excluded by default: they travel in the thrown
 * {@link PreflightError}, whose message is the same cause-and-fix text, and the
 * bin entry prints that. Rendering them here too printed every refusal twice.
 */
export function renderPreflight(
	findings: readonly PreflightFinding[],
	{ includeBlocking = false }: { includeBlocking?: boolean } = {},
): string {
	const glyphs = { error: '✖', warn: '⚠', info: '·', ok: '' } as const
	const notable = findings.filter(
		(f) =>
			(!f.blocking || includeBlocking) &&
			(f.status === 'warn' ||
				f.status === 'error' ||
				// An `info` finding earns a line only by carrying something to say: the
				// shared-postgres note, for instance, changes how `demo` behaves.
				(f.status === 'info' && Boolean(f.fix))),
	)
	if (notable.length === 0) return ''
	return notable
		.map(
			(f) =>
				`${glyphs[f.status]} ${f.detail}${f.fix ? `\n${indent(f.fix)}` : ''}`,
		)
		.join('\n\n')
}

/** The machine report (`--preflight-json`): the whole set, blocking flags and
 * fixes included, so an agent that hits a failed preflight can act on it
 * instead of parsing prose. */
export function preflightJson(
	phase: PreflightPhase,
	dir: string,
	findings: readonly PreflightFinding[],
): string {
	return `${JSON.stringify(
		{
			preflight: phase,
			dir: resolve(dir),
			ok: !findings.some((f) => f.blocking),
			findings,
		},
		null,
		'\t',
	)}\n`
}

/**
 * Run the phase's checks, report them, and stop the command if any blocks.
 *
 * JSON goes to stdout (it is the requested output); the human report goes to
 * stderr, so preflight warnings never contaminate a command whose stdout is
 * being read.
 */
export async function runPreflight(
	phase: PreflightPhase,
	dir: string,
	opts: PreflightOptions = {},
): Promise<PreflightFinding[]> {
	const findings = await collectPreflight(phase, dir, opts)
	if (opts.json) {
		process.stdout.write(preflightJson(phase, dir, findings))
	} else {
		const report = renderPreflight(findings)
		if (report) process.stderr.write(`\n${report}\n\n`)
	}
	if (findings.some((f) => f.blocking)) throw new PreflightError(findings)
	return findings
}
