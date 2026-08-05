import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { author, task } from '../demo/schema.ts'
import type { DocumentPlan } from './documents.ts'
import { generateInputSchema, generateMCPTools } from './mcp.ts'
import { type ResourceConfig, ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'

function registryWith(access?: { task?: ResourceConfig['access'] }) {
	const r = new ResourceRegistry()
	r.register(author)
	r.register(task, { access: access?.task })
	return r
}

/** The same registry, with a declared search index on `task`. */
function registryWithSearch(access?: { task?: ResourceConfig['access'] }) {
	const r = new ResourceRegistry()
	r.register(author)
	r.register(task, {
		access: access?.task,
		search: {
			key: 'task-search',
			language: 'english',
			fields: [{ column: 'title', weight: 'A' }],
			indexed: true,
		},
	})
	return r
}

/** A minimal grounded template. The sections are irrelevant to what these
 * assert — which tools exist and why — so the shape stays the smallest thing
 * that is a `DocumentPlan`. */
function documentPlan(key: string): DocumentPlan {
	return {
		key,
		description: 'A one-page brief.',
		resource: 'task',
		pageSize: 'a4',
		download: true,
		style: {
			font: 'sans',
			accent: '#111111',
			density: 'comfortable',
			typeScale: 'default',
		},
		sections: [{ kind: 'heading', level: 1, text: 'Brief' }],
		values: {},
	}
}

describe('generateInputSchema', () => {
	const r = registryWith()
	const entry = r.get('task')
	if (!entry) throw new Error('task not registered')

	it('omits PK, defaulted timestamp, and defaulted columns in create mode', () => {
		const schema = generateInputSchema(entry, 'create')
		const props = Object.keys(schema.properties)
		expect(props).toContain('title')
		expect(props).toContain('authorId')
		expect(props).not.toContain('id')
		expect(props).not.toContain('createdAt')
		expect(props).not.toContain('done') // has a DB default
	})

	it('marks non-nullable columns as required in create mode', () => {
		const schema = generateInputSchema(entry, 'create')
		expect(schema.required).toContain('title')
		expect(schema.required ?? []).not.toContain('authorId') // nullable
	})

	it('describes enum and FK columns', () => {
		const schema = generateInputSchema(entry, 'create')
		expect(schema.properties.priority).toBeUndefined() // priority has a default
		expect(schema.properties.authorId).toMatchObject({
			description: 'Foreign key to author',
		})
	})
})

/**
 * A registry of `count` entities with `fields` plain columns each — the shape
 * issue #320 measured (12-field entities, admin user, `JSON.stringify({tools})`).
 */
function syntheticRegistry(count: number, fields = 12): ResourceRegistry {
	const r = new ResourceRegistry()
	for (let i = 0; i < count; i++) {
		const columns: Record<string, ReturnType<typeof text>> = {}
		for (let f = 0; f < fields; f++)
			columns[`field${f}`] = withMeta(text(`field${f}`), {
				label: `Field ${f}`,
				description: `The ${f} field of entity ${i}`,
			})
		r.register(
			pgTable(`entity_${i}`, {
				id: uuid('id').primaryKey().defaultRandom(),
				...columns,
			}),
		)
	}
	return r
}

describe('generateMCPTools', () => {
	it('emits one fixed vocabulary, not per-resource tools', async () => {
		const r = registryWith()
		const tools = await generateMCPTools(r, { id: 'a', role: 'admin' })
		const names = tools.map((t) => t.name)
		expect(names).toEqual(
			expect.arrayContaining([
				'describe_resources',
				'list_records',
				'get_record',
				'create_record',
				'update_record',
				'delete_record',
			]),
		)
		// The resource is an argument now — no name carries it.
		expect(names.some((n) => n.endsWith('_task'))).toBe(false)
		expect(names.some((n) => n.endsWith('_author'))).toBe(false)
		for (const tool of tools)
			if (tool.name !== 'describe_resources')
				expect(tool.description).toBeTruthy()
	})

	/**
	 * The regression this issue exists to prevent. The old shape emitted 5–7 tools
	 * per entity with per-field schemas inline: 110 tools / 49KB at 22 entities and
	 * 670 tools / 299KB at 134 — ~2.8× the payload a client already refuses. The
	 * bound is asserted on the *connect* payload, because that is what a client
	 * loads before the agent has asked for anything, and a client that truncates
	 * it does not say what it dropped.
	 */
	it('keeps tools/list bounded as entity count grows', async () => {
		const admin = { id: 'a', role: 'admin' }
		const one = await generateMCPTools(syntheticRegistry(1), admin)
		const many = await generateMCPTools(syntheticRegistry(134), admin)
		// Not "grows slowly" — identical. The vocabulary is a constant.
		expect(many.map((t) => t.name)).toEqual(one.map((t) => t.name))
		expect(many.length).toBeLessThanOrEqual(12)
		const bytes = JSON.stringify({ tools: many }).length
		expect(bytes).toBeLessThan(8_000)
		// And the 134-entity payload is no larger than the 1-entity one except for
		// the resource count quoted in describe_resources' description.
		expect(bytes - JSON.stringify({ tools: one }).length).toBeLessThan(50)
	})

	it('offers search_records only where some index is declared', async () => {
		// A tool that existed with nothing behind it would teach an agent to try
		// search first and fall back — a round trip per session. `describe_resources`
		// carries which resources actually declare an index.
		const withIndex = await generateMCPTools(registryWithSearch(), {
			id: 'a',
			role: 'admin',
		})
		expect(withIndex.map((t) => t.name)).toContain('search_records')
		const without = await generateMCPTools(registryWith(), {
			id: 'a',
			role: 'admin',
		})
		expect(without.map((t) => t.name)).not.toContain('search_records')
		const search = withIndex.find((t) => t.name === 'search_records')
		expect(search?.inputSchema.required).toEqual(['resource', 'query'])
		expect(Object.keys(search?.inputSchema.properties ?? {})).toEqual([
			'resource',
			'query',
			'limit',
			'offset',
		])
	})

	/**
	 * Issue #222. #176 shipped declared documents with a URL and no tool, which
	 * is an asymmetry with #174's `search_<table>` that the next person was
	 * always going to re-litigate. The recorded answer is: a tool, gated the same
	 * way, that never returns bytes — see `RENDER_DOCUMENT_SCHEMA`.
	 */
	it('offers render_document only when some template declares a download', async () => {
		const r = new ResourceRegistry()
		r.register(author)
		r.register(task, {
			documents: [
				// Retired: no URL, and therefore no tool. One flag decides both.
				{ ...documentPlan('task-archive'), download: false },
			],
		})
		expect(
			(await generateMCPTools(r, { id: 'a', role: 'admin' })).map(
				(t) => t.name,
			),
		).not.toContain('render_document')

		const r2 = new ResourceRegistry()
		r2.register(task, {
			documents: [{ ...documentPlan('task-brief'), download: true }],
		})
		expect(
			(await generateMCPTools(r2, { id: 'a', role: 'admin' })).map(
				(t) => t.name,
			),
		).toContain('render_document')
	})

	it('gates render_document on read, so it is not a second door into the row', async () => {
		const r = new ResourceRegistry()
		r.register(task, {
			access: { read: 'admin' },
			documents: [{ ...documentPlan('task-brief'), download: true }],
		})
		const names = (await generateMCPTools(r, { id: 'u', role: 'member' })).map(
			(t) => t.name,
		)
		expect(names).not.toContain('render_document')
	})

	it('gates search on read, so it reaches exactly what list reaches', async () => {
		const tools = await generateMCPTools(
			registryWithSearch({ task: { read: 'admin' } }),
			{ id: 'u', role: 'member' },
		)
		expect(tools.map((t) => t.name)).not.toContain('search_records')
	})

	/**
	 * Row-less gating survives the reshape: a verb is offered when *some*
	 * reachable resource permits it, and `describe_resources` reports per resource
	 * which actions the caller may perform — computed with the same
	 * `canPerformAction`, still with no row fetched.
	 */
	it('RBAC-gates the vocabulary (row-less) — a delete nobody may do is hidden', async () => {
		const r = new ResourceRegistry()
		r.register(task, { access: { delete: 'admin' } })
		const names = (await generateMCPTools(r, { id: 'u', role: 'member' })).map(
			(t) => t.name,
		)
		expect(names).toContain('list_records')
		expect(names).not.toContain('delete_record')
	})

	it('offers nothing but the vocabulary when a resource is entirely unreachable', async () => {
		const r = new ResourceRegistry()
		r.register(task, {
			access: {
				read: 'admin',
				create: 'admin',
				update: 'admin',
				delete: 'admin',
			},
		})
		const names = (await generateMCPTools(r, { id: 'u', role: 'member' })).map(
			(t) => t.name,
		)
		expect(names).toEqual([])
	})
})
