/**
 * #343 — `maxstack init` writes a fluent, structurally complete product doc that
 * nobody authored, and nothing in the loop ever said so. These tests pin the
 * detector that makes the difference legible: the seed must read as unwritten,
 * a written section must stop being reported, and the detector must not drift
 * from the strings the seed actually emits.
 */

import { describe, expect, it } from 'vitest'
import { blogPRD } from '../fixtures/blog.prd.ts'
import { tasklyPRD } from '../fixtures/taskly.prd.ts'
import { minimalPRD } from './minimal.ts'
import {
	PRD_SECTION_COUNT,
	prdSeedProse,
	unauthoredPrdNotice,
	unauthoredPrdSections,
} from './placeholder.ts'
import type { PRD } from './prd.types.ts'

/** Exactly what `seedSpec` builds — the doc a fresh project starts with. */
function seeded(title = 'reader'): PRD {
	const seed = prdSeedProse(title)
	return minimalPRD({
		title,
		tldr: seed.tldr,
		problem: seed.problem,
		northStar: seed.northStar,
		persona: seed.persona,
		differentiation: seed.differentiation,
		lastUpdated: '2026-08-06',
		milestoneDate: '2026-08-20',
	})
}

describe('unauthoredPrdSections', () => {
	it('reports EVERY section of a freshly-seeded doc as unauthored', () => {
		// The bug: after seven real spec-ops the doc still described nothing about
		// the product, and no surface said so. If a single probe silently stopped
		// matching the seed, that section would start reading as authored — this
		// is the assertion that catches it.
		const gaps = unauthoredPrdSections(seeded())
		expect(gaps).toHaveLength(PRD_SECTION_COUNT)
	})

	it('reports nothing for a real, hand-authored PRD', () => {
		expect(unauthoredPrdSections(tasklyPRD)).toEqual([])
		expect(unauthoredPrdSections(blogPRD)).toEqual([])
		expect(unauthoredPrdNotice(tasklyPRD)).toBeNull()
	})

	it('stops reporting a section the moment its text is edited', () => {
		// Detection is by content, not by a flag written once at init: nothing in
		// the loop would ever clear such a flag, because no spec-op rewrites PRD
		// prose — the only author is a human editing the file or the workbench.
		const prd = seeded()
		const before = unauthoredPrdSections(prd).map((g) => g.path)
		expect(before).toContain('problem.statement')

		prd.problem.statement =
			'People lose track of which books they own, lent out, or half-finished.'
		const after = unauthoredPrdSections(prd).map((g) => g.path)
		expect(after).not.toContain('problem.statement')
		expect(after).toHaveLength(before.length - 1)
	})

	it('does not report the tl;dr when `init` was given a description', () => {
		// `maxstack init --desc` is the one field the human actually supplies, so
		// it must not be accused of being scaffold.
		const seed = prdSeedProse('reader')
		const prd = minimalPRD({
			title: 'reader',
			tldr: 'A shelf for the books you own, lent out and half-finished.',
			problem: seed.problem,
			northStar: seed.northStar,
			persona: seed.persona,
			differentiation: seed.differentiation,
		})
		const paths = unauthoredPrdSections(prd).map((g) => g.path)
		expect(paths).not.toContain('context.tldr')
		expect(paths).toContain('problem.statement')
	})

	it('survives a doc that has grown rows through spec-ops', () => {
		// The report is about the sections nobody wrote, not about how busy the
		// doc is. Adding a requirement authors `requirements`; it must not
		// silently clear `problem.statement` too.
		const prd = seeded()
		prd.requirements.push({
			id: 'r-lending',
			userStory: 'As a reader, I can see who has my copy.',
			acceptanceCriteria: ['A book can be marked as lent to a person.'],
			priority: 'P1',
			edgeCasesAndErrorStates: ['The borrower is not in the address book'],
		})
		const paths = unauthoredPrdSections(prd).map((g) => g.path)
		expect(paths).not.toContain('requirements')
		expect(paths).toContain('problem.statement')
	})
})

describe('unauthoredPrdNotice', () => {
	it('names the count, the denominator and the paths', () => {
		const notice = unauthoredPrdNotice(seeded())
		expect(notice).toContain(`${PRD_SECTION_COUNT} of ${PRD_SECTION_COUNT}`)
		expect(notice).toContain('problem.statement')
		expect(notice).toContain('maxstack init')
	})
})

describe('the seed prose itself', () => {
	it('says it is unwritten, in every field it invents', () => {
		// The original seed read like a brief somebody wrote — "Weekly active
		// use", "The maintainer", "Grown safely over time through typed spec-ops".
		// That plausibility is the whole defect: a reviewer could not tell, so
		// nobody replaced it.
		const seed = prdSeedProse('reader')
		for (const value of Object.values(seed))
			expect(value).toContain('UNWRITTEN')
		// …and it still names the project, so a reader sees WHAT is unwritten.
		expect(seed.tldr).toContain('reader')
	})
})
