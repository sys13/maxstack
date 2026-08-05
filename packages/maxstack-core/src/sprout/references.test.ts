import { describe, expect, it, vi } from 'vitest'
import {
	inverseReferences,
	parseIdArray,
	resolveReferences,
} from './references.ts'
import type { Row } from './store.ts'
import type { SproutResource } from './types.ts'

const col = (over: Partial<SproutResource['columns'][number]>) => ({
	name: 'x',
	type: 'string' as const,
	nullable: true,
	hasDefault: false,
	isPrimaryKey: false,
	meta: {},
	...over,
})

const story: SproutResource = {
	name: 'story',
	primaryKey: 'id',
	relations: [],
	columns: [
		col({ name: 'id', type: 'uuid', isPrimaryKey: true }),
		col({ name: 'title' }),
		col({
			name: 'authorId',
			type: 'uuid',
			references: { table: 'author', column: 'id', displayField: 'name' },
		}),
	],
}

describe('resolveReferences', () => {
	it('batches FK ids per table into one getMany and maps id → display value', async () => {
		const rows: Row[] = [
			{ id: 's1', title: 'A', authorId: 'a1' },
			{ id: 's2', title: 'B', authorId: 'a2' },
			{ id: 's3', title: 'C', authorId: 'a1' }, // dup id
		]
		const getMany = vi.fn(async (_table: string, ids: string[]) =>
			ids.map((id) => ({ id, name: `Author ${id}` })),
		)

		const map = await resolveReferences(story, rows, { getMany })

		// One call for the `author` table, with the two distinct ids.
		expect(getMany).toHaveBeenCalledTimes(1)
		const [table, ids] = getMany.mock.calls[0] as [string, string[]]
		expect(table).toBe('author')
		expect([...ids].sort()).toEqual(['a1', 'a2'])
		expect(map).toEqual({
			author: { a1: 'Author a1', a2: 'Author a2' },
		})
	})

	it('skips empty FK values and falls back to the id when no display field', async () => {
		const noDisplay: SproutResource = {
			...story,
			columns: story.columns.map((c) =>
				c.name === 'authorId'
					? { ...c, references: { table: 'author', column: 'id' } }
					: c,
			),
		}
		const rows: Row[] = [
			{ id: 's1', authorId: 'a1' },
			{ id: 's2', authorId: null },
		]
		const getMany = vi.fn(async (_t: string, ids: string[]) =>
			ids.map((id) => ({ id })),
		)
		const map = await resolveReferences(noDisplay, rows, { getMany })
		expect(getMany).toHaveBeenCalledWith('author', ['a1'])
		expect(map.author?.a1).toBe('a1') // no displayField → id itself
	})

	it('resolves array-reference columns, merging their ids into the same table batch', async () => {
		// A post with a scalar `authorId` and a `tags` array both pointing at
		// tables — the array ids flatten into the shared per-table `getMany`.
		const post: SproutResource = {
			name: 'post',
			primaryKey: 'id',
			relations: [],
			columns: [
				col({ name: 'id', type: 'uuid', isPrimaryKey: true }),
				col({
					name: 'tags',
					type: 'json',
					meta: {
						arrayReference: {
							table: 'tag',
							column: 'id',
							displayField: 'name',
						},
					},
				}),
			],
		}
		const rows: Row[] = [
			{ id: 'p1', tags: ['t1', 't2'] },
			{ id: 'p2', tags: '["t2","t3"]' }, // JSON string form (crossed a wire)
			{ id: 'p3', tags: null },
		]
		const getMany = vi.fn(async (_table: string, ids: string[]) =>
			ids.map((id) => ({ id, name: `Tag ${id}` })),
		)

		const map = await resolveReferences(post, rows, { getMany })

		expect(getMany).toHaveBeenCalledTimes(1)
		const [table, ids] = getMany.mock.calls[0] as [string, string[]]
		expect(table).toBe('tag')
		expect([...ids].sort()).toEqual(['t1', 't2', 't3']) // deduped across rows
		expect(map.tag).toEqual({
			t1: 'Tag t1',
			t2: 'Tag t2',
			t3: 'Tag t3',
		})
	})

	it('does nothing for a resource with no reference columns', async () => {
		const plain: SproutResource = {
			name: 'tag',
			primaryKey: 'id',
			relations: [],
			columns: [col({ name: 'id', isPrimaryKey: true }), col({ name: 'name' })],
		}
		const getMany = vi.fn()
		const map = await resolveReferences(plain, [{ id: 't1' }], { getMany })
		expect(getMany).not.toHaveBeenCalled()
		expect(map).toEqual({})
	})
})

describe('parseIdArray', () => {
	it('accepts real arrays, JSON strings, and drops blanks', () => {
		expect(parseIdArray(['a', 'b'])).toEqual(['a', 'b'])
		expect(parseIdArray('["a","b"]')).toEqual(['a', 'b'])
		expect(parseIdArray(['a', null, '', undefined, 'b'])).toEqual(['a', 'b'])
		expect(parseIdArray([1, 2])).toEqual(['1', '2'])
	})
	it('yields [] for empty / non-array / unparseable values', () => {
		expect(parseIdArray(null)).toEqual([])
		expect(parseIdArray('')).toEqual([])
		expect(parseIdArray('not json')).toEqual([])
		expect(parseIdArray('{"a":1}')).toEqual([])
		expect(parseIdArray(42)).toEqual([])
	})
})

describe('inverseReferences', () => {
	const comment: SproutResource = {
		name: 'comment',
		primaryKey: 'id',
		relations: [],
		columns: [
			col({ name: 'id', type: 'uuid', isPrimaryKey: true }),
			col({ name: 'body' }),
			col({
				name: 'storyId',
				type: 'uuid',
				references: { table: 'story', column: 'id' },
			}),
			col({
				name: 'parentId',
				type: 'uuid',
				references: { table: 'comment', column: 'id' },
			}),
		],
	}
	const tag: SproutResource = {
		name: 'tag',
		primaryKey: 'id',
		relations: [],
		columns: [
			col({ name: 'id', type: 'uuid', isPrimaryKey: true }),
			col({
				name: 'storyIds',
				type: 'json',
				meta: { arrayReference: { table: 'story', column: 'id' } },
			}),
		],
	}

	it('finds every FK pointing at a table', () => {
		expect(inverseReferences([story, comment, tag], 'story')).toEqual([
			{ resource: 'comment', column: 'storyId', targetColumn: 'id' },
		])
	})

	it('includes self-references — a comment thread is a real inverse', () => {
		expect(inverseReferences([story, comment], 'comment')).toEqual([
			{ resource: 'comment', column: 'parentId', targetColumn: 'id' },
		])
	})

	it('ignores array references — their inverse is not an equality filter', () => {
		expect(inverseReferences([tag], 'story')).toEqual([])
	})

	it('yields nothing for a table nothing points at', () => {
		expect(inverseReferences([story, comment], 'nobody')).toEqual([])
	})
})
