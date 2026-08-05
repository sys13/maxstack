/**
 * The two halves of the search vocabulary must agree.
 *
 * `@maxstack/spec`'s `SEARCH_LANGUAGES` / `SEARCH_WEIGHTS` are what a
 * declaration is **validated** against. `@maxstack/core`'s copies are what the
 * SQL generator **interpolates** — they are the last check before a language
 * name reaches a `regconfig` literal and a weight reaches `setweight`.
 *
 * They cannot be one list: `@maxstack/core` does not depend on `@maxstack/spec`
 * (`boundaries.config.json` — core's allowed-imports list is empty, on purpose,
 * so the spec→Sprout bridge stays a translation rather than a coupling). So the
 * duplication is deliberate, and this file is the price of it.
 *
 * The drift is invisible and asymmetric, which is why it is worth a file:
 *
 *  - A language in **spec but not core** means every project declaring it boots
 *    to a thrown error at DDL time, long after the op was accepted and
 *    committed.
 *  - A language in **core but not spec** is the dangerous direction: it is a
 *    value the interpolating side is willing to splice into SQL and the
 *    validating side never sees, which is exactly the shape of the gap an
 *    injection goes through.
 *
 * `@maxstack/features` is the lowest package permitted to import both, which is
 * the same reason `sources/ssrf.agreement.test.ts` lives here.
 */

import {
	assertPlanIsSafe,
	SEARCH_LANGUAGES as CORE_LANGUAGES,
	SEARCH_WEIGHTS as CORE_WEIGHTS,
} from '@maxstack/core'
import {
	SEARCH_LANGUAGES as SPEC_LANGUAGES,
	SEARCH_WEIGHTS as SPEC_WEIGHTS,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'

describe('the spec and core search vocabularies', () => {
	it('name exactly the same text search configurations', () => {
		expect([...CORE_LANGUAGES].sort()).toEqual([...SPEC_LANGUAGES].sort())
	})

	it('name exactly the same weights, in the same order', () => {
		// Order matters here and not for languages: `orderedSearchFields` sorts by
		// index into this array, so a reordering would silently change which field
		// ranks first without changing any declaration.
		expect([...CORE_WEIGHTS]).toEqual([...SPEC_WEIGHTS])
	})

	it('is not vacuous — the lists are non-empty and contain more than a default', () => {
		// A test comparing two empty arrays passes forever. This is the guard
		// against somebody "fixing" a future failure by emptying one side.
		expect(SPEC_LANGUAGES.length).toBeGreaterThan(5)
		expect(SPEC_LANGUAGES).toContain('simple')
		expect(SPEC_WEIGHTS).toHaveLength(4)
	})

	it('agree that a value outside the shared set is refused', () => {
		// The agreement that actually matters at runtime: whatever the lists hold,
		// core's assertion is the one standing between a declaration and the SQL,
		// and it must reject anything the spec would have rejected.
		for (const bad of ['klingon', 'ENGLISH', "english'--", '']) {
			expect(SPEC_LANGUAGES as readonly string[]).not.toContain(bad)
			expect(() =>
				assertPlanIsSafe({
					key: 'k',
					language: bad,
					fields: [{ column: 'title', weight: 'A' }],
					indexed: true,
				}),
			).toThrow()
		}
	})

	it('accepts every language the spec allows', () => {
		// The other direction, so the agreement is pinned as an equality rather
		// than as a one-sided subset that a shrinking core list would satisfy.
		for (const language of SPEC_LANGUAGES)
			expect(() =>
				assertPlanIsSafe({
					key: 'k',
					language,
					fields: [{ column: 'title', weight: 'A' }],
					indexed: true,
				}),
			).not.toThrow()
	})
})
