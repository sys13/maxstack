/**
 * Which parts of a product doc are still the `maxstack init` skeleton.
 *
 * `minimalPRD` has to emit a *valid* PRD — every required container present,
 * every cross-reference wired — so a fresh project cannot start with an empty
 * one. The cost of that (#343) is a 6KB `spec/product.json` of plausible
 * English: an approver, a milestone with a real date two weeks out, a kill
 * criterion, an assumption with a confidence of 0.7. None of it was decided by
 * anyone, and nothing in the loop ever said so — so after seven real spec-ops
 * the doc still described a product nobody was building, and a reader (or an
 * agent grounding on it) had no way to tell authored prose from scaffold.
 *
 * An unwritten section and a written one must not look the same. That is the
 * same rule the check runner already applies to code it could not examine, and
 * it wants the same shape of answer: name what went unauthored, never omit it.
 *
 * Detection is by **content**, not by a flag in the file. A flag would be
 * written once at `init` and then be wrong forever, because nothing edits it:
 * there is no spec-op that rewrites PRD prose, so the only way a section gets
 * authored is a human editing `spec/product.json` or the workbench pane — and
 * neither of those would clear a marker. Comparing against the exact strings
 * the seed writes clears itself the moment a word changes, needs no schema
 * field, and works on a doc that predates this module.
 *
 * The strings therefore live here and `minimal.ts` imports them, so the
 * detector and the seed physically cannot drift apart.
 */

import type { PRD } from './prd.types.ts'

/**
 * The boilerplate `minimalPRD` writes into the fields its caller does NOT
 * supply. Exported so the detector compares against the one copy.
 */
export const PRD_PLACEHOLDER = {
	background:
		'Seeded from a minimal spec skeleton; the background fills in as the product grows change-by-change.',
	costOfInaction:
		'Users keep the data in scattered notes and spreadsheets, and it rots.',
	discoveryActivity: 'Talk to a handful of target users about the workflow.',
	currentWorkarounds: ['Spreadsheets', 'Sticky notes'],
	competitor: 'A general-purpose spreadsheet',
	requirementUserStory:
		'As the primary user, I can manage the core domain data.',
	milestoneDeliverable: 'The core flow works end-to-end.',
	assumption: 'The domain model fits the user’s real workflow.',
	risk: 'The app overfits one workflow and resists change.',
	killCriterion: 'Flat for two months after launch.',
} as const

/**
 * The prose `maxstack init` invents when the human supplied only a project
 * name. Deliberately unmistakable: the previous seed read like an authored
 * elevator pitch, which is precisely why nobody ever replaced it.
 *
 * `title` is threaded through so the placeholder still names the project — a
 * reader should see *what* is unwritten, not a bare "TODO" with no subject.
 */
export function prdSeedProse(title: string): {
	tldr: string
	problem: string
	northStar: string
	persona: string
	differentiation: string
} {
	return {
		tldr: `UNWRITTEN — one line on what ${title} is for.`,
		problem: `UNWRITTEN — the problem ${title} solves, and for whom.`,
		northStar: 'UNWRITTEN — the one number that says this is working',
		persona: 'UNWRITTEN — the primary user',
		differentiation: 'UNWRITTEN — how this differs from the alternatives',
	}
}

/** A part of the product doc that is still verbatim scaffold. */
export interface UnauthoredSection {
	/** Dotted path into the PRD, e.g. `goals.northStarMetric`. */
	path: string
	/** What writing it would answer. */
	hint: string
}

interface Probe extends UnauthoredSection {
	isSeed: (prd: PRD, seed: ReturnType<typeof prdSeedProse>) => boolean
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Every section of the doc that a seed writes and a human is meant to replace.
 * The count is the denominator in the report ("4 of 14 authored"), so a section
 * belongs here only if leaving it as-is is genuinely a gap.
 */
const PROBES: Probe[] = [
	{
		path: 'context.tldr',
		hint: 'one line on what this product is',
		isSeed: (p, s) => p.context.tldr === s.tldr,
	},
	{
		path: 'context.background',
		hint: 'how this came to be worth building',
		isSeed: (p) => p.context.background === PRD_PLACEHOLDER.background,
	},
	{
		path: 'problem.statement',
		hint: 'the problem being solved, and for whom',
		isSeed: (p, s) => p.problem.statement === s.problem,
	},
	{
		path: 'problem.costOfInaction',
		hint: 'what it costs to leave the problem alone',
		isSeed: (p) => p.problem.costOfInaction === PRD_PLACEHOLDER.costOfInaction,
	},
	{
		path: 'discovery.activities',
		hint: 'what was actually done to learn about the users',
		isSeed: (p) =>
			p.discovery.activities.length === 1 &&
			p.discovery.activities[0]?.description ===
				PRD_PLACEHOLDER.discoveryActivity,
	},
	{
		path: 'audience.personas',
		hint: 'who this is for, concretely',
		isSeed: (p, s) =>
			p.audience.personas.length === 1 &&
			p.audience.personas[0]?.name === s.persona,
	},
	{
		path: 'audience.currentWorkarounds',
		hint: 'what these users do today instead',
		isSeed: (p) =>
			sameStrings(
				p.audience.currentWorkarounds,
				PRD_PLACEHOLDER.currentWorkarounds,
			),
	},
	{
		path: 'market.competitors',
		hint: 'the alternatives a user would otherwise reach for',
		isSeed: (p) =>
			p.market.competitors.length === 1 &&
			p.market.competitors[0]?.name === PRD_PLACEHOLDER.competitor,
	},
	{
		path: 'market.differentiation',
		hint: 'why this and not those',
		isSeed: (p, s) => p.market.differentiation === s.differentiation,
	},
	{
		path: 'goals.northStarMetric',
		hint: 'the one number that says this is working',
		isSeed: (p, s) => p.goals.northStarMetric.name === s.northStar,
	},
	{
		path: 'requirements',
		hint: 'what the product must actually do',
		isSeed: (p) =>
			p.requirements.length === 1 &&
			p.requirements[0]?.userStory === PRD_PLACEHOLDER.requirementUserStory,
	},
	{
		path: 'assumptions',
		hint: 'what the plan is betting on',
		isSeed: (p) =>
			p.assumptions.length === 1 &&
			p.assumptions[0]?.statement === PRD_PLACEHOLDER.assumption,
	},
	{
		path: 'risks',
		hint: 'what could go wrong',
		isSeed: (p) =>
			p.risks.length === 1 && p.risks[0]?.description === PRD_PLACEHOLDER.risk,
	},
	{
		path: 'execution.milestones',
		hint: 'a date somebody actually committed to',
		isSeed: (p) =>
			p.execution.milestones.length === 1 &&
			p.execution.milestones[0]?.deliverable ===
				PRD_PLACEHOLDER.milestoneDeliverable,
	},
	{
		path: 'postLaunch.killCriteria',
		hint: 'when to stop — a real decision, not a default',
		isSeed: (p) =>
			p.postLaunch.killCriteria.length === 1 &&
			p.postLaunch.killCriteria[0]?.threshold === PRD_PLACEHOLDER.killCriterion,
	},
]

/** How many sections {@link unauthoredPrdSections} inspects. The denominator. */
export const PRD_SECTION_COUNT = PROBES.length

/**
 * The sections of `prd` that are still verbatim `maxstack init` scaffold, in
 * document order. Empty means every section this knows about has been written.
 */
export function unauthoredPrdSections(prd: PRD): UnauthoredSection[] {
	const seed = prdSeedProse(prd.meta.title)
	return PROBES.filter((probe) => probe.isSeed(prd, seed)).map(
		({ path, hint }) => ({ path, hint }),
	)
}

/**
 * One line naming the gap, or `null` when there is nothing to say.
 *
 * Every surface that reports this — the CLI gate, the generated docs, the MCP
 * summary, the workbench pane — prints this same sentence, so a maintainer and
 * an agent are never told different stories about whether the doc is real.
 */
export function unauthoredPrdNotice(prd: PRD): string | null {
	const gaps = unauthoredPrdSections(prd)
	if (gaps.length === 0) return null
	return (
		`The product doc is still the "maxstack init" skeleton: ${gaps.length} of ` +
		`${PRD_SECTION_COUNT} sections have never been authored ` +
		`(${gaps.map((g) => g.path).join(', ')}). ` +
		'Treat them as blank, not as decisions — nobody chose them.'
	)
}
