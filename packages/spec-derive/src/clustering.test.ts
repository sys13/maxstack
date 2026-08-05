import type { Feedback, ReviewTarget } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import type { AiClient } from './ai.ts'
import {
	acceptIssue,
	aiClusterFn,
	clusterFeedback,
	groupByTarget,
	type Issue,
	issueKey,
	issueState,
	issueToCandidates,
	landableCandidates,
	type ProposedCluster,
	parseAiClusters,
	rejectIssue,
} from './clustering.ts'
import { computePriority } from './priority.ts'
import type { ExampleChange } from './types.ts'

const tTitle: ReviewTarget = { kind: 'field', id: 'title', parentId: 'task' }
const tHome: ReviewTarget = { kind: 'page', id: 'home' }

function fb(over: Partial<Feedback> & Pick<Feedback, 'id'>): Feedback {
	return {
		at: '2026-07-11T00:00:00.000Z',
		source: 'end-user',
		target: tTitle,
		kind: 'confusion',
		body: 'unclear',
		specVersion: 'gen-1',
		...over,
	}
}

function offSurface(id: string): ExampleChange {
	return {
		id,
		description: id,
		kind: 'off-surface',
		resource: 'x',
		resolution: 'eject',
	}
}
function specOp(id: string): ExampleChange {
	return {
		id,
		description: id,
		kind: 'spec-op',
		via: 'apply-op',
		op: {} as never,
	}
}

describe('groupByTarget (deterministic baseline clusterer)', () => {
	it('folds feedback that shares a target coordinate into one cluster', () => {
		const clusters = groupByTarget([
			fb({ id: 'a', target: tTitle }),
			fb({ id: 'b', target: tHome }),
			fb({ id: 'c', target: tTitle }),
		])
		expect(clusters).toHaveLength(2)
		expect(clusters[0]?.feedbackIds).toEqual(['a', 'c'])
		expect(clusters[1]?.feedbackIds).toEqual(['b'])
	})
})

describe('clusterFeedback (gated fold)', () => {
	it('enters every issue as a suggestion — never auto-accepted', async () => {
		const [issue] = await clusterFeedback([fb({ id: 'a' })])
		expect(issue).toBeDefined()
		expect(issue && issueState(issue)).toBe('suggested')
	})

	it('derives targets + severity from the real feedback, not the model’s claims', async () => {
		// A lying proposal: claims one feedback id but the fold has a bug in it, so
		// severity must come out `bug`, and the target must be the real one.
		const cluster = (): ProposedCluster[] => [
			{
				title: 'lied about severity',
				question: 'q',
				rationale: 'r',
				feedbackIds: ['a', 'b', 'ghost'], // 'ghost' does not exist
				candidates: [offSurface('cand')],
			},
		]
		const issues = await clusterFeedback(
			[fb({ id: 'a', kind: 'request' }), fb({ id: 'b', kind: 'bug' })],
			{ cluster },
		)
		const [issue] = issues
		expect(issue?.severity).toBe('bug') // peak of {request, bug}
		expect(issue?.feedbackIds).toEqual(['a', 'b']) // hallucinated 'ghost' dropped
		expect(issue?.targets).toEqual([tTitle]) // deduped to the real coordinate
	})

	it('uses deterministic ids and a neutral default confidence', async () => {
		const cluster = (): ProposedCluster[] => [
			{
				title: 't',
				question: 'q',
				rationale: 'r',
				feedbackIds: ['a'],
				candidates: [],
			},
		]
		const [issue] = await clusterFeedback([fb({ id: 'a' })], {
			cluster,
			idPrefix: 'iss',
		})
		expect(issue?.id).toBe('iss-1')
		expect(issue?.confidence).toBe(0.5)
	})
})

describe('issueKey (stable identity across re-clustering)', () => {
	it('is the sorted target-coordinate set, independent of positional id', async () => {
		// Same feedback in two orders → same key, even if the positional id differs.
		const forward = await clusterFeedback([
			fb({ id: 'a', target: tTitle }),
			fb({ id: 'b', target: tHome }),
		])
		const key = (i?: Issue) => (i ? issueKey(i) : '')
		// groupByTarget makes one issue per coordinate; each key is that coordinate.
		expect(key(forward[0])).toBe('field:task/title')
		expect(key(forward[1])).toBe('page:home')
	})

	it('folds a multi-target issue into one order-independent key', async () => {
		const cluster = (): ProposedCluster[] => [
			{
				title: 't',
				question: 'q',
				rationale: 'r',
				feedbackIds: ['b', 'a'], // reverse order
				candidates: [],
			},
		]
		const [issue] = await clusterFeedback(
			[fb({ id: 'a', target: tTitle }), fb({ id: 'b', target: tHome })],
			{ cluster },
		)
		expect(issue && issueKey(issue)).toBe('field:task/title|page:home')
	})
})

describe('the human gate + priority bridge (Cluster → Propose → Prioritize)', () => {
	const cluster = (): ProposedCluster[] => [
		{
			title: 'theme',
			question: 'q',
			rationale: 'r',
			feedbackIds: ['a', 'b'],
			confidence: 1,
			candidates: [specOp('cheap'), offSurface('exp')],
		},
	]

	it('landableCandidates excludes suggested and rejected issues (the gate)', async () => {
		const issues = await clusterFeedback(
			[fb({ id: 'a', kind: 'bug' }), fb({ id: 'b', kind: 'bug' })],
			{ cluster },
		)
		// Suggested → nothing lands.
		expect(landableCandidates(issues)).toHaveLength(0)
		// Rejected → still nothing.
		expect(landableCandidates(issues.map(rejectIssue))).toHaveLength(0)
		// Accepted → its candidates become landable.
		const accepted = issues.map(acceptIssue)
		expect(landableCandidates(accepted)).toHaveLength(2)
	})

	it('a candidate’s reach = folded feedback count, and cheaper resolutions rank first', async () => {
		const issues = (
			await clusterFeedback(
				[fb({ id: 'a', kind: 'bug' }), fb({ id: 'b', kind: 'bug' })],
				{ cluster },
			)
		).map(acceptIssue)
		const [issue] = issues
		const candidates = issue ? issueToCandidates(issue) : []
		expect(candidates.map((c) => c.reach)).toEqual([2, 2]) // both inherit reach 2
		const ranked = computePriority(candidates)
		// Same demand; the spec-op candidate (costWeight 1) beats off-surface (8).
		expect(ranked.map((r) => r.id)).toEqual(['issue-1:cheap', 'issue-1:exp'])
	})
})

describe('parseAiClusters (the AI response parser)', () => {
	it('parses a well-formed completion into ProposedClusters', () => {
		const text = JSON.stringify([
			{
				title: 'Title casing',
				question: 'Should field labels be Title Case?',
				rationale: 'Two users asked for the same thing.',
				feedbackIds: ['a', 'b'],
				confidence: 0.9,
				candidates: [
					{
						kind: 'spec-op',
						description: 'Add a requirement for label casing',
						requirement: {
							id: 'r-title-case',
							userStory: 'As a user, I want Title Case labels.',
							acceptanceCriteria: ['Labels render in Title Case.'],
							priority: 'P2',
						},
					},
				],
			},
		])
		const clusters = parseAiClusters(text)
		expect(clusters).toHaveLength(1)
		expect(clusters[0]).toMatchObject({
			title: 'Title casing',
			feedbackIds: ['a', 'b'],
			confidence: 0.9,
		})
		const [candidate] = clusters[0]?.candidates ?? []
		expect(candidate?.kind).toBe('spec-op')
		if (candidate?.kind === 'spec-op' && candidate.via === 'apply-op') {
			expect(candidate.op.op).toBe('prd.addRequirement')
		} else {
			throw new Error('expected a spec-op/apply-op candidate')
		}
	})

	it('extracts JSON embedded in prose (models sometimes ignore "no commentary")', () => {
		const text = `Sure, here you go:\n${JSON.stringify([
			{
				title: 't',
				question: 'q',
				rationale: 'r',
				feedbackIds: ['a'],
				candidates: [],
			},
		])}\nHope that helps!`
		expect(parseAiClusters(text)).toHaveLength(1)
	})

	it('degrades to [] rather than throwing on garbage input', () => {
		expect(parseAiClusters('not json at all')).toEqual([])
		expect(parseAiClusters('{"not": "an array"}')).toEqual([])
	})

	it('drops clusters missing required fields and candidates outside the allowed vocabulary', () => {
		const text = JSON.stringify([
			{ title: 'no feedbackIds', question: 'q', rationale: 'r' }, // dropped: no feedbackIds
			{
				title: 'ok',
				question: 'q',
				rationale: 'r',
				feedbackIds: ['a'],
				candidates: [
					{ kind: 'eject', resource: 'x' }, // outside the allowed vocabulary → dropped
					{ kind: 'off-surface', description: 'ok', resource: 'x' }, // kept, resolution defaults
				],
			},
		])
		const clusters = parseAiClusters(text)
		expect(clusters).toHaveLength(1)
		expect(clusters[0]?.candidates).toHaveLength(1)
		expect(clusters[0]?.candidates[0]).toMatchObject({
			kind: 'off-surface',
			resolution: 'unexpressible',
		})
	})

	it('never trusts a model-supplied requirement id that doesn’t match the branded shape', () => {
		const text = JSON.stringify([
			{
				title: 't',
				question: 'q',
				rationale: 'r',
				feedbackIds: ['a'],
				candidates: [
					{
						kind: 'spec-op',
						description: 'd',
						requirement: { id: 'not-a-valid-id', userStory: 'story' },
					},
				],
			},
		])
		const [cluster] = parseAiClusters(text)
		const [candidate] = cluster?.candidates ?? []
		if (candidate?.kind === 'spec-op' && candidate.via === 'apply-op') {
			expect(candidate.op.op).toBe('prd.addRequirement')
			if (candidate.op.op === 'prd.addRequirement') {
				expect(candidate.op.args.requirement.id).toMatch(/^r-[a-z0-9-]+$/)
			}
		} else {
			throw new Error('expected a spec-op/apply-op candidate')
		}
	})
})

describe('aiClusterFn (the real Cluster step, AiClient-backed)', () => {
	it('sends the folded feedback to the model and parses its clusters', async () => {
		const calls: { generator: string; prompt: string }[] = []
		const ai: AiClient = {
			async complete(req) {
				calls.push({ generator: req.generator, prompt: req.prompt })
				return JSON.stringify([
					{
						title: 'Bulk archive',
						question: 'Should we support bulk archive?',
						rationale: 'One high-severity ask.',
						feedbackIds: ['a'],
						confidence: 0.8,
						candidates: [
							{
								kind: 'off-surface',
								description: 'No op for bulk actions yet',
								resource: 'pg-inbox',
								resolution: 'unexpressible',
							},
						],
					},
				])
			},
		}
		const feedback: Feedback[] = [
			fb({
				id: 'a',
				kind: 'request',
				target: tHome,
				body: 'bulk archive please',
			}),
		]
		const issues = await clusterFeedback(feedback, { cluster: aiClusterFn(ai) })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.generator).toBe('feedback-cluster')
		expect(calls[0]?.prompt).toContain('bulk archive please')
		expect(issues).toHaveLength(1)
		expect(issues[0]?.title).toBe('Bulk archive')
		expect(issueState(issues[0] as Issue)).toBe('suggested') // never auto-accepted
	})

	it('is never called on an empty feedback log (no gratuitous AI calls)', async () => {
		let called = false
		const ai: AiClient = {
			async complete() {
				called = true
				return '[]'
			},
		}
		const issues = await clusterFeedback([], { cluster: aiClusterFn(ai) })
		expect(called).toBe(false)
		expect(issues).toEqual([])
	})
})
