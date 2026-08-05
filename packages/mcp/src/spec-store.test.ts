import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	applyOp,
	newSpecSystem,
	type SpecOp,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	createFileSpecStore,
	parseSpecSystem,
	serializeSpecSystem,
} from './spec-store.ts'

const seed = (): SpecSystem => newSpecSystem(tasklyPRD)

const addEntity: SpecOp = {
	op: 'data.addEntity',
	args: {
		entity: {
			id: 'e-task',
			name: 'Task',
			fields: [
				{ id: 'fld-title', name: 'title', type: 'string', required: true },
			],
		},
	},
}

let dir: string
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'maxstack-spec-store-'))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

describe('createFileSpecStore (directory format)', () => {
	it('seeds a missing spec on first load, then reads it back', async () => {
		const specDir = join(dir, 'nested', 'spec')
		const store = createFileSpecStore(specDir, { seed })
		const first = await store.load()
		expect(first.product.meta.title).toBe(tasklyPRD.meta.title)
		expect(existsSync(join(specDir, 'meta.json'))).toBe(true)
		// the seed was persisted — a second store over the same dir needs no seed
		const reread = await createFileSpecStore(specDir).load()
		expect(reread.product.meta.title).toBe(tasklyPRD.meta.title)
	})

	it('round-trips an applied op durably (save → fresh load)', async () => {
		const specDir = join(dir, 'spec')
		const store = createFileSpecStore(specDir, { seed })
		const next = applyOp(await store.load(), addEntity, {
			actor: { surface: 'harness' },
			id: 'op-1',
			origin: 'human',
			appliedAt: '2026-07-14',
		})
		await store.save(next)
		// a completely fresh store (new process, conceptually) sees the op
		const loaded = await createFileSpecStore(specDir).load()
		expect(loaded.data.entities.map((e) => e.id)).toEqual(['e-task'])
		expect(loaded.opLog).toHaveLength(1)
		expect(loaded.opLog[0]?.diff.targetId).toBe('e-task')
	})

	it('tolerates a missing theme.json (pre-#127 dir) and persists a set theme', async () => {
		const specDir = join(dir, 'spec')
		const store = createFileSpecStore(specDir, { seed })
		// a freshly seeded (pre-theme) directory has no theme.json and loads fine
		const first = await store.load()
		expect(existsSync(join(specDir, 'theme.json'))).toBe(false)
		expect(first.theme).toBeUndefined()
		// a theme.set lands the file and survives a fresh load
		await store.save(
			applyOp(
				first,
				{
					op: 'theme.set',
					args: { theme: { preset: 'forest', radius: 'lg' } },
				},
				{
					actor: { surface: 'harness' },
					id: 'op-t',
					origin: 'ai',
					appliedAt: '2026-07-23',
				},
			),
		)
		expect(existsSync(join(specDir, 'theme.json'))).toBe(true)
		const loaded = await createFileSpecStore(specDir).load()
		expect(loaded.theme).toEqual({ preset: 'forest', radius: 'lg' })
	})

	it('tolerates a missing flags.json (pre-#187 dir) and persists declared flags', async () => {
		// The regression this pins is nastier than "a file is missing": a required
		// file's ENOENT escapes readSpecDir as the "not a spec directory" signal,
		// so `load` falls through to the legacy single-file migration and a real
		// project reads as having no spec at all. Found by pointing the dev server
		// at an existing dogfood project, not by any unit test.
		const specDir = join(dir, 'spec')
		const store = createFileSpecStore(specDir, { seed })
		const first = await store.load()
		expect(existsSync(join(specDir, 'flags.json'))).toBe(false)
		expect(first.flags).toBeUndefined()

		// A second load of the untouched project must not materialize the file —
		// absence is the format's "no flags", and an empty file is not that.
		await createFileSpecStore(specDir).load()
		expect(existsSync(join(specDir, 'flags.json'))).toBe(false)

		await store.save(
			applyOp(
				first,
				{
					op: 'flags.declare',
					args: {
						flag: {
							id: 'flg-checkout-v2',
							key: 'checkout-v2',
							description: 'The rebuilt checkout flow.',
							default: false,
						},
					},
				},
				{
					actor: { surface: 'harness' },
					id: 'op-f',
					origin: 'human',
					appliedAt: '2026-07-27',
				},
			),
		)
		expect(existsSync(join(specDir, 'flags.json'))).toBe(true)
		const loaded = await createFileSpecStore(specDir).load()
		expect(loaded.flags?.flags.map((f) => f.key)).toEqual(['checkout-v2'])
	})

	it('throws on a missing spec with no seed', async () => {
		const store = createFileSpecStore(join(dir, 'absent'))
		await expect(store.load()).rejects.toThrow(/not found.*no seed/)
	})

	it('splits the spec into per-layer files and compacts provenance', async () => {
		const specDir = join(dir, 'spec')
		const store = createFileSpecStore(specDir, { seed })
		// origin human → manual() default, which the codec omits entirely
		await store.save(
			applyOp(await store.load(), addEntity, {
				actor: { surface: 'harness' },
				id: 'op-1',
				origin: 'human',
				appliedAt: '2026-07-14',
			}),
		)
		const data = await readFile(join(specDir, 'data.json'), 'utf8')
		// the entity is present …
		expect(data).toContain('"e-task"')
		// … but the manual provenance boilerplate is gone
		expect(data).not.toContain('isAddedManually')
		expect(data).not.toContain('"provenance"')
		// and the op log is its own append-friendly file
		expect(existsSync(join(specDir, 'oplog.jsonl'))).toBe(true)
	})

	it('migrates a legacy single-file spec.json to the directory on first load', async () => {
		const specDir = join(dir, 'spec')
		const legacy = `${specDir}.json`
		const withOp = applyOp(seed(), addEntity, {
			actor: { surface: 'harness' },
			id: 'op-1',
			origin: 'human',
			appliedAt: '2026-07-14',
		})
		await writeFile(legacy, serializeSpecSystem(withOp))

		const loaded = await createFileSpecStore(specDir).load()
		expect(loaded.data.entities.map((e) => e.id)).toEqual(['e-task'])
		// the directory now exists and the legacy file is gone
		expect(existsSync(join(specDir, 'meta.json'))).toBe(true)
		expect(existsSync(legacy)).toBe(false)
	})

	it('refuses to load a spec that fails validation', async () => {
		const broken = seed()
		broken.pages.pages.push({
			id: 'pg-orphan',
			name: 'Orphan',
			route: '/x',
			entityId: 'e-ghost',
			blocks: [],
			provenance: {
				isSuggested: true,
				isAccepted: null,
				isAddedManually: false,
				suggestedDescription: null,
				priority: 'medium',
			},
		})
		expect(() => parseSpecSystem(JSON.stringify(broken))).toThrow(
			/unknown entity "e-ghost"/,
		)
	})

	it('writes tab-indented JSON with a trailing newline (diff-friendly)', async () => {
		const specDir = join(dir, 'spec')
		await createFileSpecStore(specDir, { seed }).load()
		const raw = await readFile(join(specDir, 'data.json'), 'utf8')
		expect(raw.endsWith('}\n')).toBe(true)
		expect(raw).toContain('\n\t"entities"')
	})
})
