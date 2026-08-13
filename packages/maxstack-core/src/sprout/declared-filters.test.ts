/**
 * Issue #414 — what a declared filter control means on the surfaces a person
 * does not look at.
 *
 * The page-side half is tested in `@maxstack/ui`, where the derivation lives.
 * The property this file is about is the other one: `data.setFieldFilter` is a
 * declaration, and a declaration honoured by the filter bar and ignored by the
 * collection API is a sentence the author reads back and believes. So `opList`,
 * `opCount` and `query_records` — every door a caller-supplied predicate comes
 * through — refuse what the spec said this column does not offer.
 *
 * The store is an in-memory fake rather than pglite for `imports.test.ts`'
 * reason: nothing here is about SQL. The refusals happen above the store, and a
 * fake makes "the store was never asked" observable directly.
 */

import { describe, expect, it } from 'vitest'
import { registerSpecEntities, type SpecEntityShape } from './from-spec.ts'
import { executeMCPTool } from './mcp.ts'
import {
	type OpContext,
	opCount,
	opList,
	ValidationError,
} from './operations.ts'
import { opQuery } from './query.ts'
import { ResourceRegistry } from './registry.ts'
import type { ListOptions, Row, SproutStore } from './store.ts'

const invoice: SpecEntityShape = {
	name: 'invoice',
	fields: [
		{ name: 'reference', type: 'string', required: true },
		// Declared out of the filter bar entirely.
		{
			name: 'internalNote',
			type: 'string',
			required: false,
			filter: { filterable: false },
		},
		// An ordered column narrowed to an exact match — the case the op exists
		// for: a year is a number and a `>=` on it is not the useful control.
		{
			name: 'year',
			type: 'number',
			required: false,
			filter: { operators: ['eq'] },
		},
		// Undeclared: filters exactly as it has since #342.
		{ name: 'total', type: 'number', required: false },
	],
}

function fixture(): { ctx: OpContext; asked: ListOptions[] } {
	const asked: ListOptions[] = []
	const rows: Row[] = [
		{
			id: 'r-1',
			reference: 'INV-1',
			internalNote: 'chase',
			year: 2026,
			total: 10,
		},
	]
	const store: SproutStore = {
		list: async (_resource, opts = {}) => {
			asked.push(opts)
			return rows
		},
		count: async (_resource, opts = {}) => {
			asked.push(opts)
			return rows.length
		},
		get: async (_resource, id) => rows.find((r) => r.id === id) ?? null,
		getMany: async (_resource, ids) =>
			rows.filter((r) => ids.includes(String(r.id))),
		create: async (_resource, data) => ({ id: 'r-2', ...data }),
		update: async () => null,
		delete: async () => false,
	}
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, [invoice])
	return {
		asked,
		ctx: { registry, store, user: { id: 'u-1', role: 'admin' } },
	}
}

describe('a declared filter control binds the collection API', () => {
	it('refuses a filter on a column declared un-filterable, and names the op', async () => {
		const { ctx, asked } = fixture()
		await expect(
			opList(ctx, 'invoice', { filter: { internalNote: 'chase' } }),
		).rejects.toThrow(ValidationError)
		// The op that wrote the declaration is named in the field error, which is
		// what a caller can act on: the refusal says where to go and change it.
		await expect(
			opList(ctx, 'invoice', { filter: { internalNote: 'chase' } }).catch(
				(e: ValidationError) => e.fieldErrors,
			),
		).resolves.toEqual({
			internalNote: [expect.stringContaining('data.setFieldFilter')],
		})
		// Refused above the store: nothing was asked, so there is no window in
		// which the answer existed and was thrown away.
		expect(asked).toEqual([])
	})

	it('refuses a spelling the column narrowed away', async () => {
		const { ctx } = fixture()
		await expect(
			opList(ctx, 'invoice', { range: { year: { gte: '2020' } } }),
		).rejects.toThrow(/does not offer "range"/)
		// …and honours the one it declared.
		await expect(
			opList(ctx, 'invoice', { filter: { year: 2026 } }),
		).resolves.toHaveLength(1)
	})

	it('leaves an undeclared column exactly as it was', async () => {
		const { ctx } = fixture()
		await expect(
			opList(ctx, 'invoice', {
				filter: { total: 10 },
				range: { total: { gte: '1' } },
			}),
		).resolves.toHaveLength(1)
	})

	it('counts on the same terms it lists on', async () => {
		// Two doors to one question. A count that answered a filter the list
		// refuses would be the declaration disagreeing with itself.
		const { ctx } = fixture()
		await expect(
			opCount(ctx, 'invoice', { filter: { internalNote: 'chase' } }),
		).rejects.toThrow(ValidationError)
	})

	it('refuses the same predicate arriving through query_records', async () => {
		// The MCP join tool is the other filter door. A declaration an agent can
		// walk around by asking through `query_records` holds only for the
		// surfaces that happened to remember it.
		const { ctx } = fixture()
		await expect(
			opQuery(ctx, { resource: 'invoice', where: { internalNote: 'chase' } }),
		).rejects.toThrow(ValidationError)
		await expect(
			opQuery(ctx, { resource: 'invoice', range: { year: { gte: 2020 } } }),
		).rejects.toThrow(/does not offer "range"/)
	})

	it('reports the declaration through describe_resources', async () => {
		// An agent that cannot see the declaration learns it by being refused,
		// which costs a round trip to discover what the app already knows.
		const { ctx } = fixture()
		const res = await executeMCPTool(ctx, 'describe_resources', {
			resource: 'invoice',
		})
		const body = JSON.parse(res.content[0]?.text ?? '{}') as {
			fields?: {
				name: string
				filterable?: boolean
				filterOperators?: string[]
			}[]
		}
		const field = (name: string) => body.fields?.find((f) => f.name === name)
		expect(field('internalNote')?.filterable).toBe(false)
		expect(field('year')?.filterOperators).toEqual(['eq'])
		// Silence where nothing was declared: an undeclared column reports neither
		// key, rather than reporting the derivation as though it were a decision.
		expect(field('total')).not.toHaveProperty('filterOperators')
		expect(field('total')).not.toHaveProperty('filterable')
	})
})
