import type { SproutColumn } from '@maxstack/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	buildPrompt,
	coerce,
	coerceReference,
	MAX_REFERENCE_OPTIONS,
	parseableColumns,
	parseEntityFields,
	recoverObject,
	referenceColumns,
} from './entity-parse.server'

function col(
	name: string,
	type: SproutColumn['type'],
	extra: Partial<SproutColumn> = {},
): SproutColumn {
	return {
		name,
		type,
		nullable: true,
		hasDefault: false,
		isPrimaryKey: false,
		meta: {},
		...extra,
	}
}

describe('parseableColumns', () => {
	it('keeps plain data columns and drops PK/FK/file/json/hidden/readOnly/uuid', () => {
		const columns = [
			col('id', 'uuid', { isPrimaryKey: true }),
			col('name', 'string'),
			col('age', 'number'),
			col('ownerId', 'uuid', {
				references: { table: 'user', column: 'id' },
			}),
			col('avatar', 'string', { meta: { isFile: true } }),
			col('internal', 'string', { meta: { hidden: true } }),
			col('createdBy', 'string', { meta: { readOnly: true } }),
			col('payload', 'json'),
		]
		const kept = parseableColumns({ primaryKey: 'id', columns })
		expect(kept.map((c) => c.name)).toEqual(['name', 'age'])
	})
})

describe('buildPrompt', () => {
	it('lists each column with its constraints (enum options, date format)', () => {
		const prompt = buildPrompt(
			'Contacts',
			[
				col('relationship', 'enum', { enumValues: ['friend', 'family'] }),
				col('birthday', 'date'),
			],
			'my friend Ada',
		)
		expect(prompt).toContain('- relationship (enum; one of: friend | family)')
		expect(prompt).toContain('- birthday (date; format YYYY-MM-DD)')
		expect(prompt).toContain('my friend Ada')
	})
})

describe('recoverObject', () => {
	it('parses a bare JSON object', () => {
		expect(recoverObject('{"a": 1}')).toEqual({ a: 1 })
	})

	it('recovers the object out of a chatty / fenced reply', () => {
		const raw = 'Sure! Here you go:\n```json\n{"a": 1}\n```\nAnything else?'
		expect(recoverObject(raw)).toEqual({ a: 1 })
	})

	it('returns null for prose and for non-object JSON', () => {
		expect(recoverObject('no json here')).toBeNull()
		expect(recoverObject('[1, 2]')).toBeNull()
	})
})

describe('coerce', () => {
	it('trims strings and drops empties', () => {
		const c = col('name', 'string')
		expect(coerce(c, '  Ada  ')).toBe('Ada')
		expect(coerce(c, '   ')).toBeUndefined()
		expect(coerce(c, 42)).toBeUndefined()
	})

	it('accepts numbers and numeric strings, drops the rest', () => {
		const c = col('age', 'number')
		expect(coerce(c, 7)).toBe(7)
		expect(coerce(c, '7.5')).toBe(7.5)
		expect(coerce(c, 'seven')).toBeUndefined()
	})

	it('accepts booleans and their string forms only', () => {
		const c = col('done', 'boolean')
		expect(coerce(c, true)).toBe(true)
		expect(coerce(c, 'false')).toBe(false)
		expect(coerce(c, 'yes')).toBeUndefined()
	})

	it('passes YYYY-MM-DD through and normalizes other parseable dates to it', () => {
		const c = col('birthday', 'date')
		expect(coerce(c, '1990-03-14')).toBe('1990-03-14')
		expect(coerce(c, 'March 14 1990')).toBe('1990-03-14')
		expect(coerce(c, 'someday')).toBeUndefined()
	})

	it('matches enum options case-insensitively, returning the canonical value', () => {
		const c = col('relationship', 'enum', { enumValues: ['Friend', 'Family'] })
		expect(coerce(c, 'friend')).toBe('Friend')
		expect(coerce(c, 'colleague')).toBeUndefined()
	})

	it('drops null/undefined for every type', () => {
		expect(coerce(col('name', 'string'), null)).toBeUndefined()
		expect(coerce(col('age', 'number'), undefined)).toBeUndefined()
	})
})

describe('parseEntityFields (the whole pipeline over the AI port)', () => {
	beforeEach(() => {
		delete process.env.MOCK_AI
		delete process.env.ANTHROPIC_API_KEY
		delete process.env.OPENAI_API_KEY
	})

	const introspection = {
		primaryKey: 'id',
		columns: [
			col('id', 'uuid', { isPrimaryKey: true }),
			col('name', 'string'),
			col('relationship', 'enum', { enumValues: ['friend', 'family'] }),
			col('interests', 'string'),
			col('age', 'number'),
		],
	}

	it('extracts typed fields keylessly under MOCK_AI, never inventing unsupported ones', async () => {
		process.env.MOCK_AI = '1'
		const result = await parseEntityFields({
			resource: 'contact',
			pageName: 'Contacts',
			introspection,
			text: 'my friend Sam',
		})
		// The canned parse-entity reply names/relates/interests a fixed person…
		expect(result).toEqual({
			fields: {
				name: 'Sam Mocksworth',
				relationship: 'friend',
				interests: 'canned MOCK_AI output',
			},
		})
	})

	it('drops reply keys the target entity does not have', async () => {
		process.env.MOCK_AI = '1'
		const result = await parseEntityFields({
			resource: 'invoice',
			pageName: 'Invoices',
			introspection: {
				primaryKey: 'id',
				columns: [
					col('id', 'uuid', { isPrimaryKey: true }),
					col('total', 'number'),
				],
			},
			text: 'an invoice',
		})
		expect(result).toEqual({ fields: {} })
	})

	it('degrades to ai-unavailable (not a throw) when no AI is configured', async () => {
		const result = await parseEntityFields({
			resource: 'contact',
			pageName: 'Contacts',
			introspection,
			text: 'my friend Sam',
		})
		expect(result).toMatchObject({ error: 'ai-unavailable' })
	})
})

describe('referenceColumns', () => {
	const resource = {
		primaryKey: 'id',
		columns: [
			col('id', 'uuid', { isPrimaryKey: true }),
			col('ownerId', 'uuid', { references: { table: 'user', column: 'id' } }),
			col('teamId', 'uuid', { references: { table: 'team', column: 'id' } }),
			col('tags', 'string', {
				references: { table: 'tag', column: 'id' },
				meta: { arrayReference: { table: 'tag', column: 'id' } },
			}),
			col('name', 'string'),
		],
	} as unknown as { primaryKey: string; columns: SproutColumn[] }

	it('offers only FK columns that actually have choices to pick from', () => {
		const picked = referenceColumns(resource, {
			ownerId: [{ label: 'Dana', value: 'u1' }],
			teamId: [],
		})
		// teamId has no rows to match against, so anything returned for it would be
		// invented; tags is an array reference, which one label cannot express.
		expect(picked.map((p) => p.column.name)).toEqual(['ownerId'])
	})

	it('drops a field with more options than the prompt budget', () => {
		const many = Array.from({ length: MAX_REFERENCE_OPTIONS + 1 }, (_, i) => ({
			label: `Person ${i}`,
			value: `u${i}`,
		}))
		expect(referenceColumns(resource, { ownerId: many })).toEqual([])
		expect(
			referenceColumns(resource, { ownerId: many.slice(0, -1) }),
		).toHaveLength(1)
	})

	it('puts the labels, not the ids, in the prompt', () => {
		const picked = referenceColumns(resource, {
			ownerId: [{ label: 'Dana Scully', value: 'u-9f3a' }],
		})
		const prompt = buildPrompt('Task', [], 'assigned to Dana', picked)
		expect(prompt).toContain('Dana Scully')
		expect(prompt).not.toContain('u-9f3a')
	})
})

describe('coerceReference', () => {
	const choices = [
		{ label: 'Dana Scully', value: 'u-1' },
		{ label: 'Fox Mulder', value: 'u-2' },
	]

	it('resolves the label the model was shown back to the id the form posts', () => {
		expect(coerceReference(choices, 'Fox Mulder')).toBe('u-2')
		expect(coerceReference(choices, '  dana scully ')).toBe('u-1')
	})

	it('accepts a raw id, since a description may quote one', () => {
		expect(coerceReference(choices, 'u-2')).toBe('u-2')
	})

	it('drops a near miss rather than guessing', () => {
		// The whole risk of this feature: silently attaching the record to the
		// wrong row is worse than leaving the picker empty.
		expect(coerceReference(choices, 'Dana')).toBeUndefined()
		expect(coerceReference(choices, 'Scully, Dana')).toBeUndefined()
		expect(coerceReference(choices, '')).toBeUndefined()
		expect(coerceReference(choices, null)).toBeUndefined()
		expect(coerceReference([], 'Dana Scully')).toBeUndefined()
	})
})
