import {
	createInMemorySpecStore,
	defaultCheckRunner,
	defaultGeneratorRunner,
	type PlatformContext,
} from '@maxstack/mcp'
import {
	accept,
	manual,
	newSpecSystem,
	type OpId,
	partitionForRegen,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import type { ProposedCluster } from '@maxstack/spec-derive/clustering'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	allLandedKeys,
	candidateAuthorship,
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

// ===========================================================================
// Issue #359 — the row a landed AI proposal produces
// ===========================================================================

/**
 * The same seed as {@link seedLandableIssue}, but the candidate is a
 * `data.addEntity` — a *provenanced* op. `prd.addRequirement` cannot see this
 * bug: requirements carry no provenance row, so the whole
 * `manual()` vs `accept(suggested())` question never arises for them, and every
 * pre-existing Land test used one.
 *
 * The op deliberately supplies **no** `provenance` on the entity or its field,
 * because that is the production shape: the clustering layer proposes a typed
 * op, not a provenance decision, and `applyOp`'s `defaultProvenance` is what
 * fills it in. Supplying one here would test nothing.
 */
function seedLandableEntityIssue(): string {
	scope.__maxstackFeedback = [
		{
			id: 'fb-3',
			at: '2026-08-07T00:00:00.000Z',
			source: 'end-user',
			target: { kind: 'page', id: 'archive' },
			kind: 'request',
			body: 'I want somewhere to keep archived tasks.',
			specVersion: 'gen-1',
		},
	]
	scope.__maxstackAiClusters = {
		at: '2026-08-07T00:00:00.000Z',
		feedbackCount: 1,
		clusters: [
			{
				title: 'Archive shelf',
				question: 'Should archived tasks get their own entity?',
				rationale: 'One user asked for it.',
				feedbackIds: ['fb-3'],
				confidence: 0.8,
				candidates: [
					{
						id: 'cand-archive',
						description: 'Add an Archive entity',
						kind: 'spec-op',
						via: 'apply-op',
						op: {
							op: 'data.addEntity',
							args: {
								entity: {
									id: 'e-archive',
									name: 'Archive',
									fields: [
										{
											id: 'fld-label',
											name: 'label',
											type: 'string',
											required: false,
										},
									],
								},
							},
						},
					},
				],
			},
		],
	}
	return 'page:archive'
}

describe('landing an AI proposal keeps it legible as one (#359)', () => {
	beforeEach(() => {
		scope.__maxstackFeedback = []
		scope.__maxstackIssueDecisions = []
		scope.__maxstackAiClusters = undefined
		scope.__maxstackLanded = []
	})

	it('lands the row as an accepted suggestion, not as hand-authored work', async () => {
		const key = seedLandableEntityIssue()
		scope.__maxstackIssueDecisions = [
			{ issueKey: key, decision: 'accept', at: '2026-08-07T01:00:00.000Z' },
		]
		const ctx = platform()
		expect((await landIssueCandidate(key, ctx)).landed).toBe(true)

		const spec = await ctx.spec.load()
		const entity = spec.data.entities.find((e) => e.id === 'e-archive')
		expect(entity).toBeDefined()
		// The whole triple, because each third says something different:
		// `isSuggested` keeps the AI origin visible after the row goes live,
		// `isAccepted` is what makes it ground the running app immediately, and
		// `isAddedManually: false` is the one the #358 fix flipped by accident.
		expect(entity?.provenance).toMatchObject({
			isSuggested: true,
			isAccepted: true,
			isAddedManually: false,
		})
		// The fields the same op declared, not just the entity — `data.addEntity`
		// stamps both from the same fallback and a row is only as legible as its
		// least legible part.
		expect(entity?.fields[0]?.provenance).toMatchObject({
			isSuggested: true,
			isAccepted: true,
			isAddedManually: false,
		})
	})

	it('leaves the landed row regenerable rather than regen-protected', async () => {
		// `isAddedManually` is not a label, it is a behaviour: manual rows survive
		// a regenerate that drops everything else (`partitionForRegen`, and
		// `checkProvenanceInvariants`'s manual-survives rule over in
		// maxstack-core). A landed suggestion that silently acquired that
		// protection would outlive the spec it came from.
		const key = seedLandableEntityIssue()
		scope.__maxstackIssueDecisions = [
			{ issueKey: key, decision: 'accept', at: '2026-08-07T01:00:00.000Z' },
		]
		const ctx = platform()
		expect((await landIssueCandidate(key, ctx)).landed).toBe(true)

		const spec = await ctx.spec.load()
		const landedRows = spec.data.entities.filter((e) => e.id === 'e-archive')
		expect(landedRows).toHaveLength(1)
		const { kept, deleted } = partitionForRegen(landedRows)
		expect(kept).toHaveLength(0)
		expect(deleted).toHaveLength(1)
	})

	it('still records the maintainer who clicked, on the op and the ledger (#358 stays fixed)', async () => {
		// The two axes, in one assertion, so a future change cannot buy one back by
		// giving up the other. `authorship` moved the *row*; the *log* must not move.
		const key = seedLandableEntityIssue()
		scope.__maxstackIssueDecisions = [
			{ issueKey: key, decision: 'accept', at: '2026-08-07T01:00:00.000Z' },
		]
		const ctx = platform()
		expect((await landIssueCandidate(key, ctx)).landed).toBe(true)

		const spec = await ctx.spec.load()
		const entry = spec.opLog.find((e) => e.actor?.path === 'web-land-issue')
		expect(entry?.origin).toBe('human')
		expect(entry?.actor?.surface).toBe('web')
		expect(entry?.actor?.path).toBe('web-land-issue')
		expect(
			spec.ledger.find((e) => e.id === 'd-land-page-archive')?.origin,
		).toBe('human')
	})

	it('reads authorship off the proposal rather than assuming every land is an AI land', async () => {
		// The derivation, both ways round. An Issue arrives `suggested()` from
		// clustering and `accept` preserves that flag, so an accepted Issue still
		// answers `ai` — which is exactly the case the bug got wrong. A row that
		// was never a suggestion answers `human` and gets `manual()`, which is
		// still the right answer for hand-authored intent.
		const base = {
			id: 'issue-1',
			question: 'q',
			title: 't',
			rationale: 'r',
			targets: [],
			feedbackIds: [],
			severity: 'request' as const,
			confidence: 0.5,
			candidates: [],
		}
		expect(candidateAuthorship({ ...base, provenance: suggested() })).toBe('ai')
		expect(
			candidateAuthorship({ ...base, provenance: accept(suggested()) }),
		).toBe('ai')
		expect(candidateAuthorship({ ...base, provenance: manual() })).toBe('human')
	})
})
