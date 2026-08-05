/**
 * Where this app's durable platform state lives (the spec document, the pglite
 * db, the workbench telemetry JSONL). One place that resolves the project
 * layout so the spec store, the db store, and the telemetry store can never
 * disagree about which project they're looking at.
 *
 * Two layouts are supported:
 *
 *   - a **maxstack CLI project** (`maxstack init`): the committable spec lives in
 *     the `<root>/spec/` directory next to `maxstack.json`, while runtime state
 *     (db, telemetry) lives in a gitignored `.maxstack/` sub-dir. `maxstack dev`
 *     points `MAXSTACK_DATA_DIR` at that `.maxstack/`, so the web runtime must
 *     read the spec from the *project root*, not from inside the data dir —
 *     otherwise it would seed a throwaway demo and never show the real app.
 *   - a **flat project** (the default dev tour):
 *     the `spec/` directory sits directly in the data dir with no `maxstack.json`.
 *     This is the fallback when no project config is found above the data dir.
 *
 * A project that still has a single legacy `spec.json` (next to where `spec/`
 * would live) is migrated to the directory by the store on first load.
 *
 * Data-dir values are always resolved to an absolute path. A *relative*
 * `MAXSTACK_DATA_DIR` resolves against `INIT_CWD` — the shell that launched the
 * command — NOT this dev server's cwd (`apps/web`). Without that, `maxstack dev`
 * or `MAXSTACK_DATA_DIR=./todo pnpm --filter @maxstack/web dev` would silently
 * open a *different* directory under `apps/web/` than the one the user typed.
 *
 *   - under vitest there is no default — unit tests run against the in-memory
 *     hosts unless they opt in explicitly.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** The directory the user invoked the command from (set by npm/pnpm/yarn), or
 * this process's cwd as a last resort. */
function invocationCwd(): string {
	return process.env.INIT_CWD?.trim() || process.cwd()
}

/** Resolve a data-dir value to an absolute path (see module note on `INIT_CWD`). */
export function absolutizeDataDir(value: string): string {
	return isAbsolute(value) ? value : resolve(invocationCwd(), value)
}

/** The durable runtime-state dir (pglite db + telemetry). `null` under vitest. */
export function resolveDataDir(): string | null {
	const configured = process.env.MAXSTACK_DATA_DIR?.trim()
	if (configured) return absolutizeDataDir(configured)
	if (process.env.VITEST) return null
	return resolve(process.cwd(), '.maxstack')
}

/** Walk up from the data dir to the maxstack project root (the dir holding
 * `maxstack.json`), or `null` for a flat project with no config. */
function findProjectRoot(dataDir: string): string | null {
	let dir = dataDir
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(dir, 'maxstack.json'))) return dir
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

/** The spec **directory** for the current data dir: the project root's `spec/`
 * for a CLI project, else `<dataDir>/spec`. `null` under vitest. */
export function resolveSpecPath(): string | null {
	const dataDir = resolveDataDir()
	if (!dataDir) return null
	const root = findProjectRoot(dataDir)
	const specDir = root ? resolve(root, 'spec') : resolve(dataDir, 'spec')
	announceIfNew(specDir)
	return specDir
}

/**
 * The project's **generated app directory** — where the ownership
 * manifest and the route modules live.
 *
 * Only a CLI project has one: a flat demo project has a spec and rows but no
 * `maxstack.json`, so nothing has declared an app dir and nothing has ejected
 * anything. `null` there, and the drift pane says "you own nothing yet" rather
 * than guessing a path.
 */
export function resolveAppPath(): string | null {
	const dataDir = resolveDataDir()
	if (!dataDir) return null
	const root = findProjectRoot(dataDir)
	if (!root) return null
	let appDir = 'app'
	try {
		const config = JSON.parse(
			readFileSync(resolve(root, 'maxstack.json'), 'utf8'),
		) as { appDir?: unknown }
		if (typeof config.appDir === 'string' && config.appDir)
			appDir = config.appDir
	} catch {
		// A malformed config is the CLI's problem to report, not a reason for the
		// workbench to fail to render; fall back to the documented default.
	}
	return resolve(root, appDir)
}

const announced = new Set<string>()

/** Warn once when an explicitly-configured project has no spec yet — the loud
 * signal that catches a mistyped `MAXSTACK_DATA_DIR` before it quietly seeds a
 * second project instead of opening the intended one. A legacy single-file
 * `spec.json` (which the store migrates on load) counts as "has a spec". */
function announceIfNew(specDir: string): void {
	if (announced.has(specDir)) return
	announced.add(specDir)
	const hasSpec = existsSync(specDir) || existsSync(`${specDir}.json`)
	if (process.env.MAXSTACK_DATA_DIR?.trim() && !hasSpec) {
		console.warn(
			`[maxstack] no spec found at ${specDir} — seeding a brand-new ` +
				`project here. If you meant to open an existing project, stop and ` +
				`check MAXSTACK_DATA_DIR (relative values resolve against ` +
				`${invocationCwd()}).`,
		)
	}
}
