import { describe, expect, it } from 'vitest'
import { createMemFs } from './memfs.ts'
import {
	emitSourceRefinerStub,
	emitSourceRegistry,
	generateSources,
	type SourceDescriptor,
	sourceFilePaths,
	sourceModuleName,
} from './sources.ts'

const descriptor = (
	key: string,
	overrides: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
	key,
	description: `the ${key} integration`,
	mode: 'sync',
	endpoint: 'https://api.example.com',
	refine: true,
	...overrides,
})

describe('source file paths', () => {
	it('turns a dotted key into a filesystem-safe module name', () => {
		expect(sourceModuleName('inbox.sync')).toBe('inbox-sync')
		expect(sourceFilePaths('inbox.sync').refinerFile).toBe(
			'sources/inbox-sync.refine.ts',
		)
	})
})

describe('generateSources', () => {
	it('emits nothing when no source is declared', async () => {
		const fs = createMemFs()
		await generateSources(fs, [])
		expect([...fs.snapshot().keys()]).toEqual([])
	})

	it('emits nothing for a source whose declaration was enough', async () => {
		// This is the honest headline of the primitive, so it gets an assertion
		// rather than a sentence in a doc: an integration that maps cleanly grows
		// no code, not even an empty registry.
		const fs = createMemFs()
		await generateSources(fs, [descriptor('isbn.lookup', { refine: false })])
		expect([...fs.snapshot().keys()]).toEqual([])
	})

	it('emits a framework registry and a user-owned refiner stub per refining source', async () => {
		const fs = createMemFs()
		const { results } = await generateSources(fs, [descriptor('inbox.sync')])
		const files = fs.snapshot()
		expect(files.has('sources/sources.generated.ts')).toBe(true)
		expect(files.has('sources/inbox-sync.refine.ts')).toBe(true)
		expect(results.map((r) => r.ownership)).toContain('user')
		expect(results.map((r) => r.ownership)).toContain('generated')
	})

	it('NEVER rewrites a filled refiner, but does refresh the registry', async () => {
		const fs = createMemFs()
		await generateSources(fs, [descriptor('inbox.sync')])
		const mine = '// contact threading lives here\nexport default () => ({})\n'
		await fs.write('sources/inbox-sync.refine.ts', mine)

		await generateSources(fs, [
			descriptor('inbox.sync'),
			descriptor('crm.contacts'),
		])
		const files = fs.snapshot()
		expect(files.get('sources/inbox-sync.refine.ts')).toBe(mine)
		expect(files.get('sources/sources.generated.ts')).toContain(
			"'crm.contacts'",
		)
	})

	it('is byte-stable: the same declarations emit the same registry', async () => {
		const one = emitSourceRegistry([descriptor('b.sync'), descriptor('a.sync')])
		const two = emitSourceRegistry([descriptor('a.sync'), descriptor('b.sync')])
		// Sorted, so declaration order cannot produce a spurious diff.
		expect(one).toBe(two)
	})

	it('leaves a non-refining source out of the registry entirely', async () => {
		const registry = emitSourceRegistry([
			descriptor('inbox.sync'),
			descriptor('isbn.lookup', { refine: false }),
		])
		expect(registry).toContain("'inbox.sync'")
		expect(registry).not.toContain('isbn.lookup')
	})

	it('states the two properties a maintainer would otherwise learn the hard way', () => {
		const stub = emitSourceRefinerStub(descriptor('inbox.sync'))
		// The return value is re-typed — this is an extension point, not a bypass.
		expect(stub).toMatch(/re-typed against the entity/)
		// Delivery through the queue is at-least-once, same as a schedule handler.
		expect(stub).toMatch(/at-least-once/)
	})

	it('never renders a credential into the stub, because it never has one', () => {
		const stub = emitSourceRefinerStub(
			descriptor('inbox.sync', { endpoint: 'https://api.example.com' }),
		)
		expect(stub).toContain('https://api.example.com')
		expect(stub).not.toMatch(/secret|token|api[-_ ]?key/i)
	})
})
