/**
 * Issue #358 — who the *web* host says landed an op, per request.
 *
 * The web app is the one host that serves more than one kind of caller from one
 * process: the workbench (a person in a browser), `POST /mcp` (an agent
 * speaking JSON-RPC), the REST API, and background work with no request at all.
 * It answered all of them from a single module-level `PlatformContext` built
 * once at boot with `origin: 'ai'` and no surface of its own — so
 * `apply_spec_change`'s hardcoded `surface: 'mcp'` completed the sentence, and
 * a maintainer clicking **Land** in the browser recorded
 *
 *     {"origin":"ai","actor":{"surface":"mcp","path":"mcp-apply-spec-change"}}
 *
 * A human decision attributed to an agent, in the record the review layer
 * exists to be trusted about. Nothing was mis-detected; there was simply one
 * answer where there are four questions.
 *
 * ## Why these tests are shaped this way
 *
 * Every one of these entry points looks correct in isolation, and did: the
 * pre-fix code passed `land.server.test.ts` and `mcp.server.test.ts` both,
 * because each test supplied its own context and never asked what the *process*
 * would have supplied. A suite that exercises one entry point at a time cannot
 * see this bug. So the load-bearing case below drives an MCP write and a
 * browser Land **through the same process, in that order, with no injected
 * context** — the exact reproduction from the issue — and asserts they disagree.
 *
 * Covers write path `web-land-issue` (scripts/write-paths.config.json).
 */

import type { SproutUser } from '@maxstack/core'
import { executePlatformTool } from '@maxstack/mcp'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	contextForUser,
	getContext,
	getPlatform,
	platformAttributionFor,
	platformFor,
} from './sprout.server'
import {
	allLandedKeys,
	LAND_ATTRIBUTION,
	landIssueCandidate,
} from './workbench/land.server'

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: unknown[]
	__maxstackIssueDecisions?: unknown[]
	__maxstackAiClusters?: unknown
	__maxstackLanded?: unknown[]
}

/** A POST as it arrives at a route, so the derivation is exercised against a
 *  real `Request` rather than a hand-built shape that cannot be wrong. */
const post = (path: string) =>
	new Request(`http://localhost:3000${path}`, { method: 'POST' })

/**
 * One accepted Issue carrying a landable `prd.addRequirement` candidate — the
 * same in-memory globals `land.server.test.ts` seeds, which is what
 * `deriveIssues` reads with no AI client wired.
 */
function seedAcceptedIssue(id: string): string {
	const key = 'page:inbox'
	scope.__maxstackFeedback = [
		{
			id: 'fb-1',
			at: '2026-08-06T00:00:00.000Z',
			source: 'end-user',
			target: { kind: 'page', id: 'inbox' },
			kind: 'request',
			body: 'I want to bulk-archive tasks.',
			specVersion: 'gen-1',
		},
	]
	scope.__maxstackAiClusters = {
		at: '2026-08-06T00:00:00.000Z',
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
									id,
									userStory: 'As a user, I want to bulk-archive tasks.',
									acceptanceCriteria: ['Many tasks archive at once.'],
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
	scope.__maxstackIssueDecisions = [
		{ issueKey: key, decision: 'accept', at: '2026-08-06T01:00:00.000Z' },
	]
	return key
}

/** The op-log entry a given write path landed, most recent first. */
async function lastEntryFrom(path: string) {
	const spec = await getPlatform().spec.load()
	return [...spec.opLog].reverse().find((e) => e.actor?.path === path)
}

// ===========================================================================
// The derivation, entry point by entry point
// ===========================================================================

describe('platformAttributionFor — one rule for every HTTP entry point', () => {
	it('calls POST /mcp an agent over the mcp transport', () => {
		// The transport is the signal, exactly as the stdio host settles it
		// (issue #279): nothing else speaks JSON-RPC to this app.
		expect(platformAttributionFor(post('/mcp'))).toEqual({
			origin: 'ai',
			surface: 'mcp',
		})
	})

	it('calls every other request a human on the web surface', () => {
		// A workbench action, an admin form post, a project page's CRUD action,
		// a REST call. All of them are a browser talking to this app, and none of
		// them may claim the agent's label.
		for (const path of [
			'/workbench',
			'/workbench/land',
			'/admin/task/new',
			'/app/tasks',
			'/api/task',
			'/api/task/t-1',
			'/imports/task',
		]) {
			expect(platformAttributionFor(post(path))).toEqual({
				origin: 'human',
				surface: 'web',
			})
		}
	})

	it('is not fooled by a query string or a path that merely contains /mcp', () => {
		// A prefix match would hand `/api/mcp-usage` the agent's label, and the
		// direction of that mistake is the expensive one.
		expect(platformAttributionFor(post('/mcp?trace=1')).surface).toBe('mcp')
		expect(platformAttributionFor(post('/api/mcp-usage')).surface).toBe('web')
		expect(platformAttributionFor(post('/mcp/extra')).surface).toBe('web')
	})

	it('agrees with what the Land button declares for itself', () => {
		// An agreement, not a restated literal: `land.server` names its own
		// attribution and this asserts the shared rule reaches the same answer for
		// the request that triggers it, so the two cannot drift apart while both
		// look individually correct.
		const fromRequest = platformAttributionFor(post('/workbench/land'))
		expect(fromRequest.origin).toBe(LAND_ATTRIBUTION.origin)
		expect(fromRequest.surface).toBe(LAND_ATTRIBUTION.surface)
	})
})

// ===========================================================================
// The split: shared capabilities, per-request attribution
// ===========================================================================

describe('platformFor — the singleton is capabilities, never attribution', () => {
	it('shares one spec store across callers that attribute themselves differently', () => {
		const agent = platformFor({ origin: 'ai', surface: 'mcp' })
		const human = platformFor(LAND_ATTRIBUTION)
		// The expensive, stateful half is genuinely process-wide — this is what
		// made a singleton tempting, and it is preserved.
		expect(agent.spec).toBe(human.spec)
		expect(agent.generators).toBe(human.generators)
		// The four free fields are not.
		expect(agent.origin).toBe('ai')
		expect(human.origin).toBe('human')
		expect(agent.surface).toBe('mcp')
		expect(human.surface).toBe('web')
		expect(human.writePath).toBe('web-land-issue')
	})

	it('gives background work no platform at all rather than a borrowed identity', async () => {
		// A source poll or a queued job has no request and is not an author. The
		// honest answer is an absent capability, not `origin: 'human'` on a write
		// nobody made — and it fails loudly (unknown tool) rather than quietly.
		// The runtime's own `origin: 'system'` is a different axis entirely: it
		// lives on the audit log, and the source loop guard still reads it there.
		const user: SproutUser = { id: 'svc', role: 'admin' }
		expect((await contextForUser(user)).platform).toBeUndefined()
		expect(
			(await contextForUser(user, { origin: 'human', surface: 'web' }))
				.platform,
		).toBeDefined()
	})
})

// ===========================================================================
// The reproduction: two entry points, one process
// ===========================================================================

describe('a browser Land after an MCP write, in one process (#358)', () => {
	beforeEach(() => {
		scope.__maxstackFeedback = []
		scope.__maxstackIssueDecisions = []
		scope.__maxstackAiClusters = undefined
		scope.__maxstackLanded = []
	})

	it('records the agent as the agent and the human as the human', async () => {
		// 1. An agent writes over POST /mcp, through the real route context — the
		//    request the process has already served by the time a maintainer opens
		//    the workbench, and the one that used to define everybody's identity.
		const mcpCtx = await getContext(post('/mcp'))
		const agentPlatform = mcpCtx.platform
		if (!agentPlatform)
			throw new Error('the /mcp route context has no platform')
		const applied = await executePlatformTool(
			agentPlatform,
			'apply_spec_change',
			{
				op: 'prd.addRequirement',
				args: {
					requirement: {
						id: 'r-agent-wrote-this',
						userStory: 'As an agent, I write to the spec.',
						acceptanceCriteria: ['It is attributed to me.'],
						priority: 'P3',
						edgeCasesAndErrorStates: [],
					},
				},
			},
		)
		expect(applied.isError).toBeFalsy()

		const agentEntry = await lastEntryFrom('mcp-apply-spec-change')
		expect(agentEntry?.origin).toBe('ai')
		expect(agentEntry?.actor?.surface).toBe('mcp')

		// 2. Now a maintainer clicks Land in a browser. No context is injected —
		//    this is the production default, which is the whole point: injecting
		//    one is what made every existing test pass over the bug.
		const key = seedAcceptedIssue('r-human-landed-this')
		const result = await landIssueCandidate(key)
		expect(result.landed).toBe(true)
		expect(await allLandedKeys()).toContain(key)

		const landEntry = await lastEntryFrom('web-land-issue')
		expect(landEntry?.origin).toBe('human')
		expect(landEntry?.actor?.surface).toBe('web')
		expect(landEntry?.actor?.path).toBe('web-land-issue')

		// 3. And they are two different entries. Before the fix both carried
		//    `{ai, mcp, mcp-apply-spec-change}` and this file could not tell them
		//    apart at all.
		expect(landEntry?.id).not.toBe(agentEntry?.id)
		expect(agentEntry?.actor?.path).not.toBe(landEntry?.actor?.path)

		// The decision-ledger entry Land writes alongside the op carries the same
		// author kind — a maintainer's rationale must not read as an agent's.
		const spec = await getPlatform().spec.load()
		expect(spec.ledger.find((e) => e.id === `d-land-page-inbox`)?.origin).toBe(
			'human',
		)
	})

	it('leaves a later browser request unaffected by the MCP request before it', async () => {
		// The singleton's real failure mode was order-dependence: whatever built
		// it first defined everybody. Serve MCP first, then ask what a form post
		// gets.
		await getContext(post('/mcp'))
		const browser = await getContext(post('/workbench'))
		expect(browser.platform?.origin).toBe('human')
		expect(browser.platform?.surface).toBe('web')

		// …and the other order, so neither request can be the one that wins.
		const agent = await getContext(post('/mcp'))
		expect(agent.platform?.origin).toBe('ai')
		expect(agent.platform?.surface).toBe('mcp')
	})
})
