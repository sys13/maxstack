import { describe, expect, it } from 'vitest'
import {
	emitImportParserStub,
	emitImportRegistry,
	generateImports,
	type ImporterDescriptor,
	importerFilePaths,
	importerModuleName,
} from './imports.ts'
import { createMemFs } from './memfs.ts'

const descriptor = (
	key: string,
	overrides: Partial<ImporterDescriptor> = {},
): ImporterDescriptor => ({
	key,
	description: `the ${key} importer`,
	format: 'custom',
	resource: 'card',
	parserSlot: key,
	...overrides,
})

describe('importer file paths', () => {
	it('turns a dotted key into a filesystem-safe module name', () => {
		expect(importerModuleName('anki.apkg')).toBe('anki-apkg')
		expect(importerFilePaths('anki.apkg').parserFile).toBe(
			'imports/anki-apkg.parse.ts',
		)
	})
})

describe('generateImports', () => {
	it('emits nothing when no importer is declared', async () => {
		const fs = createMemFs()
		await generateImports(fs, [])
		expect([...fs.snapshot().keys()]).toEqual([])
	})

	it('emits nothing for an importer whose declaration was enough', async () => {
		// The honest headline of the primitive, asserted rather than asserted in
		// prose: a CSV importer grows no code at all, not even an empty registry.
		// If this ever emits a stub, the "declaration IS the implementation" claim
		// has quietly stopped being true.
		const fs = createMemFs()
		await generateImports(fs, [
			descriptor('cards.csv', { format: 'csv', parserSlot: undefined }),
			descriptor('cards.ndjson', { format: 'ndjson', parserSlot: undefined }),
			descriptor('cards.json', { format: 'json', parserSlot: undefined }),
		])
		expect([...fs.snapshot().keys()]).toEqual([])
	})

	it('emits a framework registry and a user-owned parser stub per custom importer', async () => {
		const fs = createMemFs()
		const { results } = await generateImports(fs, [descriptor('anki.apkg')])
		const files = fs.snapshot()
		expect(files.has('imports/imports.generated.ts')).toBe(true)
		expect(files.has('imports/anki-apkg.parse.ts')).toBe(true)
		expect(results.map((r) => r.ownership)).toContain('user')
		expect(results.map((r) => r.ownership)).toContain('generated')
	})

	it('NEVER rewrites a filled parser, but does refresh the registry', async () => {
		const fs = createMemFs()
		await generateImports(fs, [descriptor('anki.apkg')])
		const mine =
			'// the apkg reader lives here\nexport default async function* () {}\n'
		await fs.write('imports/anki-apkg.parse.ts', mine)

		await generateImports(fs, [
			descriptor('anki.apkg'),
			descriptor('mnemo.zip'),
		])
		const files = fs.snapshot()
		expect(files.get('imports/anki-apkg.parse.ts')).toBe(mine)
		expect(files.get('imports/imports.generated.ts')).toContain("'mnemo.zip'")
	})

	it('is byte-stable: the same declarations emit the same registry', async () => {
		const one = emitImportRegistry([descriptor('b.zip'), descriptor('a.zip')])
		const two = emitImportRegistry([descriptor('a.zip'), descriptor('b.zip')])
		// Sorted, so declaration order cannot produce a spurious diff.
		expect(one).toBe(two)
	})

	it('leaves a built-in-format importer out of the registry entirely', async () => {
		const registry = emitImportRegistry([
			descriptor('anki.apkg'),
			descriptor('cards.csv', { format: 'csv', parserSlot: undefined }),
		])
		expect(registry).toContain("'anki.apkg'")
		expect(registry).not.toContain('cards.csv')
	})

	it('tells a parser author, in the stub, that there is nothing here to write with', () => {
		// The property that keeps the slot from becoming a bypass. A parser author
		// who believes they are writing an *importer* will otherwise try to do a
		// lookup or a write in here.
		const stub = emitImportParserStub(descriptor('anki.apkg'))
		expect(stub).toMatch(/Nothing you return skips a check/)
		expect(stub).toMatch(/no store, no registry, no user/)
		// And that it must stream, because the file is not bounded by maxRows.
		expect(stub).toMatch(/Stream, do not buffer/)
	})
})
