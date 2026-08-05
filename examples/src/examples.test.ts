import { validateSpecSystem } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { examples } from './index.ts'

describe('examples', () => {
	it('ships eleven example apps in a stable order', () => {
		expect(examples.map((b) => b.id)).toEqual([
			'taskly',
			'todotracker',
			'blog',
			'cardstack',
			'recipebox',
			'bugtrail',
			'bookclub',
			'invoicer',
			'gymlog',
			'crmlite',
			'saas-starter',
		])
	})

	it('has unique example ids', () => {
		const ids = examples.map((b) => b.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	for (const example of examples) {
		describe(example.id, () => {
			it('has a valid three-layer spec system', () => {
				expect(() => validateSpecSystem(example.spec)).not.toThrow()
			})

			it('has data entities and CRUD pages', () => {
				expect(example.spec.data.entities.length).toBeGreaterThan(0)
				expect(example.spec.pages.pages.length).toBeGreaterThan(0)
			})

			it('carries natural-language e2eTests on every page', () => {
				for (const page of example.spec.pages.pages) {
					expect(page.e2eTests?.length ?? 0).toBeGreaterThan(0)
				}
			})

			it('has a substantial change set', () => {
				expect(example.changes.length).toBeGreaterThanOrEqual(9)
			})

			it('exercises the core change categories', () => {
				const kinds = new Set(example.changes.map((c) => c.kind))
				expect(kinds).toContain('spec-op')
				expect(kinds).toContain('slot-fill')
				expect(kinds).toContain('eject')
			})

			it('has unique change ids', () => {
				const ids = example.changes.map((c) => c.id)
				expect(new Set(ids).size).toBe(ids.length)
			})
		})
	}

	// Each example carries its own backlog. A shared change set would make the
	// apps look independent while actually measuring one story eleven times.
	it('gives every example a distinct change-id sequence', () => {
		const sequences = examples.map((b) => b.changes.map((c) => c.id).join('|'))
		expect(new Set(sequences).size).toBe(examples.length)
	})
})
