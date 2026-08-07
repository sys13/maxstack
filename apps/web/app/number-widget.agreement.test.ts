/**
 * Issue #345 — the number-widget name heuristic, and the two copies of it.
 *
 * `@maxstack/ui`'s `specialtyHint` is the authority: it decides that a number
 * column called `rating` renders as five stars and one called `durationSeconds`
 * as `1h 2m 3s`. `@maxstack/mcp`'s steering layer has to know the same thing, so
 * it can *tell the author* an inference happened — a widget nobody declared is
 * exactly what the `warnings` list is for.
 *
 * The two cannot share code: `@maxstack/ui` has no workspace dependencies at all
 * (apps embed it directly, and that emptiness is enforced by
 * `scripts/check-boundaries.mjs`), so nothing in `@maxstack/mcp` can import the
 * authority and nothing in `@maxstack/ui` can import a shared list. The
 * duplicate is therefore deliberate — and this file is the pin that makes it
 * safe, the same arrangement `docs`-side duplicates get elsewhere in this repo.
 *
 * `apps/web` is the only place that may import both packages, which is why the
 * pin lives here rather than beside either copy.
 *
 * **If this fails**: a word was added to (or removed from) `RATING_WORDS` /
 * `DURATION_WORDS` in `packages/ui/src/fields/field-semantics.ts` without the
 * matching change to `NUMBER_WIDGET_WORDS` in `packages/mcp/src/steering.ts`.
 * The consequence of leaving it is silent: the field still becomes a widget, and
 * the author simply stops being told.
 */

import { inferredNumberWidget } from '@maxstack/mcp'
import { detectFieldKind } from '@maxstack/ui'
import { describe, expect, it } from 'vitest'

/**
 * Names that must infer a widget, and names that must not. Written out rather
 * than derived from either implementation: a table generated from one of the two
 * copies would agree with itself no matter how far they drifted.
 */
const CASES: [name: string, widget: 'rating' | 'duration' | null][] = [
	['rating', 'rating'],
	['stars', 'rating'],
	['user_rating', 'rating'],
	['imdbRating', 'rating'],
	['star-rating', 'rating'],
	['duration', 'duration'],
	['durationSeconds', 'duration'],
	['pages', null],
	['score', null],
	['total', null],
	['count', null],
]

describe('the number-widget name heuristic has one meaning in two packages', () => {
	it.each(CASES)('"%s"', (name, widget) => {
		// The field library: what the app actually renders.
		const kind = detectFieldKind({ name, type: 'number' })
		expect(kind).toBe(widget ?? 'number')
		// The steering layer: what the author is told happened.
		expect(inferredNumberWidget(name)).toBe(widget)
	})
})
