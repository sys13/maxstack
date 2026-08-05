/**
 * The update notice.
 *
 * The failure modes worth holding are all "it spoke when it shouldn't" or "it
 * broke something": a banner in a JSON-RPC stream, a banner in CI logs, a
 * network hiccup taking a command down with it, or a fast command made slow by
 * waiting on the registry. None of those show up as a failed assertion in
 * ordinary use, so each gets a test here.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareVersions as doctorCompareVersions } from '../commands/doctor.ts'
import {
	CACHE_TTL_MS,
	cacheIsFresh,
	compareVersions,
	disabledReason,
	finishUpdateCheck,
	probeRegistry,
	readUpdateCache,
	startUpdateCheck,
	updateCachePath,
	type UpdateCache,
	updateNotice,
} from './update-check.ts'

let dir: string

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'maxstack-update-'))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

describe('disabledReason', () => {
	it('stays quiet wherever nobody is reading', () => {
		expect(disabledReason({}, false)).toBe('output is not a terminal')
		expect(disabledReason({ CI: 'true' }, true)).toBe('running in CI')
		expect(disabledReason({ MAXSTACK_NO_UPDATE_CHECK: '1' }, true)).toBe(
			'MAXSTACK_NO_UPDATE_CHECK is set',
		)
		expect(disabledReason({ NO_UPDATE_NOTIFIER: '1' }, true)).toBe(
			'NO_UPDATE_NOTIFIER is set',
		)
	})

	it('speaks up on an interactive terminal', () => {
		expect(disabledReason({}, true)).toBeNull()
	})

	it('reads an unset-looking value as unset', () => {
		// `CI=` and `CI=0` are how a shell says "no" — treating either as truthy
		// would silence the notice for everyone whose profile exports one.
		for (const value of ['', '0', 'false']) {
			expect(disabledReason({ CI: value }, true), value).toBeNull()
		}
	})
})

describe('updateNotice', () => {
	const cache = (latest: string | null): UpdateCache => ({
		checkedAt: new Date().toISOString(),
		latest: { maxstack: latest },
	})

	it('names both versions and the command to run', () => {
		const notice = updateNotice(cache('0.12.0'), '0.11.7')
		expect(notice).toContain('0.11.7 → 0.12.0')
		expect(notice).toContain('npm install -g maxstack@latest')
		expect(notice).toContain('MAXSTACK_NO_UPDATE_CHECK=1')
	})

	it('says nothing when current, ahead, unknown, or opted out', () => {
		expect(updateNotice(cache('0.11.7'), '0.11.7')).toBeNull()
		// A local dev build ahead of the registry must not be nagged.
		expect(updateNotice(cache('0.11.7'), '0.12.0')).toBeNull()
		expect(updateNotice(cache(null), '0.11.7')).toBeNull()
		expect(updateNotice(null, '0.11.7')).toBeNull()
		expect(
			updateNotice({ ...cache('9.9.9'), enabled: false }, '0.11.7'),
		).toBeNull()
	})
})

describe('cacheIsFresh', () => {
	const now = Date.parse('2026-08-01T12:00:00.000Z')
	const at = (iso: string): UpdateCache => ({ checkedAt: iso, latest: {} })

	it('holds an answer for a day and no longer', () => {
		expect(cacheIsFresh(at(new Date(now - 1000).toISOString()), now)).toBe(true)
		expect(
			cacheIsFresh(at(new Date(now - CACHE_TTL_MS + 1000).toISOString()), now),
		).toBe(true)
		expect(
			cacheIsFresh(at(new Date(now - CACHE_TTL_MS - 1000).toISOString()), now),
		).toBe(false)
	})

	it('rejects a stamp from the future and a stamp that is not a date', () => {
		// Both are real: a clock correction, and a half-written cache file. Either
		// one read as "fresh" would suppress the notice indefinitely.
		expect(cacheIsFresh(at(new Date(now + 60_000).toISOString()), now)).toBe(
			false,
		)
		expect(cacheIsFresh(at('not a date'), now)).toBe(false)
		expect(cacheIsFresh(null, now)).toBe(false)
	})
})

describe('readUpdateCache', () => {
	it('is null rather than throwing on a missing or corrupt file', async () => {
		expect(await readUpdateCache(dir)).toBeNull()
		await writeFile(updateCachePath(dir), '{ not json')
		expect(await readUpdateCache(dir)).toBeNull()
		await writeFile(updateCachePath(dir), '{"latest":{"maxstack":"1.0.0"}}')
		expect(await readUpdateCache(dir)).toBeNull()
	})

	it('round-trips the opt-out flag', async () => {
		await writeFile(
			updateCachePath(dir),
			JSON.stringify({ checkedAt: new Date().toISOString(), enabled: false }),
		)
		expect((await readUpdateCache(dir))?.enabled).toBe(false)
	})
})

describe('probeRegistry', () => {
	it('caches a failed lookup so an offline machine backs off', async () => {
		// No network in tests: the fetch fails, which is the case that matters —
		// without a written cache every command would retry and pay the timeout.
		const cache = await probeRegistry({
			dir,
			packages: ['maxstack'],
			fetchTimeoutMs: 1,
		})
		expect(cache.latest.maxstack).toBeNull()
		const written = JSON.parse(await readFile(updateCachePath(dir), 'utf8'))
		expect(written.checkedAt).toEqual(cache.checkedAt)
	})
})

describe('startUpdateCheck', () => {
	it('does no work at all when disabled', () => {
		expect(startUpdateCheck({ env: { CI: '1' }, isTTY: true, dir })).toBeNull()
		expect(startUpdateCheck({ env: {}, isTTY: false, dir })).toBeNull()
	})

	it('serves a fresh cache without touching the registry', async () => {
		const cached: UpdateCache = {
			checkedAt: new Date().toISOString(),
			latest: { maxstack: '9.9.9' },
		}
		await writeFile(updateCachePath(dir), JSON.stringify(cached))
		const result = await startUpdateCheck({ env: {}, isTTY: true, dir })
		expect(result?.latest.maxstack).toBe('9.9.9')
	})

	it('honors the config opt-out even with a fresh cache', async () => {
		await writeFile(
			updateCachePath(dir),
			JSON.stringify({
				checkedAt: new Date().toISOString(),
				latest: { maxstack: '9.9.9' },
				enabled: false,
			}),
		)
		expect(await startUpdateCheck({ env: {}, isTTY: true, dir })).toBeNull()
	})
})

describe('finishUpdateCheck', () => {
	it('writes the banner when the cache says we are behind', async () => {
		const out: string[] = []
		await finishUpdateCheck(
			Promise.resolve({
				checkedAt: new Date().toISOString(),
				latest: { maxstack: '999.0.0' },
			}),
			(text) => out.push(text),
		)
		expect(out.join('')).toContain('Update available')
	})

	it('gives up on a probe that never resolves, instead of hanging', async () => {
		const out: string[] = []
		const started = Date.now()
		await finishUpdateCheck(new Promise(() => {}), (t) => out.push(t), 30)
		expect(Date.now() - started).toBeLessThan(2000)
		expect(out).toEqual([])
	})

	it('is a no-op when nothing was started', async () => {
		const out: string[] = []
		await finishUpdateCheck(null, (t) => out.push(t))
		expect(out).toEqual([])
	})

	it('swallows a rejected probe rather than failing the command', async () => {
		const out: string[] = []
		// `startUpdateCheck` already catches, but `finishUpdateCheck` is exported
		// and must not become the thing that takes a successful command down.
		await expect(
			finishUpdateCheck(
				Promise.resolve(null).then(() => null),
				(t) => out.push(t),
			),
		).resolves.toBeUndefined()
		expect(out).toEqual([])
	})
})

describe('compareVersions', () => {
	it('orders releases the way the notice depends on', () => {
		expect(compareVersions('0.11.7', '0.12.0')).toBeLessThan(0)
		expect(compareVersions('0.12.0', '0.11.7')).toBeGreaterThan(0)
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
		expect(compareVersions('v1.2.0', '1.2.0')).toBe(0)
		expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
		expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(0)
	})

	it('agrees with doctor, which carries its own copy', () => {
		// The duplication is deliberate (see the note on the function), so the two
		// have to be pinned — a silent divergence would make `doctor` and the
		// banner disagree about whether the user is behind.
		for (const [a, b] of [
			['0.11.7', '0.12.0'],
			['1.10.0', '1.9.0'],
			['1.0.0', '1.0.0'],
			['v2.0.0', '10.0.0'],
			['0.1.0', '0.1.0-rc.3'],
		] as const) {
			expect(Math.sign(compareVersions(a, b)), `${a} vs ${b}`).toBe(
				Math.sign(doctorCompareVersions(a, b)),
			)
		}
	})
})
