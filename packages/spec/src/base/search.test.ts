/**
 * Declared full-text search at the spec layer: the four ops, the
 * validator, and the selectors.
 *
 * Organized by what would go wrong. The happy paths are short because they are
 * not where the risk is — the risk is in the refusals, because everything this
 * validator lets through is interpolated into SQL by `@maxstack/core`'s
 * `search.ts`, and because a search index that indexes the wrong thing produces
 * worse answers silently rather than failing.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import { manual, suggested } from './provenance.ts'
import {
	activeSearchIndexes,
	describeSearchIndex,
	findSearchIndex,
	listSearchIndexes,
	MAX_SEARCH_FIELDS,
	MAX_SEARCH_KEY_LENGTH,
	orderedSearchFields,
	SEARCH_LANGUAGES,
	SEARCH_WEIGHT_FACTORS,
	SEARCH_WEIGHTS,
	type SearchIndexSpec,
	searchIndexName,
} from './search.ts'
import { type ApplyMeta, applyOp, diffOp, type SpecOp } from './spec-ops.ts'
import { collectSpecSystemErrors } from './spec-system.schema.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: 'human',
	appliedAt: '2026-07-28',
})

/** A spec with a post entity carrying one of every field type worth refusing. */
function withPost(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-post',
					name: 'Post',
					description: 'A piece of writing.',
					fields: [
						{ id: 'fld-title', name: 'title', type: 'string', required: true },
						{ id: 'fld-body', name: 'body', type: 'string', required: false },
						{
							id: 'fld-status',
							name: 'status',
							type: 'enum',
							required: false,
							options: [{ label: 'Draft', value: 'draft' }],
						},
						{ id: 'fld-views', name: 'views', type: 'number', required: false },
						{
							id: 'fld-at',
							name: 'publishedAt',
							type: 'date',
							required: false,
						},
						{ id: 'fld-meta', name: 'meta', type: 'json', required: false },
						{
							id: 'fld-hero',
							name: 'hero',
							type: 'file',
							required: false,
							file: { accept: ['image/png'], maxSizeBytes: 1000 },
						},
						{
							id: 'fld-rank',
							name: 'position',
							type: 'string',
							required: false,
							rank: true,
						},
						{
							id: 'fld-author',
							name: 'authorId',
							type: 'string',
							required: false,
							reference: 'e-post',
						},
					],
					provenance: manual(),
				},
			},
		},
		meta(1),
	)
}

const declare = (over: Partial<SearchIndexSpec> = {}): SpecOp => ({
	op: 'search.declare',
	args: {
		index: {
			id: 'idx-post',
			key: 'post-search',
			description: 'Ranked search over post titles and bodies.',
			entityId: 'e-post',
			language: 'english',
			fields: [
				{ fieldId: 'fld-title', weight: 'A' },
				{ fieldId: 'fld-body', weight: 'B' },
			],
			indexed: true,
			provenance: manual(),
			...over,
		} as SearchIndexSpec,
	},
})

/** Every error a spec produces once the op has been force-applied. */
function loadErrors(system: SpecSystem): string[] {
	return collectSpecSystemErrors(system)
}

// ===========================================================================
// The happy path
// ===========================================================================

describe('declaring an index', () => {
	it('lands with a stamped declaredAt and is readable through the selectors', () => {
		const next = applyOp(withPost(), declare(), meta(2))
		const [index] = listSearchIndexes(next)
		expect(index?.declaredAt).toBe('2026-07-28')
		expect(findSearchIndex(next, 'e-post')?.key).toBe('post-search')
		expect(loadErrors(next)).toEqual([])
	})

	it('grows no search.json until one is declared', () => {
		expect(listSearchIndexes(newSpecSystem(tasklyPRD))).toEqual([])
		expect(newSpecSystem(tasklyPRD).search).toBeUndefined()
	})

	it('is grounded on accepted rows like every other layer', () => {
		// An index an agent proposed and nobody accepted does not start costing
		// writes — the same rule that stops an unaccepted source calling an API.
		const next = applyOp(
			withPost(),
			declare({ provenance: suggested() }),
			meta(2),
		)
		const accepted = applyOp(withPost(), declare(), meta(2))
		expect(activeSearchIndexes(accepted)).toHaveLength(1)
		expect(listSearchIndexes(next)).toHaveLength(1)
	})

	it('sorts fields by weight so declaration order cannot change the SQL', () => {
		// The emitted index must be a function of the weighting, not of the order
		// somebody happened to type the fields in — the combination-safety gate
		// requires byte-identical output across equivalent specs.
		const index = listSearchIndexes(
			applyOp(
				withPost(),
				declare({
					fields: [
						{ fieldId: 'fld-body', weight: 'B' },
						{ fieldId: 'fld-title', weight: 'A' },
					],
				}),
				meta(2),
			),
		)[0] as SearchIndexSpec
		expect(orderedSearchFields(index).map((f) => f.fieldId)).toEqual([
			'fld-title',
			'fld-body',
		])
	})
})

// ===========================================================================
// The refusals — where the risk is
// ===========================================================================

describe('refusals', () => {
	const errorsFor = (over: Partial<SearchIndexSpec>): string => {
		const system = withPost()
		const op = declare(over)
		try {
			applyOp(system, op, meta(2))
			return ''
		} catch (e) {
			return e instanceof Error ? e.message : String(e)
		}
	}

	it('refuses a field that is not a field of the indexed entity', () => {
		expect(
			errorsFor({ fields: [{ fieldId: 'fld-nope', weight: 'A' }] }),
		).toMatch(/not a field of entity/)
	})

	it('refuses a reference field, which stores an id rather than text', () => {
		// Indexing one makes search match raw uuids: it surfaces ids to anyone
		// with a search box and matches nothing a person would ever type.
		expect(
			errorsFor({ fields: [{ fieldId: 'fld-author', weight: 'A' }] }),
		).toMatch(/is a reference/)
	})

	it('refuses a rank key, which holds an ordering position', () => {
		expect(
			errorsFor({ fields: [{ fieldId: 'fld-rank', weight: 'A' }] }),
		).toMatch(/is a rank key/)
	})

	it('refuses the types that are already answerable by a filter', () => {
		// Each of these has a text form, and each of them ranks worse than the
		// exact, indexed facility that already exists for it.
		for (const id of ['fld-views', 'fld-at', 'fld-meta'] as const)
			expect(errorsFor({ fields: [{ fieldId: id, weight: 'A' }] }), id).toMatch(
				/only string and enum fields carry language/,
			)
	})

	it('refuses a file column, whose value is an opaque storage key', () => {
		expect(
			errorsFor({ fields: [{ fieldId: 'fld-hero', weight: 'A' }] }),
		).toMatch(/only string and enum fields carry language/)
	})

	it('accepts an enum, because a fixed vocabulary is still words', () => {
		expect(
			errorsFor({ fields: [{ fieldId: 'fld-status', weight: 'C' }] }),
		).toBe('')
	})

	it('refuses a language outside the shipped set', () => {
		// The value reaches SQL as a `regconfig` literal, so the enum is the
		// injection boundary as well as a portability guarantee.
		expect(errorsFor({ language: 'klingon' as 'english' })).toMatch(
			/is not one of the configurations core Postgres ships/,
		)
		expect(
			errorsFor({ language: "english'); DROP TABLE post --" as 'english' }),
		).toMatch(/is not one of the configurations core Postgres ships/)
	})

	it('refuses a weight outside A–D', () => {
		expect(
			errorsFor({ fields: [{ fieldId: 'fld-title', weight: 'S' as 'A' }] }),
		).toMatch(/is not one of A, B, C, D/)
	})

	it('refuses an empty or oversized field list', () => {
		expect(errorsFor({ fields: [] })).toMatch(/needs at least one field/)
		expect(
			errorsFor({
				fields: Array.from({ length: MAX_SEARCH_FIELDS + 1 }, () => ({
					fieldId: 'fld-title' as const,
					weight: 'A' as const,
				})),
			}),
		).toMatch(/exceeds the maximum/)
	})

	it('refuses the same field twice', () => {
		expect(
			errorsFor({
				fields: [
					{ fieldId: 'fld-title', weight: 'A' },
					{ fieldId: 'fld-title', weight: 'B' },
				],
			}),
		).toMatch(/listed twice/)
	})

	it('refuses a key that would be truncated into a database identifier', () => {
		// Postgres truncates identifiers past 63 bytes silently, so two long keys
		// sharing a prefix would resolve to one index name.
		expect(errorsFor({ key: 'a'.repeat(MAX_SEARCH_KEY_LENGTH + 1) })).toMatch(
			/the maximum is 48/,
		)
		expect(errorsFor({ key: 'Not A Key' })).toMatch(/must match/)
	})

	it('refuses a missing description', () => {
		expect(errorsFor({ description: '  ' })).toMatch(/needs a description/)
	})

	it('refuses an undefaulted indexed flag', () => {
		// "Do we pay for this on every write" is a decision about somebody's
		// production database, not something a code generator gets to imply.
		expect(errorsFor({ indexed: undefined as unknown as boolean })).toMatch(
			/indexed must be true or false/,
		)
	})

	it('refuses an unknown entity', () => {
		expect(errorsFor({ entityId: 'e-nope' })).toMatch(/unknown entity/)
	})

	it('refuses a second index on the same entity', () => {
		const once = applyOp(withPost(), declare(), meta(2))
		expect(() =>
			applyOp(
				once,
				declare({ id: 'idx-post-2', key: 'post-search-2' }),
				meta(3),
			),
		).toThrow(/already has a search index/)
	})

	it('refuses a duplicate id or key', () => {
		const once = applyOp(withPost(), declare(), meta(2))
		expect(() =>
			applyOp(once, declare({ entityId: 'e-post' }), meta(3)),
		).toThrow()
	})
})

// ===========================================================================
// The mutators
// ===========================================================================

describe('the mutators', () => {
	const declared = () => applyOp(withPost(), declare(), meta(2))

	it('setFields replaces the list wholesale and re-validates against the entity', () => {
		const next = applyOp(
			declared(),
			{
				op: 'search.setFields',
				args: {
					indexId: 'idx-post',
					fields: [{ fieldId: 'fld-title', weight: 'A' }],
				},
			},
			meta(3),
		)
		expect(listSearchIndexes(next)[0]?.fields).toHaveLength(1)
		// A field list is only correct relative to the entity it indexes, so the
		// whole declaration is re-validated with the new list spliced in.
		expect(() =>
			applyOp(
				declared(),
				{
					op: 'search.setFields',
					args: {
						indexId: 'idx-post',
						fields: [{ fieldId: 'fld-views', weight: 'A' }],
					},
				},
				meta(3),
			),
		).toThrow(/only string and enum fields carry language/)
	})

	it('setIndexing flips the physical index without touching the ranking', () => {
		const off = applyOp(
			declared(),
			{
				op: 'search.setIndexing',
				args: { indexId: 'idx-post', indexed: false },
			},
			meta(3),
		)
		const [index] = listSearchIndexes(off)
		expect(index?.indexed).toBe(false)
		// The declaration is otherwise identical: same fields, same weights, same
		// language. That is the property that makes the flip safe to make at 3am.
		expect(index?.fields).toEqual(listSearchIndexes(declared())[0]?.fields)
		expect(index?.language).toBe('english')
	})

	it('remove is refused while the physical index still exists', () => {
		// Not ceremony: the DDL is emitted from the declaration, so removing the
		// declaration first strands a real GIN index with nothing left that knows
		// its name.
		expect(() =>
			applyOp(
				declared(),
				{ op: 'search.remove', args: { indexId: 'idx-post' } },
				meta(3),
			),
		).toThrow(/still exists physically/)
	})

	it('remove succeeds once indexing is off', () => {
		const off = applyOp(
			declared(),
			{
				op: 'search.setIndexing',
				args: { indexId: 'idx-post', indexed: false },
			},
			meta(3),
		)
		const gone = applyOp(
			off,
			{ op: 'search.remove', args: { indexId: 'idx-post' } },
			meta(4),
		)
		expect(listSearchIndexes(gone)).toEqual([])
		expect(loadErrors(gone)).toEqual([])
	})

	it('refuses every mutator against an unknown index', () => {
		for (const op of [
			{
				op: 'search.setFields' as const,
				args: { indexId: 'idx-nope' as const, fields: [] },
			},
			{
				op: 'search.setIndexing' as const,
				args: { indexId: 'idx-nope' as const, indexed: false },
			},
			{ op: 'search.remove' as const, args: { indexId: 'idx-nope' as const } },
		])
			expect(() => applyOp(declared(), op, meta(3))).toThrow(
				/unknown search index/,
			)
	})
})

// ===========================================================================
// Loading a hand-edited directory
// ===========================================================================

describe('a hand-edited search.json', () => {
	it('fails to load with two indexes on one entity', () => {
		// The op refuses it; this asserts the *other* door is shut too, which is
		// the reason `searchIndexErrors` takes the sibling list rather than the op
		// checking uniqueness by itself.
		const system = applyOp(withPost(), declare(), meta(2))
		const tampered: SpecSystem = {
			...system,
			search: {
				indexes: [
					...(system.search?.indexes ?? []),
					{
						...(system.search?.indexes[0] as SearchIndexSpec),
						id: 'idx-post-2',
						key: 'post-search-2',
					},
				],
			},
		}
		expect(loadErrors(tampered).join('\n')).toMatch(
			/already has a search index/,
		)
	})

	it('fails to load with a language outside the enum', () => {
		const system = applyOp(withPost(), declare(), meta(2))
		const tampered: SpecSystem = {
			...system,
			search: {
				indexes: [
					{
						...(system.search?.indexes[0] as SearchIndexSpec),
						language: 'bobble' as 'english',
					},
				],
			},
		}
		expect(loadErrors(tampered).join('\n')).toMatch(/core Postgres ships/)
	})
})

// ===========================================================================
// Diffs, prose and constants
// ===========================================================================

describe('diffs and prose', () => {
	it('summarizes a declaration in the language of the decision', () => {
		const diff = diffOp(declare())
		expect(diff.layer).toBe('search')
		expect(diff.change).toBe('add')
		expect(diff.summary).toContain('post-search')
		expect(diff.summary).toContain('indexed')
	})

	it('says which way setIndexing went, and that ranking is unchanged', () => {
		const off = diffOp({
			op: 'search.setIndexing',
			args: { indexId: 'idx-post', indexed: false },
		})
		expect(off.summary).toContain('Drop')
		expect(off.summary).toContain('ranking is unchanged')
	})

	it('describes an index as a sentence about cost and weighting', () => {
		const index = listSearchIndexes(
			applyOp(withPost(), declare({ indexed: false }), meta(2)),
		)[0] as SearchIndexSpec
		expect(describeSearchIndex(index)).toBe(
			'english over fld-title:A, fld-body:B — unindexed (scan)',
		)
	})
})

describe('the constants', () => {
	it('names exactly the four weights a tsvector can hold', () => {
		expect(SEARCH_WEIGHTS).toEqual(['A', 'B', 'C', 'D'])
		expect(Object.keys(SEARCH_WEIGHT_FACTORS).sort()).toEqual([
			'A',
			'B',
			'C',
			'D',
		])
		// Strictly decreasing, or "weight" would not mean what the docs say.
		const factors = SEARCH_WEIGHTS.map((w) => SEARCH_WEIGHT_FACTORS[w])
		expect(factors).toEqual([...factors].sort((a, b) => b - a))
	})

	it('offers simple, for text that is not prose in one language', () => {
		expect(SEARCH_LANGUAGES).toContain('simple')
		expect(SEARCH_LANGUAGES).toContain('english')
	})

	it('derives a database identifier that fits in 63 bytes', () => {
		expect(searchIndexName('post-search')).toBe('search_post_search')
		expect(
			searchIndexName('a'.repeat(MAX_SEARCH_KEY_LENGTH)).length,
		).toBeLessThanOrEqual(63)
	})
})
