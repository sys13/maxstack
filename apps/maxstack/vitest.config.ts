import { defineConfig } from 'vitest/config'

// These suites boot pglite (~1.4s in isolation); under a full-parallel turbo
// run on a loaded machine the boot alone can blow vitest's default 5s
// timeout. 30s gives real headroom without hiding hangs.
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
