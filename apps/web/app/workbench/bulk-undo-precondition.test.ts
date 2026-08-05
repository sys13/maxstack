/**
 * That the workbench's undo offer is derived rather than assumed.
 *
 * `loadBulkReview` used to pass the literal `false` for "has anything been
 * generated since", so the offer outlived its own precondition: after a
 * `maxstack gen` had turned the accepted rows into files, the pane still showed
 * "Undo that batch", and taking it would put the spec back while leaving the
 * generated artifacts in place — a project in a state neither the spec nor the
 * tree describes. That is the specific failure #199's undo was added to prevent.
 *
 * The watermark is the seam being tested, so it is the thing that gets stubbed:
 * everything else here is the real loader over the real bulk-review model.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlatform } from '~/sprout.server'

const watermark = vi.hoisted(() => ({ value: null as number | null }))

vi.mock('./drift.server', async (importOriginal) => ({
	...(await importOriginal<typeof import('./drift.server')>()),
	loadGenerationWatermark: async () => watermark.value,
}))

const { loadBulkReview, submitBulkReview, submitBulkUndo } = await import(
	'./bulk-review.server'
)

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: unknown[]
	__maxstackWorkbenchEvents?: unknown[]
	__maxstackPlatform?: unknown
}

beforeEach(() => {
	scope.__maxstackFeedback = []
	scope.__maxstackWorkbenchEvents = []
	// These tests write to the platform's spec, which is memoised on `globalThis`.
	delete scope.__maxstackPlatform
	watermark.value = null
})

/** Land a batch over whatever the demo spec has pending, and return its id. */
async function landABatch(): Promise<string> {
	const { groups } = await loadBulkReview()
	const targets = groups.flatMap((g) =>
		g.targets.filter((_, i) => g.assessments[i]?.batchable),
	)
	expect(targets.length).toBeGreaterThan(0)

	const form = new FormData()
	form.set('action', 'accept')
	for (const target of targets) {
		form.append(
			'target',
			[target.kind, target.parentId ?? '', target.id].join(':'),
		)
	}
	const result = await submitBulkReview(form)
	expect(result.landed).toBeGreaterThan(0)
	return result.batchId
}

describe('the undo offer follows the generation watermark', () => {
	it('offers the undo while nothing has been generated', async () => {
		const batchId = await landABatch()
		const view = await loadBulkReview()
		expect(view.undoable?.batchId).toBe(batchId)
		expect(view.undoWithheld).toBeNull()
	})

	it('withdraws it once a generate has consumed the batch', async () => {
		const batchId = await landABatch()
		// A `maxstack gen` in another terminal, recorded on the manifest. A large
		// count stands for "generated from the whole log": what matters is that it
		// covers the batch's ops.
		watermark.value = 10_000

		const view = await loadBulkReview()
		expect(view.undoable).toBeNull()
		// Stated, not silently dropped. A reviewer who saw the button a minute ago
		// needs the cause and the way forward, not an absence.
		expect(view.undoWithheld?.batchId).toBe(batchId)
		expect(view.undoWithheld?.reason).toMatch(/generated since/)
		expect(view.undoWithheld?.size).toBeGreaterThan(0)
	})

	it('refuses the write too, not only the render', async () => {
		// The precondition can expire between the render and the click — a page held
		// open across a generate still has a live button — so the check that matters
		// is the one on the write path.
		const batchId = await landABatch()
		watermark.value = 10_000

		const form = new FormData()
		form.set('batchId', batchId)
		await expect(submitBulkUndo(form)).rejects.toMatchObject({ status: 409 })
	})

	it('still undoes when the generate predates the batch', async () => {
		// The boundary that decides whether this feature helps or just breaks undo:
		// a watermark from *before* the batch landed says nothing was derived from
		// it. Off by one here and every undo disappears the moment a project has
		// ever been generated.
		const priorOps = (await getPlatform().spec.load()).opLog.length
		const batchId = await landABatch()
		watermark.value = priorOps

		const view = await loadBulkReview()
		expect(view.undoable?.batchId).toBe(batchId)
		expect(view.undoWithheld).toBeNull()
		await expect(submitBulkUndo(dataOf(batchId))).resolves.toMatchObject({
			batchId,
		})
	})
})

function dataOf(batchId: string): FormData {
	const form = new FormData()
	form.set('batchId', batchId)
	return form
}
