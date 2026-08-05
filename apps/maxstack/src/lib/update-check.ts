/**
 * The passive "you are behind" notice.
 *
 * `maxstack doctor` already answers currency on demand, but a user who installed
 * weeks ago has no reason to run it — they just keep running stale tooling and
 * hitting bugs that were fixed. This is the other half: a notice that finds
 * *them*, on a command they were running anyway.
 *
 * Three rules shape everything here, in this order:
 *
 *  1. **It must never break a command.** Every failure path — no network, a
 *     garbage cache file, an unwritable home directory — resolves to "say
 *     nothing". There is no error path out of this module.
 *  2. **It must never block.** The probe is started *before* the command runs
 *     and joined after, so on any command slower than a registry round-trip it
 *     costs nothing at all. {@link JOIN_TIMEOUT_MS} caps what a fast command can
 *     be made to wait for.
 *  3. **It must not talk when nobody is listening.** CI, pipes, and `mcp`'s
 *     stdio transport all fail the TTY test, which is also what keeps this
 *     banner out of a JSON-RPC stream.
 *
 * Deliberately *not* a self-update: the global-install matrix (npm/pnpm/bun/
 * volta/asdf, with and without sudo) is a support burden out of proportion to
 * typing one command. The notice prints the command; the user runs it.
 */

import { resolve } from 'node:path'
import { pathExists, readJSON, writeJSON } from '../fsx.ts'
import { cliVersion } from './cli-resolution.ts'
import { USER_CONFIG_DIR } from './paths.ts'
import { RUNTIME_PACKAGE } from './runtime.ts'

/** How long a cached registry answer stays good. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long the *tail* of a command may wait on an in-flight probe.
 *
 * Not the fetch timeout — the fetch is given longer and simply loses the race,
 * leaving the cache stale for another run. This bounds the only latency a user
 * can actually perceive: a command that finished faster than the network did.
 */
export const JOIN_TIMEOUT_MS = 1200

/** How long the probe itself gets before it gives up on the registry. */
export const FETCH_TIMEOUT_MS = 4000

export const UPDATE_CACHE_FILENAME = 'update-check.json'

export interface UpdateCache {
	/** ISO timestamp of the last completed probe. */
	checkedAt: string
	/** Published `latest` per package, null when the registry didn't answer. */
	latest: Record<string, string | null>
	/** Opt-out. Absent means enabled; `false` silences the notice for good. */
	enabled?: boolean
}

export function updateCachePath(dir: string = USER_CONFIG_DIR): string {
	return resolve(dir, UPDATE_CACHE_FILENAME)
}

/**
 * Why the check is off, or null when it should run.
 *
 * Returned as a reason rather than a boolean so `doctor` can *say* which rule
 * silenced it — "why didn't it warn me?" is otherwise unanswerable.
 */
export function disabledReason(
	env: NodeJS.ProcessEnv,
	isTTY: boolean,
): string | null {
	const set = (name: string) => {
		const value = env[name]
		return value !== undefined && value !== '' && value !== '0' && value !== 'false'
	}
	if (set('MAXSTACK_NO_UPDATE_CHECK')) return 'MAXSTACK_NO_UPDATE_CHECK is set'
	// The update-notifier convention, honored because users already set it
	// globally and expect every CLI to respect it.
	if (set('NO_UPDATE_NOTIFIER')) return 'NO_UPDATE_NOTIFIER is set'
	if (set('CI')) return 'running in CI'
	if (!isTTY) return 'output is not a terminal'
	return null
}

export async function readUpdateCache(
	dir?: string,
): Promise<UpdateCache | null> {
	const path = updateCachePath(dir)
	if (!(await pathExists(path))) return null
	const raw = await readJSON<unknown>(path).catch(() => null)
	if (raw === null || typeof raw !== 'object') return null
	const cache = raw as Partial<UpdateCache>
	if (typeof cache.checkedAt !== 'string') return null
	return {
		checkedAt: cache.checkedAt,
		latest:
			cache.latest !== null && typeof cache.latest === 'object'
				? (cache.latest as Record<string, string | null>)
				: {},
		...(cache.enabled === false ? { enabled: false } : {}),
	}
}

export function cacheIsFresh(cache: UpdateCache | null, now: number): boolean {
	if (!cache) return false
	const at = Date.parse(cache.checkedAt)
	// A cache stamped in the future is a clock change, not a fresh answer.
	return Number.isFinite(at) && at <= now && now - at < CACHE_TTL_MS
}

/**
 * Compare two dotted versions numerically. Prerelease tags are ignored, because
 * the registry's `latest` never points at one.
 *
 * Duplicated from `commands/doctor.ts` rather than imported: importing doctor
 * would pull its whole probe graph — pglite lock reads, MCP spawning — into the
 * startup path of *every* command, which is exactly the cost this module exists
 * to avoid. The two are pinned together by a test.
 */
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

/** The published `latest` for a package, or null if the registry didn't answer. */
async function fetchLatest(
	pkg: string,
	timeoutMs: number,
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

export interface ProbeOptions {
	dir?: string
	now?: number
	fetchTimeoutMs?: number
	packages?: string[]
}

/**
 * Ask the registry about both packages and write the answer to the cache.
 *
 * Writes even when a lookup failed, so a machine that is simply offline backs
 * off for a day instead of retrying on every single command.
 */
export async function probeRegistry(
	opts: ProbeOptions = {},
): Promise<UpdateCache> {
	const packages = opts.packages ?? ['maxstack', RUNTIME_PACKAGE]
	const results = await Promise.all(
		packages.map((pkg) =>
			fetchLatest(pkg, opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS),
		),
	)
	const cache: UpdateCache = {
		checkedAt: new Date(opts.now ?? Date.now()).toISOString(),
		latest: Object.fromEntries(packages.map((pkg, i) => [pkg, results[i] ?? null])),
	}
	await writeJSON(updateCachePath(opts.dir), cache).catch(() => {
		// A read-only or missing home directory means no caching, which costs a
		// registry call per command — annoying, not broken. Still never fatal.
	})
	return cache
}

/**
 * The banner, or null when there is nothing worth saying.
 *
 * Only the CLI's own staleness is reported. The runtime is published in lockstep
 * and a project pins its own copy, so naming both versions in a banner invites
 * the reader to update one of them by hand — which is precisely how a mismatched
 * pair happens. `doctor` reports them separately, where there is room to explain.
 */
export function updateNotice(
	cache: UpdateCache | null,
	installed: string,
): string | null {
	if (!cache || cache.enabled === false) return null
	const latest = cache.latest?.maxstack
	if (typeof latest !== 'string') return null
	if (compareVersions(installed, latest) >= 0) return null
	return [
		'',
		`  Update available  ${installed} → ${latest}`,
		'  npm install -g maxstack@latest      (maxstack-runtime updates with it)',
		'  https://github.com/sys13/maxstack/blob/main/CHANGELOG.md',
		'  Silence: MAXSTACK_NO_UPDATE_CHECK=1',
		'',
	].join('\n')
}

/**
 * Start the probe if one is due — call before the command runs.
 *
 * Returns a joinable handle, or null when the check is off or the cache is still
 * fresh. The returned promise never rejects.
 */
export function startUpdateCheck(opts: {
	env?: NodeJS.ProcessEnv
	isTTY?: boolean
	dir?: string
	now?: number
}): Promise<UpdateCache | null> | null {
	const env = opts.env ?? process.env
	const isTTY = opts.isTTY ?? Boolean(process.stderr.isTTY)
	if (disabledReason(env, isTTY)) return null

	return (async () => {
		const cached = await readUpdateCache(opts.dir).catch(() => null)
		if (cached?.enabled === false) return null
		if (cacheIsFresh(cached, opts.now ?? Date.now())) return cached
		return await probeRegistry({ dir: opts.dir, now: opts.now })
	})().catch(() => null)
}

/**
 * Join a started check and print the notice — call after the command finishes.
 *
 * Gives up quietly at {@link JOIN_TIMEOUT_MS}: the probe keeps running and will
 * still write the cache, so the notice simply arrives on the next command
 * instead of holding this one open.
 */
export async function finishUpdateCheck(
	pending: Promise<UpdateCache | null> | null,
	write: (text: string) => void = (text) => process.stderr.write(text),
	timeoutMs: number = JOIN_TIMEOUT_MS,
): Promise<void> {
	if (!pending) return
	const cache = await Promise.race([
		pending,
		new Promise<null>((r) => {
			// Unref'd: a pending timer must not be the reason the process stays up.
			const timer = setTimeout(() => r(null), timeoutMs)
			timer.unref?.()
		}),
	])
	if (!cache) return
	const notice = updateNotice(cache, await cliVersion())
	if (notice) write(`${notice}\n`)
}
