import { describe, expect, it } from 'vitest'
import {
	type AiClient,
	blueprintFromDescription,
	describeApp,
	emptyUsage,
	normalizeBlueprint,
	parseBlueprint,
	projectSlug,
} from './index.ts'
import { mockAiClient } from './mocks/openai.ts'

/** An `AiClient` that answers with a fixed string — the keyed path, hermetically. */
function fixedClient(text: string): AiClient {
	return {
		usage: () => emptyUsage(),
		complete: async () => text,
	}
}

function failingClient(message: string): AiClient {
	return {
		usage: () => emptyUsage(),
		complete: async () => {
			throw new Error(message)
		},
	}
}

describe('blueprintFromDescription', () => {
	it('is a pure function of the description', () => {
		const a = blueprintFromDescription('a bug tracker for small teams')
		const b = blueprintFromDescription('a bug tracker for small teams')
		expect(JSON.stringify(a)).toBe(JSON.stringify(b))
	})

	it('matches a lexicon domain and wires the reference between its entities', () => {
		const bp = blueprintFromDescription('a bug tracker for small teams')
		expect(bp.entities.map((e) => e.slug)).toEqual(['project', 'bug'])
		expect(bp.entities[1]?.fields).toContain('project:->e-project')
	})

	it('orders a referenced entity before the entity referencing it', () => {
		for (const desc of [
			'a bug tracker',
			'freelance invoicing',
			'a recipe box',
			'a reading list',
			'an events rsvp app',
			'a course roster',
		]) {
			const bp = blueprintFromDescription(desc)
			const seen = new Set<string>()
			for (const entity of bp.entities) {
				for (const field of entity.fields) {
					const ref = /->e-([a-zA-Z0-9]+)$/.exec(field)
					if (ref) expect(seen).toContain(ref[1])
				}
				seen.add(entity.slug)
			}
		}
	})

	it("keeps the lexicon's title when the description strips down to one word", () => {
		// "a bug tracker for small teams" → the only non-stopword is "bug", and an
		// app called *Bug* in a directory called `bug/` is worse than the default.
		expect(
			blueprintFromDescription('a bug tracker for small teams').title,
		).toBe('Bug Tracker')
	})

	it('titles the app from the user own words, not the lexicon default', () => {
		const bp = blueprintFromDescription('sourdough starter inventory')
		expect(bp.title).toBe('Sourdough Starter Inventory')
		// …while still using the matched domain shape.
		expect(bp.entities.map((e) => e.slug)).toEqual(['location', 'item'])
	})

	it('falls back to a singular entity named after the description subject', () => {
		const bp = blueprintFromDescription('a place to log my telescope sightings')
		expect(bp.entities).toHaveLength(1)
		expect(bp.entities[0]?.slug).toBe('log')
		expect(bp.entities[0]?.fields[0]).toBe('title:text!')
	})

	it('never emits a field the DSL grammar would reject', () => {
		const grammar =
			/^[a-z][a-zA-Z0-9]*:(?:enum\([^()]+\)|(?:ref:|->)e-[a-z][a-zA-Z0-9]*|[a-z]+)!?$/
		const descriptions = [
			'a bug tracker',
			'a crm for my consulting clients',
			'workout logging',
			'expenses and budgets',
			'habit streaks',
			'job applications',
			'clinic appointments',
			'shop orders',
			'a course lms',
			'',
			'???',
			'THE Widgets!!!',
		]
		for (const desc of descriptions) {
			const bp = blueprintFromDescription(desc)
			expect(bp.entities.length).toBeGreaterThan(0)
			for (const entity of bp.entities) {
				expect(entity.slug).toMatch(/^[a-z][a-zA-Z0-9]*$/)
				expect(entity.fields.length).toBeGreaterThan(0)
				for (const field of entity.fields) expect(field).toMatch(grammar)
			}
		}
	})

	it('survives a description with no usable words at all', () => {
		const bp = blueprintFromDescription('   ')
		expect(bp.entities[0]?.slug).toBe('item')
		expect(bp.title).toBe('Item')
	})
})

describe('normalizeBlueprint', () => {
	it('drops fields the DSL cannot express, keeping the rest', () => {
		const bp = normalizeBlueprint({
			title: 'Bugs',
			entities: [
				{
					slug: 'bug',
					name: 'Bug',
					fields: [
						'title:text!',
						'status:pending',
						'Weird Name:text',
						'ok:bool',
					],
				},
			],
		})
		expect(bp.entities[0]?.fields).toEqual(['title:text!', 'ok:bool'])
	})

	it('drops a reference to an entity that is not in the blueprint', () => {
		const bp = normalizeBlueprint({
			entities: [{ slug: 'bug', fields: ['title:text!', 'owner:->e-user'] }],
		})
		expect(bp.entities[0]?.fields).toEqual(['title:text!'])
	})

	it('drops duplicate slugs and duplicate field names', () => {
		const bp = normalizeBlueprint({
			entities: [
				{ slug: 'bug', fields: ['title:text!', 'title:text'] },
				{ slug: 'bug', fields: ['other:text'] },
			],
		})
		expect(bp.entities).toHaveLength(1)
		expect(bp.entities[0]?.fields).toEqual(['title:text!'])
	})

	it('caps entities and fields', () => {
		const bp = normalizeBlueprint({
			entities: Array.from({ length: 12 }, (_, i) => ({
				slug: `thing${i}`,
				fields: Array.from({ length: 20 }, (_, f) => `field${f}:text`),
			})),
		})
		expect(bp.entities).toHaveLength(5)
		expect(bp.entities[0]?.fields).toHaveLength(8)
	})

	it('defaults a missing display name from the slug', () => {
		const bp = normalizeBlueprint({
			entities: [{ slug: 'lineItem', fields: ['label:text!'] }],
		})
		expect(bp.entities[0]?.name).toBe('Line Item')
		expect(bp.title).toBe('Line Item')
	})

	it('throws when nothing usable survives', () => {
		expect(() => normalizeBlueprint({ entities: [] })).toThrow(/no entity/)
		expect(() =>
			normalizeBlueprint({ entities: [{ slug: 'ok', fields: ['nope'] }] }),
		).toThrow(/no entity/)
		expect(() => normalizeBlueprint('not an object')).toThrow(/JSON object/)
	})
})

describe('parseBlueprint', () => {
	it('reads JSON out of a chatty completion', () => {
		const parsed = parseBlueprint(
			'Sure! Here you go:\n```json\n{"title":"X","entities":[]}\n```\nHope that helps.',
		) as { title: string }
		expect(parsed.title).toBe('X')
	})

	it('throws when there is no object at all', () => {
		expect(() => parseBlueprint('I cannot help with that.')).toThrow(/no JSON/)
	})
})

describe('describeApp', () => {
	it('with no client, returns the deterministic heuristic', async () => {
		const out = await describeApp({ description: 'a bug tracker' })
		expect(out.source).toBe('heuristic')
		expect(out.fallbackReason).toBeUndefined()
	})

	it('under MOCK_AI, reproduces the heuristic through the real parse path', async () => {
		const out = await describeApp({
			description: 'a bug tracker for small teams',
			ai: mockAiClient(),
		})
		expect(out.source).toBe('ai')
		expect(out.blueprint).toEqual(
			blueprintFromDescription('a bug tracker for small teams'),
		)
	})

	it('under MOCK_AI, is byte-identical across runs', async () => {
		const once = await describeApp({
			description: 'freelance invoicing with line items',
			ai: mockAiClient(),
		})
		const twice = await describeApp({
			description: 'freelance invoicing with line items',
			ai: mockAiClient(),
		})
		expect(JSON.stringify(once.blueprint)).toBe(JSON.stringify(twice.blueprint))
	})

	it('uses a valid model answer over the heuristic', async () => {
		const out = await describeApp({
			description: 'a bug tracker',
			ai: fixedClient(
				'{"title":"Telescope Log","entities":[{"slug":"sighting","name":"Sighting","fields":["title:text!","seenOn:date"]}]}',
			),
		})
		expect(out.source).toBe('ai')
		expect(out.blueprint.entities.map((e) => e.slug)).toEqual(['sighting'])
	})

	it('falls back with a stated reason when the model answer is unusable', async () => {
		const out = await describeApp({
			description: 'a bug tracker',
			ai: fixedClient('I am afraid I cannot do that.'),
		})
		expect(out.source).toBe('heuristic')
		expect(out.fallbackReason).toMatch(/no JSON/)
		expect(out.blueprint).toEqual(blueprintFromDescription('a bug tracker'))
	})

	it('falls back when the client itself fails', async () => {
		const out = await describeApp({
			description: 'a bug tracker',
			ai: failingClient('402 insufficient credit'),
		})
		expect(out.source).toBe('heuristic')
		expect(out.fallbackReason).toMatch(/insufficient credit/)
	})
})

describe('projectSlug', () => {
	it('kebab-cases a title', () => {
		expect(projectSlug('Bug Tracker')).toBe('bug-tracker')
		expect(projectSlug('  Sam & Co.  ')).toBe('sam-co')
		expect(projectSlug('!!!')).toBe('maxstack-app')
	})
})
