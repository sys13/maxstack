/**
 * That the review-cost facts are recorded by the real review path,
 * not just modelled correctly in the abstract.
 *
 * `costReview` is only as good as what `submitReview` writes down, and the field
 * most easily got wrong is `batchSize`: it has to be counted against the spec as
 * it was *before* the decision landed, and it has to count only the rows the
 * decision will actually settle. Get it wrong and bulk review measures as
 * *slower* than reviewing one at a time — the exact conclusion this metric exists
 * to prevent somebody drawing.
 *
 * Runs against the in-memory hosts (no `MAXSTACK_DATA_DIR` under vitest) over the
 * demo spec the workbench boots with, which deliberately carries a mixture of
 * provenance states.
 */

import { costReview } from '@maxstack/core/review'
import { beforeEach, describe, expect, it } from 'vitest'
import { allWorkbenchEvents } from './telemetry.server'
import { submitReview } from './workbench.server'

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: unknown[]
	__maxstackWorkbenchEvents?: unknown[]
	__maxstackPlatform?: unknown
}

beforeEach(() => {
	scope.__maxstackFeedback = []
	scope.__maxstackWorkbenchEvents = []
	// The platform context is memoised on `globalThis`, and these tests *write*
	// to its spec. Without this, the first test to accept `fld-name` settles it
	// for every later test, and the cascade below would count one proposal instead
	// of two — a green suite measuring nothing. Found exactly that way.
	delete scope.__maxstackPlatform
})

function reviewForm(fields: Record<string, string>): FormData {
	const form = new FormData()
	for (const [k, v] of Object.entries(fields)) form.set(k, v)
	return form
}

describe('submitReview records the review-cost facts', () => {
	it('labels an individual decision, with a batch size of one', async () => {
		await submitReview(
			reviewForm({
				action: 'accept',
				kind: 'field',
				id: 'fld-name',
				parentId: 'e-project',
			}),
		)
		const [event] = await allWorkbenchEvents()
		expect(event?.kind).toBe('accept')
		expect(event?.mode).toBe('individual')
		expect(event?.batchSize).toBe(1)
	})

	it('counts a cascade as bulk, over the rows it actually settles', async () => {
		// The demo spec's `e-project` is suggested and carries one suggested field
		// (`fld-name`) plus one hand-added manual field (`fld-archived`). A cascade
		// clears two proposals — the manual row is not a proposal and was never
		// anybody's to review.
		await submitReview(
			reviewForm({
				action: 'accept',
				kind: 'entity',
				id: 'e-project',
				cascade: '1',
			}),
		)
		const [event] = await allWorkbenchEvents()
		expect(event?.mode).toBe('bulk')
		expect(event?.batchSize).toBe(2)
	})

	it('never records a batch size of zero, even on an already-settled row', async () => {
		// Deciding twice on the same row is a real thing a maintainer does. The
		// second decision is still a decision somebody made, and a zero here would
		// divide review cost by nothing.
		const form = () =>
			reviewForm({
				action: 'accept',
				kind: 'field',
				id: 'fld-name',
				parentId: 'e-project',
			})
		await submitReview(form())
		await submitReview(form())
		const events = await allWorkbenchEvents()
		expect(events).toHaveLength(2)
		for (const event of events)
			expect(event.batchSize).toBeGreaterThanOrEqual(1)
	})

	it('carries the proposal time when the op log knows it', async () => {
		// The demo seed stamps a date-granular `appliedAt`, which is exactly the case
		// the cost model refuses to subtract — so this asserts the *plumbing* (the
		// value reaches the event) and that the model then declines to use it.
		await submitReview(
			reviewForm({
				action: 'accept',
				kind: 'entity',
				id: 'e-project',
			}),
		)
		const [event] = await allWorkbenchEvents()
		expect(event?.proposedAt).toBe('2026-07-09')
		const { decisions } = costReview(await allWorkbenchEvents())
		expect(decisions[0]?.elapsedMs).toBeNull()
	})

	it('produces a costable log end to end', async () => {
		await submitReview(
			reviewForm({
				action: 'accept',
				kind: 'entity',
				id: 'e-project',
				cascade: '1',
			}),
		)
		await submitReview(
			reviewForm({ action: 'reject', kind: 'page', id: 'pg-projects' }),
		)
		const { summary } = costReview(await allWorkbenchEvents())
		expect(summary.decisions).toBe(2)
		// 2 from the cascade + 1 from the page.
		expect(summary.proposals).toBe(3)
		expect(summary.byMode.bulk).toBe(2)
		expect(summary.byMode.individual).toBe(1)
		expect(summary.engagedMsPerProposal).toBeGreaterThan(0)
	})
})

// ===========================================================================
// The cascade answers to the same risk rules
// ===========================================================================

describe('a cascade cannot sweep along a high-risk proposal', () => {
	/**
	 * Found by driving the real surface: clicking a queue row's Accept settled three
	 * proposals including an access-control field, while the bulk pane two sections
	 * down refused that same field by name. A risk signal the adjacent button ignores
	 * manufactures exactly the false confidence #199's gating forbids, because the
	 * reviewer has been shown a surface that appears to be protecting them.
	 */
	it('refuses the cascade and names what it would have settled', async () => {
		const platform = (await import('~/sprout.server')).getPlatform()
		const spec = await platform.spec.load()
		// Give the demo entity an access-control-shaped undecided field.
		spec.data.entities[0]?.fields.push({
			id: 'fld-viewerRole',
			name: 'viewerRole',
			type: 'string',
			required: false,
			provenance: (await import('@maxstack/spec')).suggested(),
		})
		await platform.spec.save(spec)

		await expect(
			submitReview(
				reviewForm({
					action: 'accept',
					kind: 'entity',
					id: 'e-project',
					cascade: '1',
				}),
			),
		).rejects.toMatchObject({ status: 409 })

		// Nothing moved — the refusal is a refusal, not a partial apply.
		const after = await platform.spec.load()
		const entity = after.data.entities.find((e) => e.id === 'e-project')
		expect(entity?.provenance.isAccepted).toBeNull()
		expect(
			entity?.fields.find((f) => f.id === 'fld-viewerRole')?.provenance
				.isAccepted,
		).toBeNull()
	})

	it('still allows the individual decision on the same row', async () => {
		// The point is to narrow one shortcut, not to block the review.
		await submitReview(
			reviewForm({ action: 'accept', kind: 'entity', id: 'e-project' }),
		)
		const platform = (await import('~/sprout.server')).getPlatform()
		const spec = await platform.spec.load()
		expect(
			spec.data.entities.find((e) => e.id === 'e-project')?.provenance
				.isAccepted,
		).toBe(true)
	})

	it('allows a cascade whose subtree is all routine', async () => {
		await submitReview(
			reviewForm({
				action: 'accept',
				kind: 'entity',
				id: 'e-project',
				cascade: '1',
			}),
		)
		const events = await allWorkbenchEvents()
		expect(events[0]?.mode).toBe('bulk')
	})
})

// ===========================================================================
// Loading the workbench must never mutate anything (gating)
// ===========================================================================

describe('the attention loader is read-only', () => {
	/**
	 * #198 states this as a gating requirement, and it is easy to violate here by
	 * accident: the report's public-exposure and removal categories are computed by
	 * **applying** every pending accept to a projection of the spec. If that
	 * projection ever reached `spec.save`, opening the page would settle every
	 * review in the queue — the single worst bug this surface could have, and one
	 * that would look like the feature working.
	 */
	it('does not change the spec, even though it applies ops to compute the report', async () => {
		const platform = (await import('~/sprout.server')).getPlatform()
		const { loadWorkbenchAttention } = await import(
			'~/workbench/attention.server'
		)

		const before = JSON.stringify(await platform.spec.load())
		const view = await loadWorkbenchAttention()
		expect(JSON.stringify(await platform.spec.load())).toBe(before)

		// And it really did compute something — otherwise this asserts that a no-op
		// is a no-op.
		expect(view.report.headline.length).toBeGreaterThan(0)
		expect(typeof view.radius.unchanged).toBe('number')
	})

	it('leaves the op log alone', async () => {
		// Belt and braces on the same property, from the audit side: the projection
		// stamps `actor.path: 'attention-hypothetical'`, so if one ever leaked into a
		// real log it would be findable by name. There should be none.
		const platform = (await import('~/sprout.server')).getPlatform()
		await (
			await import('~/workbench/attention.server')
		).loadWorkbenchAttention()
		const spec = await platform.spec.load()
		expect(
			spec.opLog.filter((e) => e.actor?.path?.includes('hypothetical')),
		).toEqual([])
	})
})
