/**
 * `maxstack regen-cost` and the ledger behind it.
 *
 * Driven through the real `genCommand` over a real temp project, because the
 * whole premise of option 2 is that the ledger *builds itself* as somebody works.
 * A test that wrote the JSONL by hand would prove the fold and prove nothing
 * about whether generating ever records anything.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseRegenLog } from '@maxstack/core/regen'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadProject } from '../lib/project.ts'
import { projectRegenTrend, REGEN_LOG_FILENAME } from '../lib/regen-log.ts'
import { genCommand } from './gen.ts'
import { initCommand } from './init.ts'
import { opCommand } from './op.ts'
import { regenCostCommand } from './regen-cost.ts'

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

describe('the regeneration ledger builds itself', () => {
	let dir: string
	let logged: string[]
	const output = (): string => logged.join('\n')
	const clear = (): void => {
		logged = []
	}

	/** Read the ledger straight off disk, past every accessor. */
	const rawLedger = async () => {
		const project = await loadProject(dir)
		return parseRegenLog(
			await readFile(
				resolve(project.root, project.config.dataDir, REGEN_LOG_FILENAME),
				'utf8',
			),
		)
	}

	/** Land one suggested field, so the op log actually moves. */
	const addField = async (id: string): Promise<void> => {
		await opCommand(dir, {
			origin: 'ai',
			op: JSON.stringify({
				op: 'data.addField',
				args: {
					entityId: 'e-invoice',
					field: {
						id,
						name: id.replace('fld-', ''),
						type: 'string',
						provenance: SUGGESTED,
					},
				},
			}),
		})
	}

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-regen-cost-'))
		logged = []
		vi.spyOn(console, 'log').mockImplementation((...args) => {
			logged.push(args.map(String).join(' '))
		})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a regen-ledger fixture' })
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
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('records nothing before anything is generated, and says so', async () => {
		// `init` generates, so the ledger already has a line. What must not exist is
		// a *rate* — one generation is not an interval.
		clear()
		await regenCostCommand(dir)
		expect(output()).toMatch(/nothing to measure|no generations recorded/)
		// And no number is printed anywhere in that output.
		expect(output()).not.toMatch(/\d+\.\d\d files/)
	})

	it('appends a line per generate, carrying the op-log watermark', async () => {
		const before = (await rawLedger()).length
		await genCommand(dir)
		const after = await rawLedger()

		expect(after.length).toBe(before + 1)
		const last = after.at(-1)
		const project = await loadProject(dir)
		expect(last?.opCount).toBe((await project.spec.load()).opLog.length)
		// A day, not an instant — the ledger records generated code, not when
		// somebody was at their desk.
		expect(last?.at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	})

	it('measures a rate once a change has landed between two generates', async () => {
		await addField('fld-notes')
		await addField('fld-terms')
		await genCommand(dir)

		const report = await projectRegenTrend(await loadProject(dir))
		expect(report.meanFilesPerOp).not.toBeNull()
		const last = report.points.at(-1)
		expect(last?.opsLanded).toBe(2)
		expect(last?.filesPerOp).toBe((last?.filesTouched ?? 0) / 2)
	})

	it('names itself honestly rather than borrowing the platform’s metric', async () => {
		clear()
		await regenCostCommand(dir)
		// The proxy is described as a proxy every time it is printed. A proxy that
		// stops being described as one becomes a target.
		expect(output()).toMatch(/files-redrawn-per-op/)
		expect(output()).toMatch(/not the platform’s weightPerSafeChange/)
	})

	it('emits the whole report as JSON for an agent or a CI job', async () => {
		clear()
		await regenCostCommand(dir, { json: true })
		const parsed = JSON.parse(output())
		expect(parsed.generations).toBeGreaterThan(1)
		expect(Array.isArray(parsed.points)).toBe(true)
		// The field an unwary consumer would divide by. It has to be present and
		// non-null here, and null-not-zero elsewhere.
		expect(parsed.meanFilesPerOp).toBeGreaterThanOrEqual(0)
	})

	it('never fails a generate because the ledger could not be written', async () => {
		// The record is about the work; failing the work to protect the record is
		// backwards. Simulated by pointing the data dir at something unwritable.
		const project = await loadProject(dir)
		const { appendRegenEntry } = await import('../lib/regen-log.ts')
		await expect(
			appendRegenEntry(join(project.root, 'no', 'such', 'dir'), {
				at: '2026-07-30',
				opCount: 1,
				writes: {
					created: 0,
					overwritten: 0,
					unchanged: 0,
					skippedUserOwned: 0,
				},
				artifacts: 0,
				stable: true,
			}),
		).resolves.toBeUndefined()
	})
})
