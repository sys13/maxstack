/**
 * @vitest-environment node
 *
 * No DOM in this file. The package default is `jsdom`, which costs
 * ~400ms of environment construction per file — the dominant term in this suite's
 * CPU, and the contention that starved a synchronous render past its timeout on a
 * 2-core runner. A test that never renders should not pay for a document.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type FormFieldConfig, zodToFormFields } from './zod-to-form-fields.ts'

/** Find a top-level field by path. */
function field(fields: FormFieldConfig[], path: string): FormFieldConfig {
	const f = fields.find((x) => x.path === path)
	if (!f)
		throw new Error(`no field "${path}" in [${fields.map((x) => x.path)}]`)
	return f
}

describe('zodToFormFields — type detection', () => {
	it('detects the primitive widgets', () => {
		const fields = zodToFormFields(
			z.object({
				name: z.string(),
				age: z.number(),
				active: z.boolean(),
				role: z.enum(['admin', 'user']),
			}),
		)
		expect(field(fields, 'name').type).toBe('text')
		expect(field(fields, 'age').type).toBe('number')
		expect(field(fields, 'active').type).toBe('checkbox')
		expect(field(fields, 'role').type).toBe('select')
		expect(field(fields, 'role').options).toEqual(['admin', 'user'])
	})

	it('auto-detects email, url, and date (the original could not)', () => {
		const fields = zodToFormFields(
			z.object({
				email: z.email(),
				emailLegacy: z.string().email(),
				site: z.url(),
				born: z.date(),
				bornIso: z.iso.datetime(),
			}),
		)
		expect(field(fields, 'email').type).toBe('email')
		expect(field(fields, 'emailLegacy').type).toBe('email')
		expect(field(fields, 'site').type).toBe('url')
		expect(field(fields, 'born').type).toBe('date')
		expect(field(fields, 'bornIso').type).toBe('date')
	})

	it('auto-detects file inputs', () => {
		const fields = zodToFormFields(z.object({ avatar: z.file() }))
		expect(field(fields, 'avatar').type).toBe('file')
	})

	it('auto-detects specialty widgets from name and type (task 39)', () => {
		const fields = zodToFormFields(
			z.object({
				password: z.string(),
				apiPassword: z.string(),
				brandColor: z.string(),
				bodyHtml: z.string(),
				latlng: z.string(),
				rating: z.number(),
				durationSeconds: z.number(),
				metadata: z.record(z.string(), z.unknown()),
			}),
		)
		expect(field(fields, 'password').type).toBe('password')
		expect(field(fields, 'apiPassword').type).toBe('password')
		expect(field(fields, 'brandColor').type).toBe('color')
		expect(field(fields, 'bodyHtml').type).toBe('richtext')
		expect(field(fields, 'latlng').type).toBe('geo')
		expect(field(fields, 'rating').type).toBe('rating')
		expect(field(fields, 'durationSeconds').type).toBe('duration')
		// json columns (`z.record`) used to fall through to `null` and vanish.
		expect(field(fields, 'metadata').type).toBe('json')
	})

	it('renders a json column schema as one JSON textarea, not a branch picker', () => {
		// The exact shape `generateValidationSchema` emits for a `json` column:
		// a string-parsing preprocess piped into a record | array-guard union.
		const jsonColumn = z.preprocess(
			(v) => v,
			z.union(
				[
					z.record(z.string(), z.unknown()),
					z.custom<unknown[]>((v) => Array.isArray(v)),
				],
				{ error: 'Expected a JSON object or array' },
			),
		)
		const fields = zodToFormFields(
			z.object({
				extras: jsonColumn,
				extrasOptional: jsonColumn.nullable().optional(),
				plainArray: z.union([
					z.record(z.string(), z.unknown()),
					z.array(z.unknown()),
				]),
			}),
		)
		expect(field(fields, 'extras').type).toBe('json')
		expect(field(fields, 'extrasOptional').type).toBe('json')
		expect(field(fields, 'extrasOptional').required).toBe(false)
		expect(field(fields, 'plainArray').type).toBe('json')
	})
})

describe('zodToFormFields — optional / nullable (the biggest gap)', () => {
	it('keeps optional and nullable fields instead of dropping them', () => {
		const fields = zodToFormFields(
			z.object({
				required: z.string(),
				maybe: z.string().optional(),
				nullable: z.string().nullable(),
			}),
		)
		expect(fields.map((f) => f.path)).toEqual(['required', 'maybe', 'nullable'])
	})

	it('marks required correctly (required only when not optional/nullable/defaulted)', () => {
		const fields = zodToFormFields(
			z.object({
				required: z.string(),
				maybe: z.string().optional(),
				nullable: z.string().nullable(),
				defaulted: z.string().default('x'),
			}),
		)
		expect(field(fields, 'required').required).toBe(true)
		expect(field(fields, 'maybe').required).toBe(false)
		expect(field(fields, 'maybe').optional).toBe(true)
		expect(field(fields, 'nullable').required).toBe(false)
		expect(field(fields, 'nullable').nullable).toBe(true)
		expect(field(fields, 'defaulted').required).toBe(false)
	})
})

describe('zodToFormFields — defaults', () => {
	it('resolves a ZodDefault value without touching _def internals', () => {
		const fields = zodToFormFields(
			z.object({
				plan: z.enum(['free', 'pro']).default('pro'),
				count: z.number().default(3),
			}),
		)
		expect(field(fields, 'plan').defaultValue).toBe('pro')
		expect(field(fields, 'count').defaultValue).toBe(3)
	})

	it('unwraps optional+default combinations', () => {
		const fields = zodToFormFields(
			z.object({ nick: z.string().default('anon').optional() }),
		)
		expect(field(fields, 'nick').type).toBe('text')
		expect(field(fields, 'nick').defaultValue).toBe('anon')
	})
})

describe('zodToFormFields — nested objects (was broken)', () => {
	it('produces a child tree, not flat dotted keys', () => {
		const fields = zodToFormFields(
			z.object({
				address: z.object({ street: z.string(), city: z.string() }),
			}),
		)
		const address = field(fields, 'address')
		expect(address.type).toBe('object')
		expect(address.fields?.map((f) => f.path)).toEqual([
			'address.street',
			'address.city',
		])
	})
})

describe('zodToFormFields — arrays', () => {
	it('collapses array(enum) to a multi-select', () => {
		const fields = zodToFormFields(
			z.object({ tags: z.array(z.enum(['a', 'b', 'c'])) }),
		)
		const tags = field(fields, 'tags')
		expect(tags.type).toBe('multi-select')
		expect(tags.options).toEqual(['a', 'b', 'c'])
	})

	it('emits a repeater element template for general arrays (was unimplemented)', () => {
		const fields = zodToFormFields(z.object({ aliases: z.array(z.string()) }))
		const aliases = field(fields, 'aliases')
		expect(aliases.type).toBe('array')
		expect(aliases.element?.type).toBe('text')
		expect(aliases.element?.path).toBe('aliases[]')
	})

	it('supports array-of-object repeaters', () => {
		const fields = zodToFormFields(
			z.object({
				lineItems: z.array(z.object({ sku: z.string(), qty: z.number() })),
			}),
		)
		const items = field(fields, 'lineItems')
		expect(items.type).toBe('array')
		expect(items.element?.type).toBe('object')
		expect(items.element?.fields?.map((f) => f.type)).toEqual([
			'text',
			'number',
		])
	})
})

describe('zodToFormFields — unions (was unhandled)', () => {
	it('collapses a scalar-encoding union to one widget (the date-column shape)', () => {
		// The exact schema `generateValidationSchema` emits for a `date` column:
		// two accepted encodings of one value (a zone-less wall clock, or a bare
		// date dropped the `z.date()` branch). Must render as a
		// single date input, not a discriminated branch picker with a mangled
		// nested name.
		const fields = zodToFormFields(
			z.object({
				postedAt: z.iso.datetime({ local: true }).or(z.iso.date()),
			}),
		)
		const postedAt = field(fields, 'postedAt')
		expect(postedAt.type).toBe('date')
		expect(postedAt.path).toBe('postedAt')
		expect(postedAt.branches).toBeUndefined()
	})

	it('emits a branch list', () => {
		const fields = zodToFormFields(
			z.object({
				payment: z.union([
					z.object({ card: z.string() }),
					z.object({ iban: z.string() }),
				]),
			}),
		)
		const payment = field(fields, 'payment')
		expect(payment.type).toBe('union')
		expect(payment.branches).toHaveLength(2)
		expect(payment.branches?.[0]?.fields?.[0]?.path).toBe('payment.card')
	})
})

describe('zodToFormFields — labels', () => {
	it('uses .describe() text, else a humanized leaf key', () => {
		const fields = zodToFormFields(
			z.object({
				firstName: z.string(),
				last_name: z.string(),
				email: z.string().describe('Email address'),
			}),
		)
		expect(field(fields, 'firstName').label).toBe('First Name')
		expect(field(fields, 'last_name').label).toBe('Last Name')
		expect(field(fields, 'email').label).toBe('Email address')
	})
})
