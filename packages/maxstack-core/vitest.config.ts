import { defineConfig } from 'vitest/config'

// These suites boot pglite (~1.4s in isolation); under a full-parallel turbo
// run on a loaded machine the boot alone can blow vitest's default 5s
// timeout. 30s gives real headroom without hiding hangs.
//
// `maxWorkers` caps how many of those boot at once. See the longer note in
// `packages/features/vitest.config.ts`: turbo runs eleven packages
// concurrently, each vitest defaulting to one worker per core, and the two
// pglite-heavy packages between them were asking a 14-core machine for far more
// WASM instances than it has cores. The timeout is deliberately NOT raised —
// its value is the invariant that a timeout means a real hang rather than
// contention.
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
		maxWorkers: 4,
	},
})
