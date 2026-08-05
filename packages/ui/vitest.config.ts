import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ['./src/test-setup.ts'],
		// Issue #224. Every test in this package is a synchronous jsdom render
		// with synchronous assertions — there is nothing here to await and nothing
		// to race, so a wall-clock ceiling measures the *runner*, not the
		// component. vitest's 5000ms default is one that several of these renders
		// already sit within a second or two of on a loaded CI box, and
		// `DynamicForm.form-layer.test.tsx` went over it once `validate` stopped
		// being accidentally serialized by the lattice sweep: the same file
		// takes 1.0s locally and 23.5s on a contended 2-core runner.
		//
		// Raising it removes no coverage — every assertion still runs and still
		// has to pass. It is deliberately *not* the fix for the contention itself,
		// which is #224's actual subject; it is here so a starved runner reports
		// "slow" rather than "the tabs are broken".
		testTimeout: 30_000,
		//
		// #224 also asked whether these suites are slow *for a reason* rather than
		// only slow under load. Measured, on this package, over 68 files and 531
		// tests:
		//
		//     transform 2.4s · setup 5.5s · import 6.0s · tests 6.1s
		//     environment 25.9s        ← four times the cost of running the tests
		//
		// The dominant term is not `act` churn or the assertions. It is jsdom
		// *construction* — roughly 400ms per file, paid per file because each one
		// gets its own environment. That is exactly the resource a 2-core runner
		// runs out of when eleven tasks overlap, and it is why a synchronous render
		// with nothing to await blew a 5s wall-clock ceiling.
		//
		// 21 of the 68 files never touch a DOM at all and were each paying for one.
		// They now declare `@vitest-environment node` in their own docblock, which
		// took `environment` from 25.9s to 17.9s (-31%) and the wall clock from
		// 4.27s to 3.48s on an unloaded many-core machine — a bigger share on a
		// contended 2-core one, where environment construction *is* the contention.
		//
		// Left as the default rather than inverted: `jsdom` is the right default for
		// a component library, and a per-file opt-out states what each file needs
		// instead of making a new component test fail in a way nobody expects.
		environment: 'jsdom',
	},
})
