/**
 * The write-path invariant suite, MCP surface.
 *
 * This is the surface the whole positioning is nervous about: the one an agent
 * drives unattended. Two write paths live behind it, and the distinction between
 * them is the platform's central claim, so it gets tested rather than trusted:
 *
 *   `validate-op-dry-run`   `propose_spec_change` — validates and diffs, writes
 *                           nothing. The suggest half.
 *   `mcp-apply-spec-change` `apply_spec_change` / `record_decision` — the
 *                           authorized write. Lands accepted, attributed, logged.
 *
 * The honest statement of the guarantee, and the one asserted here: an agent
 * cannot change the spec *without leaving a complete, attributed, revertible
 * record*, and it cannot settle a review somebody else has to make. It CAN land
 * a change that grounds immediately settled that, because a
 * suggestion the runtime cannot see is a suggestion nobody can evaluate. Review
 * is a record, not a gate.
 *
 * Registry: scripts/write-paths.config.json. Policy: docs/write-paths.md.
 */

import type { McpToolResult } from '@maxstack/core'
import {
	type EntitySpec,
	newSpecSystem,
	type OpId,
	opActorSchema,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { defaultCheckRunner } from './checks.ts'
import type { PlatformContext } from './context.ts'
import { defaultGeneratorRunner } from './generators.ts'
import { createInMemorySpecStore } from './spec-store.ts'
import { executePlatformTool } from './tools.ts'

function payload(res: McpToolResult): Record<string, unknown> {
	return JSON.parse(res.content[0]?.text ?? 'null')
}

/** A context whose host answered every attribution question it could. */
function ctxFor(
	spec: SpecSystem,
	actor?: PlatformContext['actor'],
): PlatformContext {
	let n = 0
	return {
		spec: createInMemorySpecStore(spec),
		generators: defaultGeneratorRunner(),
		checks: defaultCheckRunner(),
		origin: 'ai',
		now: () => '2026-07-29',
		nextOpId: () => `op-${++n}` as OpId,
		actor,
	}
}

/** An entity whose rows land undecided — an explicit review-queue candidate. */
const undecided: EntitySpec = {
	id: 'e-order',
	name: 'Order',
	provenance: suggested(),
	fields: [
		{
			id: 'fld-total',
			name: 'total',
			type: 'number',
			required: true,
			provenance: suggested(),
		},
	],
}

const addUndecided = {
	op: 'data.addEntity',
	args: { entity: undecided },
}

// ===========================================================================
// validate-op-dry-run — propose writes nothing
// ===========================================================================

describe('write path "validate-op-dry-run" (propose_spec_change)', () => {
	it('validates and diffs without touching the stored spec', async () => {
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		const before = structuredClone(await ctx.spec.load())

		const res = await executePlatformTool(
			ctx,
			'propose_spec_change',
			addUndecided,
		)
		expect(payload(res).valid).toBe(true)

		const after = await ctx.spec.load()
		expect(after).toEqual(before)
		expect(after.opLog).toHaveLength(0)
		expect(after.data.entities).toHaveLength(0)
	})

	it('writes nothing on a proposal it rejects either', async () => {
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		const before = structuredClone(await ctx.spec.load())
		const res = await executePlatformTool(ctx, 'propose_spec_change', {
			op: 'data.addField',
			args: { entityId: 'e-nope', field: undecided.fields[0] },
		})
		expect(payload(res).valid).toBe(false)
		expect(await ctx.spec.load()).toEqual(before)
	})

	it('stays write-free across a long proposal run', async () => {
		// The realistic agent loop: propose repeatedly while narrowing in on a
		// payload. None of it may accumulate anywhere.
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		for (let i = 0; i < 25; i++) {
			await executePlatformTool(ctx, 'propose_spec_change', {
				op: 'data.addEntity',
				args: { entity: { ...undecided, id: `e-try${i}` } },
			})
		}
		const after = await ctx.spec.load()
		expect(after.opLog).toHaveLength(0)
		expect(after.data.entities).toHaveLength(0)
	})
})

// ===========================================================================
// mcp-apply-spec-change — the authorized write, fully attributed
// ===========================================================================

describe('write path "mcp-apply-spec-change" (apply_spec_change)', () => {
	it('lands the op attributed to the mcp surface and its write path', async () => {
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		await executePlatformTool(ctx, 'apply_spec_change', addUndecided)

		const entry = (await ctx.spec.load()).opLog.at(-1)
		expect(entry?.origin).toBe('ai')
		expect(entry?.actor?.surface).toBe('mcp')
		expect(entry?.actor?.path).toBe('mcp-apply-spec-change')
	})

	it("carries the host's agent, session and key into the trail", async () => {
		// The reason `origin: 'ai'` was not enough: two entries both
		// stamped `ai` may be an interactive coding agent and a scheduled job holding
		// a long-lived key, and a reviewer treats those differently.
		const ctx = ctxFor(newSpecSystem(tasklyPRD), {
			agent: 'claude-code',
			session: 'sess-abc123',
			keyId: 'key-42',
		})
		await executePlatformTool(ctx, 'apply_spec_change', addUndecided)

		const entry = (await ctx.spec.load()).opLog.at(-1)
		expect(entry?.actor).toEqual({
			surface: 'mcp',
			path: 'mcp-apply-spec-change',
			agent: 'claude-code',
			session: 'sess-abc123',
			keyId: 'key-42',
		})
		expect(opActorSchema.safeParse(entry?.actor).success).toBe(true)
	})

	it('records nothing it cannot answer, rather than a placeholder', async () => {
		// A host that knows nothing about the caller supplies nothing. An invented
		// `agent: 'unknown'` would read as an answer in an audit record.
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		await executePlatformTool(ctx, 'apply_spec_change', addUndecided)

		const actor = (await ctx.spec.load()).opLog.at(-1)?.actor
		expect(actor).toEqual({ surface: 'mcp', path: 'mcp-apply-spec-change' })
		expect(actor).not.toHaveProperty('agent')
		expect(actor).not.toHaveProperty('session')
		expect(actor).not.toHaveProperty('keyId')
	})

	it('attributes every op in an unattended agent run', async () => {
		const ctx = ctxFor(newSpecSystem(tasklyPRD), { agent: 'claude-code' })
		for (let i = 0; i < 10; i++) {
			await executePlatformTool(ctx, 'apply_spec_change', {
				op: 'data.addEntity',
				args: { entity: { ...undecided, id: `e-run${i}` } },
			})
		}
		const spec = await ctx.spec.load()
		expect(spec.opLog).toHaveLength(10)
		for (const entry of spec.opLog) {
			expect(entry.actor?.path, `op ${entry.id} lost its write path`).toBe(
				'mcp-apply-spec-change',
			)
			expect(entry.actor?.agent).toBe('claude-code')
		}
	})

	it('cannot settle a review the agent did not already own', async () => {
		// The one thing an unattended agent must not be able to do: take an
		// undecided row somebody else is meant to look at and mark it reviewed as a
		// side effect of unrelated work.
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		await executePlatformTool(ctx, 'apply_spec_change', addUndecided)
		expect(
			(await ctx.spec.load()).data.entities[0]?.provenance.isAccepted,
		).toBeNull()

		// Ten further ops, none of them a review.
		for (let i = 0; i < 10; i++) {
			await executePlatformTool(ctx, 'apply_spec_change', {
				op: 'data.addField',
				args: {
					entityId: 'e-order',
					field: {
						id: `fld-x${i}`,
						name: `x${i}`,
						type: 'string',
						required: false,
						provenance: suggested(),
					},
				},
			})
		}
		const spec = await ctx.spec.load()
		expect(spec.data.entities[0]?.provenance.isAccepted).toBeNull()
		expect(spec.data.entities[0]?.fields[0]?.provenance.isAccepted).toBeNull()
	})

	it('attributes a recorded decision the same way', async () => {
		// `record_decision` is a second entrance to the same helper, so it is the
		// obvious place for attribution to be quietly missing.
		const ctx = ctxFor(newSpecSystem(tasklyPRD), { agent: 'claude-code' })
		await executePlatformTool(ctx, 'record_decision', {
			id: 'd-store',
			question: 'pglite or postgres for the dev store?',
			options: [
				{ id: 'o-pglite', description: 'pglite', pros: [], cons: [] },
				{ id: 'o-pg', description: 'postgres', pros: [], cons: [] },
			],
			rationale: 'zero-install beats parity for a first run',
		})
		const entry = (await ctx.spec.load()).opLog.at(-1)
		expect(entry?.op.op).toBe('prd.recordDecision')
		expect(entry?.actor?.path).toBe('mcp-apply-spec-change')
		expect(entry?.actor?.agent).toBe('claude-code')
	})

	it('leaves no trace when it rejects the op', async () => {
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		const before = structuredClone(await ctx.spec.load())
		const res = await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'data.addField',
			args: { entityId: 'e-nope', field: undecided.fields[0] },
		})
		expect(res.isError).toBe(true)
		expect(await ctx.spec.load()).toEqual(before)
	})
})

// ===========================================================================
// init-projection — the batch preflight never reaches the store
// ===========================================================================

describe('write path "init-projection" (init without apply)', () => {
	const batch = [
		addUndecided,
		{
			op: 'data.addField',
			args: {
				entityId: 'e-order',
				field: {
					id: 'fld-status',
					name: 'status',
					type: 'string',
					required: false,
					provenance: suggested(),
				},
			},
		},
	]

	it('folds a whole chain in memory and stores none of it', async () => {
		// The same danger `attention-hypothetical` guards: this projection exists
		// so a caller can see the merged effect BEFORE consenting to it. If it
		// reached `spec.save`, a proposal would become a write while looking
		// exactly like the feature working.
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		const before = structuredClone(await ctx.spec.load())
		await executePlatformTool(ctx, 'init', { ops: batch })
		expect(await ctx.spec.load()).toEqual(before)
	})

	it('spends no real op id on a batch it only projected', async () => {
		// A projection that burned ids would advance the counter for batches nobody
		// committed, and op ids are how the audit trail is read.
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		for (let i = 0; i < 5; i++)
			await executePlatformTool(ctx, 'init', { ops: batch })
		await executePlatformTool(ctx, 'init', { ops: batch, apply: true })
		expect((await ctx.spec.load()).opLog.map((e) => e.id)).toEqual([
			'op-1',
			'op-2',
		])
	})

	it('leaves no projection op stamped into the trail', async () => {
		// Findable by name if one ever leaks — which is why the projection stamps a
		// path of its own rather than borrowing the write path's.
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		await executePlatformTool(ctx, 'init', { ops: batch })
		await executePlatformTool(ctx, 'init', { ops: batch, apply: true })
		const paths = (await ctx.spec.load()).opLog.map((e) => e.actor?.path)
		expect(paths).not.toContain('init-projection')
	})
})

// ===========================================================================
// mcp-init-batch — the batch write, attributed and all-or-nothing
// ===========================================================================

describe('write path "mcp-init-batch" (init with apply)', () => {
	const field = (id: string) => ({
		op: 'data.addField',
		args: {
			entityId: 'e-order',
			field: {
				id: `fld-${id}`,
				name: id,
				type: 'string',
				required: false,
				provenance: suggested(),
			},
		},
	})

	it('lands ONE op-log entry per op, each attributed to this path', async () => {
		// A batch is a way of *sending* ops. It must never collapse into a single
		// entry claiming to be several, because the trail is what makes an
		// unattended agent's writes revertible one at a time.
		const ctx = ctxFor(newSpecSystem(tasklyPRD), { agent: 'claude-code' })
		await executePlatformTool(ctx, 'init', {
			ops: [addUndecided, field('a'), field('b'), field('c')],
			apply: true,
		})
		const spec = await ctx.spec.load()
		expect(spec.opLog).toHaveLength(4)
		for (const entry of spec.opLog) {
			expect(entry.actor?.surface).toBe('mcp')
			expect(entry.actor?.path, `op ${entry.id} lost its write path`).toBe(
				'mcp-init-batch',
			)
			expect(entry.actor?.agent).toBe('claude-code')
			expect(opActorSchema.safeParse(entry.actor).success).toBe(true)
		}
	})

	it('writes NOTHING when a later op refuses, however much validated first', async () => {
		// The property the whole design rests on. Three ops validate cleanly against
		// the running projection and the fourth does not; a half-applied batch would
		// leave the spec in a state nobody designed and nobody consented to.
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		const before = structuredClone(await ctx.spec.load())
		await executePlatformTool(ctx, 'init', {
			ops: [
				addUndecided,
				field('a'),
				field('b'),
				{ op: 'data.addField', args: { entityId: 'e-nope', field: {} } },
			],
			apply: true,
		})
		expect(await ctx.spec.load()).toEqual(before)
	})

	it('cannot settle a review as a side effect of landing a batch', async () => {
		// The one thing an unattended agent must not do, restated for the path that
		// makes writing cheap. `canAccept: false` is a claim; this is the check.
		const ctx = ctxFor(newSpecSystem(tasklyPRD))
		await executePlatformTool(ctx, 'init', { ops: [addUndecided], apply: true })
		await executePlatformTool(ctx, 'init', {
			ops: [field('a'), field('b'), field('c')],
			apply: true,
		})
		const spec = await ctx.spec.load()
		expect(spec.data.entities[0]?.provenance.isAccepted).toBeNull()
		for (const f of spec.data.entities[0]?.fields ?? [])
			expect(f.provenance.isAccepted).toBeNull()
	})
})

// ===========================================================================
// The read-only tools stay read-only
// ===========================================================================

describe('the MCP read tools never write', () => {
	for (const [name, args] of [
		['query_spec', { section: 'summary' }],
		['query_spec', { section: 'ops' }],
		['list_acceptance_criteria', {}],
		['run_checks', {}],
		// Bare init is an orienting read like any other, and the tool that also
		// happens to own a write path is the one worth pinning.
		['init', {}],
	] as const) {
		it(`${name} ${JSON.stringify(args)} leaves the spec byte-identical`, async () => {
			const ctx = ctxFor(newSpecSystem(tasklyPRD))
			const before = structuredClone(await ctx.spec.load())
			await executePlatformTool(ctx, name, args)
			expect(await ctx.spec.load()).toEqual(before)
		})
	}
})
