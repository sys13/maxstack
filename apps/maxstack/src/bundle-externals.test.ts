/**
 * The published CLI's install surface, checked on every run of the suite.
 *
 * `build.mjs` already asserts this, but it only runs at `prepublishOnly` — after
 * the decision to ship. #348 is what that costs: `bundle/catalog.ts` imported one
 * DDL string through the `auth` barrel, which also re-exports the better-auth
 * instance the CLI never calls, so `better-auth` and its drizzle adapter landed in
 * the tarball's dependency tree. The adapter peers on a `drizzle-orm` our pin does
 * not satisfy, npm completed the tree with a copy no dependency edge pointed at,
 * and the next install into that tree pruned it. Every command — `init` included,
 * the first one in the README — then died at import with `ERR_MODULE_NOT_FOUND`.
 *
 * A single install never observes that; neither does typecheck, lint, or any test
 * of the CLI's behaviour. What observes it is the import graph, which is cheap to
 * ask about, so ask about it here where a PR can see the answer.
 */

import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import {
	BUNDLE_OPTIONS,
	collectExternals,
	EXPECTED_EXTERNALS,
} from '../scripts/bundle-externals.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Bundle exactly as `build.mjs` does, but to memory. */
async function externals(): Promise<string[]> {
	const result = await build({
		...BUNDLE_OPTIONS,
		absWorkingDir: root,
		outfile: 'dist/lib/cli.js',
		write: false,
		logLevel: 'silent',
	})
	return collectExternals(result.metafile)
}

describe('published CLI bundle', () => {
	it('imports exactly the packages its install surface declares', async () => {
		expect(await externals()).toEqual(EXPECTED_EXTERNALS)
	})

	it('does not pull better-auth in through a barrel (#348)', async () => {
		// Named separately from the list above because this one is not a
		// bookkeeping mismatch: better-auth arriving here means the npx tree needs
		// a peer `drizzle-orm` it cannot resolve, and every command stops starting.
		expect(await externals()).not.toContain('better-auth')
	})
})
