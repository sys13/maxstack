/**
 * Block-slot id derivation.
 *
 * The load-bearing property under test is **stability**: a slot id is a public
 * API the moment a maintainer writes into it, so these tests assert that the id
 * is a function of spec identity alone and that nothing about *how* a page was
 * assembled can move it.
 */

import { describe, expect, it } from 'vitest'
import {
	BLOCK_SLOT_ROLES,
	BLOCK_SLOT_ROLES_VERSION,
	blockSlotId,
	blockSlotPropsImport,
	blockSlotsForResource,
	emitBlockSlotStub,
	isBlockSlotId,
	parseBlockSlotId,
} from './block-slots.ts'
import { exportedSlotNames } from './emit.ts'
import { fillBlockSlot } from './generate.ts'
import { emptyManifest, upsertEntry } from './manifest.ts'
import { createMemFs } from './memfs.ts'
import { renderOwnedManifest } from './owned-codegen.ts'

describe('blockSlotId', () => {
	it('derives from entity + role, not from block order or id', () => {
		expect(blockSlotId({ resource: 'exercise', role: 'row' })).toBe(
			'exercise__row',
		)
		expect(
			blockSlotId({ resource: 'task', role: 'field', field: 'dueDate' }),
		).toBe('task__field__dueDate')
	})

	it('is a legal JS identifier for kebab-case resources', () => {
		const id = blockSlotId({ resource: 'reading-item', role: 'list' })
		expect(id).toBe('reading_ditem__list')
		expect(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)).toBe(true)
	})

	it('refuses a parameterized role with no field, and vice versa', () => {
		expect(() => blockSlotId({ resource: 'task', role: 'field' })).toThrow(
			/requires a field name/,
		)
		expect(() =>
			blockSlotId({ resource: 'task', role: 'row', field: 'title' }),
		).toThrow(/takes no field name/)
	})

	/**
	 * The injectivity property. A lossy `-` → `_` fold would collide these two,
	 * and a collision means one exported function silently serves two resources —
	 * different apps, same id, different meaning.
	 */
	it('never maps two distinct resources onto one id', () => {
		const names = ['read-item', 'read_item', 'read_ditem', 'read.item', 'x']
		const ids = names.map((resource) => blockSlotId({ resource, role: 'row' }))
		expect(new Set(ids).size).toBe(ids.length)
	})
})

describe('parseBlockSlotId', () => {
	it('round-trips every role', () => {
		for (const def of BLOCK_SLOT_ROLES) {
			const ref = def.parameterized
				? { resource: 'reading-item', role: def.role, field: 'coverImage' }
				: { resource: 'reading-item', role: def.role }
			expect(parseBlockSlotId(blockSlotId(ref))).toEqual(ref)
		}
	})

	it('rejects names that are not block slots', () => {
		// A page-level `slot:<name>` fill lives in the same file and must not be
		// mistaken for a block slot (nor the reverse).
		for (const name of [
			'streakBadge',
			'todoFilters',
			'task',
			'task__notARole',
			'task__row__extra',
			'task__field',
			'__row',
		]) {
			expect(isBlockSlotId(name), name).toBe(false)
		}
	})
})

describe('blockSlotsForResource', () => {
	it('offers every unparameterized role plus one slot per rendered field', () => {
		const slots = blockSlotsForResource('exercise', ['name', 'muscleGroup'])
		expect(slots.map((s) => s.id)).toEqual([
			'exercise__header',
			'exercise__list',
			'exercise__row',
			'exercise__field__name',
			'exercise__field__muscleGroup',
			'exercise__empty',
		])
	})

	it('offers no field slots when the page renders no fields', () => {
		const slots = blockSlotsForResource('exercise')
		expect(slots.every((s) => s.role !== 'field')).toBe(true)
	})

	/**
	 * Adding a field must not move an existing slot. This is the regeneration
	 * invariant at block granularity: yesterday's filled `exercise__row` is still
	 * `exercise__row` after the entity grows.
	 */
	it('keeps existing ids fixed when fields are added or reordered', () => {
		const before = blockSlotsForResource('exercise', ['name', 'muscleGroup'])
		const after = blockSlotsForResource('exercise', [
			'muscleGroup',
			'videoUrl',
			'name',
		])
		const ids = new Set(after.map((s) => s.id))
		for (const slot of before) {
			if (slot.field === 'muscleGroup' || slot.role !== 'field')
				expect(ids.has(slot.id), slot.id).toBe(true)
		}
	})
})

describe('emitBlockSlotStub', () => {
	it('emits an export the slot reader recognizes, typed on its props', () => {
		const [row] = blockSlotsForResource('exercise').filter(
			(s) => s.role === 'row',
		)
		if (!row) throw new Error('no row slot')
		const stub = emitBlockSlotStub(row)
		expect(stub).toContain('export function exercise__row(props: RowSlotProps)')
		// The same AST reader the dangling-slot gate uses must see it as filled.
		expect(exportedSlotNames(stub)).toContain('exercise__row')
	})

	it('imports exactly the props types it references, deduplicated', () => {
		const slots = blockSlotsForResource('exercise', ['name', 'muscleGroup'])
		expect(blockSlotPropsImport(slots)).toBe(
			"import type { EmptySlotProps, FieldSlotProps, HeaderSlotProps, ListSlotProps, RowSlotProps } from '@maxstack/ui'",
		)
	})
})

describe('fillBlockSlot', () => {
	const rowSlot = () => {
		const slot = blockSlotsForResource('exercise').find((s) => s.role === 'row')
		if (!slot) throw new Error('no row slot')
		return slot
	}

	it('creates the slot file with a typed stub and its props import', async () => {
		const fs = createMemFs()
		const res = await fillBlockSlot(fs, emptyManifest(), 'exercise', rowSlot())
		const source = await fs.read('routes/exercise.slots.tsx')
		expect(res.added).toBe(true)
		expect(source).toContain("import type { RowSlotProps } from '@maxstack/ui'")
		expect(exportedSlotNames(source)).toEqual(['exercise__row'])
	})

	it('appends without touching what is already there', async () => {
		const fs = createMemFs()
		const existing = 'export function coachNotes() {\n\treturn null\n}\n'
		await fs.write('routes/exercise.slots.tsx', existing)
		await fillBlockSlot(fs, emptyManifest(), 'exercise', rowSlot())
		const source = await fs.read('routes/exercise.slots.tsx')
		expect(source).toContain(existing)
		expect(exportedSlotNames(source).sort()).toEqual([
			'coachNotes',
			'exercise__row',
		])
	})

	it('is a no-op on a slot that is already implemented', async () => {
		const fs = createMemFs()
		const mine = 'export function exercise__row() {\n\treturn <p>mine</p>\n}\n'
		await fs.write('routes/exercise.slots.tsx', mine)
		const res = await fillBlockSlot(fs, emptyManifest(), 'exercise', rowSlot())
		expect(res.added).toBe(false)
		expect(await fs.read('routes/exercise.slots.tsx')).toBe(mine)
	})

	/**
	 * The registration that decides whether a filled slot *executes*.
	 * `renderOwnedManifest` builds `OWNED_SLOTS` from route entries carrying a
	 * `slotFile`, so without it the code lands on disk, `maxstack slots` reports
	 * the slot filled, and the app renders the generated block anyway — the one
	 * failure mode a seam whose whole promise is "safe to write into" cannot have.
	 */
	it('points the route entry at the slot file, so the app imports it', async () => {
		const fs = createMemFs()
		const manifest = upsertEntry(emptyManifest(), {
			id: 'exercise',
			routePath: '/exercise',
			file: 'routes/exercise.tsx',
			ownership: 'generated',
		})
		const res = await fillBlockSlot(fs, manifest, 'exercise', rowSlot())
		const route = res.manifest.entries.find((e) => e.id === 'exercise')
		expect(route?.slotFile).toBe('routes/exercise.slots.tsx')
		expect(renderOwnedManifest(res.manifest)).toContain('"exercise": slots_')
	})

	/** Writing the export by hand is a documented path, so the repair has to
	 * work on a file the command did not create. */
	it('registers a hand-written slot file it did not have to write', async () => {
		const fs = createMemFs()
		await fs.write(
			'routes/exercise.slots.tsx',
			'export function exercise__row() {\n\treturn null\n}\n',
		)
		const manifest = upsertEntry(emptyManifest(), {
			id: 'exercise',
			routePath: '/exercise',
			file: 'routes/exercise.tsx',
			ownership: 'generated',
		})
		const res = await fillBlockSlot(fs, manifest, 'exercise', rowSlot())
		expect(res.added).toBe(false)
		expect(
			res.manifest.entries.find((e) => e.id === 'exercise')?.slotFile,
		).toBe('routes/exercise.slots.tsx')
	})
})

describe('the role registry', () => {
	/**
	 * Slot proliferation is the declared risk. The version is what makes growing
	 * this list a visible event rather than a quiet one, so it is pinned to the
	 * shape it describes: a role added without a bump fails here.
	 */
	it('is versioned against the roles it publishes', () => {
		expect(BLOCK_SLOT_ROLES_VERSION).toBe(1)
		expect(BLOCK_SLOT_ROLES.map((r) => r.role)).toEqual([
			'header',
			'list',
			'row',
			'field',
			'empty',
		])
	})
})
