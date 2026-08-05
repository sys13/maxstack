/**
 * The intent fold.
 *
 * The write path's own invariants — attribution, settling nothing, refusing an
 * empty sentence — live in `write-path.invariant.test.ts`, where every other write
 * on this surface is asserted. What is here is the read: which requirements the
 * surface is entitled to call *yours*.
 *
 * That distinction is the whole reason `intentView` takes the path rather than
 * returning every requirement flat. A project seeded from a PRD already has
 * requirements, and telling its owner "you recorded this" about a line they never
 * typed is a small lie in the one pane whose entire job is reflecting them back at
 * themselves.
 */

import { applyOp, newSpecSystem, type OpId } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { draftIntent, intentId, intentView } from './intent'

const PATH = 'web-record-intent'

let n = 0
const meta = (path: string) => ({
	id: `op-i${++n}` as OpId,
	origin: 'human' as const,
	appliedAt: '2026-07-31',
	actor: { surface: 'web' as const, path },
})

function record(
	spec = newSpecSystem(tasklyPRD),
	story = 'a thing',
	path = PATH,
) {
	const draft = draftIntent(spec, story)
	if (!draft.ok) throw new Error(draft.message)
	return applyOp(
		spec,
		{ op: 'prd.addRequirement', args: { requirement: draft.requirement } },
		meta(path),
	)
}

describe('intentView', () => {
	it('claims only what this path recorded', () => {
		const base = newSpecSystem(tasklyPRD)
		expect(base.product.requirements.length).toBeGreaterThan(0)
		const seeded = intentView(base, PATH)
		expect(seeded.yoursCount).toBe(0)
		expect(seeded.intents.every((i) => !i.yours && i.at === null)).toBe(true)

		const after = intentView(record(base, 'log client visits'), PATH)
		expect(after.yoursCount).toBe(1)
		expect(after.intents.filter((i) => i.yours)).toHaveLength(1)
	})

	it('does not claim a requirement another path landed', () => {
		// An agent adding a requirement through `apply_spec_change` is an ordinary
		// thing to happen, and it is not the maintainer saying what they want.
		const view = intentView(
			record(undefined, 'agent wrote this', 'mcp-apply-spec-change'),
			PATH,
		)
		expect(view.yoursCount).toBe(0)
	})

	it('puts the newest first', () => {
		let spec = record(undefined, 'first thing')
		spec = record(spec, 'second thing')
		expect(intentView(spec, PATH).intents[0]?.story).toBe('second thing')
	})
})

describe('intentId', () => {
	it('reads as the sentence it came from', () => {
		expect(intentId('A place to log client visits', new Set())).toBe(
			'r-a-place-to-log-client',
		)
	})

	it('falls back rather than emitting a bare prefix', () => {
		// A sentence of punctuation would otherwise produce `r-`, which is a
		// syntactically valid id and a useless one.
		expect(intentId('!!! ???', new Set())).toBe('r-intent')
	})

	it('steps around an id already taken', () => {
		expect(intentId('a thing', new Set(['r-a-thing']))).toBe('r-a-thing-2')
		expect(intentId('a thing', new Set(['r-a-thing', 'r-a-thing-2']))).toBe(
			'r-a-thing-3',
		)
	})
})
