/**
 * `maxstack dev` / `demo` — wrappers over the web runtime
 * and the harness. `dev` runs the platform web app over a project's data dir
 * (the established data-dir mode — `MAXSTACK_DATA_DIR` grounds the admin +
 * workbench in the project spec); `demo` seeds sample data the same way.
 *
 * Both run against whichever runtime `resolveRuntime` finds: a maxstack checkout
 * (vite dev server, HMR, owned-slot hot loop) or the published
 * `maxstack-runtime` package (prebuilt react-router server + bundled seed —
 * no pnpm, no checkout). `eval`/`dogfood` are maxstack dev-loop tools and stay
 * checkout-only.
 */

import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { MANIFEST_FILENAME, parseManifest } from '@maxstack/core/ownership'
import { pathExists } from '../fsx.ts'
import { warnOnPathCliMismatch } from '../lib/cli-resolution.ts'
import {
	readDevServerPort,
	removeDevServerFile,
	writeDevServerFile,
} from '../lib/dev-server.ts'
import { generateProject } from '../lib/generate.ts'
import { ensureMcpJson, readMcpRegistration } from '../lib/mcp-config.ts'
import { runPreflight } from '../lib/preflight.ts'
import { loadProject, type Project } from '../lib/project.ts'
import {
	linkedRuntimeBanner,
	type Runtime,
	resolveRuntime,
} from '../lib/runtime.ts'
import { readRuntimeStamp, vendorRuntime } from './build.ts'

const require = createRequire(import.meta.url)

/**
 * The one address every `maxstack dev` variant binds and advertises.
 *
 * `apps/web`'s vite config pins `host: '127.0.0.1'` under `MAXSTACK_DATA_DIR`
 * (an unpinned `localhost` is IPv6-only on most machines), and the port probe
 * and `.mcp.json` both target that literal. The prebuilt runtime used to bind
 * every interface and say `localhost` instead, which made the *origin* depend
 * on which dev path you got — and `dev` picks that path for you, from whether a
 * slot happens to be filled.
 *
 * Origin is not cosmetic here: `localhost:3000` and `127.0.0.1:3000` have
 * separate `localStorage`, so crossing between them silently empties every
 * client-persisted preference — the cookie-banner dismissal, saved queries,
 * column prefs. Naming the host in one place is also how the
 * banner stops being able to claim an address it never bound.
 */
const DEV_HOST = '127.0.0.1'

function spawnNode(
	script: string,
	args: string[],
	env: Record<string, string> = {},
	transformTypes = true,
): Promise<void> {
	return new Promise((res, reject) => {
		const child = spawn(
			process.execPath,
			[
				...(transformTypes ? ['--experimental-transform-types'] : []),
				script,
				...args,
			],
			{ stdio: 'inherit', env: { ...process.env, ...env } },
		)
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0 ? res() : reject(new Error(`exited with code ${code}`)),
		)
	})
}

export interface DemoOptions {
	/** Port the running dev server is on, if any (default: `PORT` env, then the
	 * port recorded by `maxstack dev` in the data dir, then 3000). */
	port?: string
	/** Remove the rows a previous seed created, instead of seeding. */
	clear?: boolean
}

/**
 * The dev-server record + the second-writer refusal now live in
 * `lib/dev-server.ts` and `lib/preflight.ts` respectively — the record so
 * preflight can read it without a cycle back through this module, the refusal so
 * it is *one* code path that both stops `dev` and appears in
 * `--preflight-json`. Re-exported here because `demo`, `doctor` and the tests
 * have always reached for them at this address.
 */
export {
	type DevServerRecord,
	devServerFile,
	readDevServerPort,
	readDevServerRecord,
	removeDevServerFile,
	writeDevServerFile,
} from '../lib/dev-server.ts'

/** Where `demo`'s target port came from. An *aimed* source (`flag`/`env`) means
 * the user pointed at a specific server — nothing listening there is an error,
 * never a silent in-process seed. `recorded`/`default` are best guesses and
 * fall back to the in-process seed when nothing is listening. */
export type DemoTarget = {
	port: string
	source: 'flag' | 'env' | 'recorded' | 'default'
}

/** Resolve which port `demo` should seed through: explicit `--port`, then the
 * `PORT` env, then the port `maxstack dev` recorded in the data dir, then the
 * default. Before issue #116 this skipped the recorded port and went straight
 * to 3000 — seeding a *different* server's store (each dev process has its own
 * db handle) while reporting success, when dev ran on any other port. */
export async function resolveDemoTarget(
	dataDir: string,
	opts: DemoOptions,
	envPort: string | undefined = process.env.PORT,
): Promise<DemoTarget> {
	if (opts.port) return { port: opts.port, source: 'flag' }
	if (envPort) return { port: envPort, source: 'env' }
	const recorded = await readDevServerPort(dataDir)
	if (recorded) return { port: recorded, source: 'recorded' }
	return { port: '3000', source: 'default' }
}

/**
 * Seed through a running `maxstack dev` server by POSTing its `/onboarding/seed`
 * route — the same server-side action the wizard's "Load demo data" button hits,
 * which runs `seedDemoData()` in the server's own process on its own db handle.
 *
 * Returns `true` when the running server handled the seed; `false` when nothing
 * is listening on the port (caller falls back to the in-process seed). Throws if
 * something *is* on the port but isn't a maxstack app, rather than silently
 * seeding into a second, invisible db view.
 */
/** Which demo action to route through the dev server. */
export type DemoAction = 'seed' | 'clear'

export async function seedViaRunningServer(
	port: string,
	action: DemoAction = 'seed',
): Promise<boolean> {
	// `maxstack dev` now pins IPv4 loopback (`apps/web/vite.config.ts` sets
	// `server.host = '127.0.0.1'`), so `127.0.0.1` is tried first and normally
	// hits. `[::1]` stays as a fallback for a hand-run `pnpm dev` (unpinned host,
	// which commonly lands on IPv6 `::1` only): missing it there would ECONNREFUSE
	// and wrongly fall back to the in-process seed, reintroducing the very
	// concurrent-handle split this routes around.
	for (const host of ['127.0.0.1', '[::1]']) {
		const res = await postSeed(`http://${host}:${port}/onboarding/${action}`)
		if (res === 'refused') continue
		// The action awaits `seedDemoData()` before it responds, on the server's
		// own store handle — so any response here means the rows are already
		// committed and visible to the next `/api/<entity>` read. A
		// JSON body (newer runtime) tells us exactly what landed; an older runtime
		// still redirects, surfacing as an opaque redirect (status 0) with
		// `redirect: 'manual'`. Accept any non-error status either way.
		if (res.status === 0 || (res.status >= 200 && res.status < 400)) {
			console.log(
				action === 'clear'
					? await clearSummary(res, port)
					: await seedSummary(res, port),
			)
			return true
		}
		// A 404 here is the one non-error failure worth naming precisely: the
		// project is on a runtime that predates `--clear`, which is a
		// different problem from "that port isn't maxstack".
		if (res.status === 404 && action === 'clear') {
			throw new Error(
				`the runtime on port ${port} has no /onboarding/clear route — it predates ` +
					"`demo --clear`. Upgrade the project's `maxstack-runtime` (see `maxstack doctor`).",
			)
		}
		throw new Error(
			`something is listening on port ${port} but isn't a maxstack dev server ` +
				`(POST /onboarding/${action} → ${res.status}). Stop it, or pass --port <n>.`,
		)
	}
	// Nothing on either loopback family: no dev server, seed in-process.
	return false
}

/** Build the success line from the seed action's response. A newer runtime
 * returns `{ seeded, resources }` as JSON, so we can name what committed (or say
 * nothing was seeded because data already existed); an older runtime redirects
 * with no body, so we fall back to the generic confirmation. */
export async function seedSummary(
	res: Response,
	port: string,
): Promise<string> {
	const via = `via the running dev server (port ${port})`
	if (!res.headers.get('content-type')?.includes('application/json')) {
		return `✓ demo data loaded ${via}`
	}
	try {
		const result = (await res.json()) as {
			seeded?: boolean
			resources?: string[]
		}
		if (result.seeded === false) {
			return `· nothing to seed ${via} — resources already have data`
		}
		const named = result.resources?.length
			? ` (${result.resources.join(', ')})`
			: ''
		return `✓ demo data loaded ${via}${named}`
	} catch {
		// Malformed body from something claiming JSON — the rows still committed
		// (the action awaited the seed), so report success without the detail.
		return `✓ demo data loaded ${via}`
	}
}

/**
 * The counterpart of {@link seedSummary} for `--clear`. A clear
 * that removed nothing is reported as such rather than as a success: "nothing
 * was tracked as demo data" is the honest reading, and the user needs to know
 * their rows are still there.
 */
export async function clearSummary(
	res: Response,
	port: string,
): Promise<string> {
	const via = `via the running dev server (port ${port})`
	if (!res.headers.get('content-type')?.includes('application/json')) {
		return `✓ demo data cleared ${via}`
	}
	try {
		const result = (await res.json()) as {
			cleared?: number
			resources?: string[]
			missing?: number
		}
		const cleared = result.cleared ?? 0
		if (cleared === 0) {
			return `· nothing to clear ${via} — no rows are tracked as demo data`
		}
		const named = result.resources?.length
			? ` (${result.resources.join(', ')})`
			: ''
		const missing = result.missing
			? `; ${result.missing} tracked row(s) were already gone`
			: ''
		return `✓ removed ${cleared} demo row(s) ${via}${named}${missing}`
	} catch {
		return `✓ demo data cleared ${via}`
	}
}

/** POST the seed route on one host. Returns the response, or the sentinel
 * `'refused'` when the connection was refused (nothing listening there). */
async function postSeed(url: string): Promise<Response | 'refused'> {
	try {
		return await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				// Ask for the seed result as JSON so we report only what committed,
				// instead of treating an opaque redirect as "probably worked".
				accept: 'application/json',
			},
			body: 'redirectTo=/',
			redirect: 'manual',
		})
	} catch (err) {
		// Connection refused → nothing on this host. Re-throw anything else (a
		// mid-flight reset, a DNS failure) as a real error worth surfacing.
		if ((err as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') {
			return 'refused'
		}
		throw err
	}
}

/** How long {@link seedWhenReady} waits for a dev server to answer before
 * giving up and telling the user to seed by hand. Generous on purpose: the
 * vendored (`--owned`) dev path installs dependencies before it ever binds. */
const SEED_READY_TIMEOUT_MS = 180_000
const SEED_POLL_INTERVAL_MS = 500

/** A scheduled seed, cancellable by the caller when the server it was waiting
 * for goes away. */
export interface PendingSeed {
	cancel(): void
	/** Resolves when the seed committed, failed, or was cancelled. */
	done: Promise<void>
}

/**
 * Seed as soon as a dev server answers on `port`.
 *
 * `maxstack start` has to hand the foreground to `dev` — a server that isn't
 * running serves nothing — but the rows have to land *through* that server,
 * because a second process opening the same single-writer store seeds into a
 * private view the server never sees. So the seed is scheduled
 * before `dev` is spawned and fires when the port comes up.
 *
 * Never throws into the caller: a failed seed leaves a working, empty app plus
 * the one command that fills it, which is a far better outcome than killing a
 * dev server the user is already looking at.
 */
export function seedWhenReady(
	port: string,
	handlers: { onFail?: (reason: string) => void } = {},
	clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
		now: () => Date.now(),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
	},
): PendingSeed {
	let cancelled = false
	const started = clock.now()

	const done = (async () => {
		while (!cancelled) {
			if (clock.now() - started > SEED_READY_TIMEOUT_MS) {
				handlers.onFail?.('the dev server did not come up in time')
				return
			}
			try {
				// Reuses `demo`'s exact seeding path, including its "something is
				// listening but isn't a maxstack app" refusal — which surfaces here as
				// a stated reason rather than a thrown command.
				if (await seedViaRunningServer(port)) return
			} catch (err) {
				handlers.onFail?.(err instanceof Error ? err.message : String(err))
				return
			}
			await clock.sleep(SEED_POLL_INTERVAL_MS)
		}
	})()

	return {
		cancel: () => {
			cancelled = true
		},
		done,
	}
}

/**
 * `maxstack demo [dir]` → load sample data into the project's data dir
 *, headlessly. When a `maxstack dev` server is running it
 * routes the seed through that server (see `seedViaRunningServer`); otherwise it
 * spawns `apps/web/scripts/seed-demo.ts` the same way `dev` spawns the web app
 * itself (`MAXSTACK_DATA_DIR` grounds it in the project's spec + store), running
 * the exact `seedDemoData()` the onboarding wizard's "Load demo data" button and
 * the empty-state CTA call — one seed mechanism, reachable from the UI and CLI.
 *
 * `--clear` (closes #101) is the same command in reverse, down the
 * identical routing: it removes exactly the rows a previous seed created, read
 * from the demo manifest the seed wrote. It never guesses at which rows look
 * like demo data — a heuristic that deleted a real row once would be worse than
 * not shipping the flag.
 */
export async function demoCommand(
	dir: string | undefined,
	opts: DemoOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const dataDir = resolve(project.root, project.config.dataDir)
	const action: DemoAction = opts.clear ? 'clear' : 'seed'

	// Issue #100: if `maxstack dev` is running, it holds an exclusive on-disk
	// pglite handle (documented in `apps/web/app/sprout.server.ts`). A second
	// process opening the same db seeds into a private view the server never
	// sees, so those rows 404 on the live API even though the server created its
	// own rows fine. Route the seed *through* the running server instead — it
	// runs the exact same `seedDemoData()` in its own process, so seeded rows are
	// indistinguishable from API-created rows and delete through the same route.
	const target = await resolveDemoTarget(dataDir, opts)
	if (await seedViaRunningServer(target.port, action)) return

	// Nothing is listening on the resolved port.
	if (target.source === 'flag' || target.source === 'env') {
		// The user aimed at a specific server. Seeding in-process
		// instead would open a second db handle — and if their real server is
		// alive on some *other* port (a typo'd --port, say), the rows would land
		// in a private view that server never sees, "success" into the void.
		throw new Error(
			`nothing is listening on port ${target.port} (from ${
				target.source === 'flag' ? '--port' : 'the PORT env'
			}). Start \`maxstack dev --port ${target.port}\` first, or drop the ` +
				`port to reach the project's data dir directly.`,
		)
	}
	if (target.source === 'recorded') {
		// `dev` exited without cleanup (crash / SIGKILL): the record is stale.
		// With no live server there's no concurrent handle, so seeding in-process
		// is safe — clear the record so the next resolution doesn't re-probe it.
		console.log(
			`· stale dev-server record (nothing listening on port ${target.port}) — removing it, running in-process`,
		)
		await removeDevServerFile(dataDir)
	}

	// No dev server on the port: it's safe to open the db ourselves and seed (or
	// clear) in-process — a single handle, no concurrent reader.
	const runtime = await resolveRuntime(project.root)
	const env = {
		MAXSTACK_DATA_DIR: dataDir,
		...(project.config.backend === 'postgres' && process.env.DATABASE_URL
			? { DATABASE_URL: process.env.DATABASE_URL }
			: {}),
	}
	// One entry for both directions: the seed script takes `--clear`,
	// so `demo` never grows a second spawn path that could drift from this one.
	const args = action === 'clear' ? ['--clear'] : []
	if (runtime.mode === 'package') {
		// The runtime package ships the seed pre-bundled (plain node, no vite).
		await spawnNode(runtime.seedScript, args, env, false)
		return
	}
	await spawnNode(
		resolve(runtime.root, 'apps/web/scripts/seed-demo.ts'),
		args,
		env,
	)
}

/**
 * `maxstack dev [dir]` → run the platform web app over the project's data dir,
 * with three ergonomic guarantees the bare dev server didn't give:
 *
 * - **self-heal + banner:** write `.mcp.json` if it's missing (so
 *     older/hand-made projects get MCP auto-discovery too) and print a one-line
 *     "MCP tools live as `mcp__maxstack__*`" banner.
 * - **auto-gen:** regenerate the app tree on boot, then watch
 *     `spec.json` and regenerate on every change. This makes the "writable on
 *     the very next request — no gen ceremony" promise literally true: an
 *     accepted op lands, the on-disk `app/` tree follows automatically, no
 *     explicit `maxstack gen`.
 * - **owned-slot hot loop:** pass `MAXSTACK_PROJECT_APP_DIR` so
 *     the web app's `ownedSlotDevPlugin` (a vite plugin) can regenerate the
 *     owned-code manifest from the project's real app dir, live — previously
 *     `dev` only ever imported the committed empty `owned.generated.tsx`
 *     stub, so filled slot/ejected-route files never rendered until you ran
 *     `maxstack build`.
 *
 * Every mode serves on the same default port (3000, `--port`/`PORT` to
 * change), so the scaffolded `.mcp.json` default URL is right out of the box.
 *
 * From npm, `--owned` closes the owned-code gap without a checkout: it vendors
 * the runtime source snapshot under `.maxstack/runtime/` (once), installs it,
 * and runs *its* vite dev server — the same HMR + owned-slot hot loop as
 * checkout dev, pointed at the project's real app dir.
 */
export interface DevOptions {
	/** Run the vendored runtime's vite dev server so owned code executes. */
	owned?: boolean
	/** Port to serve on (default `PORT` env, then 3000). */
	port?: string
	/** Emit preflight diagnostics as JSON instead of the human report. */
	preflightJson?: boolean
}

export async function devCommand(
	dir: string | undefined,
	opts: DevOptions = {},
): Promise<void> {
	const project = await loadProject(dir ?? '.')
	const dataDir = resolve(project.root, project.config.dataDir)
	const port = opts.port ?? process.env.PORT ?? '3000'

	// Preflight. Everything that can stop `dev` before it spawns
	// anything, each with the command that fixes it: the Node floor, an
	// unresolvable runtime, the canonical port already taken (a silent drift to
	// another port would strand `.mcp.json` and every open tab), a foreign writer
	// on the single-writer store, and an `.mcp.json` naming a command that isn't
	// there. Cheap by construction — no network, no spawn.
	await runPreflight('dev', project.root, {
		project,
		port,
		json: opts.preflightJson,
	})

	const runtime = await resolveRuntime(project.root)

	// A linked runtime is unpublished code — say so before anything
	// else scrolls it away, so "the app misbehaves" is never silently attributed
	// to the released runtime (or to the user's spec).
	if (runtime.mode === 'checkout' && runtime.linkedFrom) {
		console.log(linkedRuntimeBanner(runtime.linkedFrom))
	}

	if (await ensureMcpJson(project.root)) {
		console.log('· wrote .mcp.json (MCP auto-discovery for Claude Code)')
	}
	// The `mcp__maxstack__*` tools no longer depend on this server: `.mcp.json`
	// registers a stdio server (`maxstack mcp`) that the agent client spawns
	// itself, so they're present in every session regardless of what's running
	// here. This retires issue #98's ordering hazard — the banner used to have to
	// warn that a session started before this server would never see the tools.
	console.log(
		'· MCP tools (`mcp__maxstack__*`) come from `maxstack mcp` over stdio —\n' +
			'  every agent session has them, no ordering with this server required.',
	)
	// …provided PATH resolves `maxstack` to a CLI that has the verb.
	// Only worth the two probe spawns when the registration actually depends on
	// PATH: an npx-shaped registration carries its own version, and
	// preflight has already reported it if the command is missing outright.
	if ((await readMcpRegistration(project.root))?.command === 'maxstack') {
		await warnOnPathCliMismatch()
	}

	// (The second-`dev` refusal for issue #123 is a preflight finding now — it ran
	// here, after the MCP banner, which meant the refusal scrolled up behind two
	// paragraphs of unrelated success output.)
	// Record this server so `maxstack demo` seeds through the port the user is
	// actually watching, not the default. Removed on exit; a stale
	// record after a crash is handled by demo's probe + fallback.
	await writeDevServerFile(dataDir, port)

	// Keep the app tree in sync with the spec, automatically.
	await regen(project, 'initial')
	const stop = watchSpec(project)

	console.log(
		`starting the maxstack web app over ${project.config.dataDir}/ (${project.config.backend})…`,
	)
	try {
		if (runtime.mode !== 'package') {
			// Checkout dev already runs owned code (the hot loop) — `--owned` is moot.
			await devFromCheckout(project, runtime, dataDir, port)
		} else {
			// Issue #124: don't default to a server the user's owned code demonstrably
			// isn't in. When the project carries owned modules, take the vendored
			// (owned) path automatically; `--owned` stays as the explicit form.
			const ownedCount = await countOwnedModules(project)
			const selection = selectPackageDevPath(
				Boolean(opts.owned),
				ownedCount,
				// Probe pnpm only when auto-selection would need it: an explicit
				// `--owned` fails loudly at install time with its own message, and a
				// zero-owned project never takes the vendored path.
				opts.owned || ownedCount === 0 ? true : await pnpmOnPath(),
			)
			if (selection.path === 'vendored') {
				if (selection.reason === 'auto-owned') {
					console.log(
						`· ${ownedCount} owned module(s) (filled slots / ejected routes) detected —\n` +
							'  auto-selecting the owned dev server (`dev --owned`) so they run live.',
					)
				}
				await devFromVendored(project, runtime, dataDir, port)
			} else {
				const stopManifestWatch =
					selection.reason === 'no-owned' ? watchForOwnedModules(project) : null
				try {
					await devFromPackage(project, runtime, dataDir, port, selection)
				} finally {
					stopManifestWatch?.()
				}
			}
		}
	} finally {
		stop()
		// Only if the record is still ours — a newer dev may have replaced it.
		await removeDevServerFile(dataDir, process.pid)
	}
}

/** Env every dev server variant needs: the data dir grounds the runtime in the
 * project, the app dir feeds the owned-slot hot loop. */
function devEnv(project: Project, dataDir: string): Record<string, string> {
	return {
		MAXSTACK_DATA_DIR: dataDir,
		// Owned-slot dev hot loop: the web app's vite plugin
		// (`ownedSlotDevPlugin`) regenerates the owned-code manifest from
		// this dir instead of the checked-in empty stub.
		MAXSTACK_PROJECT_APP_DIR: project.appPath,
		...(project.config.backend === 'postgres' && process.env.DATABASE_URL
			? { DATABASE_URL: process.env.DATABASE_URL }
			: {}),
	}
}

/** Spawn `pnpm run dev --port <port>` in a workspace's `apps/web`. The web vite
 * config sets `server.strictPort`, so vite binds exactly `port` or fails instead
 * of silently auto-incrementing off it (which would strand `.mcp.json`). */
function spawnWebDev(
	webDir: string,
	port: string,
	env: Record<string, string>,
): Promise<void> {
	return new Promise<void>((res, reject) => {
		const child = spawn('pnpm', ['run', 'dev', '--port', port], {
			cwd: webDir,
			stdio: 'inherit',
			env: { ...process.env, ...env },
		})
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0
				? res()
				: reject(new Error(`web dev exited with code ${code}`)),
		)
	})
}

/** Checkout dev: vite dev server in `apps/web` — HMR + the owned-slot hot loop. */
function devFromCheckout(
	project: Project,
	runtime: Extract<Runtime, { mode: 'checkout' }>,
	dataDir: string,
	port: string,
): Promise<void> {
	console.log(
		`· maxstack checkout — vite dev server on http://${DEV_HOST}:${port} (HMR + owned code)`,
	)
	return spawnWebDev(
		resolve(runtime.root, 'apps/web'),
		port,
		devEnv(project, dataDir),
	)
}

/**
 * `dev --owned` from npm: run the *vendored* runtime's vite dev server, so
 * owned code (filled slots, ejected routes) executes with the same HMR hot
 * loop a maxstack checkout gets — no checkout needed. The vendored tree
 * (`.maxstack/runtime/`, cloned from the runtime package's source snapshot) is
 * reused across runs — the hot loop reads the project's *real* app dir live,
 * so a stale mirror inside the tree doesn't matter — and installed once with
 * pnpm (the one extra tool this path needs).
 */
async function devFromVendored(
	project: Project,
	runtime: Extract<Runtime, { mode: 'package' }>,
	dataDir: string,
	port: string,
): Promise<void> {
	const runtimeDir = resolve(project.root, '.maxstack', 'runtime')
	const webDir = resolve(runtimeDir, 'apps/web')

	// Reuse the vendored tree only when it exists AND was cloned by THIS maxstack
	// version. A tree left by an older release can't read a newer spec format —
	// reusing it 404s every page (and older runtimes even seed a fixture spec into
	// the project) — so a version-stamp mismatch forces a fresh vendor. `vendorRuntime`
	// wipes the whole tree (node_modules included), so the install step below re-runs.
	const stamp = await readRuntimeStamp(runtimeDir)
	const vendored = await pathExists(resolve(webDir, 'package.json'))
	if (!vendored || stamp !== runtime.version) {
		console.log(
			vendored
				? `· maxstack changed (runtime ${stamp ?? 'unstamped'} → ${runtime.version}); re-vendoring .maxstack/runtime/…`
				: '· vendoring the runtime source into .maxstack/runtime/ (one-time)…',
		)
		await vendorRuntime(project, runtime.root, runtime.version)
	} else {
		console.log(`· reusing .maxstack/runtime/ (runtime ${runtime.version})`)
	}

	if (!(await pathExists(resolve(runtimeDir, 'node_modules')))) {
		console.log('· installing the vendored runtime (pnpm, one-time)…')
		await new Promise<void>((res, reject) => {
			const child = spawn('pnpm', ['install', '--frozen-lockfile'], {
				cwd: runtimeDir,
				stdio: 'inherit',
				env: { ...process.env },
			})
			child.on('error', (err: NodeJS.ErrnoException) =>
				reject(
					err.code === 'ENOENT'
						? new Error(
								'`maxstack dev --owned` needs pnpm to install the vendored runtime — `npm install -g pnpm` (or `corepack enable`), then re-run.',
							)
						: err,
				),
			)
			child.on('close', (code) =>
				code === 0 ? res() : reject(new Error(`pnpm install exited ${code}`)),
			)
		})
	}

	// `127.0.0.1`, not `localhost`: the web vite config pins IPv4 loopback under
	// `MAXSTACK_DATA_DIR`, and this is the address `.mcp.json` targets. Printing
	// the name instead of the address is how a banner ends up claiming a server
	// on a host it never bound.
	console.log(
		`· vendored runtime dev server — http://${DEV_HOST}:${port} (owned code + HMR)`,
	)
	return spawnWebDev(webDir, port, devEnv(project, dataDir))
}

/**
 * Which dev server a package-mode (npm install) project gets, and why
 *. `vendored` is the owned-code path (`devFromVendored`);
 * `package` is the prebuilt spec-interpreter server (`devFromPackage`).
 *
 * The prebuilt server does not execute owned code — so when the project
 * demonstrably carries owned modules, serving a build their code isn't in is
 * the wrong default. `--owned` remains the explicit form; without it the
 * vendored path is auto-selected whenever owned modules exist and pnpm (the
 * one extra tool that path needs) is on PATH. No pnpm → the prebuilt server
 * with an explicit "install pnpm" pointer, never a hard failure the user
 * didn't opt into.
 */
export type PackageDevSelection =
	| { path: 'vendored'; reason: 'flag' | 'auto-owned' }
	| { path: 'package'; reason: 'no-owned' | 'no-pnpm' }

export function selectPackageDevPath(
	ownedFlag: boolean,
	ownedCount: number,
	pnpmAvailable: boolean,
): PackageDevSelection {
	// An explicit `--owned` always takes the vendored path — if pnpm is missing
	// the install step fails with its own actionable message (the user asked for
	// exactly this path, so a loud failure beats a silent downgrade).
	if (ownedFlag) return { path: 'vendored', reason: 'flag' }
	if (ownedCount === 0) return { path: 'package', reason: 'no-owned' }
	return pnpmAvailable
		? { path: 'vendored', reason: 'auto-owned' }
		: { path: 'package', reason: 'no-pnpm' }
}

/** Whether `pnpm` resolves on PATH (probed by spawning `pnpm --version`).
 * Used only to decide auto-selection — the vendored path's own install step
 * still handles ENOENT with a full message for the explicit `--owned` case. */
function pnpmOnPath(): Promise<boolean> {
	return new Promise((res) => {
		const child = spawn('pnpm', ['--version'], { stdio: 'ignore' })
		child.on('error', () => res(false))
		child.on('close', (code) => res(code === 0))
	})
}

/** The owned-code caveat line(s) for the prebuilt server, by why we're here.
 * Exported for tests: `no-pnpm` must say how to unblock (install pnpm), and
 * `no-owned` must set the expectation before any code is ejected. */
export function ownedGapNotice(
	reason: Extract<PackageDevSelection, { path: 'package' }>['reason'],
	ownedCount: number,
): string {
	return reason === 'no-pnpm'
		? `· ⚠ ${ownedCount} owned module(s) (filled slots / ejected routes) do NOT run in this` +
				'\n  server, and pnpm is missing so the owned dev server cannot be auto-selected.' +
				'\n  Install pnpm (`npm install -g pnpm`, or `corepack enable`) and re-run' +
				'\n  `maxstack dev` to serve them live — or `maxstack build` for a deployable image.'
		: '· owned code (filled slots / ejected routes) does not run in this server;' +
				'\n  when you fill one in, restart `maxstack dev` — it auto-selects the owned' +
				'\n  dev server (needs pnpm). `maxstack build` compiles the deployable image.'
}

/**
 * Package dev: run the prebuilt react-router server shipped in
 * `maxstack-runtime` — no pnpm, no vite, no checkout. The runtime is a spec
 * interpreter that composes the app from `spec.json` at request time, so spec
 * changes show on the next request; the trade-off is that *owned code* (filled
 * slots, ejected routes) is compiled in at build time and the shipped server
 * carries the empty stub. Reached only when the project has no owned modules
 * or pnpm is missing (see `selectPackageDevPath`) — `--owned`/auto-selection
 * route owned-code projects to `devFromVendored` instead.
 */
async function devFromPackage(
	project: Project,
	runtime: Extract<Runtime, { mode: 'package' }>,
	dataDir: string,
	port: string,
	selection: Extract<PackageDevSelection, { path: 'package' }>,
): Promise<void> {
	const serveBin = resolve(
		dirname(
			createRequire(resolve(runtime.pkgDir, 'package.json')).resolve(
				'@react-router/serve/package.json',
			),
		),
		'bin.cjs',
	)
	const owned = await countOwnedModules(project)
	// Refuse, rather than warn, when there is owned code and no pnpm to run it.
	//
	// The prebuilt runtime compiles owned modules in at *build* time, so this
	// server carries the empty stub instead. Serving it anyway means the pages
	// you wrote yourself are silently missing from the app you are looking at —
	// and the app still comes up, still looks right, and still answers on the
	// port the banner printed. A warning is the wrong shape for a failure you
	// cannot see: you would have to notice an absence to know something broke.
	if (selection.reason === 'no-pnpm' && owned > 0) {
		throw new Error(
			`${owned} owned module(s) (filled slots / ejected routes) cannot run in the ` +
				'prebuilt runtime, and pnpm is missing so the owned dev server cannot be ' +
				'started.\n\n' +
				'  Fix it with either:\n' +
				'    npm install -g pnpm      (or: corepack enable)   then re-run `maxstack dev`\n' +
				'    maxstack build           to compile a deployable image instead\n\n' +
				'  Refusing rather than serving: this server would come up looking correct ' +
				'with your own code missing from it.',
		)
	}
	console.log(
		`· prebuilt runtime (maxstack-runtime ${runtime.version}) — http://${DEV_HOST}:${port}\n` +
			ownedGapNotice(selection.reason, owned),
	)
	return new Promise<void>((res, reject) => {
		const child = spawn(
			process.execPath,
			// `--enable-source-maps`: the runtime ships `.map` files
			// next to its chunks, so node can print `app/routes/…tsx:LINE` instead
			// of an offset into a 900 kB bundle. Costs a one-time map parse on the
			// first thrown error, nothing on the happy path.
			['--enable-source-maps', serveBin, runtime.serverIndex],
			packageServeSpawnOptions(runtime, dataDir, port, project.config.backend),
		)
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0
				? res()
				: reject(new Error(`web dev exited with code ${code}`)),
		)
	})
}

/**
 * Spawn options for the prebuilt-runtime react-router server.
 *
 * The critical bit is `cwd: runtime.pkgDir`: react-router-serve
 * serves static assets via `express.static(build.assetsBuildDirectory)`, and
 * `assetsBuildDirectory` is a *relative* path (`build/client`) resolved against
 * `process.cwd()`. With no cwd the child inherits the user's project dir, so the
 * static handler looks under `<project>/build/client/assets/…` — which doesn't
 * exist — and serves every `/assets/*` as 404 (unstyled, un-hydrated app). SSR
 * survives only because `serverIndex` is an absolute path. Pinning cwd to the
 * runtime package dir (which contains `build/`) fixes both.
 */
export function packageServeSpawnOptions(
	runtime: Extract<Runtime, { mode: 'package' }>,
	dataDir: string,
	port: string,
	backend: Project['config']['backend'],
): { stdio: 'inherit'; cwd: string; env: NodeJS.ProcessEnv } {
	return {
		stdio: 'inherit',
		cwd: runtime.pkgDir,
		env: {
			...process.env,
			NODE_ENV: 'production',
			PORT: port,
			// Same loopback address the vite dev paths pin. Without
			// it `@react-router/serve` binds every interface and the banner says
			// `localhost`, while `dev --owned` sends you to `127.0.0.1` — a
			// *different origin*, so every localStorage-backed preference (the
			// cookie-banner dismissal, saved queries, column prefs) silently
			// resets when a filled slot flips you from one dev path to the other.
			// One canonical origin is also what `.mcp.json` and the demo-seed
			// port probe already assume.
			HOST: DEV_HOST,
			MAXSTACK_DATA_DIR: dataDir,
			...(backend === 'postgres' && process.env.DATABASE_URL
				? { DATABASE_URL: process.env.DATABASE_URL }
				: {}),
		},
	}
}

/** How many owned modules (filled slots + ejected routes) the project carries —
 * the same count `vendorRuntime` compiles in. Zero when there's no manifest. */
async function countOwnedModules(project: Project): Promise<number> {
	try {
		const manifest = parseManifest(
			await readFile(resolve(project.appPath, MANIFEST_FILENAME), 'utf8'),
		)
		return manifest.entries.filter(
			(e) => e.slotFile || e.ownership === 'ejected',
		).length
	} catch {
		return 0
	}
}

/** Regenerate the app tree, logging a compact one-liner (never throwing out of
 * the watcher — a bad in-progress edit shouldn't kill the dev server). */
async function regen(project: Project, label: string): Promise<void> {
	try {
		const { writes, artifacts } = await generateProject(project)
		const changed = writes.filter(
			(w) => w.action !== 'unchanged' && w.action !== 'skipped-user-owned',
		).length
		console.log(
			`· gen (${label}): ${changed} changed · ${writes.length} routes · ${artifacts.length} artifacts`,
		)
	} catch (err) {
		console.warn(`· gen (${label}) failed: ${(err as Error).message}`)
	}
}

/**
 * Watch the project's `spec/` directory for changes and regenerate, debounced.
 * Returns a stopper.
 *
 * We watch the spec *directory*, not individual files: the store saves each
 * layer file atomically (write `<file>.tmp` then rename over it), and a
 * file-level `fs.watch` goes dead the moment the inode it's holding is replaced.
 * A non-recursive directory watch survives those renames and sees every layer
 * file's write; the generator's own output lands under `app/`, never here, so it
 * can't feed back into the watch.
 */
function watchSpec(project: Project): () => void {
	let timer: NodeJS.Timeout | null = null
	let watcher: ReturnType<typeof watch> | null = null
	try {
		watcher = watch(project.specDir, () => {
			if (timer) clearTimeout(timer)
			// Debounce: an atomic save fires many events (a tmp + rename per layer
			// file) in a burst; collapse them into one regen.
			timer = setTimeout(() => void regen(project, 'spec change'), 150)
		})
	} catch {
		// Watching is best-effort — an unusual FS just means manual `gen` still works.
	}
	return () => {
		if (timer) clearTimeout(timer)
		watcher?.close()
	}
}

/**
 * The mid-session eject scenario from issue #124: the prebuilt server was
 * (correctly) selected because the project had *no* owned modules — then the
 * user ejects a route or fills a slot while it's running, and their new code
 * silently doesn't execute. In the dogfood session the agent's "fix" was a
 * second dev server on another port, which is how the two-writer pglite
 * collision happened.
 *
 * Watch the app dir for ownership-manifest writes (eject/fill rewrite it) and
 * print one loud, actionable line the moment owned modules appear. We
 * deliberately do NOT restart into the owned path automatically: the vendored
 * path's one-time `pnpm install` can take minutes, and yanking a live server
 * mid-session to run it would be worse than telling the user exactly what to
 * do. Non-recursive dir watch (not file watch) for the same atomic-rename
 * reason as `watchSpec`. Returns a stopper.
 */
function watchForOwnedModules(project: Project): () => void {
	let timer: NodeJS.Timeout | null = null
	let watcher: ReturnType<typeof watch> | null = null
	const stop = () => {
		if (timer) clearTimeout(timer)
		watcher?.close()
	}
	try {
		watcher = watch(project.appPath, (_event, filename) => {
			if (filename !== MANIFEST_FILENAME) return
			if (timer) clearTimeout(timer)
			timer = setTimeout(() => {
				void countOwnedModules(project).then((count) => {
					if (count === 0) return
					stop() // one loud notice, not a nag on every manifest write
					console.log(
						`\n· ⚠ ${count} owned module(s) just appeared (eject / filled slot) — this\n` +
							'  prebuilt server does NOT run them. Do not start a second dev server\n' +
							'  (single-writer store); stop this one and re-run `maxstack dev`, which\n' +
							'  now auto-selects the owned dev server.\n',
					)
				})
			}, 150)
		})
	} catch {
		// Watching is best-effort — the restart banner in `ownedGapNotice` already
		// sets the expectation.
	}
	return stop
}
