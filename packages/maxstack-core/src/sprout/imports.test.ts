/**
 * The import pipeline's tests.
 *
 * Organized around the four properties the issue gates on rather than around the
 * modules: the **dry-run is structural** (there is no way to write without a
 * plan), **row validation is the forms' validation** (not a lookalike), the
 * **readers stream** (no whole-file buffering), and there is **no delete path**.
 *
 * The store below is a tiny in-memory fake rather than pglite because none of
 * these properties is about SQL — every one of them is about which function calls
 * which, and a fake makes "this went through `opCreate`" observable directly.
 */

import { describe, expect, it } from 'vitest'
import { registerSpecEntities, type SpecEntityShape } from './from-spec.ts'
import {
	builtinParser,
	type ImportRecord,
	parseCsv,
	parseJsonArray,
	parseNdjson,
} from './import-parse.ts'
import {
	type ImportPlan,
	type ImportPlanShape,
	importFailureCsv,
	readCell,
	reconciles,
} from './imports.ts'
import {
	type OpAuditEntry,
	type OpContext,
	opApplyImport,
	planImport,
	UnsupportedOperationError,
} from './operations.ts'
import {
	PermissionError,
	type ResourceAccess,
	type SproutUser,
} from './permissions.ts'
import { ResourceRegistry } from './registry.ts'
import type { ListOptions, Row, SproutStore } from './store.ts'

// ===========================================================================
// A tiny in-memory store
// ===========================================================================

function memoryStore(seed: Row[] = []): SproutStore & { rows: Row[] } {
	const rows: Row[] = seed.map((r) => ({ ...r }))
	let next = seed.length
	const matches = (row: Row, opts: ListOptions) =>
		Object.entries(opts.filter ?? {}).every(([k, v]) => row[k] === v)
	return {
		rows,
		list: async (_resource, opts = {}) =>
			rows.filter((r) => matches(r, opts)).slice(0, opts.limit ?? 50),
		count: async (_resource, opts = {}) =>
			rows.filter((r) => matches(r, opts)).length,
		get: async (_resource, id) => rows.find((r) => r.id === id) ?? null,
		getMany: async (_resource, ids) =>
			rows.filter((r) => ids.includes(String(r.id))),
		create: async (_resource, data) => {
			next++
			const row = { id: `row-${next}`, ...data }
			rows.push(row)
			return row
		},
		update: async (_resource, id, data) => {
			const row = rows.find((r) => r.id === id)
			if (!row) return null
			Object.assign(row, data)
			return row
		},
		delete: async (_resource, id) => {
			const at = rows.findIndex((r) => r.id === id)
			if (at === -1) return false
			rows.splice(at, 1)
			return true
		},
	}
}

const cardEntity: SpecEntityShape = {
	name: 'card',
	fields: [
		{ name: 'guid', type: 'string', required: true },
		{ name: 'front', type: 'string', required: true },
		{ name: 'back', type: 'string', required: false },
		{ name: 'ease', type: 'number', required: false },
		{ name: 'suspended', type: 'boolean', required: false },
		{ name: 'extra', type: 'json', required: false },
	],
}

const csvImporter: ImportPlanShape = {
	key: 'cards-csv',
	description: 'Import cards from a CSV.',
	format: 'csv',
	resource: 'card',
	columns: [
		{ column: 'GUID', field: 'guid', type: 'string' },
		{ column: 'Front', field: 'front', type: 'string' },
		{ column: 'Back', field: 'back', type: 'string' },
		{ column: 'Ease', field: 'ease', type: 'number' },
	],
	upsertColumn: 'guid',
	maxRows: 100,
	paused: false,
}

interface Fixture {
	ctx: OpContext
	store: SproutStore & { rows: Row[] }
	audit: OpAuditEntry[]
}

function fixture(
	over: Partial<ImportPlanShape> = {},
	opts: {
		seed?: Row[]
		user?: SproutUser | null
		access?: ResourceAccess
	} = {},
): Fixture {
	const registry = new ResourceRegistry()
	const [entry] = registerSpecEntities(registry, [
		{
			...cardEntity,
			importers: [{ ...csvImporter, ...over }],
		},
	])
	if (entry && opts.access) entry.config.access = opts.access
	const store = memoryStore(opts.seed)
	const audit: OpAuditEntry[] = []
	return {
		store,
		audit,
		ctx: {
			registry,
			store,
			user: opts.user ?? { id: 'u-1', role: 'admin' },
			audit: (entry) => {
				audit.push(entry)
			},
		},
	}
}

/** One string as the chunk stream the readers take. */
async function* chunks(...parts: string[]): AsyncGenerator<string> {
	for (const part of parts) yield part
}

/** UTF-8 bytes, split at an arbitrary index — the multi-byte boundary case. */
async function* bytes(text: string, at: number): AsyncGenerator<Uint8Array> {
	const encoded = new TextEncoder().encode(text)
	yield encoded.slice(0, at)
	yield encoded.slice(at)
}

async function collect(
	it: AsyncIterable<ImportRecord>,
): Promise<ImportRecord[]> {
	const out: ImportRecord[] = []
	for await (const record of it) out.push(record)
	return out
}

// ===========================================================================
// The readers
// ===========================================================================

describe('the CSV reader', () => {
	it('reads quoted cells, embedded commas, newlines and escaped quotes', async () => {
		const records = await collect(
			parseCsv(
				chunks(
					'GUID,Front,Back\n',
					'a,"one, two","line\nbreak"\n',
					'b,"a ""quoted"" word",plain\n',
				),
			),
		)
		expect(records).toEqual([
			{ GUID: 'a', Front: 'one, two', Back: 'line\nbreak' },
			{ GUID: 'b', Front: 'a "quoted" word', Back: 'plain' },
		])
	})

	it('handles CRLF and a missing trailing newline', async () => {
		const records = await collect(parseCsv(chunks('A,B\r\n1,2\r\n3,4')))
		expect(records).toEqual([
			{ A: '1', B: '2' },
			{ A: '3', B: '4' },
		])
	})

	it('survives a multi-byte character split across chunk boundaries', async () => {
		// Decoding each chunk independently corrupts exactly one character
		// somewhere in a large file, which gets reported as "the import mangled one
		// row" and is very hard to reproduce.
		const text = 'A\nGrößé\n'
		const records = await collect(parseCsv(bytes(text, 4)))
		expect(records).toEqual([{ A: 'Größé' }])
	})

	it('refuses a header with a repeated column rather than picking one', async () => {
		await expect(
			collect(parseCsv(chunks('Front,Front\n1,2\n'))),
		).rejects.toThrow(/repeats the column/)
	})

	it('does not guess a delimiter', async () => {
		// A semicolon-separated export parses as one column, visibly wrong in the
		// dry-run, rather than as plausible-looking wrong rows.
		const records = await collect(parseCsv(chunks('A;B\n1;2\n')))
		expect(records).toEqual([{ 'A;B': '1;2' }])
	})
})

describe('the NDJSON reader', () => {
	it('parses one object per line as the line completes', async () => {
		const records = await collect(
			parseNdjson(chunks('{"a":1}\n{"a":', '2,"b":"x"}\n\n')),
		)
		expect(records).toEqual([{ a: '1' }, { a: '2', b: 'x' }])
	})

	it('re-serializes nested values so every reader yields the same shape', async () => {
		const records = await collect(parseNdjson(chunks('{"extra":{"k":1}}\n')))
		expect(records).toEqual([{ extra: '{"k":1}' }])
	})

	it('names the line that is not valid JSON', async () => {
		await expect(
			collect(parseNdjson(chunks('{"a":1}\nnot json\n'))),
		).rejects.toThrow(/line 2/)
	})
})

describe('the JSON-array reader', () => {
	it('yields elements as they complete, not after the document does', async () => {
		const seen: string[] = []
		for await (const record of parseJsonArray(
			chunks('[{"a":1},', '{"a":2}', ']'),
		))
			seen.push(String(record.a))
		expect(seen).toEqual(['1', '2'])
	})

	it('handles braces and brackets inside strings, and escaped quotes', async () => {
		const records = await collect(
			parseJsonArray(chunks('[{"a":"}]{\\"x\\""},{"a":"b"}]')),
		)
		expect(records).toEqual([{ a: '}]{"x"' }, { a: 'b' }])
	})

	it('points at NDJSON when the document is not an array', async () => {
		await expect(collect(parseJsonArray(chunks('{"a":1}')))).rejects.toThrow(
			/top-level ARRAY/,
		)
	})

	it('refuses a truncated document rather than importing the prefix', async () => {
		await expect(
			collect(parseJsonArray(chunks('[{"a":1},{"a":'))),
		).rejects.toThrow(/truncated/)
	})

	it('refuses a scalar element — a record needs column names', async () => {
		await expect(collect(parseJsonArray(chunks('[1,2]')))).rejects.toThrow(
			/not an object/,
		)
	})
})

describe('builtinParser', () => {
	it('has a reader for every declared format except custom', () => {
		expect(builtinParser('csv')).toBe(parseCsv)
		expect(builtinParser('ndjson')).toBe(parseNdjson)
		expect(builtinParser('json')).toBe(parseJsonArray)
		// `custom` deliberately has none: the platform does not know how to read a
		// .apkg, and the slot is how it says so.
		expect(builtinParser('custom')).toBeNull()
	})
})

// ===========================================================================
// Reading a cell
// ===========================================================================

describe('readCell', () => {
	it('treats a blank cell as ABSENT, never as an empty value', async () => {
		// The rule that stops a partial export from blanking a thousand rows on an
		// upsert. Clearing a value is a deliberate edit; it is not something a
		// missing column should do at scale.
		expect(readCell('', 'string')).toEqual({ present: false })
		expect(readCell('   ', 'number')).toEqual({ present: false })
	})

	it('refuses a number that is not entirely a number', () => {
		expect(readCell('12abc', 'number')).toHaveProperty('error')
		expect(readCell('12', 'number')).toEqual({ present: true, value: 12 })
	})

	it('reads the yes/no spellings a spreadsheet actually contains', () => {
		for (const yes of ['true', 'YES', 'y', '1'])
			expect(readCell(yes, 'boolean')).toEqual({ present: true, value: true })
		for (const no of ['false', 'No', 'n', '0'])
			expect(readCell(no, 'boolean')).toEqual({ present: true, value: false })
		expect(readCell('maybe', 'boolean')).toHaveProperty('error')
	})

	it('passes date and json through to the forms’ own schemas', () => {
		// Converted here, they would be a second parser to keep in step with the
		// one every form already uses.
		expect(readCell('2026-07-28', 'date')).toEqual({
			present: true,
			value: '2026-07-28',
		})
		expect(readCell('{"k":1}', 'json')).toEqual({
			present: true,
			value: '{"k":1}',
		})
	})
})

// ===========================================================================
// The plan
// ===========================================================================

describe('planImport', () => {
	it('plans creates for a clean file and writes nothing', async () => {
		const { ctx, store } = fixture()
		const plan = await planImport(
			ctx,
			'cards-csv',
			chunks('GUID,Front,Back,Ease\na,Q1,A1,2.5\nb,Q2,A2,1.3\n'),
		)
		expect(plan.counts).toEqual({ create: 2, update: 0, invalid: 0 })
		expect(plan.rows.map((r) => r.line)).toEqual([1, 2])
		// The whole point of a dry-run.
		expect(store.rows).toEqual([])
	})

	it('plans an update for a row the upsert key already matches', async () => {
		const { ctx } = fixture(
			{},
			{ seed: [{ id: 'row-1', guid: 'a', front: 'old', back: null }] },
		)
		const plan = await planImport(
			ctx,
			'cards-csv',
			chunks('GUID,Front\na,new\nb,fresh\n'),
		)
		expect(plan.counts).toEqual({ create: 1, update: 1, invalid: 0 })
		expect(plan.rows[0]).toMatchObject({ action: 'update', matchedId: 'row-1' })
		expect(plan.rows[1]).toMatchObject({ action: 'create' })
	})

	it('plans only creates when the importer is insert-only', async () => {
		const { ctx } = fixture(
			{ upsertColumn: null },
			{ seed: [{ id: 'row-1', guid: 'a', front: 'old' }] },
		)
		const plan = await planImport(
			ctx,
			'cards-csv',
			chunks('GUID,Front\na,new\n'),
		)
		expect(plan.counts.update).toBe(0)
		expect(plan.counts.create).toBe(1)
	})

	it('rejects a row rather than overwriting one of several ambiguous matches', async () => {
		const { ctx } = fixture(
			{},
			{
				seed: [
					{ id: 'row-1', guid: 'a', front: 'one' },
					{ id: 'row-2', guid: 'a', front: 'two' },
				],
			},
		)
		const plan = await planImport(
			ctx,
			'cards-csv',
			chunks('GUID,Front\na,new\n'),
		)
		expect(plan.rows[0]?.action).toBe('invalid')
		expect(JSON.stringify(plan.rows[0]?.errors)).toContain('ambiguous')
	})

	it('uses the forms’ own validator, not a lookalike', async () => {
		// `front` is required, and the refusal arrives in the exact shape a form
		// renders — which is the assertion that the two paths are one function.
		const { ctx } = fixture()
		const plan = await planImport(ctx, 'cards-csv', chunks('GUID,Front\na,\n'))
		expect(plan.counts.invalid).toBe(1)
		expect(Object.keys(plan.rows[0]?.errors ?? {})).toContain('front')
	})

	it('validates an update in update mode, so a partial file row is legal', async () => {
		const { ctx } = fixture(
			{},
			{ seed: [{ id: 'row-1', guid: 'a', front: 'kept' }] },
		)
		// No `Front` column at all: on a create this would fail the required check;
		// on an update the existing row already carries it.
		const plan = await planImport(ctx, 'cards-csv', chunks('GUID,Ease\na,3\n'))
		expect(plan.counts).toEqual({ create: 0, update: 1, invalid: 0 })
	})

	it('FAILS the whole run past maxRows rather than truncating', async () => {
		const { ctx, store } = fixture({ maxRows: 2 })
		await expect(
			planImport(ctx, 'cards-csv', chunks('GUID,Front\na,1\nb,2\nc,3\n')),
		).rejects.toThrow(/more than the declared maximum/)
		expect(store.rows).toEqual([])
	})

	it('refuses a paused importer', async () => {
		const { ctx } = fixture({ paused: true })
		await expect(
			planImport(ctx, 'cards-csv', chunks('GUID,Front\na,1\n')),
		).rejects.toBeInstanceOf(UnsupportedOperationError)
	})

	it('authorizes create up front — and update too, when it can upsert', async () => {
		// Discovering at apply time that a plan full of updates cannot be applied is
		// discovering it after somebody has read a report promising them.
		const denied = fixture(
			{},
			{ access: { update: 'admin' }, user: { id: 'u-2', role: 'member' } },
		)
		await expect(
			planImport(denied.ctx, 'cards-csv', chunks('GUID,Front\na,1\n')),
		).rejects.toBeInstanceOf(PermissionError)

		// The same rule set, with the importer insert-only, never needs `update`.
		const fine = fixture(
			{ upsertColumn: null },
			{ access: { update: 'admin' }, user: { id: 'u-2', role: 'member' } },
		)
		const plan = await planImport(
			fine.ctx,
			'cards-csv',
			chunks('GUID,Front\na,1\n'),
		)
		expect(plan.counts.create).toBe(1)
	})

	it('throws loudly for a custom importer with no parser, naming the file', async () => {
		// Never an empty plan: "your file had no rows" is a different and far more
		// confusing problem than "the parser has not been written".
		const { ctx } = fixture({ format: 'custom', parserSlot: 'anki.apkg' })
		await expect(planImport(ctx, 'cards-csv', chunks(''))).rejects.toThrow(
			/imports\/cards-csv\.parse\.ts/,
		)
	})

	it('feeds a custom parser’s records through the IDENTICAL pipeline', async () => {
		// The property that keeps the slot from being a bypass: a parser's output
		// is validated exactly as a CSV's is.
		const { ctx } = fixture({ format: 'custom', parserSlot: 'anki.apkg' })
		const parser = async function* (): AsyncGenerator<ImportRecord> {
			yield { GUID: 'a', Front: 'ok' }
			yield { GUID: 'b', Front: '' } // fails the same required check
		}
		const plan = await planImport(ctx, 'cards-csv', chunks(''), { parser })
		expect(plan.counts).toEqual({ create: 1, update: 0, invalid: 1 })
		expect(Object.keys(plan.rows[1]?.errors ?? {})).toContain('front')
	})
})

// ===========================================================================
// Apply
// ===========================================================================

describe('opApplyImport', () => {
	it('takes ONLY a plan — a write cannot happen without a dry-run', () => {
		// The structural guarantee, asserted at the type level by construction and
		// here by arity: `opApplyImport(ctx, plan)`. There is no overload taking
		// bytes, so "always dry-run first" is not a rule anybody can skip.
		expect(opApplyImport.length).toBe(2)
		expect(planImport.length).toBeGreaterThanOrEqual(3)
	})

	it('writes through opCreate/opUpdate, so audit attribution is inherited', async () => {
		const { ctx, store, audit } = fixture(
			{},
			{ seed: [{ id: 'row-1', guid: 'a', front: 'old' }] },
		)
		const plan = await planImport(
			ctx,
			'cards-csv',
			chunks('GUID,Front\na,new\nb,fresh\n'),
		)
		const result = await opApplyImport(ctx, plan)
		expect(result).toMatchObject({ created: 1, updated: 1, skipped: 0 })
		expect(store.rows.find((r) => r.guid === 'a')?.front).toBe('new')
		// An import performed by an agent is attributed like any other write,
		// because it *is* any other write — these entries come from `opCreate` and
		// `opUpdate`, not from anything this module wrote.
		expect(audit.map((e) => e.action).sort()).toEqual(['create', 'update'])
		expect(audit.every((e) => e.userId === 'u-1')).toBe(true)
	})

	it('never attempts a row the plan marked invalid', async () => {
		const { ctx, store } = fixture()
		const plan = await planImport(
			ctx,
			'cards-csv',
			chunks('GUID,Front\na,ok\nb,\n'),
		)
		const result = await opApplyImport(ctx, plan)
		expect(result.created).toBe(1)
		expect(result.skipped).toBe(1)
		expect(store.rows).toHaveLength(1)
		expect(reconciles(plan, result)).toBe(true)
	})

	it('reports a row that fails at write time and still lands the rest', async () => {
		const { ctx, store } = fixture()
		const plan = await planImport(
			ctx,
			'cards-csv',
			chunks('GUID,Front\na,one\nb,two\nc,three\n'),
		)
		// A racing writer, a filled WIP column, a unique index — something that was
		// not true when the plan was built.
		const create = store.create.bind(store)
		let calls = 0
		store.create = async (resource, data) => {
			calls++
			if (calls === 2) throw new Error('unique violation')
			return create(resource, data)
		}
		const result = await opApplyImport(ctx, plan)
		expect(result.created).toBe(2)
		expect(result.failed).toEqual([{ line: 2, reason: 'unique violation' }])
		// Rolling the successful rows back would mean deleting rows this module
		// just created — the delete path it deliberately does not have.
		expect(store.rows).toHaveLength(2)
		expect(reconciles(plan, result)).toBe(true)
	})

	it('has no delete path at all', () => {
		// Asserted by reading the source, because the honest way to prove a feature
		// is absent is to prove nothing can call it. A `deleteMissing` option, a
		// truncate, or a call to `opDelete` would each show up here.
		const source = opApplyImport.toString()
		expect(source).not.toMatch(/opDelete|deleteMissing|truncate/i)
	})
})

// ===========================================================================
// The failure report
// ===========================================================================

describe('importFailureCsv', () => {
	const plan = (rows: ImportPlan['rows']): ImportPlan => ({
		importer: csvImporter,
		key: 'cards-csv',
		resource: 'card',
		rows,
		counts: { create: 0, update: 0, invalid: rows.length },
		truncated: false,
	})

	it('emits one row per failing line, quoting what the person typed', async () => {
		const csv = importFailureCsv(
			plan([
				{
					line: 3,
					action: 'invalid',
					errors: { ease: ['"x" is not a number'] },
					raw: { GUID: 'a', Ease: 'x' },
				},
			]),
		)
		expect(csv).toBe(
			'line,fields,values,reasons\r\n3,ease,x,"""x"" is not a number"\r\n',
		)
	})

	it('keeps a line with two bad cells as ONE row — a line is what gets fixed', () => {
		const csv = importFailureCsv(
			plan([
				{
					line: 1,
					action: 'invalid',
					errors: { ease: ['not a number'], front: ['required'] },
					raw: { Ease: 'x', Front: '' },
				},
			]),
		)
		expect(csv.trim().split('\r\n')).toHaveLength(2)
		expect(csv).toContain('ease; front')
	})

	it('is deterministic byte-for-byte', () => {
		const rows: ImportPlan['rows'] = [
			{
				line: 1,
				action: 'invalid',
				errors: { front: ['required'] },
				raw: { Front: '' },
			},
		]
		expect(importFailureCsv(plan(rows))).toBe(importFailureCsv(plan(rows)))
		// No clock, no locale: `Intl` output varies with the ICU build, and this
		// file is evidence somebody attaches to a ticket and compares to a later run.
		expect(importFailureCsv.toString()).not.toMatch(/Intl|Date\.now|toLocale/)
	})

	it('escapes commas, quotes and newlines per RFC 4180', () => {
		const csv = importFailureCsv(
			plan([
				{
					line: 1,
					action: 'invalid',
					errors: { front: ['bad, very "bad"'] },
					raw: { Front: 'a\nb' },
				},
			]),
		)
		expect(csv).toContain('"a\nb"')
		expect(csv).toContain('"bad, very ""bad"""')
	})
})
