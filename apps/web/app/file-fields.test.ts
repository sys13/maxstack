/**
 * Declared file fields, end to end through the app's own layers:
 * a spec `file` field → a grounded shape → a real column with the declaration
 * on it → the DDL → the signed-URL resolution the loaders hand to the UI.
 *
 * This is the seam the unit tests in `@maxstack/spec` and
 * `@maxstack/features/storage` cannot cover on their own: each of them is
 * correct about its own half, and the interesting failure is the declaration
 * silently not arriving at the column the upload route reads it off.
 */

import {
	introspectTable,
	type SpecEntityShape,
	specSchemaDdl,
	tableFromSpecEntity,
} from '@maxstack/core'
import {
	type EntitySpec,
	type FieldSpec,
	newSpecSystem,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { groundedEntityShapes } from './spec-sprout'

const coverField: FieldSpec = {
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
}

const post: EntitySpec = {
	id: 'e-post',
	name: 'Post',
	provenance: suggested(),
	fields: [
		{
			id: 'fld-post-title',
			name: 'title',
			type: 'string',
			required: true,
			provenance: suggested(),
		},
		coverField,
	],
}

function specWith(entities: EntitySpec[]): SpecSystem {
	return { ...newSpecSystem(tasklyPRD), data: { entities } }
}

/**
 * The introspected `post.cover` column — read through `introspectTable`, the
 * same path the registry and the upload route use, rather than off the drizzle
 * builder's internals. A test that reached into the internals could pass while
 * the surface everything actually consumes was empty.
 */
function coverColumn(entity: EntitySpec = post) {
	const [shape] = groundedEntityShapes(specWith([entity]))
	const resource = introspectTable(
		tableFromSpecEntity(shape as SpecEntityShape),
	)
	const column = resource.columns.find((c) => c.name === 'cover')
	if (!column) throw new Error('cover column missing from introspection')
	return column
}

describe('a spec file field reaches the runtime as a declared file column', () => {
	it('grounds with its declaration intact', () => {
		const [shape] = groundedEntityShapes(specWith([post]))
		const cover = shape?.fields.find((f) => f.name === 'cover')
		expect(cover?.type).toBe('file')
		expect(cover?.file).toEqual({
			accept: ['image/png', 'image/jpeg'],
			maxSizeBytes: 5 * 1024 * 1024,
			derivatives: [{ name: 'thumb', width: 320 }],
		})
	})

	it('materializes as a text column carrying the allowlist, the cap and the variants', () => {
		// This is what the upload route reads to build its server-side wall. If
		// any of it stops arriving, uploads fall back to nothing enforceable —
		// which the route refuses rather than papering over.
		const { meta, type } = coverColumn()
		expect(type).toBe('string')
		expect(meta.isFile).toBe(true)
		expect(meta.fileAccept).toBe('image/png,image/jpeg')
		expect(meta.fileMaxSize).toBe(5 * 1024 * 1024)
		expect(meta.fileDerivatives).toEqual([{ name: 'thumb', width: 320 }])
		// The resource name travels too, so the widget can name the field it is
		// uploading for and the server can find this very declaration.
		expect(meta.fileResource).toBe('post')
	})

	it('is a text column in the DDL — it stores a key, never the bytes', () => {
		const ddl = specSchemaDdl(groundedEntityShapes(specWith([post])))
		expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "cover" text;')
		expect(ddl).not.toContain('bytea')
	})

	it('a file field with no declaration degrades to plain text, not an open uploader', () => {
		// Unreachable from a validated spec (`fieldFileErrors` requires the block),
		// but the bridge must not invent an unbounded upload widget if it happens.
		const bare: EntitySpec = {
			...post,
			fields: [{ ...coverField, file: undefined }],
		}
		expect(coverColumn(bare).meta.isFile).toBeUndefined()
	})
})
