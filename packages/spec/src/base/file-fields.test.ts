/**
 * Declared file fields — the validator that makes "the server
 * enforces an allowlist and a size cap" a property of the *vocabulary* rather
 * than something each app remembers to wire.
 *
 * The bar these tests hold: a file field that would accept anything, or accept
 * an unbounded number of bytes, must be unspellable — `validateOp` refuses it
 * and `applyOp` throws, so it can never reach a spec, a column, or an upload
 * handler.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import { suggested } from './provenance.ts'
import {
	type ApplyMeta,
	applyOp,
	type FieldSpecInput,
	SPEC_OP_VOCABULARY,
	type SpecOp,
	validateOp,
} from './spec-ops.ts'
import {
	acceptsContentType,
	FIELD_TYPES,
	FILE_DERIVATIVE_MAX_DIMENSION,
	FILE_MAX_SIZE_CEILING,
	isAcceptPattern,
	isImageAcceptPattern,
	newSpecSystem,
	type SpecSystem,
} from './spec-system.ts'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-${n}`,
	origin: 'ai',
	appliedAt: '2026-07-26',
})

/** A spec with one entity to hang file fields off. */
function specWithEntity(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-post',
					name: 'Post',
					fields: [
						{
							id: 'fld-post-title',
							name: 'title',
							type: 'string',
							required: true,
							provenance: suggested(),
						},
					],
					provenance: suggested(),
				},
			},
		},
		meta(1),
	)
}

const addField = (field: FieldSpecInput): SpecOp => ({
	op: 'data.addField',
	args: { entityId: 'e-post', field },
})

/** A well-formed cover-image field — the shape every negative case perturbs. */
const coverImage = (
	overrides: Partial<FieldSpecInput> = {},
): FieldSpecInput => ({
	id: 'fld-post-cover',
	name: 'cover',
	type: 'file',
	required: false,
	file: {
		accept: ['image/png', 'image/jpeg'],
		maxSizeBytes: 5 * 1024 * 1024,
		derivatives: [{ name: 'thumb', width: 320 }],
	},
	provenance: suggested(),
	...overrides,
})

describe('file is a canonical field type', () => {
	it('is in FIELD_TYPES, so an op arriving as JSON passes the runtime guard', () => {
		expect(FIELD_TYPES).toContain('file')
	})

	it('is self-described in the MCP vocabulary, with both limits required', () => {
		const field = SPEC_OP_VOCABULARY['data.addField'].args.properties.field
		expect(field?.properties?.type?.enum).toContain('file')
		expect(field?.properties?.file?.required).toEqual([
			'accept',
			'maxSizeBytes',
		])
	})
})

describe('a valid file field', () => {
	it('validates, applies, and round-trips its declaration onto the entity', () => {
		const spec = specWithEntity()
		const op = addField(coverImage())
		expect(validateOp(spec, op)).toEqual([])

		const next = applyOp(spec, op, meta(2))
		const stored = next.data.entities
			.find((e) => e.id === 'e-post')
			?.fields.find((f) => f.id === 'fld-post-cover')
		expect(stored?.type).toBe('file')
		expect(stored?.file).toEqual({
			accept: ['image/png', 'image/jpeg'],
			maxSizeBytes: 5 * 1024 * 1024,
			derivatives: [{ name: 'thumb', width: 320 }],
		})
	})

	it('accepts a wildcard subtype and a derivative with both bounds', () => {
		expect(
			validateOp(
				specWithEntity(),
				addField(
					coverImage({
						file: {
							accept: ['image/*'],
							maxSizeBytes: 1024,
							derivatives: [
								{ name: 'thumb', width: 320, height: 320, fit: 'cover' },
							],
						},
					}),
				),
			),
		).toEqual([])
	})

	it('accepts a non-image file field with no derivatives', () => {
		expect(
			validateOp(
				specWithEntity(),
				addField(
					coverImage({
						id: 'fld-post-attachment',
						name: 'attachment',
						file: { accept: ['application/pdf'], maxSizeBytes: 1024 },
					}),
				),
			),
		).toEqual([])
	})
})

describe('an unbounded file field is unspellable', () => {
	const rejects = (field: FieldSpecInput, match: RegExp) => {
		const spec = specWithEntity()
		const errors = validateOp(spec, addField(field))
		expect(errors.join('\n')).toMatch(match)
		// The op path and the apply path agree — a bad field cannot slip through
		// by being applied directly rather than validated first.
		expect(() => applyOp(spec, addField(field), meta(2))).toThrow()
	}

	it('refuses a file field with no declaration at all', () => {
		rejects(coverImage({ file: undefined }), /must declare "file"/)
	})

	it('refuses an empty or missing accept allowlist', () => {
		rejects(
			coverImage({ file: { accept: [], maxSizeBytes: 1024 } }),
			/"file\.accept" must be a non-empty array/,
		)
	})

	it('refuses a bare wildcard — "allow everything" is not a policy', () => {
		rejects(
			coverImage({
				file: { accept: ['*/*'] as string[], maxSizeBytes: 1024 },
			}),
			/cannot be a bare wildcard/,
		)
	})

	it('refuses a malformed MIME pattern', () => {
		rejects(
			coverImage({ file: { accept: ['image'], maxSizeBytes: 1024 } }),
			/must be a MIME type or one-level wildcard/,
		)
	})

	it('refuses a missing, zero, or non-integer size cap', () => {
		for (const cap of [undefined, 0, -1, 1.5]) {
			rejects(
				coverImage({
					file: {
						accept: ['image/png'],
						maxSizeBytes: cap as number,
					},
				}),
				/"file\.maxSizeBytes" must be a positive integer/,
			)
		}
	})

	it('refuses a cap past the ceiling', () => {
		rejects(
			coverImage({
				file: {
					accept: ['image/png'],
					maxSizeBytes: FILE_MAX_SIZE_CEILING + 1,
				},
			}),
			/exceeds the \d+-byte ceiling/,
		)
	})
})

describe('derivatives are checked against what they resize', () => {
	const rejects = (field: FieldSpecInput, match: RegExp) => {
		expect(validateOp(specWithEntity(), addField(field)).join('\n')).toMatch(
			match,
		)
	}

	it('refuses derivatives on an allowlist that admits non-images', () => {
		rejects(
			coverImage({
				file: {
					accept: ['image/png', 'application/pdf'],
					maxSizeBytes: 1024,
					derivatives: [{ name: 'thumb', width: 320 }],
				},
			}),
			/needs an image-only "accept" allowlist/,
		)
	})

	it('refuses a duplicate derivative name — keys would collide', () => {
		rejects(
			coverImage({
				file: {
					accept: ['image/png'],
					maxSizeBytes: 1024,
					derivatives: [
						{ name: 'thumb', width: 320 },
						{ name: 'thumb', width: 640 },
					],
				},
			}),
			/"thumb" is declared twice/,
		)
	})

	it('refuses a name that is not a key-safe slug', () => {
		rejects(
			coverImage({
				file: {
					accept: ['image/png'],
					maxSizeBytes: 1024,
					derivatives: [{ name: 'Thumb Nail', width: 320 }],
				},
			}),
			/must be a lowercase slug/,
		)
	})

	it('refuses a dimension past the amplification ceiling', () => {
		rejects(
			coverImage({
				file: {
					accept: ['image/png'],
					maxSizeBytes: 1024,
					derivatives: [
						{ name: 'huge', width: FILE_DERIVATIVE_MAX_DIMENSION + 1 },
					],
				},
			}),
			/must be an integer between 1 and/,
		)
	})
})

describe('the file declaration belongs to file fields only', () => {
	it('refuses a file block on a string field — a constraint nothing enforces', () => {
		expect(
			validateOp(
				specWithEntity(),
				addField(
					coverImage({
						type: 'string',
						file: { accept: ['image/png'], maxSizeBytes: 1024 },
					}),
				),
			).join('\n'),
		).toMatch(/only a field of type "file" may declare "file" constraints/)
	})

	it('refuses a file field that is also a reference', () => {
		expect(
			validateOp(
				specWithEntity(),
				addField(coverImage({ reference: 'e-post' })),
			).join('\n'),
		).toMatch(/cannot also be a reference/)
	})

	it('applies the same guard to every field of data.addEntity', () => {
		expect(
			validateOp(newSpecSystem(tasklyPRD), {
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-doc',
						name: 'Doc',
						fields: [
							{
								id: 'fld-doc-body',
								name: 'body',
								type: 'file',
								required: true,
								provenance: suggested(),
							},
						],
						provenance: suggested(),
					},
				},
			}).join('\n'),
		).toMatch(/must declare "file"/)
	})
})

describe('the accept matcher is shared by the client hint and the server wall', () => {
	it('matches exact types and one-level wildcards, and ignores parameters', () => {
		expect(acceptsContentType(['image/png'], 'image/png')).toBe(true)
		expect(acceptsContentType(['image/png'], 'image/jpeg')).toBe(false)
		expect(acceptsContentType(['image/*'], 'image/webp')).toBe(true)
		expect(acceptsContentType(['image/*'], 'application/pdf')).toBe(false)
		expect(acceptsContentType(['text/csv'], 'text/csv; charset=utf-8')).toBe(
			true,
		)
		expect(acceptsContentType(['image/PNG'], 'IMAGE/png')).toBe(true)
	})

	it('never matches an empty allowlist — closed by default', () => {
		expect(acceptsContentType([], 'image/png')).toBe(false)
	})

	it('classifies patterns', () => {
		expect(isAcceptPattern('image/*')).toBe(true)
		expect(isAcceptPattern('application/vnd.api+json')).toBe(true)
		expect(isAcceptPattern('image')).toBe(false)
		expect(isImageAcceptPattern('image/png')).toBe(true)
		expect(isImageAcceptPattern('video/mp4')).toBe(false)
	})
})
