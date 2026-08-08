/**
 * `maxstack doctor [dir]` — one command that answers "what am I actually
 * running, and is any of it wrong?".
 *
 * The motivating experience: three shipped defects in a row lived in the
 * prebuilt web runtime, not in the user's spec — and from inside a generated
 * project *nothing* could tell you that. The app was a minified bundle under a
 * global npm install; the CLI on PATH might be a different version than the one
 * the project pins; the MCP tools might be silently absent; a stale dev-server
 * record or a held pglite lock could explain "my rows vanished". Each of those
 * was diagnosable only by someone with the monorepo checked out.
 *
 * Doctor collects them into one report: which CLI is running vs which is on
 * PATH, which runtime resolves (and whether it is linked or stale against npm),
 * whether the runtime ships source maps, what the project's store lock and dev
 * server records say, and whether the MCP server actually completes a handshake.
 *
 * Every probe is non-fatal and time-bounded — doctor's job is to *report*, so a
 * network hiccup or a wedged MCP server becomes a finding, never a crash. The
 * process exits 1 only when a check is at `error`, so it composes into CI.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pgliteLockFile, pidAlive } from '@maxstack/core/backend'
import { MANIFEST_FILENAME, parseManifest } from '@maxstack/core/ownership'
import { pathExists } from '../fsx.ts'
import {
	cliDependencyRange,
	cliVersion,
	PINNED_DEP,
	probePathCli,
} from '../lib/cli-resolution.ts'
import { readDevServerRecord } from '../lib/dev-server.ts'
import { MCP_FILENAME } from '../lib/mcp-config.ts'
import { portInUse } from '../lib/net.ts'
import { nodeVersionFinding } from '../lib/preflight.ts'
import { CONFIG_FILENAME, loadProject, type Project } from '../lib/project.ts'
import {
	RUNTIME_PACKAGE,
	type Runtime,
	readRuntimeLink,
	resolveRuntime,
} from '../lib/runtime.ts'
import {
	disabledReason,
	readUpdateCache,
	updateCachePath,
} from '../lib/update-check.ts'

export type DoctorStatus = 'ok' | 'info' | 'warn' | 'error'

export interface DoctorCheck {
	/** Report grouping (`toolchain`, `runtime`, `project`, `store`, `mcp`). */
	section: string
	name: string
	status: DoctorStatus
	detail: string
	/**
	 * What to do about it. Present on every warn/error, and on an `info` that
	 * reports a *choice the user has not made yet* rather than a problem — an
	 * unconfigured AI provider is not wrong, but it is actionable.
	 */
	fix?: string
}

export interface DoctorOptions {
	/** Skip the npm registry staleness probe (offline / CI). */
	offline?: boolean
	/** Skip the MCP stdio handshake (it spawns a process). */
	noMcpProbe?: boolean
	/** Emit the findings as JSON instead of the rendered report. */
	json?: boolean
}

// --- rendering ---------------------------------------------------------------

const GLYPH: Record<DoctorStatus, string> = {
	ok: '✔',
	info: '·',
	warn: '⚠',
	error: '✖',
}

/** Render the findings as the human report: one block per section, aligned
 * names, and each non-ok finding followed by its indented fix. */
export function renderDoctorReport(checks: DoctorCheck[]): string {
	const sections = [...new Set(checks.map((c) => c.section))]
	const out: string[] = []
	for (const section of sections) {
		const rows = checks.filter((c) => c.section === section)
		const width = Math.max(...rows.map((r) => r.name.length))
		out.push(`\n${section}`)
		for (const r of rows) {
			out.push(`  ${GLYPH[r.status]} ${r.name.padEnd(width)}  ${r.detail}`)
			if (r.fix) {
				for (const line of r.fix.split('\n')) {
					out.push(`      ${' '.repeat(width)}${line}`)
				}
			}
		}
	}
	return out.join('\n')
}

/** The one-line verdict, and the exit code it implies. */
export function doctorSummary(checks: DoctorCheck[]): {
	line: string
	failed: boolean
} {
	const errors = checks.filter((c) => c.status === 'error').length
	const warns = checks.filter((c) => c.status === 'warn').length
	if (errors === 0 && warns === 0) {
		return { line: '✔ no problems found.', failed: false }
	}
	const parts = [
		errors ? `${errors} problem${errors === 1 ? '' : 's'}` : null,
		warns ? `${warns} warning${warns === 1 ? '' : 's'}` : null,
	].filter(Boolean)
	return {
		line: `${errors ? '✖' : '⚠'} ${parts.join(' · ')}.`,
		failed: errors > 0,
	}
}

// --- version comparison ------------------------------------------------------

/** Compare two dotted versions numerically (prerelease tags ignored — the
 * registry's `latest` tag never points at one, so a full semver implementation
 * would be dead weight here). Returns <0, 0, >0 like a comparator. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) =>
		v
			.replace(/^[^0-9]*/, '')
			.split('-')[0]
			?.split('.')
			.map((n) => Number.parseInt(n, 10) || 0) ?? []
	const left = parse(a)
	const right = parse(b)
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

/** The published `latest` version of a package, or null when the registry can't
 * be reached in time. Never throws — staleness is a nice-to-have finding. */
export async function fetchLatestVersion(
	pkg: string,
	timeoutMs = 4000,
): Promise<string | null> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				accept: 'application/vnd.npm.install-v1+json, application/json',
			},
		})
		if (!res.ok) return null
		const body = (await res.json()) as { version?: unknown }
		return typeof body.version === 'string' ? body.version : null
	} catch {
		return null
	}
}

// --- probes ------------------------------------------------------------------

/** The result of actually talking to the project's MCP server. */
export interface McpProbeResult {
	ok: boolean
	/** Server name + version from the `initialize` result, when it answered. */
	server?: string
	/** How many tools `tools/list` reported. */
	tools?: number
	error?: string
}

/**
 * Spawn the command `.mcp.json` registers and complete a real handshake
 * (`initialize` → `tools/list`) over stdio. This is the only check that proves
 * an agent session will actually have `mcp__maxstack__*`: the config can be
 * perfect while the `maxstack` it names is too old to have the verb, and that
 * failure is otherwise completely silent.
 */
export async function probeMcpServer(
	projectRoot: string,
	command: string,
	args: string[],
	timeoutMs = 15_000,
): Promise<McpProbeResult> {
	return new Promise<McpProbeResult>((res) => {
		let settled = false
		const done = (result: McpProbeResult) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.kill()
			res(result)
		}
		const timer = setTimeout(
			() =>
				done({ ok: false, error: `no response within ${timeoutMs / 1000}s` }),
			timeoutMs,
		)
		const child = spawn(command, args, {
			cwd: projectRoot,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		child.on('error', (err: NodeJS.ErrnoException) =>
			done({
				ok: false,
				error:
					err.code === 'ENOENT' ? `\`${command}\` is not on PATH` : err.message,
			}),
		)
		let server: string | undefined
		let buffer = ''
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString()
			let index = buffer.indexOf('\n')
			while (index >= 0) {
				const line = buffer.slice(0, index).trim()
				buffer = buffer.slice(index + 1)
				index = buffer.indexOf('\n')
				if (!line) continue
				let msg: {
					id?: unknown
					result?: {
						serverInfo?: { name?: string; version?: string }
						tools?: unknown[]
					}
					error?: { message?: string }
				}
				try {
					msg = JSON.parse(line)
				} catch {
					continue // not our protocol line (a stray log) — ignore
				}
				if (msg.error) {
					done({ ok: false, error: msg.error.message ?? 'JSON-RPC error' })
					return
				}
				if (msg.id === 1) {
					const info = msg.result?.serverInfo
					server = info
						? `${info.name ?? '?'} ${info.version ?? ''}`.trim()
						: undefined
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
					)
				} else if (msg.id === 2) {
					done({ ok: true, server, tools: msg.result?.tools?.length ?? 0 })
					return
				}
			}
		})
		child.on('close', (code) =>
			done({
				ok: false,
				error: `server exited (code ${code}) before answering`,
			}),
		)
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {},
					clientInfo: { name: 'maxstack-doctor', version: '1' },
				},
			})}\n`,
		)
	})
}

// --- collectors --------------------------------------------------------------

async function toolchainChecks(opts: DoctorOptions): Promise<DoctorCheck[]> {
	// Node's own version, from the same finding preflight blocks on,
	// so doctor and preflight cannot disagree about the floor. It reads as
	// `toolchain` here rather than `preflight` — same fact, this report's section.
	const node = nodeVersionFinding()
	const checks: DoctorCheck[] = [{ ...node, section: 'toolchain' }]
	const version = await cliVersion()
	checks.push({
		section: 'toolchain',
		name: 'cli',
		status: 'info',
		detail: `maxstack ${version} (${fileURLToPath(import.meta.url).replace(/\/src\/commands\/doctor\.ts$/, '')})`,
	})

	const path = await probePathCli()
	checks.push(
		path.usable
			? {
					section: 'toolchain',
					name: 'cli on PATH',
					status: path.found === version ? 'ok' : 'warn',
					detail:
						path.found === version
							? `maxstack ${path.found} — same as the running CLI`
							: `maxstack ${path.found ?? '?'} — differs from the running CLI (${version})`,
					...(path.found === version
						? {}
						: {
								fix: `.mcp.json and .claude/settings.json invoke \`maxstack\` by name, so they get ${path.found ?? '?'}.\nnpm install -g maxstack@${version}`,
							}),
				}
			: {
					section: 'toolchain',
					name: 'cli on PATH',
					status: 'error',
					detail:
						path.found === null
							? 'no `maxstack` on PATH'
							: `maxstack ${path.found} — no \`mcp\`/\`guard-edit\` verb`,
					fix: `Agent sessions get no mcp__maxstack__* tools and the edit guard never runs — both fail silently.\nnpm install -g maxstack@${version}${path.found === version ? ' --force' : ''}`,
				},
	)

	// Whether the *passive* notice would ever fire. Someone reading
	// this report is usually asking "why didn't it tell me?", and the answer is
	// always one of these rules — so name the rule rather than leave them to
	// guess which of CI, a pipe, or an env var silenced it.
	const silenced = disabledReason(process.env, Boolean(process.stderr.isTTY))
	const updateCache = await readUpdateCache().catch(() => null)
	checks.push({
		section: 'toolchain',
		name: 'update notice',
		status: 'info',
		detail:
			updateCache?.enabled === false
				? `off (enabled:false in ${updateCachePath()})`
				: silenced
					? `not shown here — ${silenced}`
					: `on · last checked ${updateCache?.checkedAt ?? 'never'}`,
	})

	if (opts.offline) {
		checks.push({
			section: 'toolchain',
			name: 'npm latest',
			status: 'info',
			detail: 'skipped (--offline)',
		})
		return checks
	}
	const [cliLatest, runtimeLatest] = await Promise.all([
		fetchLatestVersion('maxstack'),
		fetchLatestVersion(RUNTIME_PACKAGE),
	])
	for (const [pkg, installed, latest] of [
		['maxstack', version, cliLatest],
		[RUNTIME_PACKAGE, null, runtimeLatest],
	] as const) {
		if (latest === null) {
			checks.push({
				section: 'toolchain',
				name: `npm ${pkg}`,
				status: 'info',
				detail: 'registry unreachable — staleness unknown',
			})
			continue
		}
		if (installed === null) {
			// The runtime's installed version is reported in the runtime section;
			// here we only publish what `latest` is, so the two can be compared.
			checks.push({
				section: 'toolchain',
				name: `npm ${pkg}`,
				status: 'info',
				detail: `latest is ${latest}`,
			})
			continue
		}
		const behind = compareVersions(installed, latest) < 0
		checks.push({
			section: 'toolchain',
			name: `npm ${pkg}`,
			status: behind ? 'warn' : 'ok',
			detail: behind
				? `${installed} installed · ${latest} published`
				: `${installed} — current`,
			...(behind
				? { fix: `npm install -g maxstack@latest  (runtime updates with it)` }
				: {}),
		})
	}
	return checks
}

async function runtimeChecks(
	projectRoot: string,
	opts: DoctorOptions,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = []
	const link = await readRuntimeLink(projectRoot)
	let runtime: Runtime | null = null
	try {
		runtime = await resolveRuntime(projectRoot)
	} catch (err) {
		checks.push({
			section: 'runtime',
			name: 'resolution',
			status: 'error',
			detail: (err as Error).message.split('\n')[0] ?? 'unresolved',
			fix: `pnpm add -D ${RUNTIME_PACKAGE}`,
		})
		return checks
	}

	if (runtime.mode === 'checkout') {
		checks.push({
			section: 'runtime',
			name: 'resolution',
			status: link ? 'warn' : 'info',
			detail: link
				? `LINKED checkout at ${runtime.root}`
				: `maxstack checkout at ${runtime.root}`,
			...(link
				? {
						fix: 'Serving unpublished runtime code — behavior may not match the released\nruntime. `maxstack runtime unlink` restores the installed one.',
					}
				: {}),
		})
		checks.push({
			section: 'runtime',
			name: 'source maps',
			status: 'info',
			detail: 'checkout dev server — original sources, no maps needed',
		})
		return checks
	}

	checks.push({
		section: 'runtime',
		name: 'resolution',
		status: 'ok',
		detail: `${RUNTIME_PACKAGE} ${runtime.version} at ${runtime.pkgDir}`,
	})
	// Version skew between the two lockstep packages is a real failure mode: the
	// CLI writes a spec the prebuilt server may not be able to read.
	const cli = await cliVersion()
	if (compareVersions(cli, runtime.version) !== 0) {
		checks.push({
			section: 'runtime',
			name: 'version skew',
			status: 'warn',
			detail: `cli ${cli} · runtime ${runtime.version} — these ship in lockstep`,
			fix: 'npm install -g maxstack@latest  (or pin both to the same version)',
		})
	}
	const hasMaps = await pathExists(`${runtime.serverIndex}.map`)
	checks.push({
		section: 'runtime',
		name: 'source maps',
		status: hasMaps ? 'ok' : 'warn',
		detail: hasMaps
			? 'shipped — stack traces and devtools point at real files'
			: 'absent from this runtime build',
		...(hasMaps
			? {}
			: {
					fix: 'Runtime errors will surface as offsets into a minified bundle.\nUpdate to a runtime built with source maps (maxstack >= 0.11.7).',
				}),
	})
	if (!opts.offline) {
		const latest = await fetchLatestVersion(RUNTIME_PACKAGE)
		if (latest && compareVersions(runtime.version, latest) < 0) {
			checks.push({
				section: 'runtime',
				name: 'staleness',
				status: 'warn',
				detail: `${runtime.version} installed · ${latest} published`,
				fix: 'npm install -g maxstack@latest',
			})
		}
	}
	return checks
}

async function projectChecks(project: Project): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = []
	checks.push({
		section: 'project',
		name: 'config',
		status: 'info',
		detail: `${project.config.name} · backend ${project.config.backend} · app ${project.config.appDir}/ · data ${project.config.dataDir}/`,
	})
	let owned = 0
	try {
		const manifest = parseManifest(
			await readFile(resolve(project.appPath, MANIFEST_FILENAME), 'utf8'),
		)
		owned = manifest.entries.filter(
			(e) => e.slotFile || e.ownership === 'ejected',
		).length
		checks.push({
			section: 'project',
			name: 'owned code',
			status: 'info',
			detail: `${owned} owned module(s) of ${manifest.entries.length} route(s)`,
		})
	} catch {
		checks.push({
			section: 'project',
			name: 'owned code',
			status: 'info',
			detail: 'no ownership manifest yet (run `maxstack gen`)',
		})
	}
	checks.push(await aiProviderCheck(project))
	checks.push(await depOverrideCheck(project))
	return checks
}

/**
 * Does this project's manifest pin the runtime's `drizzle-orm` tree-wide
 *?
 *
 * `init` writes the override, but a project scaffolded before that fix carries
 * a manifest that doesn't — and the failure it produces is invisible until the
 * project is installed *somewhere else* from its own lockfile, at which point
 * the app dies at boot naming a package the user never chose. Nothing else in
 * the product could tell them why, so doctor answers it here: the check reads
 * the manifest on disk, not the installed tree, because the machine that has a
 * working `node_modules` is exactly the machine that cannot see the bug.
 */
export async function depOverrideCheck(
	project: Pick<Project, 'root'>,
): Promise<DoctorCheck> {
	const base = { section: 'project', name: 'dep pinning' } as const
	let pkg: {
		devDependencies?: Record<string, string>
		dependencies?: Record<string, string>
		overrides?: Record<string, unknown>
	}
	try {
		pkg = JSON.parse(
			await readFile(resolve(project.root, 'package.json'), 'utf8'),
		)
	} catch {
		// No manifest at all means no lockfile either, so nothing can be pruned.
		return {
			...base,
			status: 'info',
			detail: 'no package.json in this project',
		}
	}
	const declaresRuntime =
		'maxstack-runtime' in { ...pkg.dependencies, ...pkg.devDependencies }
	if (!declaresRuntime) {
		return {
			...base,
			status: 'info',
			detail: 'package.json does not declare maxstack-runtime',
		}
	}
	const pinned = await cliDependencyRange(PINNED_DEP)
	const declared = pkg.overrides?.[PINNED_DEP]
	if (typeof declared === 'string' && (!pinned || declared === pinned)) {
		return {
			...base,
			status: 'ok',
			detail: `overrides pin ${PINNED_DEP} to ${declared}`,
		}
	}
	const want = pinned ?? '<the range maxstack-runtime depends on>'
	return {
		...base,
		status: 'warn',
		detail:
			declared === undefined
				? `package.json has no "overrides" entry for ${PINNED_DEP} — a lockfile-driven install (a clone, a teammate's checkout, CI) prunes it and the app fails at boot`
				: `overrides pin ${PINNED_DEP} to ${String(declared)}, but this runtime depends on ${want}`,
		fix: `add to package.json:  "overrides": { "${PINNED_DEP}": "${want}" }  then delete package-lock.json and reinstall`,
	}
}

/**
 * Is an AI provider configured for this project?
 *
 * The describe-to-prefill box sits at the top of every generated create form
 * and, with no key, answers with a message that reads like a transient outage.
 * Nothing else in the product named the variable, so "AI is unavailable" was
 * unactionable. Doctor already answers "what is actually running"; this is the
 * same question about the one input the user has to supply themselves.
 *
 * The project's own `.env` is the authority, not this process's environment: a
 * key exported in the shell that ran `doctor` says nothing about the server.
 */
export async function aiProviderCheck(
	project: Pick<Project, 'root'>,
): Promise<DoctorCheck> {
	let env = ''
	try {
		env = await readFile(resolve(project.root, '.env'), 'utf8')
	} catch {
		// No .env at all — the same finding as an empty one.
	}
	return resolveAiProvider(env)
}

/**
 * The rule itself, over the text of a `.env`. Pure, and taking the *text*
 * rather than a lookup is what makes "reads the project's file, not this
 * process's environment" structural instead of a thing a test has to remember
 * to check: `process.env` is not reachable from here.
 */
export function resolveAiProvider(env: string): DoctorCheck {
	const envValue = (key: string): string =>
		env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
	const mock = envValue('MOCK_AI')
	if (mock && mock !== '0' && mock !== 'false') {
		return {
			section: 'project',
			name: 'AI provider',
			status: 'info',
			detail: 'MOCK_AI — deterministic stub, no key used',
		}
	}
	for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const) {
		if (envValue(key)) {
			return {
				section: 'project',
				name: 'AI provider',
				status: 'ok',
				detail: `${key} is set in .env`,
			}
		}
	}
	return {
		section: 'project',
		name: 'AI provider',
		status: 'info',
		detail:
			'not configured — the "Describe it" box on generated forms cannot fill anything',
		fix: 'set ANTHROPIC_API_KEY in .env (https://console.anthropic.com/settings/keys) and restart the dev server',
	}
}

async function storeChecks(project: Project): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = []
	const dataDir = resolve(project.root, project.config.dataDir)

	// The pglite single-writer lock — a held lock by a *dead* pid is
	// the state that makes `dev` refuse to start with no visible cause.
	if (project.config.backend === 'pglite') {
		const lockFile = pgliteLockFile(resolve(dataDir, 'db'))
		let holder: { pid?: unknown; startedAt?: unknown } | null = null
		try {
			holder = JSON.parse(await readFile(lockFile, 'utf8'))
		} catch {
			holder = null
		}
		if (!holder) {
			checks.push({
				section: 'store',
				name: 'pglite lock',
				status: 'ok',
				detail: 'free — no process holds the data dir',
			})
		} else {
			const pid = typeof holder.pid === 'number' ? holder.pid : null
			const alive = pid !== null && pidAlive(pid)
			checks.push({
				section: 'store',
				name: 'pglite lock',
				status: alive ? 'info' : 'warn',
				detail: alive
					? `held by pid ${pid}${typeof holder.startedAt === 'string' ? ` since ${holder.startedAt}` : ''}`
					: `stale — recorded pid ${pid ?? '?'} is gone`,
				...(alive
					? {}
					: {
							fix: `The next open reclaims it automatically; delete it by hand only if that fails:\nrm ${lockFile}`,
						}),
			})
		}
	} else {
		checks.push({
			section: 'store',
			name: 'backend',
			status: process.env.DATABASE_URL ? 'ok' : 'warn',
			detail: process.env.DATABASE_URL
				? 'postgres · DATABASE_URL set'
				: 'postgres configured but DATABASE_URL is not set',
			...(process.env.DATABASE_URL
				? {}
				: {
						fix: 'Set DATABASE_URL, or switch `backend` to "pglite" in maxstack.json.',
					}),
		})
	}

	// The dev-server record: `demo` seeds through whatever it names, so a stale
	// record is how a seed lands in a store nobody is looking at.
	const record = await readDevServerRecord(dataDir)
	if (!record) {
		checks.push({
			section: 'store',
			name: 'dev server',
			status: 'info',
			detail: 'no dev server recorded',
		})
		return checks
	}
	const alive = record.pid !== null ? pidAlive(record.pid) : null
	const listening = await portInUse(Number(record.port))
	if (listening && alive !== false) {
		checks.push({
			section: 'store',
			name: 'dev server',
			status: 'ok',
			detail: `port ${record.port}${record.pid !== null ? ` · pid ${record.pid}` : ''} · listening`,
		})
	} else {
		checks.push({
			section: 'store',
			name: 'dev server',
			status: 'warn',
			detail: listening
				? `port ${record.port} is listening but recorded pid ${record.pid} is gone — something else holds the port`
				: `stale record: port ${record.port} has no listener`,
			fix: listening
				? 'Stop whatever holds the port before running `maxstack dev`.'
				: '`maxstack demo` clears it on its next run; `maxstack dev` overwrites it.',
		})
	}
	return checks
}

async function mcpChecks(
	project: Project,
	opts: DoctorOptions,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = []
	const configPath = resolve(project.root, MCP_FILENAME)
	let entry: { command?: unknown; args?: unknown; type?: unknown } | undefined
	try {
		const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
			mcpServers?: Record<string, typeof entry>
		}
		entry = parsed.mcpServers?.maxstack
	} catch {
		entry = undefined
	}
	if (!entry) {
		checks.push({
			section: 'mcp',
			name: 'registration',
			status: 'error',
			detail: `${MCP_FILENAME} does not register a \`maxstack\` server`,
			fix: '`maxstack dev` writes it automatically, or copy the template from `maxstack init`.',
		})
		return checks
	}
	const command = typeof entry.command === 'string' ? entry.command : null
	const args = Array.isArray(entry.args) ? (entry.args as string[]) : []
	if (!command) {
		checks.push({
			section: 'mcp',
			name: 'registration',
			status: 'warn',
			detail: `${MCP_FILENAME} registers a non-stdio server (type ${String(entry.type)})`,
			fix: 'The HTTP registration only answers while `maxstack dev` runs — delete\n.mcp.json and re-run `maxstack dev` to get the stdio one.',
		})
		return checks
	}
	checks.push({
		section: 'mcp',
		name: 'registration',
		status: 'ok',
		detail: `${MCP_FILENAME} → ${command} ${args.join(' ')} (stdio)`,
	})
	if (opts.noMcpProbe) {
		checks.push({
			section: 'mcp',
			name: 'handshake',
			status: 'info',
			detail: 'skipped (--no-mcp-probe)',
		})
		return checks
	}
	const probe = await probeMcpServer(project.root, command, args)
	checks.push(
		probe.ok
			? {
					section: 'mcp',
					name: 'handshake',
					status: 'ok',
					detail: `${probe.server ?? 'server'} answered · ${probe.tools} tool(s)`,
				}
			: {
					section: 'mcp',
					name: 'handshake',
					status: 'error',
					detail: probe.error ?? 'no answer',
					fix: 'Agent sessions will have no mcp__maxstack__* tools. Check that the\n`maxstack` on PATH is current (see the toolchain section).',
				},
	)
	return checks
}

// --- the command -------------------------------------------------------------

/** Collect every finding. Exported so tests (and any future `--json` consumer)
 * can work with the data rather than the rendered text. */
export async function collectDoctorChecks(
	dir: string,
	opts: DoctorOptions = {},
): Promise<DoctorCheck[]> {
	const checks = await toolchainChecks(opts)

	let project: Project | null = null
	try {
		project = await loadProject(dir)
	} catch {
		checks.push({
			section: 'project',
			name: 'project',
			status: 'info',
			detail: `not a maxstack project (no ${CONFIG_FILENAME} in ${resolve(dir)}) — toolchain checks only`,
		})
		return checks
	}

	checks.push(...(await runtimeChecks(project.root, opts)))
	checks.push(...(await projectChecks(project)))
	checks.push(...(await storeChecks(project)))
	checks.push(...(await mcpChecks(project, opts)))
	return checks
}

/**
 * The closing note (ask 4 of issue #143): make the runtime/spec boundary
 * explicit at the moment someone is debugging. Users audited their own five-op
 * spec for bugs that lived in a bundle they could not see.
 */
export const RUNTIME_BOUNDARY_NOTE =
	'Rendering, forms, routing, auth and the API are the *runtime*, not your spec.\n' +
	'If the app misbehaves in a way no spec-op explains, it is a runtime bug:\n' +
	'  report it at https://github.com/sys13/maxstack/issues (include this report), or\n' +
	'  debug it yourself with `maxstack runtime link <path-to-a-maxstack-checkout>`.'

export async function doctorCommand(
	dir: string | undefined,
	opts: DoctorOptions = {},
): Promise<void> {
	const target = dir ?? '.'
	const checks = await collectDoctorChecks(target, opts)
	const summary = doctorSummary(checks)
	if (opts.json) {
		console.log(
			JSON.stringify(
				{ dir: resolve(target), checks, ok: !summary.failed },
				null,
				'\t',
			),
		)
	} else {
		// A relative path only reads better when it actually is one — for a target
		// outside the cwd it degenerates into a stack of `../`, so use the absolute.
		const rel = relative(process.cwd(), resolve(target))
		const where =
			rel === '' ? '.' : rel.startsWith('..') ? resolve(target) : rel
		console.log(`maxstack doctor — ${where}`)
		console.log(renderDoctorReport(checks))
		console.log(`\n${summary.line}`)
		console.log(`\n${RUNTIME_BOUNDARY_NOTE}`)
	}
	// A finding is a report, not a thrown error — but CI should still be able to
	// gate on it, so an `error`-level finding sets a failing exit code.
	if (summary.failed) process.exitCode = 1
}
