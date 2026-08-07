import {
	createInMemorySpecStore,
	defaultCheckRunner,
	defaultGeneratorRunner,
	type PlatformContext,
} from '@maxstack/mcp'
import {
	applyOp,
	newSpecSystem,
	type OpId,
	type SpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import type { ProposedCluster } from '@maxstack/spec-derive/clustering'
import { beforeEach, describe, expect, it } from 'vitest'
import { computeHypotheticalSpec, loadDiffPreview } from './diff-preview.server'

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

const META = {
	id: 'op-seed' as OpId,
	origin: 'human' as const,
	appliedAt: '2026-07-12T00:00:00.000Z',
	actor: { surface: 'harness' as const },
}

/** Seeds one feedback + AI cluster snapshot that proposes a `page.addPage`
 *  candidate — a new page ("checkout") that doesn't exist in the spec yet, so
 *  its before render is legitimately empty and its after render is not. Same
 *  seeding pattern `land.server.test.ts` uses (poking the in-memory globals
 *  the workbench host reads through directly, so this stays independent of a
 *  live `AiClient`). Returns the issue key. */
function seedNewPageCandidate(): string {
	scope.__maxstackFeedback = [
		{
			id: 'fb-1',
			at: '2026-07-11T00:00:00.000Z',
			source: 'end-user',
			target: { kind: 'page', id: 'pg-checkout' },
			kind: 'request',
			body: 'I want a checkout page.',
			specVersion: 'gen-1',
		},
	]
	scope.__maxstackAiClusters = {
		at: '2026-07-11T00:00:00.000Z',
		feedbackCount: 1,
		clusters: [
			{
				title: 'Add checkout page',
				question: 'Should we add a checkout page?',
				rationale: 'A user asked for one.',
				feedbackIds: ['fb-1'],
				confidence: 0.8,
				candidates: [
					{
						id: 'cand-1',
						description: 'Add a checkout page',
						kind: 'spec-op',
						via: 'apply-op',
						op: {
							op: 'page.addPage',
							args: {
								page: {
									id: 'pg-checkout',
									name: 'Checkout',
									route: '/checkout',
									blocks: [],
								},
							},
						},
					},
				],
			},
		],
	}
	return 'page:pg-checkout'
}

/** Seeds a candidate against a page that already exists in the platform's
 *  spec (added to `base` before the store is created) — so both before and
 *  after resolve to the same page id, the case where a reviewer is looking at
 *  a change to an existing page rather than a brand-new one. */
function seedExistingPageEditCandidate(): {
	issueKey: string
	base: SpecSystem
} {
	const base = applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'page.addPage',
			args: {
				page: { id: 'pg-inbox', name: 'Inbox', route: '/inbox', blocks: [] },
			},
		},
		META,
	)

	scope.__maxstackFeedback = [
		{
			id: 'fb-2',
			at: '2026-07-11T00:00:00.000Z',
			source: 'end-user',
			target: { kind: 'page', id: 'pg-inbox' },
			kind: 'request',
			body: 'I want a bulk-archive action on the inbox.',
			specVersion: 'gen-1',
		},
	]
	scope.__maxstackAiClusters = {
		at: '2026-07-11T00:00:00.000Z',
		feedbackCount: 1,
		clusters: [
			{
				title: 'Bulk archive slot',
				question: 'Add a bulk-archive extension slot to inbox?',
				rationale: 'A user asked for it.',
				feedbackIds: ['fb-2'],
				confidence: 0.8,
				candidates: [
					{
						id: 'cand-2',
						description: 'Add a bulk-archive slot block to inbox',
						kind: 'spec-op',
						via: 'apply-op',
						op: {
							op: 'page.addBlock',
							args: {
								pageId: 'pg-inbox',
								block: { id: 'blk-bulk-archive', type: 'slot:bulkArchive' },
							},
						},
					},
				],
			},
		],
	}
	return { issueKey: 'page:pg-inbox', base }
}

function platform(
	spec: SpecSystem = newSpecSystem(tasklyPRD),
): PlatformContext {
	let counter = 0
	return {
		spec: createInMemorySpecStore(spec),
		generators: defaultGeneratorRunner(),
		checks: defaultCheckRunner(),
		origin: 'ai',
		surface: 'mcp',
		now: () => '2026-07-12',
		nextOpId: () => `op-test-${++counter}` as OpId,
	}
}

describe('computeHypotheticalSpec — the "if accepted" clone', () => {
	it('never mutates the original spec object', () => {
		const original = newSpecSystem(tasklyPRD)
		const snapshot = structuredClone(original)

		const { spec: hypothetical, error } = computeHypotheticalSpec(original, {
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-checkout',
					name: 'Checkout',
					route: '/checkout',
					blocks: [],
				},
			},
		})

		expect(error).toBeNull()
		expect(hypothetical).not.toBeNull()
		expect(original).toEqual(snapshot) // byte-for-byte unchanged
		expect(original.pages.pages).toHaveLength(0)
		expect(hypothetical?.pages.pages).toHaveLength(1)
		// Genuinely a different object, not the same reference mutated in place.
		expect(hypothetical).not.toBe(original)
	})

	it('reports an error instead of throwing when the op does not validate', () => {
		const spec = applyOp(
			newSpecSystem(tasklyPRD),
			{
				op: 'page.addPage',
				args: {
					page: {
						id: 'pg-checkout',
						name: 'Checkout',
						route: '/checkout',
						blocks: [],
					},
				},
			},
			META,
		)
		// Same id again — validateOp rejects the duplicate.
		const { spec: hypothetical, error } = computeHypotheticalSpec(spec, {
			op: 'page.addPage',
			args: {
				page: {
					id: 'pg-checkout',
					name: 'Checkout 2',
					route: '/checkout2',
					blocks: [],
				},
			},
		})
		expect(hypothetical).toBeNull()
		expect(error).toMatch(/already exists/)
	})
})

describe('loadDiffPreview — before/after over the review queue', () => {
	beforeEach(() => {
		scope.__maxstackFeedback = []
		scope.__maxstackIssueDecisions = []
		scope.__maxstackAiClusters = undefined
		scope.__maxstackLanded = []
	})

	it('renders distinct before/after for a brand-new page — before is empty, after renders the page', async () => {
		const key = seedNewPageCandidate()
		const diff = await loadDiffPreview(key, platform())

		expect(diff).not.toBeNull()
		expect(diff?.unavailableReason).toBeNull()
		expect(diff?.pageId).toBe('pg-checkout')
		// Target coordinate carried through for highlighting in both panes.
		expect(diff?.targets).toEqual([{ kind: 'page', id: 'pg-checkout' }])

		expect(diff?.before).toBeNull() // the page doesn't exist yet
		expect(diff?.after?.error).toBeNull()
		expect(diff?.after?.html).toContain('<h1>Checkout</h1>')
		expect(diff?.after?.html).toContain('data-resource="checkout"')
	})

	it('renders both before and after for a change to an existing page, both keyed to the same target', async () => {
		const { issueKey, base } = seedExistingPageEditCandidate()
		const diff = await loadDiffPreview(issueKey, platform(base))

		expect(diff?.unavailableReason).toBeNull()
		expect(diff?.pageId).toBe('pg-inbox')
		expect(diff?.targets).toEqual([{ kind: 'page', id: 'pg-inbox' }])

		// Both renders exist (the page already exists before AND after).
		expect(diff?.before?.error).toBeNull()
		expect(diff?.after?.error).toBeNull()
		expect(diff?.before?.html).toContain('data-resource="inbox"')
		expect(diff?.after?.html).toContain('data-resource="inbox"')
	})

	it('reports why no diff is available for a non-spec-op candidate (nothing typed to apply)', async () => {
		scope.__maxstackFeedback = [
			{
				id: 'fb-3',
				at: '2026-07-11T00:00:00.000Z',
				source: 'end-user',
				target: { kind: 'page', id: 'settings' },
				kind: 'bug',
				body: 'Something is broken.',
				specVersion: 'gen-1',
			},
		]
		// No AI snapshot → groupByTarget + heuristicPropose, which never proposes
		// a spec-op/apply-op candidate for a bug (same fixture land.server.test.ts
		// uses for its "no landable candidate" case).
		const diff = await loadDiffPreview('page:settings', platform())
		expect(diff?.before).toBeNull()
		expect(diff?.after).toBeNull()
		expect(diff?.unavailableReason).toMatch(/no landable spec-op candidate/)
	})

	it('returns null for a key that does not resolve to any queue item', async () => {
		const diff = await loadDiffPreview('page:does-not-exist', platform())
		expect(diff).toBeNull()
	})
})
