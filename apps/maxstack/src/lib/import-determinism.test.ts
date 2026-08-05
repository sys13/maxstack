/**
 * Determinism with declared importers.
 *
 * The property is easy to state and easy to satisfy accidentally: nothing in the
 * generator reads an uploaded file **today**. It is also easy to lose silently —
 * the day somebody threads "sniff the last upload so the stub can show the real
 * column names" into the generator, every other test stays green and the eval
 * stops being reproducible, because the tree now depends on what somebody
 * happened to upload last week.
 *
 * So this file asserts it the way `source-determinism.test.ts` does: it **removes
 * the inputs** and generates anyway. `globalThis.fetch` throws and every file
 * read this process could make would have to go through it or through `node:fs`,
 * neither of which the ownership layer imports; the corpus app with a declared
 * `format: 'custom'` importer generates its whole seam regardless.
 *
 * It then pins the property from the other side: specs whose *runtime* behavior
 * genuinely differs must emit identical trees. A paused importer and a running
 * one produce the same files, because pausing is a runtime fact and if it moved
 * the tree, every operational pause would produce a regeneration diff to review.
 *
 * The corpus app is cloned and extended here rather than in `examples/src/`,
 * for the reason `flag-determinism.test.ts` gives: the frozen backlog is a
 * measuring instrument, and this test needs a realistic spec, not a scored one.
 */

import { cardstackExample } from '@maxstack/examples'
import { createMemFs, generateImports } from '@maxstack/core/ownership'
import { specToImporterDescriptors } from '@maxstack/spec-derive'
import {
	activeImporters,
	type ApplyMeta,
	applyOp,
	listImporters,
	type SpecSystem,
} from '@maxstack/spec'
import { afterEach, describe, expect, it } from 'vitest'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-imp-${n}`,
	origin: 'human',
	appliedAt: '2026-07-28',
})

/** cardstack, whose spec declares the Anki importer (a `custom` one). */
function corpusApp(opts: { paused?: boolean } = {}): SpecSystem {
	const spec = structuredClone(cardstackExample.spec)
	if (!opts.paused) return spec
	return applyOp(
		spec,
		{ op: 'imports.pause', args: { importerId: 'imp-anki', paused: true } },
		meta(1),
	)
}

/** cardstack with a second, ordinary CSV importer over the same entity. */
function withCsvImporter(): SpecSystem {
	return applyOp(
		corpusApp(),
		{
			op: 'imports.declare',
			args: {
				importer: {
					id: 'imp-cards-csv',
					key: 'cards-csv',
					description: 'Import cards from a plain CSV.',
					entityId: 'e-card',
					format: 'csv',
					columns: [
						{ column: 'Front', fieldId: 'fld-card-front' },
						{ column: 'Back', fieldId: 'fld-card-back' },
					],
					upsertFieldId: null,
					maxRows: 1000,
					paused: false,
				},
			},
		},
		meta(2),
	)
}

/** The generated tree for a spec's import seam, as a file map. */
async function generateSeam(spec: SpecSystem): Promise<Map<string, string>> {
	const fs = createMemFs()
	await generateImports(fs, specToImporterDescriptors(spec))
	return fs.snapshot()
}

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

function forbidNetwork(): void {
	globalThis.fetch = (async (input: unknown) => {
		throw new Error(
			`the generation path reached the network (${String(input)}) — ` +
				'generation must be a function of the declaration alone',
		)
	}) as typeof globalThis.fetch
}

describe('generation reads the declaration and nothing else', () => {
	it('generates a spec with a declared custom importer while the network is gone', async () => {
		forbidNetwork()
		const spec = corpusApp()
		expect(activeImporters(spec)).toHaveLength(1)
		const files = await generateSeam(spec)
		// The case where the generator *does* emit something and still must not
		// reach for anything outside the declaration.
		expect(files.has('imports/imports.generated.ts')).toBe(true)
		expect(files.has('imports/anki-deck.parse.ts')).toBe(true)
	})

	it('derives the descriptors from the declaration alone', async () => {
		forbidNetwork()
		expect(specToImporterDescriptors(cardstackExample.spec)).toEqual([
			{
				key: 'anki-deck',
				description: 'Import a shared deck from an Anki .apkg archive.',
				format: 'custom',
				resource: 'card',
				parserSlot: 'anki-deck',
			},
		])
	})

	it('reads EVERY declared importer, not only the active ones', () => {
		// `activeImporters` is a runtime filter. If the generated tree depended on
		// it, pausing an importer would rewrite the app.
		const paused = corpusApp({ paused: true })
		expect(activeImporters(paused)).toHaveLength(0)
		expect(listImporters(paused)).toHaveLength(1)
		expect(specToImporterDescriptors(paused)).toHaveLength(1)
	})
})

describe('the generated tree does not depend on what an importer has done', () => {
	it('a paused importer emits the same tree as a running one', async () => {
		const running = corpusApp()
		const paused = corpusApp({ paused: true })
		// Not vacuous: the two specs genuinely disagree about what accepts uploads.
		expect(activeImporters(running)).toHaveLength(1)
		expect(activeImporters(paused)).toHaveLength(0)
		expect(await generateSeam(paused)).toEqual(await generateSeam(running))
	})

	it('regenerating the same spec twice is byte-identical', async () => {
		const spec = corpusApp()
		expect(await generateSeam(spec)).toEqual(await generateSeam(spec))
	})

	it('a project with no declared importer grows no import files at all', async () => {
		const bare = structuredClone(cardstackExample.spec)
		bare.imports = undefined
		expect([...(await generateSeam(bare)).keys()]).toEqual([])
	})

	it('an importer whose declaration was enough grows no files either', async () => {
		// The honest headline: a CSV importer is a spec op with no code behind it,
		// so adding one leaves the emitted tree exactly as it was.
		const before = await generateSeam(corpusApp())
		expect(await generateSeam(withCsvImporter())).toEqual(before)
	})
})
