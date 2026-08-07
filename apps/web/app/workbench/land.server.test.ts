import {
	createInMemorySpecStore,
	defaultCheckRunner,
	defaultGeneratorRunner,
	type PlatformContext,
} from '@maxstack/mcp'
import { newSpecSystem, type OpId, type SpecSystem } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import type { ProposedCluster } from '@maxstack/spec-derive/clustering'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	allLandedKeys,
	LAND_ATTRIBUTION,
	landIssueCandidate,
} from './land.server'

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: unknown[]
	__maxstackIssueDecisions?: unknown[]
	__maxstackAiClusters?: {
		at: string
		feedbackCount: number
		clusters: ProposedCluster[]
	}
	__maxstackLanded?: unknown[]
}

/** One captured feedback item + an AI cluster snapshot that proposes a real,
 *  landable `prd.addRequirement` candidate for it — the shape `ai-cluster
 *  .server`'s `runAiClustering` would have persisted after an explicit
 *  trigger. Poking the in-memory globals directly (same pattern the other
 *  workbench host tests use for `__maxstackFeedback`/`__maxstackIssueDecisions`)
 *  keeps this test independent of a live `AiClient`. */
function seedLandableIssue(): string {
	scope.__maxstackFeedback = [
		{
			id: 'fb-1',
			at: '2026-07-11T00:00:00.000Z',
			source: 'end-user',
			target: { kind: 'page', id: 'inbox' },
			kind: 'request',
			body: 'I want to bulk-archive tasks.',
			specVersion: 'gen-1',
		},
	]
	scope.__maxstackAiClusters = {
		at: '2026-07-11T00:00:00.000Z',
		feedbackCount: 1,
		clusters: [
			{
				title: 'Bulk archive',
				question: 'Should we support bulk archive?',
				rationale: 'One user asked for it.',
				feedbackIds: ['fb-1'],
				confidence: 0.8,
				candidates: [
					{
						id: 'cand-1',
						description: 'Add a requirement for bulk archive',
						kind: 'spec-op',
						via: 'apply-op',
						op: {
							op: 'prd.addRequirement',
							args: {
								requirement: {
									id: 'r-bulk-archive',
									userStory: 'As a user, I want to bulk-archive tasks.',
									acceptanceCriteria: [
										'Selecting many tasks can archive them at once.',
									],
									priority: 'P2',
									edgeCasesAndErrorStates: [],
								},
							},
						},
					},
				],
			},
		],
	}
	// The issueKey groupByTarget/clusterFeedback would derive: the sole target
	// is `page:inbox`.
	return 'page:inbox'
}

function platform(): PlatformContext {
	const spec: SpecSystem = newSpecSystem(tasklyPRD)
	let counter = 0
	return {
		spec: createInMemorySpecStore(spec),
		generators: defaultGeneratorRunner(),
		checks: defaultCheckRunner(),
		// The real attribution the Land button declares, spread rather than
		// restated, so these tests exercise what production stamps (issue #358).
		...LAND_ATTRIBUTION,
		now: () => '2026-07-12',
		nextOpId: () => `op-test-${++counter}` as OpId,
	}
}

describe('landIssueCandidate (the Land step, #11)', () => {
	beforeEach(() => {
		scope.__maxstackFeedback = []
		scope.__maxstackIssueDecisions = []
		scope.__maxstackAiClusters = undefined
		scope.__maxstackLanded = []
	})

	it('refuses to land an issue that has not been accepted', async () => {
		const key = seedLandableIssue()
		const result = await landIssueCandidate(key, platform())
		expect(result).toEqual({ landed: false, reason: 'issue is not accepted' })
	})

	it('lands an accepted spec-op candidate via apply_spec_change, records the ledger rationale, and marks it landed', async () => {
		const key = seedLandableIssue()
		scope.__maxstackIssueDecisions = [
			{ issueKey: key, decision: 'accept', at: '2026-07-11T01:00:00.000Z' },
		]

		const ctx = platform()
		const result = await landIssueCandidate(key, ctx)
		expect(result.landed).toBe(true)
		expect(result.opId).toBeTruthy()

		// The op actually landed in the spec — opLog + the new requirement.
		const spec = await ctx.spec.load()
		expect(spec.opLog).toHaveLength(2) // the addRequirement op + the ledger record_decision op
		expect(spec.product.requirements.map((r) => r.id)).toContain(
			'r-bulk-archive',
		)

		// The rationale is in the decision ledger.
		const entry = spec.ledger.find((e) => e.id === 'd-land-page-inbox')
		expect(entry?.rationale).toBe('One user asked for it.')
		expect(entry?.status).toBe('resolved')

		// Landed set now contains this issue's key.
		expect(await allLandedKeys()).toEqual(new Set([key]))
	})

	it('is idempotent — landing an already-landed issue is a safe no-op', async () => {
		const key = seedLandableIssue()
		scope.__maxstackIssueDecisions = [
			{ issueKey: key, decision: 'accept', at: '2026-07-11T01:00:00.000Z' },
		]
		const ctx = platform()
		const first = await landIssueCandidate(key, ctx)
		expect(first.landed).toBe(true)

		const second = await landIssueCandidate(key, ctx)
		expect(second).toEqual({ landed: false, reason: 'already landed' })

		// Only landed once — the requirement isn't duplicated.
		const spec = await ctx.spec.load()
		expect(
			spec.product.requirements.filter((r) => r.id === 'r-bulk-archive'),
		).toHaveLength(1)
	})

	it('reports no landable candidate for an accepted issue whose only proposals are non-spec-op', async () => {
		scope.__maxstackFeedback = [
			{
				id: 'fb-2',
				at: '2026-07-11T00:00:00.000Z',
				source: 'end-user',
				target: { kind: 'page', id: 'settings' },
				kind: 'bug',
				body: 'Something is broken.',
				specVersion: 'gen-1',
			},
		]
		// No AI snapshot → falls back to groupByTarget + heuristicPropose, which
		// never proposes a spec-op/apply-op candidate for a bug.
		const key = 'page:settings'
		scope.__maxstackIssueDecisions = [
			{ issueKey: key, decision: 'accept', at: '2026-07-11T01:00:00.000Z' },
		]
		const result = await landIssueCandidate(key, platform())
		expect(result.landed).toBe(false)
		expect(result.reason).toMatch(/no landable spec-op candidate/)
	})

	it('reports "issue not found" for an unknown key', async () => {
		const result = await landIssueCandidate('page:does-not-exist', platform())
		expect(result).toEqual({ landed: false, reason: 'issue not found' })
	})
})
