import { describe, expect, it } from 'vitest'
import { article, author, task } from '../demo/schema.ts'
import { type SpecEntityShape, tableFromSpecEntity } from './from-spec.ts'
import { introspectTable } from './introspection.ts'

describe('introspectTable', () => {
	const resource = introspectTable(task)
	const byName = (n: string) => {
		const c = resource.columns.find((col) => col.name === n)
		if (!c) throw new Error(`no column ${n}`)
		return c
	}

	it('reads the table name and primary key', () => {
		expect(resource.name).toBe('task')
		expect(resource.primaryKey).toBe('id')
	})

	it('infers column types', () => {
		expect(byName('id').type).toBe('uuid')
		expect(byName('title').type).toBe('string')
		expect(byName('done').type).toBe('boolean')
		expect(byName('priority').type).toBe('enum')
		expect(byName('createdAt').type).toBe('date')
	})

	it('captures enum values', () => {
		expect(byName('priority').enumValues).toEqual(['low', 'medium', 'high'])
	})

	it('captures nullability and defaults', () => {
		expect(byName('title').nullable).toBe(false)
		expect(byName('authorId').nullable).toBe(true)
		expect(byName('done').hasDefault).toBe(true)
		expect(byName('id').isPrimaryKey).toBe(true)
	})

	it('extracts the inline foreign key', () => {
		expect(byName('authorId').references).toEqual({
			table: 'author',
			column: 'id',
		})
	})

	it('builds the belongs-to relation graph (improvement over always-[])', () => {
		expect(resource.relations).toEqual([
			{
				name: 'author',
				type: 'many-to-one',
				column: 'authorId',
				references: { table: 'author', column: 'id' },
			},
		])
	})

	it('preserves attached metadata', () => {
		expect(byName('title').meta).toMatchObject({
			label: 'Title',
			placeholder: 'What needs doing?',
			maxLength: 200,
			required: true,
		})
	})

	it('introspects a table with no relations cleanly', () => {
		const a = introspectTable(author)
		expect(a.name).toBe('author')
		expect(a.relations).toEqual([])
		expect(a.columns.map((c) => c.name)).toEqual(['id', 'name'])
	})
})

/**
 * Issue #209 — the relation graph was built from drizzle's foreign-key map
 * alone, so it was empty for every *spec-driven* project (i.e. every maxstack
 * project): a spec entity's reference arrives as column metadata, not as a
 * drizzle FK. `column.references` was populated the whole time while
 * `relations` said the project had no relationships.
 *
 * These tests pin the graph to the columns, which is the only place both kinds
 * of reference are resolved.
 */
describe('the relation graph covers spec references, not just drizzle FKs', () => {
	/** A spec entity shaped the way `groundedEntityShapes` hands them over. */
	const bug: SpecEntityShape = {
		name: 'bug',
		fields: [
			{ name: 'title', type: 'string', required: true },
			{
				name: 'projectId',
				type: 'string',
				required: false,
				reference: { table: 'project', column: 'id', displayField: 'name' },
			},
			{
				name: 'reporterId',
				type: 'string',
				required: false,
				// A bundle infra table: text ids, not uuid.
				reference: { table: 'user', column: 'id', idType: 'text' },
			},
		],
	}

	const resource = introspectTable(tableFromSpecEntity(bug))

	it('names an edge for every spec reference', () => {
		// This is the assertion that was failing in fact: `relations` was `[]`.
		expect(resource.relations).toEqual([
			{
				name: 'project',
				type: 'many-to-one',
				column: 'projectId',
				references: { table: 'project', column: 'id' },
			},
			{
				name: 'reporter',
				type: 'many-to-one',
				column: 'reporterId',
				references: { table: 'user', column: 'id' },
			},
		])
	})

	it('agrees with column.references — the two can no longer disagree', () => {
		const fromColumns = resource.columns
			.filter((c) => c.references)
			.map((c) => c.name)
		expect(resource.relations.map((r) => r.column)).toEqual(fromColumns)
	})

	it('keeps presentation and DDL concerns off the edge', () => {
		// `displayField` / `idType` stay on the column; an edge is for traversal.
		expect(Object.keys(resource.relations[0]?.references ?? {}).sort()).toEqual(
			['column', 'table'],
		)
	})

	it('still has no edges for an entity that references nothing', () => {
		const plain: SpecEntityShape = {
			name: 'note',
			fields: [{ name: 'body', type: 'string', required: true }],
		}
		expect(introspectTable(tableFromSpecEntity(plain)).relations).toEqual([])
	})

	it('represents an array reference as many-to-many, not as a scalar edge', () => {
		// `article.tags` holds a *list* of tag ids (task 38). A walker that read
		// it as one id would silently take the first.
		const relation = introspectTable(article).relations.find(
			(r) => r.column === 'tags',
		)
		expect(relation).toEqual({
			name: 'tags',
			type: 'many-to-many',
			column: 'tags',
			references: { table: 'tag', column: 'id' },
		})
	})
})
