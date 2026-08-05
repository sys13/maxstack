/**
 * Issue #144 — the cookie-consent banner only appears when the app actually
 * has a disclosure to make. A fresh single-user app on localhost with no
 * sign-in configured sets nothing but functional preference storage, so
 * nagging for consent on every visit is friction over a dead link (`/settings`
 * isn't there either). The policy lives in `resolveCookieBanner`; `maxstack.json`
 * can override it in both directions.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCookieBanner, showCookieBanner } from './sprout.server'

describe('resolveCookieBanner', () => {
	it('stays hidden on a personal app with no auth bundle', () => {
		expect(resolveCookieBanner({ authInstalled: false })).toBe(false)
		expect(resolveCookieBanner({ mode: 'auto', authInstalled: false })).toBe(
			false,
		)
	})

	it('shows once sign-in cookies exist (auth bundle installed)', () => {
		expect(resolveCookieBanner({ authInstalled: true })).toBe(true)
		expect(resolveCookieBanner({ mode: 'auto', authInstalled: true })).toBe(
			true,
		)
	})

	it('honors an explicit "always" — analytics the runtime can\'t see', () => {
		expect(resolveCookieBanner({ mode: 'always', authInstalled: false })).toBe(
			true,
		)
	})

	it('honors an explicit "never", even with auth installed', () => {
		expect(resolveCookieBanner({ mode: 'never', authInstalled: true })).toBe(
			false,
		)
	})

	it('treats an unrecognized mode as auto rather than failing the request', () => {
		expect(
			resolveCookieBanner({ mode: 'yes please', authInstalled: false }),
		).toBe(false)
		expect(resolveCookieBanner({ mode: '', authInstalled: true })).toBe(true)
	})
})

/**
 * Issue #282 reported the banner as *server-path dependent*: absent under the
 * prebuilt runtime and present under the vendored (`dev --owned`) one, for the
 * same project with `bundles: []`. Both paths run this module over the same
 * absolute `MAXSTACK_DATA_DIR`, so the pin that makes that class of report
 * impossible is on the wiring rather than on either server: given a project on
 * disk, the answer is a pure function of its `maxstack.json`, reachable without
 * booting the store (which is the only thing the two paths could have
 * disagreed about, and which the root loader silently degrades to `false`).
 *
 * The layouts below are the real ones `maxstack dev` produces — including the
 * vendored tree, which parks a *copy* of `maxstack.json` at
 * `<dataDir>/runtime/maxstack.json`; the project's own file must win.
 */
describe('showCookieBanner', () => {
	const previous = process.env.MAXSTACK_DATA_DIR
	afterEach(() => {
		if (previous === undefined) delete process.env.MAXSTACK_DATA_DIR
		else process.env.MAXSTACK_DATA_DIR = previous
	})

	/** A `maxstack init` project on disk: config at the root, data dir under it
	 * (`dataDir: ".maxstack"`), and `MAXSTACK_DATA_DIR` pointed at it the way
	 * every dev path points it. Returns the project root. */
	async function project(
		config: Record<string, unknown>,
		vendoredConfig?: Record<string, unknown>,
	): Promise<string> {
		const root = await mkdtemp(resolve(tmpdir(), 'maxstack-cookie-'))
		await writeFile(
			resolve(root, 'maxstack.json'),
			JSON.stringify({ name: 'demo', dataDir: '.maxstack', ...config }),
		)
		const dataDir = resolve(root, '.maxstack')
		await mkdir(dataDir, { recursive: true })
		if (vendoredConfig) {
			// What `dev --owned` leaves behind: the vendored runtime tree, with a
			// copy of the config baked in for the deploy image.
			const runtime = resolve(dataDir, 'runtime')
			await mkdir(runtime, { recursive: true })
			await writeFile(
				resolve(runtime, 'maxstack.json'),
				JSON.stringify(vendoredConfig),
			)
		}
		process.env.MAXSTACK_DATA_DIR = dataDir
		return root
	}

	it('is false in demo mode — no project, no bundles, nothing to disclose', async () => {
		// The suite boots the demo backend (no MAXSTACK_DATA_DIR), which is the
		// same posture as the personal localhost app in the report.
		delete process.env.MAXSTACK_DATA_DIR
		await expect(showCookieBanner()).resolves.toBe(false)
	})

	it('is false for a project with `bundles: []` — the #282 report', async () => {
		await project({ bundles: [] })
		await expect(showCookieBanner()).resolves.toBe(false)
	})

	it('is false with `bundles: []` even under the vendored (owned) tree', async () => {
		// The vendored copy is baked for the deploy image and can be arbitrarily
		// stale; the walk-up must never reach it. Stacked against the project as
		// hard as possible: this copy says "always" *and* carries auth.
		await project(
			{ bundles: [] },
			{ cookieBanner: 'always', bundles: [{ slug: 'auth', version: '0.1.0' }] },
		)
		await expect(showCookieBanner()).resolves.toBe(false)
	})

	it('is true once the auth bundle is installed — read from config, no store', async () => {
		await project({ bundles: [{ slug: 'auth', version: '0.1.0' }] })
		await expect(showCookieBanner()).resolves.toBe(true)
	})

	it('answers without booting the project store', async () => {
		// The invariant behind #282: the disclosure question is answerable from
		// `maxstack.json` alone, and it must be answered from there. The root
		// loader degrades a throw to "no banner", so any dependency on the store
		// turns a store that comes up on one server path and stumbles on the other
		// into a banner that differs between the two for nothing the user changed.
		await project({ bundles: [{ slug: 'auth', version: '0.1.0' }] })
		await expect(showCookieBanner()).resolves.toBe(true)
		const scope = globalThis as {
			__maxstackSprout?: unknown
			__maxstackProjectSprout?: unknown
		}
		expect(scope.__maxstackProjectSprout).toBeUndefined()
		expect(scope.__maxstackSprout).toBeUndefined()
	})

	it('honors an explicit mode over the installed bundles', async () => {
		await project({ cookieBanner: 'always', bundles: [] })
		await expect(showCookieBanner()).resolves.toBe(true)
		await project({
			cookieBanner: 'never',
			bundles: [{ slug: 'auth', version: '0.1.0' }],
		})
		await expect(showCookieBanner()).resolves.toBe(false)
	})
})
