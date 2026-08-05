/**
 * The `name:type[!]` field DSL — the parse layer behind
 * `add-entity`/`add-field`. Proves each type alias, enum, reference, and the
 * required-`!` marker compile to the right FieldSpec, and that bad input is
 * rejected with a readable message before any op is built.
 */

import { describe, expect, it } from 'vitest'
import {
	buildEntity,
	buildPage,
	entityIdFor,
	parseField,
	titleCase,
} from './field-dsl.ts'

describe('parseField', () => {
	it('maps type aliases to the canonical FieldType', () => {
		expect(parseField('task', 'title:text').type).toBe('string')
		expect(parseField('task', 'title:string').type).toBe('string')
		expect(parseField('task', 'count:int').type).toBe('number')
		expect(parseField('task', 'count:number').type).toBe('number')
		expect(parseField('task', 'done:bool').type).toBe('boolean')
		expect(parseField('task', 'at:date').type).toBe('date')
		expect(parseField('task', 'blob:json').type).toBe('json')
	})

	it('marks a trailing ! as required and namespaces the id under the entity', () => {
		const f = parseField('task', 'title:text!')
		expect(f.required).toBe(true)
		expect(f.id).toBe('fld-task-title')
		expect(parseField('task', 'title:text').required).toBe(false)
	})

	it('allows camelCase field names', () => {
		expect(parseField('sub', 'renewsOn:date!').name).toBe('renewsOn')
		expect(parseField('sub', 'renewsOn:date!').id).toBe('fld-sub-renewsOn')
	})

	it('parses enum(...) into an option list', () => {
		const f = parseField('task', 'priority:enum(low,med,high)')
		expect(f.type).toBe('enum')
		expect(f.options).toEqual([
			{ label: 'low', value: 'low' },
			{ label: 'med', value: 'med' },
			{ label: 'high', value: 'high' },
		])
	})

	it('parses a belongs-to reference (ref: and -> forms)', () => {
		const a = parseField('post', 'author:ref:e-user')
		expect(a.type).toBe('string')
		expect(a.reference).toBe('e-user')
		expect(parseField('post', 'author:->e-user').reference).toBe('e-user')
	})

	it('carries human (manual) provenance — accepted + regen-protected', () => {
		const p = parseField('task', 'title:text!').provenance
		expect(p.isAccepted).toBe(true)
		expect(p.isAddedManually).toBe(true)
	})

	it('rejects malformed specs', () => {
		expect(() => parseField('task', 'title')).toThrow(/expected name:type/)
		expect(() => parseField('task', 'title:mystery')).toThrow(/unknown field type/)
		expect(() => parseField('task', 'title:enum()')).toThrow(/at least one option/)
		expect(() => parseField('task', 'Title:text')).toThrow(/invalid field name/)
		expect(() => parseField('task', 'x:ref:user')).toThrow(/must target an entity id/)
	})

	// #280: `--field owner:->e-user` unquoted reaches us as `owner:-` because the
	// shell ate the arrow as a redirect. The old message named the type `-`,
	// which is the one thing the user did not write.
	it('names the shell redirect when an unquoted -> was eaten', () => {
		expect(() => parseField('post', 'owner:-')).toThrow(/unquoted "->"/)
		expect(() => parseField('post', 'owner:-')).toThrow(/Quote the argument/)
	})
})

describe('buildEntity', () => {
	it('builds an EntitySpec with e--prefixed id and parsed fields', () => {
		const e = buildEntity('task', 'Task', ['title:text!', 'done:bool'])
		expect(e.id).toBe('e-task')
		expect(e.name).toBe('Task')
		expect(e.fields.map((f) => f.name)).toEqual(['title', 'done'])
		expect(e.provenance.isAddedManually).toBe(true)
	})

	it('rejects a duplicate field name and a bad slug', () => {
		expect(() => buildEntity('task', 'Task', ['title:text', 'title:bool'])).toThrow(
			/duplicate field/,
		)
		expect(() => buildEntity('Task', 'Task', ['title:text'])).toThrow(
			/invalid entity id/,
		)
	})
})

describe('buildPage', () => {
	it('builds a default list page from a slug', () => {
		const p = buildPage('task')
		expect(p.id).toBe('pg-task')
		expect(p.name).toBe('Task')
		expect(p.route).toBe('/task')
		expect(p.entityId).toBe('e-task')
		expect(p.blocks.map((b) => b.type)).toEqual(['table'])
		expect(p.provenance.isAddedManually).toBe(true)
		expect(p.blocks[0]!.provenance!.isAddedManually).toBe(true)
	})

	it('honors overrides and rejects a bad slug', () => {
		const p = buildPage('task', {
			name: 'Today',
			route: '/today',
			id: 'pg-today',
		})
		expect(p.id).toBe('pg-today')
		expect(p.name).toBe('Today')
		expect(p.route).toBe('/today')
		expect(() => buildPage('Task')).toThrow(/invalid entity id/)
	})
})

describe('helpers', () => {
	it('entityIdFor + titleCase', () => {
		expect(entityIdFor('task')).toBe('e-task')
		expect(titleCase('task')).toBe('Task')
	})
})
