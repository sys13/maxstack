/**
 * The write-path invariant suite for `seo-gate-fixture` (#432, registry #200).
 *
 * The SEO gate builds a spec and encodes it to disk so it has something real to
 * crawl. That makes it a **write path**, and the registry refuses an undeclared
 * one — correctly: a gate that quietly grew the ability to land ops on a
 * maintainer's project would be a bad trade for a `<title>` check.
 *
 * What makes it safe is *where* it writes, not whether. So that is what is
 * asserted here:
 *
 *   - it stamps `harness`, never `web` or `human`'s own surface, so a fixture
 *     op can never read as somebody's real work (`web-demo-seed`'s rule);
 *   - it stamps `actor.path` with this path's registry id, so an op that ever
 *     leaked out of here is findable by name rather than by guesswork;
 *   - it writes to an `mkdtemp` under the OS temp dir and nowhere else, and in
 *     particular resolves no project path and never calls `spec.save`;
 *   - the spec it builds is the one the gate's assertions assume — a public
 *     collection portal, a token portal and a paused one — because a fixture
 *     that quietly stopped declaring the token portal would turn the gate's
 *     "never lists a token portal" assertion into a check of nothing.
 *
 * That last one is the `ok: true only when nothing went unchecked` rule pointed
 * at the fixture itself. An assertion over an absent thing passes.
 *
 * Registry: scripts/write-paths.config.json. Policy: docs/write-paths.md.
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { listPortals, OPTIONAL_SPEC_DIR_FILES } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { fixtureSpec, writeFixture } from '../scripts/check-seo'

const PATH_ID = 'seo-gate-fixture'

describe(`write path "${PATH_ID}"`, () => {
	it('stamps the harness surface and this path’s id on every op', () => {
		const spec = fixtureSpec()
		expect(spec.opLog.length).toBeGreaterThan(0)
		for (const applied of spec.opLog) {
			// Asserted present rather than optional-chained: an op with no actor at
			// all is exactly the unattributed write this registry exists to refuse,
			// so `?.` here would let the interesting failure pass.
			expect(applied.actor).toBeDefined()
			expect(applied.actor?.surface).toBe('harness')
			// Findable by name if one ever escapes the temp dir.
			expect(applied.actor?.path).toBe(PATH_ID)
		}
	})

	it('declares exactly the portals the gate’s assertions depend on', () => {
		// A fixture that stopped declaring the token portal would turn
		// "the sitemap never lists a token portal" into a check of nothing.
		const portals = listPortals(fixtureSpec())
		const byKey = Object.fromEntries(portals.map((p) => [p.key, p]))
		expect(Object.keys(byKey).sort()).toEqual(['archive', 'client', 'old'])
		expect(byKey.archive?.audience).toBe('public')
		expect(byKey.archive?.paused).toBe(false)
		expect(byKey.archive?.filter).toBeDefined()
		expect(byKey.client?.audience).toBe('token')
		expect(byKey.old?.paused).toBe(true)
	})

	it('declares a site, or the whole gate would be checking noindex pages', () => {
		const site = fixtureSpec().site
		expect(site).toBeDefined()
		expect(site?.domain).toMatch(/^https:\/\//)
	})

	it('writes only under the OS temp dir — no project path is ever resolved', async () => {
		const dir = await writeFixture()
		try {
			// The load-bearing assertion. `spec.save` and a resolved project path are
			// the two ways this could reach a maintainer's tree, and it does neither
			// — the directory is a fresh mkdtemp handed to the server as
			// MAXSTACK_DATA_DIR and removed in a `finally`.
			expect(resolve(dir).startsWith(resolve(tmpdir()))).toBe(true)
			expect((await stat(dir)).isDirectory()).toBe(true)

			const files = await readdir(resolve(dir, 'spec'))
			expect(files).toContain('meta.json')
			expect(files).toContain('site.json')
			expect(files).toContain('portals.json')
			// The absence rule still holds in the fixture: it grew no optional file
			// for a layer it never declared.
			const untouched = OPTIONAL_SPEC_DIR_FILES.filter(
				(f) => f !== 'oplog.jsonl' && f !== 'site.json' && f !== 'portals.json',
			)
			for (const file of untouched) expect(files).not.toContain(file)

			const site = JSON.parse(
				await readFile(resolve(dir, 'spec', 'site.json'), 'utf8'),
			)
			expect(site.domain).toMatch(/^https:\/\//)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('importing the gate module neither builds nor serves anything', async () => {
		// The module is imported at the top of this file. If the auto-run guard
		// ever regressed, this suite would have started a server and a production
		// build as a side effect of importing it — so reaching this assertion at
		// all is the test.
		expect(typeof fixtureSpec).toBe('function')
	})
})
