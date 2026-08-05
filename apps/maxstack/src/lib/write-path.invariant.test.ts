/**
 * The write-path invariant suite, CLI surface.
 *
 * Seven declared paths, all landing through the one shared pipeline in `land.ts`:
 *
 *   `cli-op`         `maxstack op` — the raw typed op
 *   `cli-add-entity` `maxstack add-entity` — sugar → data.addEntity
 *   `cli-add-field`  `maxstack add-field`  — sugar → data.addField
 *   `cli-add-page`   `maxstack add-page`   — sugar → page.addPage
 *   `cli-theme`      `maxstack theme`      — sugar → theme.set
 *   `cli-start`      `maxstack start` — lands the AI-drafted blueprint
 *   `cli-land-op`    the shared apply → (accept) → (gen) pipeline itself
 *
 * The CLI is the surface where attribution is *hardest*, and issue #141 is the
 * proof: the verbs hardcoded `origin: 'human'`, so an agent shelling out to
 * `maxstack add-entity` — which the docs actively encourage — logged its own work
 * as hand-authored, while the same op over MCP logged `'ai'`. That is a
 * provenance record that lies, and it lay undetected because nothing asserted
 * over it. These tests exist so the next such gap fails a build.
 *
 * The commands are driven for real over a temp project directory rather than
 * through mocks: what is being checked is precisely the *wiring* between a verb
 * and the trail, and a mock of `landOps` would assert that the test knows what
 * the test set up.
 *
 * Registry: scripts/write-paths.config.json. Policy: docs/write-paths.md.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpecDir } from '@maxstack/mcp'
import { type AppliedOp, opActorSchema, type SpecSystem } from '@maxstack/spec'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	addEntityCommand,
	addFieldCommand,
	addPageCommand,
} from '../commands/add-entity.ts'
import { initCommand } from '../commands/init.ts'
import { opCommand } from '../commands/op.ts'
import { themeCommand } from '../commands/theme.ts'
import { resolveActor, resolveOrigin } from './origin.ts'

/** A hand-authored row, spelled out: `maxstack op` takes the wire shape, and the
 *  op validator deliberately refuses the compact on-disk provenance codec. */
const MANUAL = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium' as const,
}

/** Pin a scaffolded project's review mode, for suites that exercise the queue. */
async function setReviewMode(dir: string, mode: 'review' | 'auto'): Promise<void> {
	const path = join(dir, 'maxstack.json')
	const config = JSON.parse(await readFile(path, 'utf8'))
	config.reviewMode = mode
	await writeFile(path, `${JSON.stringify(config, null, '\t')}\n`)
}

describe('CLI write paths are attributed end to end', () => {
	let dir: string
	const loadSpec = (): Promise<SpecSystem> => readSpecDir(join(dir, 'spec'))

	/** Op-log entries added since `from`, newest last. */
	const since = async (from: number): Promise<AppliedOp[]> =>
		(await loadSpec()).opLog.slice(from)

	const logLength = async (): Promise<number> => (await loadSpec()).opLog.length

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-writepath-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'a write-path invariant fixture' })
		// This suite exercises the review queue, so it pins the mode it tests
		// rather than depending on the scaffold default.
		await setReviewMode(dir, 'review')
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('cli-op stamps the cli surface and its own write path', async () => {
		const before = await logLength()
		await opCommand(dir, {
			origin: 'human',
			agent: 'test-harness',
			op: JSON.stringify({
				op: 'data.addEntity',
				args: {
					entity: {
						id: 'e-widget',
						name: 'Widget',
						provenance: MANUAL,
						fields: [
							{
								id: 'fld-title',
								name: 'title',
								type: 'string',
								required: true,
								provenance: MANUAL,
							},
						],
					},
				},
			}),
		})
		const [entry] = await since(before)
		expect(entry?.origin).toBe('human')
		expect(entry?.actor?.surface).toBe('cli')
		expect(entry?.actor?.path).toBe('cli-op')
		expect(entry?.actor?.agent).toBe('test-harness')
	})

	it('cli-add-entity, cli-add-field and cli-add-page each name themselves', async () => {
		// Three verbs share one `settle` helper, which is exactly the shape that
		// produces a trail reading "the sugar commands" for all of them. Each has to
		// be distinguishable or a reviewer is guessing.
		const before = await logLength()
		await addEntityCommand(dir, 'invoice', {
			field: ['total:number!'],
			origin: 'human',
		})
		await addFieldCommand(dir, 'invoice', 'dueOn:date', { origin: 'human' })
		await addPageCommand(dir, 'invoice', { origin: 'human' })

		const paths = (await since(before)).map((e) => e.actor?.path)
		expect(paths).toEqual(['cli-add-entity', 'cli-add-field', 'cli-add-page'])
	})

	it('cli-theme is attributed even though it reviews nothing', async () => {
		// The theme is not a provenanced row, so there is no review queue entry for
		// it — but it still lands an op-log entry, and an unattributed entry in an
		// audit trail is the thing this issue exists to prevent.
		const before = await logLength()
		await themeCommand(dir, 'ocean', { origin: 'human' })
		const [entry] = await since(before)
		expect(entry?.op.op).toBe('theme.set')
		expect(entry?.actor?.path).toBe('cli-theme')
		expect(entry?.actor?.surface).toBe('cli')
	})

	it('records an agent-driven CLI write as ai, not as hand-authored', async () => {
		// Issue #141's bug, now with a test: `--origin ai` must reach the trail, and
		// `--agent` must say which agent, so an agent shelling out to the CLI is
		// distinguishable from the maintainer typing.
		const before = await logLength()
		await addEntityCommand(dir, 'receipt', {
			field: ['amount:number!'],
			origin: 'ai',
			agent: 'claude-code',
		})
		const [entry] = await since(before)
		expect(entry?.origin).toBe('ai')
		expect(entry?.actor?.agent).toBe('claude-code')
		expect(entry?.actor?.path).toBe('cli-add-entity')
	})

	it('leaves no CLI-landed op unattributed, across the whole session', async () => {
		const spec = await loadSpec()
		const cliEntries = spec.opLog.filter((e) => e.actor?.surface === 'cli')
		expect(cliEntries.length).toBeGreaterThan(5)
		for (const entry of cliEntries) {
			expect(entry.actor?.path, `op ${entry.id} has no write path`).toBeTruthy()
			expect(opActorSchema.safeParse(entry.actor).success).toBe(true)
		}
	})

	it('never settles a review as a side effect of an unrelated write', async () => {
		// Everything above landed with `--accept` unset and the project's default
		// `reviewMode: 'review'`, so nothing here should have flipped a decision.
		const spec = await loadSpec()
		const reviews = spec.opLog.filter((e) => e.op.op === 'provenance.review')
		expect(reviews).toHaveLength(0)
	})
})

// ===========================================================================
// cli-land-op — the shared pipeline, and the one path that may accept
// ===========================================================================

describe('write path "cli-land-op" (the shared land pipeline)', () => {
	let dir: string
	const loadSpec = (): Promise<SpecSystem> => readSpecDir(join(dir, 'spec'))

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-writepath-land-'))
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await initCommand(dir, { desc: 'the land pipeline fixture' })
		// This suite exercises the review queue, so it pins the mode it tests
		// rather than depending on the scaffold default.
		await setReviewMode(dir, 'review')
	})

	afterAll(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	it('stamps --accept\'s review with the SAME actor as the op it settles', async () => {
		// This is the honest bit. `--accept` is the author accepting their own
		// change, not a review somebody performed — so the trail must show one actor
		// across both entries rather than implying a second party looked at it.
		await addEntityCommand(dir, 'ticket', {
			field: ['subject:text!'],
			origin: 'ai',
			agent: 'claude-code',
			accept: true,
		})
		const spec = await loadSpec()
		const review = spec.opLog.find((e) => e.op.op === 'provenance.review')
		const add = spec.opLog.find(
			(e) => e.op.op === 'data.addEntity' && e.actor?.path === 'cli-add-entity',
		)
		expect(review).toBeDefined()
		expect(review?.actor).toEqual(add?.actor)
		expect(review?.origin).toBe(add?.origin)
		expect(review?.origin).toBe('ai')
	})
})

// ===========================================================================
// cli-start — the entry path
// ===========================================================================

describe('write path "cli-start"', () => {
	it('is declared as always-ai, whoever typed the command', () => {
		// `maxstack start` lands a blueprint an AI drafted from a sentence, so the
		// spec is machine-authored whether a person or an agent invoked it — the
		// whole point of the entry path is that the user did not write it. Encoded in
		// the registry as `authorKind: "ai"`.
		//
		// The command itself is not driven here: it scaffolds, calls a model,
		// regenerates the tree and serves. It is exercised end to end by the
		// `cold-start` CI job, which runs `npx maxstack start` on a cold runner and
		// asserts rows are visible through the app's own API — a far better test of
		// that path than anything this file could stand up.
		const actor = resolveActor(
			{ path: 'cli-start', agent: 'maxstack-start' },
			{},
		)
		expect(actor).toEqual({
			surface: 'cli',
			path: 'cli-start',
			agent: 'maxstack-start',
		})
	})
})

// ===========================================================================
// resolveActor / resolveOrigin — the resolution rules themselves
// ===========================================================================

describe('actor resolution reads the environment, never guesses', () => {
	it('prefers an explicit --agent over everything', () => {
		const actor = resolveActor(
			{ path: 'cli-op', agent: 'explicit' },
			{ MAXSTACK_AGENT: 'from-env', CLAUDECODE: '1' },
		)
		expect(actor.agent).toBe('explicit')
	})

	it('falls back to MAXSTACK_AGENT, then to a recognised harness', () => {
		expect(
			resolveActor({ path: 'cli-op' }, { MAXSTACK_AGENT: 'from-env' }).agent,
		).toBe('from-env')
		expect(resolveActor({ path: 'cli-op' }, { CLAUDECODE: '1' }).agent).toBe(
			'claude-code',
		)
	})

	it('records no agent at all when nothing identified itself', () => {
		// A placeholder in a provenance record reads as an answer. Absent is honest.
		const actor = resolveActor({ path: 'cli-op' }, {})
		expect(actor).toEqual({ surface: 'cli', path: 'cli-op' })
		expect(actor).not.toHaveProperty('agent')
	})

	it('carries session and key id through when the caller sets them', () => {
		const actor = resolveActor(
			{ path: 'cli-op' },
			{ MAXSTACK_SESSION: 'sess-1', MAXSTACK_KEY_ID: 'key-9' },
		)
		expect(actor.session).toBe('sess-1')
		expect(actor.keyId).toBe('key-9')
	})

	it('treats blank and explicitly-off values as absent', () => {
		const actor = resolveActor(
			{ path: 'cli-op', agent: '  ' },
			{ MAXSTACK_AGENT: '', MAXSTACK_SESSION: '   ', CLAUDECODE: '0' },
		)
		expect(actor).toEqual({ surface: 'cli', path: 'cli-op' })
	})

	it('keeps origin and actor as independent facts', () => {
		// A human runs the CLI and so does an agent; the surface is the same either
		// way. Collapsing the two would reintroduce #141's bug from the other side.
		const env = { CLAUDECODE: '1' }
		expect(resolveOrigin(undefined, env)).toBe('ai')
		expect(resolveActor({ path: 'cli-op' }, env).surface).toBe('cli')
		expect(resolveOrigin('human', env)).toBe('human')
		expect(resolveActor({ path: 'cli-op' }, env).agent).toBe('claude-code')
	})
})
