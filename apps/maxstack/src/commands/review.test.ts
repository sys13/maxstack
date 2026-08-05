/**
 * `maxstack review` — the write path `cli-review`.
 *
 * Driven over a real temp project rather than mocked, because what needs checking
 * is the wiring: that the terminal surface inherits the *same* refusals as the
 * pane, and that there is no way to talk it into clearing something the workbench
 * would not. A mocked `planBulkReview` would assert only that this test knows what
 * this test set up.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpecDir } from '@maxstack/mcp'
import {
	deriveProvenanceState,
	hasGeneratedSinceBatch,
	type SpecSystem,
} from '@maxstack/spec'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { projectGenerationWatermark } from '../lib/generate.ts'
import { loadProject } from '../lib/project.ts'
import { genCommand } from './gen.ts'
import { initCommand } from './init.ts'
import { opCommand } from './op.ts'
import { reviewCommand } from './review.ts'

/** An AI-authored row: suggested, so it lands in the review queue. */
const SUGGESTED = {
	isSuggested: true,
	isAccepted: null,
	isAddedManually: false,
	suggestedDescription: null,
	priority: 'medium' as const,
}

/** Pin a scaffolded project's review mode, for suites that exercise the queue. */
async function setReviewMode(
	dir: string,
	mode: 'review' | 'auto',
): Promise<void> {
	const path = join(dir, 'maxstack.json')
	const config = JSON.parse(await readFile(path, 'utf8'))
	config.reviewMode = mode
	await writeFile(path, `${JSON.stringify(config, null, '\t')}\n`)
}

describe('maxstack review', () => {
	let dir: string
	let logged: string[]
	const loadSpec = (): Promise<SpecSystem> => readSpecDir(join(dir, 'spec'))

	/** The provenance state of one field, by id. */
	const stateOf = async (fieldId: string): Promise<string | null> => {
		const spec = await loadSpec()
		for (const entity of spec.data.entities) {
			const field = entity.fields.find((f) => f.id === fieldId)
			if (field) return deriveProvenanceState(field.provenance)
		}
		return null
	}

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-review-'))
		logged = []
		vi.spyOn(console, 'log').mockImplementation((...args) => {
			logged.push(args.map(String).join(' '))
		})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a bulk-review fixture' })
		// This suite exercises the review queue, so it pins the mode it tests
		// rather than depending on the scaffold default.
		await setReviewMode(dir, 'review')
		// One entity with three routine fields and one that reads as access control.
		await opCommand(dir, {
			origin: 'ai',
			op: JSON.stringify({
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-order',
						name: 'Order',
						provenance: SUGGESTED,
						fields: [
							{
								id: 'fld-total',
								name: 'total',
								type: 'number',
								required: true,
								provenance: SUGGESTED,
							},
							{
								id: 'fld-notes',
								name: 'notes',
								type: 'string',
								required: false,
								provenance: SUGGESTED,
							},
							{
								id: 'fld-sku',
								name: 'sku',
								type: 'string',
								required: false,
								provenance: SUGGESTED,
							},
							{
								id: 'fld-role',
								name: 'viewerRole',
								type: 'string',
								required: false,
								provenance: SUGGESTED,
							},
						],
					},
				},
			}),
		})
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	const output = (): string => logged.join('\n')
	const clear = (): void => {
		logged.length = 0
	}

	it('prints the queue with risk, worst first, and marks what cannot be batched', async () => {
		clear()
		await reviewCommand(dir, {})
		const out = output()
		expect(out).toMatch(/review queue: \d+ pending/)
		expect(out).toMatch(/fld-role/)
		expect(out).toMatch(/!!/) // the access-control field is flagged
		expect(out).toMatch(/cannot be cleared in a batch at any size/)
	})

	it('clears a group and refuses the access-control field inside it', async () => {
		// The whole point: one action clears the routine three, and the fourth is
		// reported as refused rather than silently swept along.
		clear()
		await reviewCommand(dir, { accept: 'field:e-order', origin: 'human' })
		const out = output()
		expect(out).toMatch(/refused fld-role/)
		expect(out).toMatch(/high risk/)

		expect(await stateOf('fld-total')).toBe('accepted')
		expect(await stateOf('fld-notes')).toBe('accepted')
		expect(await stateOf('fld-sku')).toBe('accepted')
		// Still undecided, still in the queue.
		expect(await stateOf('fld-role')).toBe('suggested')
	})

	it('stamps one batch id across the whole batch, per artifact', async () => {
		const spec = await loadSpec()
		const reviews = spec.opLog.filter((e) => e.op.op === 'provenance.review')
		expect(reviews.length).toBe(3)
		const sessions = new Set(reviews.map((e) => e.actor?.session))
		expect(sessions.size).toBe(1)
		for (const entry of reviews) {
			expect(entry.actor?.path).toBe('cli-review')
			expect(entry.actor?.surface).toBe('cli')
		}
		// Per artifact: three entries naming three different rows.
		expect(new Set(reviews.map((e) => e.diff.targetId)).size).toBe(3)
	})

	it('undoes the batch, putting the rows back in the queue', async () => {
		const spec = await loadSpec()
		const batchId = spec.opLog.find((e) => e.op.op === 'provenance.review')
			?.actor?.session
		expect(batchId).toBeTruthy()

		clear()
		await reviewCommand(dir, { undo: batchId, origin: 'human' })
		expect(output()).toMatch(/back to undecided/)
		expect(await stateOf('fld-total')).toBe('suggested')
		expect(await stateOf('fld-notes')).toBe('suggested')
	})

	it('has no select-all, and says so rather than guessing', async () => {
		// A control that grows as an agent proposes more is a rubber stamp with extra
		// steps. Both spellings someone would reach for are refused by name.
		for (const selector of ['all', '*']) {
			clear()
			await reviewCommand(dir, { accept: selector, origin: 'human' })
			expect(output()).toMatch(/there is no select-all/)
			expect(output()).toMatch(/nothing selected/)
		}
		// Nothing moved.
		expect(await stateOf('fld-total')).toBe('suggested')
	})

	it('lands nothing when the selector matches nothing', async () => {
		clear()
		await reviewCommand(dir, { accept: 'fld-does-not-exist', origin: 'human' })
		expect(output()).toMatch(/no pending proposal matches/)
		expect(output()).toMatch(/nothing selected/)
	})

	it('refuses the access-control field even when named directly', async () => {
		// Selecting it by id is not a way round the classification — a batch of one
		// is still a batch.
		clear()
		await reviewCommand(dir, { accept: 'fld-role', origin: 'human' })
		expect(output()).toMatch(/refused fld-role/)
		expect(output()).toMatch(/nothing landed/)
		expect(await stateOf('fld-role')).toBe('suggested')
	})

	it('emits machine-readable risk for an agent', async () => {
		clear()
		await reviewCommand(dir, { json: true })
		const parsed = JSON.parse(output())
		expect(parsed.pending).toBeGreaterThan(0)
		expect(
			parsed.needsAttention.some(
				(p: { target: { id: string } }) => p.target.id === 'fld-role',
			),
		).toBe(true)
	})
})

/**
 * The undo's precondition.
 *
 * Its own project, because the check is about what a `maxstack gen` leaves on
 * disk and the suite above deliberately never generates. Driven through the real
 * `genCommand` rather than by writing a watermark by hand: the thing that was
 * broken was the wiring between generation and the offer, so a test that stamped
 * the manifest itself would pass over exactly the defect.
 */
describe('maxstack review --undo after generation', () => {
	let dir: string
	let logged: string[]
	const output = (): string => logged.join('\n')

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-undo-gen-'))
		logged = []
		vi.spyOn(console, 'log').mockImplementation((...args) => {
			logged.push(args.map(String).join(' '))
		})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'an undo-precondition fixture' })
		// This suite exercises the review queue, so it pins the mode it tests
		// rather than depending on the scaffold default.
		await setReviewMode(dir, 'review')
		await opCommand(dir, {
			origin: 'ai',
			op: JSON.stringify({
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-invoice',
						name: 'invoice',
						pluralName: 'invoices',
						provenance: SUGGESTED,
						fields: [
							{
								id: 'fld-amount',
								name: 'amount',
								type: 'number',
								provenance: SUGGESTED,
							},
						],
					},
				},
			}),
		})
		await reviewCommand(dir, { accept: 'field:e-invoice', origin: 'human' })
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	const batchIdOf = async (): Promise<string> => {
		const spec = await readSpecDir(join(dir, 'spec'))
		const id = spec.opLog.find((e) => e.op.op === 'provenance.review')?.actor
			?.session
		if (!id) throw new Error('no batch landed')
		return id
	}

	it('is undoable before anything has been generated', async () => {
		const spec = await readSpecDir(join(dir, 'spec'))
		expect(hasGeneratedSinceBatch(spec, await batchIdOf(), null)).toBe(false)
	})

	it('records the watermark when gen runs, and then refuses the undo', async () => {
		const batchId = await batchIdOf()
		await genCommand(dir)

		const spec = await readSpecDir(join(dir, 'spec'))
		// Read back through the same accessor the command uses, so the manifest's
		// location stays the project's business rather than this test's.
		const watermark = await projectGenerationWatermark(await loadProject(dir))
		// The watermark covers the batch's ops — that is what makes the refusal
		// derivable rather than guessed.
		expect(watermark).toBe(spec.opLog.length)
		expect(hasGeneratedSinceBatch(spec, batchId, watermark)).toBe(true)

		logged = []
		await reviewCommand(dir, { undo: batchId, origin: 'human' })
		expect(output()).toMatch(/cannot undo batch/)
		expect(output()).toMatch(/generated since/)
		// And nothing moved: the refusal is a refusal, not a warning.
		const after = await readSpecDir(join(dir, 'spec'))
		const amount = after.data.entities
			.flatMap((e) => e.fields)
			.find((f) => f.id === 'fld-amount')
		expect(deriveProvenanceState(amount?.provenance ?? SUGGESTED)).toBe(
			'accepted',
		)
	})
})
