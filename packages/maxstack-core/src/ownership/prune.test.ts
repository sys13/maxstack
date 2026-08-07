/**
 * Pruning (issue #338) — the unit half. `apps/maxstack`'s `generate.test.ts`
 * drives the whole cycle through a real project on disk; what is pinned here is
 * the decision table, because the decisions are where never-clobber lives and
 * three of the four outcomes are unreachable from a spec edit alone (they need a
 * file somebody ejected or hand-edited first).
 */

import { describe, expect, it } from 'vitest'
import {
	addRouteToManifest,
	EMPTY_ROUTES_MANIFEST,
	type PageDescriptor,
	removeRoutesToModule,
} from './emit.ts'
import { generateResourcePage, pageFilePaths, prunePages } from './generate.ts'
import { MANIFEST_FILENAME, parseManifest } from './manifest.ts'
import { createMemFs, type MemFs } from './memfs.ts'
import { eject } from './write.ts'

const BOOK: PageDescriptor = {
	resource: 'book',
	title: 'Books',
	routePath: '/books',
	slots: [],
}
const SHELF: PageDescriptor = {
	resource: 'book',
	module: 'shelf',
	title: 'Shelf',
	routePath: '/shelf',
	slots: ['afterList'],
}

/** A project with both pages generated, as `maxstack gen` would leave it. */
async function generated(): Promise<MemFs> {
	const fs = createMemFs()
	await generateResourcePage(fs, BOOK)
	await generateResourcePage(fs, SHELF)
	return fs
}

const live = (...pairs: [string, string][]) => new Map(pairs)
const manifestOf = async (fs: MemFs) =>
	parseManifest(await fs.read(MANIFEST_FILENAME))

describe('removeRoutesToModule', () => {
	it('removes every route pointing at a module, by module not by path', () => {
		const source = addRouteToManifest(
			addRouteToManifest(EMPTY_ROUTES_MANIFEST, {
				path: '/books',
				file: './routes/book.tsx',
			}),
			{ path: '/shelf', file: './routes/shelf.tsx' },
		)
		const next = removeRoutesToModule(source, './routes/shelf.tsx')
		expect(next).toContain("path: '/books'")
		expect(next).not.toContain('shelf')
	})

	it('returns the source untouched when nothing points there', () => {
		const source = addRouteToManifest(EMPTY_ROUTES_MANIFEST, {
			path: '/books',
			file: './routes/book.tsx',
		})
		expect(removeRoutesToModule(source, './routes/gone.tsx')).toBe(source)
	})
})

describe('prunePages', () => {
	it('deletes a still-generated module the spec no longer declares', async () => {
		const fs = await generated()

		const { results } = await prunePages(fs, live(['book', '/books']))

		expect(results).toEqual([
			expect.objectContaining({ id: 'shelf', action: 'deleted' }),
		])
		expect(await fs.exists('routes/shelf.tsx')).toBe(false)
		expect(await fs.read('routes.ts')).not.toContain('shelf')
		const ids = (await manifestOf(fs)).entries.map((e) => e.id)
		expect(ids).not.toContain('shelf')
		// The page that survived, and the whole rest of the tree, is untouched.
		expect(await fs.exists('routes/book.tsx')).toBe(true)
		expect(await fs.read('routes.ts')).toContain("path: '/books'")
	})

	it('is a no-op when every tracked module is still declared', async () => {
		const fs = await generated()
		const before = fs.snapshot()

		const { results } = await prunePages(
			fs,
			live(['book', '/books'], ['shelf', '/shelf']),
		)

		expect(results).toEqual([])
		expect(fs.snapshot()).toEqual(before)
	})

	it('unwires but does NOT delete a generated module that was edited', async () => {
		const fs = await generated()
		// The manifest still says `generated`; the bytes say somebody worked here.
		await fs.write(
			'routes/shelf.tsx',
			`${await fs.read('routes/shelf.tsx')}\n// mine now\n`,
		)

		const { results } = await prunePages(fs, live(['book', '/books']))

		expect(results).toEqual([
			expect.objectContaining({ id: 'shelf', action: 'unwired' }),
		])
		// The wiring is gone — the app stops serving a route the spec dropped …
		expect(await fs.read('routes.ts')).not.toContain('shelf')
		expect((await manifestOf(fs)).entries.map((e) => e.id)).not.toContain(
			'shelf',
		)
		// … and the work is not. Deleting hand-written lines to enforce a spec
		// deletion is precisely the clobber the invariant forbids.
		expect(await fs.read('routes/shelf.tsx')).toContain('// mine now')
	})

	it('leaves an ejected module and its route completely alone', async () => {
		const fs = await generated()
		const ejected = await eject(
			fs,
			await manifestOf(fs),
			'shelf',
			'routes/shelf.tsx',
		)
		await fs.write(
			MANIFEST_FILENAME,
			`${JSON.stringify(ejected.manifest, null, '\t')}\n`,
		)

		const { results } = await prunePages(fs, live(['book', '/books']))

		expect(results).toEqual([
			expect.objectContaining({ id: 'shelf', action: 'kept-owned' }),
		])
		expect(await fs.exists('routes/shelf.tsx')).toBe(true)
		// Route and manifest entry both stay: the module is the maintainer's, and
		// the drift report's `underived` status is what speaks about it.
		expect(await fs.read('routes.ts')).toContain('shelf.tsx')
		expect((await manifestOf(fs)).entries.map((e) => e.id)).toContain('shelf')
	})

	it('never touches the user-owned slot file beside a pruned module', async () => {
		const fs = await generated()
		const slotFile = pageFilePaths('book').slotFile
		await fs.write(
			slotFile,
			'// hand written\nexport function afterList() {}\n',
		)

		await prunePages(fs, live(['book', '/books']))

		expect(await fs.read(slotFile)).toContain('// hand written')
		expect((await manifestOf(fs)).entries.map((e) => e.id)).toContain(
			'book:slot',
		)
	})

	it('drops the stale line when a live module changes route path', async () => {
		const fs = await generated()

		const { results } = await prunePages(
			fs,
			live(['book', '/library'], ['shelf', '/shelf']),
		)

		expect(results).toEqual([
			expect.objectContaining({ id: 'book', action: 'repathed' }),
		])
		expect(await fs.read('routes.ts')).not.toContain("path: '/books'")
		// The module itself is untouched — only the table pointing at it was stale.
		expect(await fs.exists('routes/book.tsx')).toBe(true)
		// Recorded on the entry too, so an unchanged file (which regenerates as
		// `unchanged` and upserts nothing) does not report this again next run.
		const entry = (await manifestOf(fs)).entries.find((e) => e.id === 'book')
		expect(entry?.routePath).toBe('/library')
	})
})
