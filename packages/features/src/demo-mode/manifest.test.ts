import { describe, expect, it } from 'vitest'
import {
	DEMO_MANIFEST_FILENAME,
	emptyManifest,
	type ManifestFs,
	manifestRowCount,
	mergeManifest,
	readDemoManifest,
	removeDemoManifest,
	writeDemoManifest,
} from './manifest.ts'

/** An in-memory `ManifestFs` — the module's whole filesystem surface. */
function memoryFs(seed: Record<string, string> = {}) {
	const files = new Map(Object.entries(seed))
	const fs: ManifestFs = {
		readFile: async (path) => {
			const hit = files.get(path)
			if (hit === undefined) {
				const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
				err.code = 'ENOENT'
				throw err
			}
			return hit
		},
		writeFile: async (path, data) => {
			files.set(path, data)
		},
		rm: async (path) => {
			files.delete(path)
		},
	}
	return { fs, files }
}

const DIR = '/project/.maxstack'
const PATH = `${DIR}/${DEMO_MANIFEST_FILENAME}`

describe('readDemoManifest', () => {
	it('reports nothing seeded when the file is missing', async () => {
		const { fs } = memoryFs()
		expect(await readDemoManifest(DIR, fs)).toEqual(emptyManifest())
	})

	it('reports nothing seeded when the file is corrupt', async () => {
		const { fs } = memoryFs({ [PATH]: '{ not json' })
		expect(manifestRowCount(await readDemoManifest(DIR, fs))).toBe(0)
	})

	it('reports nothing seeded on an unknown future version', async () => {
		const { fs } = memoryFs({
			[PATH]: JSON.stringify({ version: 2, rows: { task: ['a'] } }),
		})
		expect(manifestRowCount(await readDemoManifest(DIR, fs))).toBe(0)
	})

	it('drops non-string ids a hand-edit could introduce', async () => {
		const { fs } = memoryFs({
			[PATH]: JSON.stringify({
				version: 1,
				seededAt: 'x',
				rows: { task: ['a', 42, null, 'b'], bad: 'not-an-array' },
			}),
		})
		const manifest = await readDemoManifest(DIR, fs)
		expect(manifest.rows).toEqual({ task: ['a', 'b'] })
	})

	it('round-trips what it wrote', async () => {
		const { fs } = memoryFs()
		const manifest = mergeManifest(emptyManifest(), { task: ['a', 'b'] }, 'now')
		await writeDemoManifest(DIR, manifest, fs)
		expect(await readDemoManifest(DIR, fs)).toEqual(manifest)
	})
})

describe('mergeManifest', () => {
	it('extends a previous seed rather than replacing it', async () => {
		const first = mergeManifest(emptyManifest(), { task: ['a'] }, 't1')
		const second = mergeManifest(first, { task: ['b'], note: ['c'] }, 't2')
		expect(second.rows).toEqual({ task: ['a', 'b'], note: ['c'] })
		expect(second.seededAt).toBe('t2')
	})

	it('dedupes without reordering', () => {
		const first = mergeManifest(emptyManifest(), { task: ['a', 'b'] }, 't1')
		const second = mergeManifest(first, { task: ['b', 'c'] }, 't2')
		expect(second.rows.task).toEqual(['a', 'b', 'c'])
	})

	it('ignores resources that contributed no rows', () => {
		const merged = mergeManifest(emptyManifest(), { task: [] }, 't1')
		expect(merged.rows).toEqual({})
		expect(manifestRowCount(merged)).toBe(0)
	})
})

describe('removeDemoManifest', () => {
	it('leaves the project with no tracked demo rows', async () => {
		const { fs, files } = memoryFs()
		await writeDemoManifest(
			DIR,
			mergeManifest(emptyManifest(), { task: ['a'] }, 't'),
			fs,
		)
		await removeDemoManifest(DIR, fs)
		expect(files.has(PATH)).toBe(false)
		expect(manifestRowCount(await readDemoManifest(DIR, fs))).toBe(0)
	})

	it('is a no-op when there is nothing to remove', async () => {
		const { fs } = memoryFs()
		await expect(removeDemoManifest(DIR, fs)).resolves.toBeUndefined()
	})
})
