import { describe, expect, it } from 'vitest'
import { task } from '../demo/schema.ts'
import { introspectTable } from './introspection.ts'
import type { SproutResource } from './types.ts'
import { generateValidationSchema, validateData } from './validation.ts'

const resource = introspectTable(task)

describe('generateValidationSchema', () => {
	it('excludes the primary key and defaulted timestamp from create input', () => {
		const schema = generateValidationSchema(resource, 'create')
		const keys = Object.keys(schema.shape)
		expect(keys).not.toContain('id')
		expect(keys).not.toContain('createdAt')
		expect(keys).toContain('title')
	})
})

describe('validateData (create)', () => {
	it('accepts a valid record', () => {
		const r = validateData(resource, { title: 'Write spec' }, 'create')
		expect(r.success).toBe(true)
	})

	it('requires title', () => {
		const r = validateData(resource, {}, 'create')
		expect(r.success).toBe(false)
		expect(r.fieldErrors).toHaveProperty('title')
	})

	it('honors meta maxLength (dropped by the original)', () => {
		const r = validateData(resource, { title: 'x'.repeat(201) }, 'create')
		expect(r.success).toBe(false)
		expect(r.fieldErrors?.title).toBeDefined()
	})

	it('rejects an out-of-range enum value', () => {
		const r = validateData(
			resource,
			{ title: 'ok', priority: 'urgent' },
			'create',
		)
		expect(r.success).toBe(false)
		expect(r.fieldErrors).toHaveProperty('priority')
	})

	it('treats defaulted columns as optional', () => {
		const r = validateData(resource, { title: 'ok' }, 'create')
		expect(r.success).toBe(true)
	})
})

describe('validateData — json columns', () => {
	const dimension: SproutResource = {
		name: 'dimension',
		primaryKey: 'id',
		relations: [],
		columns: [
			{
				name: 'id',
				type: 'uuid',
				nullable: false,
				hasDefault: true,
				isPrimaryKey: true,
				meta: {},
			},
			{
				name: 'allowedValues',
				type: 'json',
				nullable: true,
				hasDefault: false,
				isPrimaryKey: false,
				meta: {},
			},
		],
	}
	const run = (allowedValues: unknown) =>
		validateData(dimension, { allowedValues }, 'create')

	it('accepts a top-level JSON array (422 "expected record" before)', () => {
		const r = run(['linear', 'log'])
		expect(r.success).toBe(true)
		expect(r.data?.allowedValues).toEqual(['linear', 'log'])
	})

	it('still accepts a JSON object', () => {
		expect(run({ values: ['linear'] }).success).toBe(true)
	})

	it('parses a JSON-encoded string (the JSON-textarea form widget posts one)', () => {
		const r = run('["linear","log"]')
		expect(r.success).toBe(true)
		expect(r.data?.allowedValues).toEqual(['linear', 'log'])
	})

	it('rejects invalid JSON text and scalars', () => {
		expect(run('not json').success).toBe(false)
		// Issue #258: the refusal states the expectation, the value that arrived
		// and a value that would work — enough to fix the call without probing.
		const [message] = run('not json').fieldErrors?.allowedValues ?? []
		expect(message).toMatch(/expected a JSON object or array/)
		expect(message).toMatch(/received string "not json"/)
		expect(message).toMatch(/send e\.g\. \{"key":"value"\}/)
		expect(run(5).success).toBe(false)
	})

	it('keeps null working for a nullable json column', () => {
		expect(run(null).success).toBe(true)
	})
})

describe('validateData — date columns', () => {
	const appointment: SproutResource = {
		name: 'appointment',
		primaryKey: 'id',
		relations: [],
		columns: [
			{
				name: 'id',
				type: 'uuid',
				nullable: false,
				hasDefault: true,
				isPrimaryKey: true,
				meta: {},
			},
			{
				name: 'startsAt',
				type: 'date',
				nullable: true,
				hasDefault: false,
				isPrimaryKey: false,
				meta: {},
			},
		],
	}
	const run = (startsAt: unknown) =>
		validateData(appointment, { startsAt }, 'update')

	it('accepts the space-separated form the column itself reads back as', () => {
		const r = run('2026-03-08 09:00:00')
		expect(r.success).toBe(true)
		expect(r.data?.startsAt).toBe('2026-03-08T09:00:00')
	})

	it('round-trips a read-modify-write: what comes out goes back in', () => {
		// The whole point of #218 — a client reads a row, changes another field,
		// and posts the record back. The date it never touched must validate.
		const readBack = '2026-03-08 09:00:00'
		expect(run(readBack).success).toBe(true)
	})

	it('accepts a space-separated value carrying an offset', () => {
		const r = run('2026-03-08 09:00:00+01:00')
		expect(r.success).toBe(true)
		expect(r.data?.startsAt).toBe('2026-03-08T09:00:00')
	})

	it('accepts minute precision, which is what a read-back can also carry', () => {
		expect(run('2026-03-08 09:00').success).toBe(true)
	})

	it('still accepts every form it accepted before', () => {
		expect(run('2026-03-08T09:00:00Z').success).toBe(true)
		expect(run('2026-03-08T09:00:00').success).toBe(true)
		expect(run('2026-03-08').success).toBe(true)
		expect(run(new Date('2026-03-08T09:00:00Z')).success).toBe(true)
	})

	it('drops a zone marker instead of letting it shift the stored value', () => {
		// A spec `date` is a timestamp WITHOUT time zone. An offset names an
		// instant the column cannot hold, so the platform keeps the reading as
		// written rather than leaving the backend to decide. 9am stays 9am.
		expect(run('2026-03-08T09:00:00-05:00').data?.startsAt).toBe(
			'2026-03-08T09:00:00',
		)
		expect(run('2026-03-08T09:00:00+01:00').data?.startsAt).toBe(
			'2026-03-08T09:00:00',
		)
		expect(run('2026-03-08T09:00:00Z').data?.startsAt).toBe(
			'2026-03-08T09:00:00',
		)
		expect(run('2026-03-08T09:00-0500').data?.startsAt).toBe('2026-03-08T09:00')
		// A bare date has no reading to move, and a wall clock is already canonical.
		expect(run('2026-03-08').data?.startsAt).toBe('2026-03-08')
		expect(run('2026-03-08T09:00:00').data?.startsAt).toBe(
			'2026-03-08T09:00:00',
		)
	})

	it('reads a Date — an instant — as its UTC wall clock, not as an object', () => {
		expect(run(new Date('2026-03-08T09:00:00Z')).data?.startsAt).toBe(
			'2026-03-08T09:00:00.000',
		)
	})

	it('does not turn the normalizer into a way to smuggle junk past the schema', () => {
		expect(run('2026-03-08 not a time').success).toBe(false)
		expect(run('yesterday').success).toBe(false)
		expect(run('2026-03-08 09:00:00 extra').success).toBe(false)
		expect(run('2026-13-40 09:00:00').success).toBe(false)
		// The date part stays calendar-exact through the date-*time* branch too,
		// so an impossible day is a 422 and not a 500 from the insert.
		expect(run('2026-02-30T09:00:00').success).toBe(false)
		expect(run('2027-02-29T09:00:00').success).toBe(false)
		expect(run('2028-02-29T09:00:00').success).toBe(true)
		expect(run('2026-03-08T25:00:00').success).toBe(false)
	})
})

describe('validateData (update)', () => {
	it('makes every field optional', () => {
		const r = validateData(resource, {}, 'update')
		expect(r.success).toBe(true)
	})

	it('still validates provided fields', () => {
		const r = validateData(resource, { priority: 'nope' }, 'update')
		expect(r.success).toBe(false)
	})
})

describe('validateData — nullable columns through update', () => {
	/** One column of every type: nullable+optional, then the same type required. */
	const book: SproutResource = {
		name: 'book',
		primaryKey: 'id',
		relations: [],
		columns: [
			{
				name: 'id',
				type: 'uuid',
				nullable: false,
				hasDefault: true,
				isPrimaryKey: true,
				meta: {},
			},
			{
				name: 'title',
				type: 'string',
				nullable: false,
				hasDefault: false,
				isPrimaryKey: false,
				meta: { required: true },
			},
			...(['string', 'uuid', 'number', 'boolean', 'date', 'json'] as const).map(
				(type) => ({
					name: `optional_${type}`,
					type,
					nullable: true,
					hasDefault: false,
					isPrimaryKey: false,
					meta: {},
				}),
			),
			{
				name: 'optional_enum',
				type: 'enum' as const,
				enumValues: ['reading', 'finished'],
				nullable: true,
				hasDefault: false,
				isPrimaryKey: false,
				meta: {},
			},
		],
	}

	const nullableNames = book.columns
		.filter((c) => c.nullable)
		.map((c) => c.name)

	it.each(nullableNames)(
		'accepts null for the nullable column %s (422 before)',
		(name) => {
			const r = validateData(book, { [name]: null }, 'update')
			expect(r.success).toBe(true)
			expect(r.data?.[name]).toBeNull()
		},
	)

	it('round-trips a GET row unchanged through the update schema', () => {
		// The point of #257: the API emitted these nulls, so the API must take
		// them back. A read-modify-write is the most obvious thing any client,
		// form, or agent does.
		const readBack = {
			title: 'Piranesi',
			optional_string: null,
			optional_uuid: null,
			optional_number: null,
			optional_boolean: null,
			optional_date: null,
			optional_json: null,
			optional_enum: null,
		}
		expect(validateData(book, readBack, 'update').success).toBe(true)
	})

	it('clears a date column, which had no clearing value at all before', () => {
		// `null` 422'd and `''` 422'd, so "I un-finished this book" was
		// inexpressible through the app's own API.
		expect(validateData(book, { optional_date: null }, 'update').success).toBe(
			true,
		)
	})

	it('still refuses null for a required column', () => {
		const r = validateData(book, { title: null }, 'update')
		expect(r.success).toBe(false)
		expect(r.fieldErrors).toHaveProperty('title')
	})

	it('still refuses a bad non-null value on a nullable column', () => {
		expect(
			validateData(book, { optional_enum: 'nope' }, 'update').success,
		).toBe(false)
		expect(
			validateData(book, { optional_number: 'twelve' }, 'update').success,
		).toBe(false)
	})

	it('agrees with create mode on which columns accept null', () => {
		for (const name of nullableNames) {
			const created = validateData(book, { title: 'x', [name]: null }, 'create')
			const updated = validateData(book, { [name]: null }, 'update')
			expect(updated.success).toBe(created.success)
		}
	})
})

// ===========================================================================
// Refusals sufficient to fix the call
// ===========================================================================

describe('422 bodies are repair instructions', () => {
	const job: SproutResource = {
		name: 'job',
		primaryKey: 'id',
		relations: [],
		columns: [
			{
				name: 'id',
				type: 'uuid',
				nullable: false,
				hasDefault: true,
				isPrimaryKey: true,
				meta: {},
			},
			{
				name: 'title',
				type: 'string',
				nullable: false,
				hasDefault: false,
				isPrimaryKey: false,
				meta: { required: true, maxLength: 40 },
			},
			{
				name: 'finishedOn',
				type: 'date',
				nullable: true,
				hasDefault: false,
				isPrimaryKey: false,
				meta: {},
			},
			{
				name: 'stage',
				type: 'enum',
				enumValues: ['queued', 'running', 'done'],
				nullable: false,
				hasDefault: true,
				isPrimaryKey: false,
				meta: {},
			},
		],
	}

	it('names the expectation, the value received, and a value that works', () => {
		// The old body was {"finishedOn":["Invalid input"]} — no cause, no
		// expectation, no received value. Four probe round-trips and still a guess.
		const r = validateData(job, { finishedOn: 'tomorrow' }, 'update')
		const [message] = r.fieldErrors?.finishedOn ?? []
		expect(message).toMatch(/expected a wall-clock date-time/)
		expect(message).toMatch(/received string "tomorrow"/)
		expect(message).toMatch(/send e\.g\. "2026-07-31T09:00:00"/)
	})

	it('says null clears a nullable column, in the message itself', () => {
		const r = validateData(job, { finishedOn: 'tomorrow' }, 'update')
		expect(r.fieldErrors?.finishedOn?.[0]).toMatch(/null to clear it/)
	})

	it('says a key may be omitted on update, so a client stops sending junk', () => {
		const r = validateData(job, { finishedOn: 'tomorrow' }, 'update')
		expect(r.fieldErrors?.finishedOn?.[0]).toMatch(
			/omit the key to leave it unchanged/,
		)
	})

	it('lists the accepted enum values rather than saying "invalid"', () => {
		const r = validateData(job, { title: 'x', stage: 'urgent' }, 'create')
		const [message] = r.fieldErrors?.stage ?? []
		expect(message).toMatch(/one of "queued" \| "running" \| "done"/)
		expect(message).toMatch(/received string "urgent"/)
	})

	it('states the bound a string broke, not just that it broke one', () => {
		const r = validateData(job, { title: 'x'.repeat(41) }, 'create')
		expect(r.fieldErrors?.title?.[0]).toMatch(/at most 40 characters/)
	})

	it('distinguishes an absent required key from a bad value', () => {
		const r = validateData(job, {}, 'create')
		expect(r.fieldErrors?.title?.[0]).toMatch(
			/received nothing \(the key was absent\)/,
		)
	})

	it('carries a machine-readable contract beside the prose', () => {
		// A client should not have to parse English to know what a column takes.
		const r = validateData(job, { finishedOn: 'tomorrow' }, 'update')
		expect(r.fields?.finishedOn).toMatchObject({
			type: 'date',
			required: false,
			nullable: true,
		})
		expect(r.fields?.finishedOn?.examples).toContain('null')
	})

	it('summarizes the whole refusal in one line, resource and mode included', () => {
		const r = validateData(job, { title: 123, stage: 'nope' }, 'create')
		expect(r.summary).toMatch(/^job create: 2 field\(s\) rejected/)
		expect(r.summary).toMatch(/title/)
		expect(r.summary).toMatch(/stage/)
		expect(r.summary).toMatch(/Nothing was written/)
	})
})
