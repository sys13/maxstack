import { describe, expect, it } from 'vitest'
import {
	emitLiveComponentStub,
	emitLiveRegistry,
	generateLive,
	type LiveDescriptor,
	liveFilePaths,
	liveModuleName,
} from './live.ts'
import { createMemFs } from './memfs.ts'

const descriptor = (
	key: string,
	overrides: Partial<LiveDescriptor> = {},
): LiveDescriptor => ({
	key,
	description: `the ${key} channel`,
	kind: 'query',
	resource: 'task',
	bound: 'rows matching project',
	fields: ['title', 'status'],
	slot: true,
	...overrides,
})

describe('live file paths', () => {
	it('turns a dotted key into a filesystem-safe module name', () => {
		expect(liveModuleName('task.board')).toBe('task-board')
		expect(liveFilePaths('task.board').componentFile).toBe(
			'live/task-board.live.tsx',
		)
	})
})

describe('generateLive', () => {
	it('emits nothing when no channel is declared', async () => {
		const fs = createMemFs()
		await generateLive(fs, [])
		expect([...fs.snapshot().keys()]).toEqual([])
	})

	it('emits nothing for a channel whose declaration was enough', async () => {
		// The honest headline of the primitive, asserted rather than claimed in
		// prose: a derived list, board or calendar over a declared channel simply
		// updates and grows no code at all — not even an empty registry. If this
		// ever emits a stub, "the declaration IS the implementation" has quietly
		// stopped being true.
		const fs = createMemFs()
		await generateLive(fs, [
			descriptor('task-board', { slot: false }),
			descriptor('task-viewers', { slot: false, kind: 'presence', fields: [] }),
		])
		expect([...fs.snapshot().keys()]).toEqual([])
	})

	it('emits a framework registry and a user-owned surface per slotted channel', async () => {
		const fs = createMemFs()
		const { results } = await generateLive(fs, [descriptor('task-board')])
		const files = fs.snapshot()
		expect(files.has('live/live.generated.ts')).toBe(true)
		expect(files.has('live/task-board.live.tsx')).toBe(true)
		expect(results.map((r) => r.ownership)).toContain('user')
		expect(results.map((r) => r.ownership)).toContain('generated')
	})

	it('NEVER rewrites a filled surface, but does refresh the registry', async () => {
		const fs = createMemFs()
		await generateLive(fs, [descriptor('task-board')])
		const mine =
			'// the drag-and-drop board lives here\nexport default () => null\n'
		await fs.write('live/task-board.live.tsx', mine)

		await generateLive(fs, [
			descriptor('task-board'),
			descriptor('thread-reader'),
		])
		const files = fs.snapshot()
		expect(files.get('live/task-board.live.tsx')).toBe(mine)
		expect(files.get('live/live.generated.ts')).toContain("'thread-reader'")
	})

	it('is byte-stable: the same declarations emit the same registry', () => {
		const one = emitLiveRegistry([descriptor('b-board'), descriptor('a-board')])
		const two = emitLiveRegistry([descriptor('a-board'), descriptor('b-board')])
		// Sorted, so declaration order cannot produce a spurious diff.
		expect(one).toBe(two)
	})

	it('leaves an unslotted channel out of the registry entirely', () => {
		const registry = emitLiveRegistry([
			descriptor('task-board'),
			descriptor('quiet', { slot: false }),
		])
		expect(registry).toContain("'task-board'")
		expect(registry).not.toContain('quiet')
	})

	it('tells a surface author, in the stub, that filtering here would be a second weaker gate', () => {
		// The property that keeps the slot from becoming a bypass. An author who
		// believes they are writing a *page* will otherwise reach for a filter.
		const stub = emitLiveComponentStub(descriptor('task-board'))
		expect(stub).toMatch(/already loaded, gated and projected/)
		expect(stub).toMatch(/second, weaker copy of a rule/)
	})

	it('tells a surface author there is nowhere to put a cursor, and why', () => {
		// The scope line, delivered where somebody will actually go looking for it.
		const stub = emitLiveComponentStub(descriptor('task-board'))
		expect(stub).toMatch(/no cursor, no selection, no/)
		expect(stub).toMatch(/d-live-last-write-wins/)
	})

	it('warns that the connection can drop and the surface must still be right', () => {
		const stub = emitLiveComponentStub(descriptor('task-board'))
		expect(stub).toMatch(/falls back to polling/)
		expect(stub).toMatch(/Render the state, not the/)
	})

	it('emits nothing that varies from run to run', () => {
		// No clock, no connection id, no random source. A generated file carrying
		// any of those turns every regeneration into a diff to review.
		const stub = emitLiveComponentStub(descriptor('task-board'))
		expect(emitLiveComponentStub(descriptor('task-board'))).toBe(stub)
		expect(stub).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
	})
})
