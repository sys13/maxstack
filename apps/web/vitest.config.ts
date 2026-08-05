import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts so the React Router plugin doesn't run
// under the test harness — the web tests exercise the server wiring (MCP
// dispatch, Sprout context) as plain modules. The `~` alias mirrors
// tsconfig's `paths` so server modules that import `~/…` are unit-testable
// (the RR plugin resolves it in the real build; vitest needs it spelled out).
export default defineConfig({
	resolve: {
		alias: {
			'~': fileURLToPath(new URL('./app', import.meta.url)),
		},
	},
	test: {
		environment: 'node',
		// `app/**` is the served app; the root-level glob covers build-tooling
		// modules that live alongside `vite.config.ts` (e.g.
		// `vite-owned-slots-plugin.ts`) rather than under `app/`.
		include: ['app/**/*.{test,spec}.{ts,tsx}', '*.{test,spec}.{ts,tsx}'],
		// The server-wiring suites boot pglite (~1.4s in isolation); under a
		// full-parallel turbo run on a loaded machine the boot alone can blow
		// vitest's default 5s timeout. 30s gives real headroom
		// without hiding hangs.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// This was the last pglite-booting package with no worker cap, and it
		// showed: `app/mcp.server.test.ts` failed its `beforeAll` on 2 of 4 full
		// `turbo run test --force` runs while passing in 2.5s alone.
		// Eleven files here call `getSprout()`, and that is the most expensive
		// boot in the repo — pglite *plus* the better-auth DDL *plus* the demo
		// seed, in a fresh fork each time, since vitest 4's pool is `forks`.
		// Uncapped that is eleven of them racing while `@maxstack/core` (4) and
		// `@maxstack/features` (6) hold their own. The cap matches core's, for
		// the same reason and by the same route as issues #67 and #224.
		//
		// As in features' config, the timeout is deliberately NOT raised: its
		// value is the invariant that a timeout means a real hang rather than
		// contention.
		maxWorkers: 4,
	},
})
