import { defineConfig } from 'vitest/config'

// These suites boot pglite (~1.4s in isolation); under a full-parallel turbo
// run on a loaded machine the boot alone can blow vitest's default 5s
// timeout. 30s gives real headroom without hiding hangs.
//
// `maxWorkers` is the other half of that same problem, added when issue #174's
// search suite became the sixth pglite-booting file in `@maxstack/core` and
// tipped the full `turbo run test --force` sweep into 30s timeouts — in *other*
// packages' files, not the new one. Nothing was hanging. Turbo runs eleven
// packages at once, each vitest defaulting to one worker per core; this package
// has eighteen pglite-booting suites and is by far the largest consumer, so on a
// 14-core machine it alone was asking for thirteen concurrent WASM instances and
// starving everyone else.
//
// The timeout is deliberately NOT raised. Its whole value is the invariant that
// a timeout means a real hang rather than contention, and raising it to absorb
// contention is exactly how that invariant gets quietly lost. Capping the
// workers removes the contention the 30s was there to survive. No test is
// skipped and nothing is loosened.
// Shuffled, at a pinned seed. Four files in this package shared state across
// the tests in their file and passed only in declaration order — 8 tests failed
// under `--sequence.shuffle --sequence.seed=42`, and isolating them
// turned up a real ordering defect in `ConsentService.latest`. Declaration order
// is not a property any of these suites should be relying on, so the default run
// no longer supplies it.
//
// The seed is fixed rather than random so a failure reproduces from the log
// alone: a random seed would make this a source of unreproducible red. It does
// mean one order is exercised rather than all of them — running a few other
// seeds by hand is still worth doing when touching a stateful suite.
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
		maxWorkers: 6,
		sequence: { shuffle: true, seed: 42 },
	},
})
