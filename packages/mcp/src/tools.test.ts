import type { McpToolResult } from '@maxstack/core'
import {
	type EntitySpec,
	type FieldSpec,
	manual,
	minimalPRD,
	newSpecSystem,
	type OpId,
	type PageSpec,
	prdSeedProse,
	type SpecSystem,
	suggested,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	createCheckRegistry,
	defaultCheckRunner,
	specValidateCheck,
} from './checks.ts'
import type { PlatformContext } from './context.ts'
import { defaultGeneratorRunner } from './generators.ts'
import { createInMemorySpecStore } from './spec-store.ts'
import {
	executePlatformTool,
	HOST_GATED_TOOLS,
	hostGate,
	isPlatformTool,
	PLATFORM_TOOL_NAMES,
	platformTools,
} from './tools.ts'

/** Parse a (non-error) tool result's JSON payload, steering envelope and all. */
function payload(res: McpToolResult): unknown {
	expect(res.isError, res.content[0]?.text).toBeFalsy()
	return JSON.parse(res.content[0]?.text ?? 'null')
}

/**
 * The tool's own answer, with the uniform `warnings`/`next` pair peeled off —
 * and out of `result` for the array/scalar payloads the envelope has to wrap.
 * Tests about *what a tool answers* use this; the tests about the envelope
 * itself use {@link payload}.
 */
function data(res: McpToolResult): unknown {
	const parsed = payload(res) as Record<string, unknown>
	if (parsed === null || typeof parsed !== 'object') return parsed
	const { warnings: _w, next: _n, ...rest } = parsed
	return 'result' in rest && Object.keys(rest).length === 1 ? rest.result : rest
}

/** The steering pair a result carries. */
function steering(res: McpToolResult): { warnings: string[]; next: string[] } {
	const parsed = payload(res) as { warnings: string[]; next: string[] }
	return { warnings: parsed.warnings, next: parsed.next }
}

function ctxFor(spec: SpecSystem): PlatformContext {
	let n = 0
	return {
		spec: createInMemorySpecStore(spec),
		generators: defaultGeneratorRunner(),
		checks: defaultCheckRunner(),
		origin: 'ai',
		now: () => '2026-07-09',
		nextOpId: () => `op-${++n}` as OpId,
	}
}

const entity: EntitySpec = {
	id: 'e-order',
	name: 'Order',
	fields: [
		{
			id: 'fld-total',
			name: 'total',
			type: 'number',
			required: true,
			provenance: manual(),
		},
	],
	provenance: manual(),
}

const page: PageSpec = {
	id: 'pg-orders',
	name: 'Orders',
	route: '/orders',
	entityId: 'e-order',
	blocks: [],
	e2eTests: ['lists all orders', 'creates an order'],
	provenance: manual(),
}

/**
 * The tools whose presence depends on the host wiring a provider — always
 * routable (a call without one gets a named error rather than "unknown tool"),
 * but absent from `tools/list` where they could not be answered.
 *
 * Read off `HOST_GATED_TOOLS` rather than restated. This was a second hand-kept
 * copy of the list, which is exactly how the reference generator came to omit all
 * three without any test noticing — the gate was knowledge you had to
 * already have, in three separate places.
 */
const HOST_GATED: readonly string[] = Object.keys(HOST_GATED_TOOLS)

let ctx: PlatformContext

beforeEach(() => {
	ctx = ctxFor(newSpecSystem(tasklyPRD))
})

describe('tool listing', () => {
	it('exposes the platform tools, self-describing', () => {
		const tools = platformTools(ctx)
		// The host-gated tools are listed only when the host wired the provider that
		// answers them: a tool that answers "this host
		// cannot tell you" is worse than a tool that is absent, because an agent
		// will try it first.
		expect(tools.map((t) => t.name).sort()).toEqual(
			[...PLATFORM_TOOL_NAMES]
				.filter((name) => !HOST_GATED.includes(name))
				.sort(),
		)
		for (const t of tools) expect(t.description.length).toBeGreaterThan(20)
	})

	it('lists browse_catalog once a host supplies a catalog', () => {
		const withCatalog = platformTools({
			...ctx,
			catalog: { list: () => [], preview: () => ({}) },
		})
		expect(withCatalog.map((t) => t.name)).toContain('browse_catalog')
	})

	it('lists ownership_drift once a host supplies a filesystem', () => {
		// Same rule as browse_catalog: drift is a *disk* fact, and a tool that only
		// answers "this host cannot tell you" is worse than an absent one.
		const withDrift = platformTools({
			...ctx,
			ownership: { drift: () => ({ owned: [] }) },
		})
		expect(withDrift.map((t) => t.name)).toContain('ownership_drift')
	})

	it('lists review_cost once a host can answer it', () => {
		// Same rule again: review cost is derived from an event log on disk and
		// gated on the project's opt-in, neither of which this layer can see.
		const withCost = platformTools({
			...ctx,
			reviewCost: { report: () => null },
		})
		expect(withCost.map((t) => t.name)).toContain('review_cost')
	})

	it('lists every declared tool once every provider is wired', () => {
		const withAll = platformTools({
			...ctx,
			catalog: { list: () => [], preview: () => ({}) },
			ownership: { drift: () => ({ owned: [] }) },
			reviewCost: { report: () => null },
		})
		expect(withAll.map((t) => t.name).sort()).toEqual(
			[...PLATFORM_TOOL_NAMES].sort(),
		)
	})

	it('says what each gated tool needs, in a sentence a doc can print', () => {
		// #242: the gate used to be three inline spreads, so "is this host-gated,
		// and on what?" was unrecoverable by anything but a reader. The generated
		// reference could not recover it at all and silently dropped a third of the
		// vocabulary while the validate gate checked that omission as correct.
		for (const name of HOST_GATED) {
			const gate = hostGate(name)
			expect(
				gate,
				`${name} is gated but hostGate() does not say so`,
			).toBeTruthy()
			// The provider it names has to be a real field, or the filter in
			// `platformTools` silently never fires and the tool is always present.
			const wired = platformTools({
				...ctx,
				[gate?.provider as string]: {},
			} as PlatformContext)
			expect(wired.map((t) => t.name)).toContain(name)
			expect(gate?.requires.length).toBeGreaterThan(20)
		}
	})

	it('reports no gate for a tool every host gets', () => {
		expect(hostGate('query_spec')).toBeNull()
		expect(hostGate('apply_spec_change')).toBeNull()
	})

	it('surfaces generator + check names as schema enums', () => {
		const tools = platformTools(ctx)
		const gen = tools.find((t) => t.name === 'run_generator')
		if (!gen) throw new Error('run_generator tool missing')
		expect(
			(gen.inputSchema.properties.generator as { enum: string[] }).enum,
		).toContain('docs')
		const checks = tools.find((t) => t.name === 'run_checks')
		if (!checks) throw new Error('run_checks tool missing')
		const items = (
			checks.inputSchema.properties.checks as { items: { enum: string[] } }
		).items
		expect(items.enum).toContain('spec-validate')
	})

	it('classifies platform vs sprout tool names', () => {
		expect(isPlatformTool('query_spec')).toBe(true)
		expect(isPlatformTool('list_author')).toBe(false)
	})
})

describe('query_spec', () => {
	it('summarizes by default', async () => {
		const data = payload(await executePlatformTool(ctx, 'query_spec', {})) as {
			title: string
			requirements: number
		}
		expect(data.title).toContain('Taskly')
		expect(data.requirements).toBeGreaterThan(0)
	})

	it('lists the spec-op vocabulary (self-description for agents)', async () => {
		const res = data(
			await executePlatformTool(ctx, 'query_spec', { section: 'ops' }),
		) as { count: number; ops: { name: string }[]; argSchemas: string }
		expect(res.ops.map((o) => o.name)).toContain('data.addField')
		expect(res.ops.map((o) => o.name)).toContain('theme.set')
		expect(res.ops.map((o) => o.name)).toContain('page.setBlockVariant')
		expect(res.count).toBe(res.ops.length)
		// The schemas are not here and the payload says where they are.
		expect(res.ops[0]).not.toHaveProperty('args')
		expect(res.argSchemas).toMatch(/ops:\["page.addPage","data.addField"\]/)
	})

	// issue #140: each op carries its argument JSON Schema, so an agent reads the
	// arg shape off the vocabulary instead of guessing it. Issue #313: it reads
	// the ones it names, because all 60 at once is a payload hosts refuse.
	it('returns the arg schemas for the ops it is asked for', async () => {
		const res = data(
			await executePlatformTool(ctx, 'query_spec', {
				section: 'ops',
				ops: ['data.addField', 'page.addPage'],
			}),
		) as {
			ops: {
				name: string
				args: {
					type: string
					properties: Record<string, unknown>
					required?: string[]
				}
			}[]
		}
		expect(res.ops.map((o) => o.name)).toEqual([
			'data.addField',
			'page.addPage',
		])
		const addField = res.ops[0]
		expect(addField?.args.type).toBe('object')
		expect(addField?.args.required).toEqual(['entityId', 'field'])
		expect(addField?.args.properties).toHaveProperty('field')
	})

	it('names the ops it did not recognize rather than silently dropping them', async () => {
		const res = data(
			await executePlatformTool(ctx, 'query_spec', {
				section: 'ops',
				ops: ['data.addField', 'data.nope'],
			}),
		) as { ops: { name: string }[]; unknown: string[]; note: string }
		expect(res.ops.map((o) => o.name)).toEqual(['data.addField'])
		expect(res.unknown).toEqual(['data.nope'])
		expect(res.note).toContain('data.nope')
	})

	// The defect: the only documented route to an arg schema returned
	// 107,533 characters and the reference host REFUSED it, so the four strings
	// promising "you never have to guess an arg shape" were all false. Neither
	// form of this call may return a payload a host will not deliver.
	it('keeps both forms of the ops section inside what a host will return', async () => {
		const summary = await executePlatformTool(ctx, 'query_spec', {
			section: 'ops',
		})
		expect(summary.content[0]?.text?.length ?? 0).toBeLessThan(40_000)

		const filtered = await executePlatformTool(ctx, 'query_spec', {
			section: 'ops',
			ops: ['data.addField', 'page.addPage', 'page.addBoard'],
		})
		expect(filtered.content[0]?.text?.length ?? 0).toBeLessThan(40_000)
	})

	it('returns the resolved theme (zinc default before any theme.set)', async () => {
		const theme = data(
			await executePlatformTool(ctx, 'query_spec', { section: 'theme' }),
		) as { preset: string }
		expect(theme).toEqual({ preset: 'zinc' })

		await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'theme.set',
			args: { theme: { preset: 'ocean', accent: '#0ea5e9' } },
		})
		const after = data(
			await executePlatformTool(ctx, 'query_spec', { section: 'theme' }),
		) as { preset: string; accent: string }
		expect(after).toEqual({ preset: 'ocean', accent: '#0ea5e9' })
		const summary = payload(
			await executePlatformTool(ctx, 'query_spec', {}),
		) as { theme: string }
		expect(summary.theme).toBe('ocean')
	})
})

describe('propose vs apply (suggest → accept)', () => {
	const addEntity = { op: 'data.addEntity', args: { entity } }

	it('propose validates + diffs without mutating', async () => {
		const res = payload(
			await executePlatformTool(ctx, 'propose_spec_change', addEntity),
		) as { valid: boolean; diff: { targetId: string } }
		expect(res.valid).toBe(true)
		expect(res.diff.targetId).toBe('e-order')
		// nothing was written
		const after = payload(await executePlatformTool(ctx, 'query_spec', {})) as {
			entities: number
		}
		expect(after.entities).toBe(0)
	})

	it('propose reports validation errors instead of a diff', async () => {
		const res = payload(
			await executePlatformTool(ctx, 'propose_spec_change', {
				op: 'data.addField',
				args: { entityId: 'e-missing', field: entity.fields[0] },
			}),
		) as { valid: boolean; errors: string[]; diff: null }
		expect(res.valid).toBe(false)
		expect(res.errors.join()).toContain('e-missing')
		expect(res.diff).toBeNull()
	})

	it('apply mutates, logs to the op-log, and persists', async () => {
		const applied = payload(
			await executePlatformTool(ctx, 'apply_spec_change', addEntity),
		) as { applied: { id: string; origin: string }; diff: unknown }
		expect(applied.applied.id).toBe('op-1')
		expect(applied.applied.origin).toBe('ai')
		const after = payload(await executePlatformTool(ctx, 'query_spec', {})) as {
			entities: number
			opsApplied: number
		}
		expect(after.entities).toBe(1)
		expect(after.opsApplied).toBe(1)
	})

	it('apply rejects an op that would break integrity', async () => {
		const res = await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'data.addField',
			args: { entityId: 'e-missing', field: entity.fields[0] },
		})
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toContain('e-missing')
	})

	// Issue #71: a malformed provenance passed propose but blew up apply's save
	// as an opaque HTTP 500 — the two tools must share one verdict, and apply
	// must fail structured.
	const malformedField = {
		op: 'data.addField',
		args: {
			entityId: 'e-order',
			field: {
				id: 'fld-cover',
				name: 'coverUrl',
				type: 'string',
				required: false,
				provenance: { origin: 'agent' },
			},
		},
	}

	it('propose rejects a malformed provenance (same validator as apply)', async () => {
		await executePlatformTool(ctx, 'apply_spec_change', addEntity)
		const res = payload(
			await executePlatformTool(ctx, 'propose_spec_change', malformedField),
		) as { valid: boolean; errors: string[]; diff: null }
		expect(res.valid).toBe(false)
		expect(res.errors.join()).toContain('malformed provenance')
		expect(res.diff).toBeNull()
	})

	it('apply rejects the same payload as structured {applied:false, errors}, writing nothing', async () => {
		await executePlatformTool(ctx, 'apply_spec_change', addEntity)
		const res = await executePlatformTool(
			ctx,
			'apply_spec_change',
			malformedField,
		)
		expect(res.isError).toBe(true)
		const body = JSON.parse(res.content[0]?.text ?? 'null') as {
			applied: boolean
			errors: string[]
		}
		expect(body.applied).toBe(false)
		expect(body.errors.join()).toContain('malformed provenance')
		const after = payload(await executePlatformTool(ctx, 'query_spec', {})) as {
			opsApplied: number
		}
		expect(after.opsApplied).toBe(1) // only the addEntity landed
	})

	it('a save-time throw resolves to a tool error, never a rejection (the 500 path)', async () => {
		ctx = {
			...ctx,
			spec: {
				load: ctx.spec.load,
				save: async () => {
					throw new Error('disk on fire')
				},
			},
		}
		const res = await executePlatformTool(ctx, 'apply_spec_change', addEntity)
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toContain('disk on fire')
	})
})

describe('record_decision', () => {
	it('appends a pending decision when no choice is given', async () => {
		await executePlatformTool(ctx, 'record_decision', {
			id: 'd-store',
			question: 'Which store?',
			options: [
				{ id: 'o-pg', description: 'Postgres', pros: [], cons: [] },
				{ id: 'o-sqlite', description: 'SQLite', pros: [], cons: [] },
			],
			rationale: 'still weighing',
		})
		const ledger = data(
			await executePlatformTool(ctx, 'query_spec', { section: 'ledger' }),
		) as { id: string; status: string; chosenOptionId: string | null }[]
		const entry = ledger.find((e) => e.id === 'd-store')
		expect(entry?.status).toBe('pending')
		expect(entry?.chosenOptionId).toBeNull()
	})

	it('records a resolved decision when a choice is given', async () => {
		await executePlatformTool(ctx, 'record_decision', {
			id: 'd-store',
			question: 'Which store?',
			options: [{ id: 'o-pg', description: 'Postgres', pros: [], cons: [] }],
			chosenOptionId: 'o-pg',
			rationale: 'managed + familiar',
		})
		const ledger = data(
			await executePlatformTool(ctx, 'query_spec', { section: 'ledger' }),
		) as { id: string; status: string; decidedAt: string | null }[]
		const entry = ledger.find((e) => e.id === 'd-store')
		expect(entry?.status).toBe('resolved')
		expect(entry?.decidedAt).toBe('2026-07-09')
	})
})

describe('run_generator', () => {
	it('generates project-tailored docs from the spec', async () => {
		const res = payload(
			await executePlatformTool(ctx, 'run_generator', { generator: 'docs' }),
		) as { artifacts: { path: string; content: string }[] }
		expect(res.artifacts[0]?.path).toBe('docs/OVERVIEW.md')
		expect(res.artifacts[0]?.content).toContain('Taskly')
	})

	it('scaffolds one e2e test per page.e2eTests string', async () => {
		await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'data.addEntity',
			args: { entity },
		})
		await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'page.addPage',
			args: { page },
		})
		const res = payload(
			await executePlatformTool(ctx, 'run_generator', {
				generator: 'e2e-tests',
			}),
		) as { artifacts: { path: string; content: string }[] }
		expect(res.artifacts[0]?.path).toBe('e2e/orders.spec.ts')
		expect(res.artifacts[0]?.content).toContain('lists all orders')
		expect(res.artifacts[0]?.content).toContain('creates an order')
	})

	it('drives the real ownership code generator (route + slot + manifest)', async () => {
		await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'data.addEntity',
			args: { entity },
		})
		await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'page.addPage',
			args: { page },
		})
		const res = payload(
			await executePlatformTool(ctx, 'run_generator', { generator: 'page' }),
		) as { artifacts: { path: string; content: string }[]; notes: string[] }
		const paths = res.artifacts.map((a) => a.path)
		expect(paths).toContain('routes/order.tsx')
		expect(paths).toContain('routes.ts')
		const route = res.artifacts.find((a) => a.path === 'routes/order.tsx')
		expect(route?.content).toContain("resource: 'order'")
		const manifest = res.artifacts.find((a) => a.path === 'routes.ts')
		expect(manifest?.content).toContain('/orders')
		expect(res.notes.some((n) => n.startsWith('created:'))).toBe(true)
	})

	it('errors on an unknown generator, naming the available ones', async () => {
		const res = await executePlatformTool(ctx, 'run_generator', {
			generator: 'nope',
		})
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toContain('docs')
	})
})

describe('run_checks', () => {
	/** The result shape, minus the steering envelope. */
	interface ChecksResult {
		ok: boolean
		status: string
		ran: string[]
		results: { name: string; ok: boolean }[]
		unavailable: { name: string; reason: string; remedy?: string }[]
		headline: string
	}

	it('passes spec-validate on a valid spec', async () => {
		const res = payload(
			await executePlatformTool(ctx, 'run_checks', {}),
		) as ChecksResult
		expect(res.ok).toBe(true)
		expect(res.status).toBe('pass')
		expect(res.unavailable).toEqual([])
		expect(res.results.find((r) => r.name === 'spec-validate')?.ok).toBe(true)
	})

	it('REFUSES a green while any check went unexamined', async () => {
		// The bug this exists for: an agent takes `ok: true` as terminal and stops.
		// A check that never ran reads exactly like one that passed, which is how a
		// whole session goes by without a typecheck over the code it just wrote.
		const host: PlatformContext = {
			...ctx,
			checks: createCheckRegistry(
				[specValidateCheck],
				[
					{
						name: 'typecheck',
						reason: 'package.json declares no "typecheck" script',
						remedy: 'Add "typecheck": "tsc --noEmit".',
					},
				],
			),
		}
		const res = payload(
			await executePlatformTool(host, 'run_checks', {}),
		) as ChecksResult
		expect(res.ok).toBe(false)
		expect(res.status).toBe('incomplete')
		expect(res.results.every((r) => r.ok)).toBe(true)
		expect(res.unavailable.map((u) => u.name)).toEqual(['typecheck'])
		// The headline has to say it out loud — an agent reading past `ok` must
		// not be able to mistake this for a pass.
		expect(res.headline).toMatch(/never ran/)
		expect(res.headline).toMatch(/NOT a green/)
	})

	it('still greens when the only unrunnable checks had nothing to examine', async () => {
		// A freshly scaffolded project owns no code. Reporting "3 checks never ran
		// — that code is unexamined" over an empty set makes the scaffold fail its
		// own gate on creation, with no action available that would have avoided
		// it — and a gate that is red no matter what is a gate agents learn to
		// skip. They are still NAMED, so the moment there is owned code to look at
		// the same three go blocking again.
		const host: PlatformContext = {
			...ctx,
			checks: createCheckRegistry(
				[specValidateCheck],
				[
					{
						name: 'typecheck',
						blocking: false,
						reason: 'this project owns no code yet',
						remedy: 'Run `npm install` (or `pnpm install`) and check again.',
					},
				],
			),
		}
		const res = payload(
			await executePlatformTool(host, 'run_checks', {}),
		) as ChecksResult
		expect(res.ok).toBe(true)
		expect(res.status).toBe('pass')
		// Named, never dropped — the payload still carries it.
		expect(res.unavailable.map((u) => u.name)).toEqual(['typecheck'])
		expect(res.headline).toMatch(/did not apply here \(typecheck\)/)
		expect(res.headline).not.toMatch(/NOT a green/)
	})

	it('keeps the red when a blocking check joins a non-blocking one', async () => {
		const host: PlatformContext = {
			...ctx,
			checks: createCheckRegistry(
				[specValidateCheck],
				[
					{ name: 'typecheck', blocking: false, reason: 'nothing to examine' },
					{ name: 'lint', reason: 'no "lint" script' },
				],
			),
		}
		const res = payload(
			await executePlatformTool(host, 'run_checks', {}),
		) as ChecksResult
		expect(res.ok).toBe(false)
		expect(res.status).toBe('incomplete')
		// The headline names the blocking one only — an agent must not be sent to
		// fix a check that was never the problem.
		expect(res.headline).toMatch(/1 never ran \(lint\)/)
	})

	it('carries the reason and the remedy, not just a name', async () => {
		const host: PlatformContext = {
			...ctx,
			checks: createCheckRegistry(
				[specValidateCheck],
				[
					{
						name: 'test',
						reason: 'package.json declares no "test" script',
						remedy: 'Add a "test" script.',
					},
				],
			),
		}
		const res = payload(
			await executePlatformTool(host, 'run_checks', {}),
		) as ChecksResult
		expect(res.unavailable[0]?.reason).toMatch(/no "test" script/)
		expect(res.unavailable[0]?.remedy).toMatch(/Add a "test" script/)
	})

	it('reports an unknown requested check as unavailable, not as a crash', async () => {
		const res = payload(
			await executePlatformTool(ctx, 'run_checks', { checks: ['typecheck'] }),
		) as ChecksResult
		expect(res.ok).toBe(false)
		expect(res.status).toBe('incomplete')
		expect(res.unavailable[0]?.name).toBe('typecheck')
		expect(res.unavailable[0]?.remedy).toMatch(/Available here: spec-validate/)
	})

	it('still reports a real failure as a failure, not as incomplete', async () => {
		const failing = createCheckRegistry([
			{
				name: 'always-red',
				summary: 'fails',
				run: () => ({ name: 'always-red', ok: false, output: 'boom' }),
			},
		])
		const res = payload(
			await executePlatformTool({ ...ctx, checks: failing }, 'run_checks', {}),
		) as ChecksResult
		expect(res.status).toBe('fail')
		expect(res.headline).toMatch(/always-red/)
	})
})

describe('explain_feature + list_acceptance_criteria', () => {
	it('explains a requirement with its acceptance criteria', async () => {
		const data = payload(
			await executePlatformTool(ctx, 'explain_feature', {
				requirementId: 'r-tasks',
			}),
		) as { kind: string; acceptanceCriteria: string[] }
		expect(data.kind).toBe('requirement')
		expect(data.acceptanceCriteria.length).toBeGreaterThan(0)
	})

	it('explains an entity and links its pages', async () => {
		await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'data.addEntity',
			args: { entity },
		})
		await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'page.addPage',
			args: { page },
		})
		const data = payload(
			await executePlatformTool(ctx, 'explain_feature', {
				entityId: 'e-order',
			}),
		) as { kind: string; pages: { id: string }[] }
		expect(data.kind).toBe('entity')
		expect(data.pages[0]?.id).toBe('pg-orders')
	})

	it('lists acceptance criteria for one requirement', async () => {
		const data = payload(
			await executePlatformTool(ctx, 'list_acceptance_criteria', {
				requirementId: 'r-tasks',
			}),
		) as { id: string; acceptanceCriteria: string[] }
		expect(data.id).toBe('r-tasks')
	})

	it('lists acceptance criteria for all requirements when unscoped', async () => {
		const all = data(
			await executePlatformTool(ctx, 'list_acceptance_criteria', {}),
		) as unknown[]
		expect(all.length).toBe(tasklyPRD.requirements.length)
	})

	it('errors clearly when no target id is given', async () => {
		const res = await executePlatformTool(ctx, 'explain_feature', {})
		expect(res.isError).toBe(true)
	})
})

// ===========================================================================
// browse_catalog — discovery + preview over MCP
// ===========================================================================

describe('browse_catalog', () => {
	const withCatalog = (over: Partial<PlatformContext['catalog']> = {}) => ({
		...ctx,
		catalog: {
			list: () => [{ slug: 'auth', title: 'Authentication' }],
			preview: (slugs: string[]) => ({ order: slugs, ops: [] }),
			...over,
		},
	})

	it('lists the catalog the host supplied, verbatim', async () => {
		const result = await executePlatformTool(
			withCatalog() as PlatformContext,
			'browse_catalog',
			{},
		)
		expect(data(result)).toEqual({
			modules: [{ slug: 'auth', title: 'Authentication' }],
		})
	})

	it('previews an install when asked, without applying it', async () => {
		const result = await executePlatformTool(
			withCatalog() as PlatformContext,
			'browse_catalog',
			{ preview: ['billing'] },
		)
		expect(data(result)).toEqual({
			order: ['billing'],
			ops: [],
		})
	})

	it('says so plainly when the host has no catalog', async () => {
		// Routable but unanswerable: an agent that calls it anyway gets a named
		// reason rather than "unknown tool".
		const result = await executePlatformTool(ctx, 'browse_catalog', {})
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toMatch(/no catalog wired/)
	})
})

// ===========================================================================
// ownership_drift — the eject tax, itemized, over MCP
// ===========================================================================

describe('ownership_drift', () => {
	it('returns the host’s drift report verbatim', async () => {
		// Verbatim matters: the CLI, this tool and the workbench pane render the
		// same `ownershipDrift()` fold, so an agent asking "what am I missing by
		// owning this file?" and a human running `maxstack drift` must not be told
		// different things.
		const report = {
			owned: [
				{
					id: 'task',
					file: 'routes/task.tsx',
					ownership: 'ejected',
					status: 'drifted',
					ahead: 6,
					behind: 2,
					patch: '@@ -1 +1 @@',
					explanation: 'Nothing will be applied',
				},
			],
			ownedCount: 1,
			driftedCount: 1,
		}
		const result = await executePlatformTool(
			{ ...ctx, ownership: { drift: () => report } } as PlatformContext,
			'ownership_drift',
			{},
		)
		expect(data(result)).toEqual(report)
	})

	it('says so plainly when the host has no filesystem', async () => {
		const result = await executePlatformTool(ctx, 'ownership_drift', {})
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toMatch(/no filesystem wired/)
	})
})

// ===========================================================================
// review_queue
// ===========================================================================

describe('review_queue', () => {
	/** A suggested (undecided) field — the thing that lands in the queue. */
	const suggestedField = (id: string, name: string): FieldSpec => ({
		id: id as FieldSpec['id'],
		name,
		type: 'string',
		required: false,
		provenance: suggested(),
	})

	/**
	 * A host with three undecided fields on one entity, one of them access-shaped.
	 *
	 * `ownershipKnown` by default, because that is what a real host with a readable
	 * manifest reports and it is the only state in which batching happens at all —
	 * the unknown case is its own test below.
	 */
	function withQueue(knowsOwnership = true): PlatformContext {
		const spec = newSpecSystem(tasklyPRD)
		spec.data.entities.push({
			...entity,
			fields: [
				suggestedField('fld-total', 'total'),
				suggestedField('fld-notes', 'notes'),
				// Reads as access control, so the model refuses it a place in a batch.
				suggestedField('fld-role', 'viewerRole'),
			],
			provenance: suggested(),
		})
		const host = ctxFor(spec)
		if (!knowsOwnership) return host
		return {
			...host,
			ownership: {
				drift: () => ({ owned: [] }),
				riskContext: () => ({
					ownedEntityIds: [],
					ownedPageIds: [],
					ownershipKnown: true,
				}),
			},
		}
	}

	it('is listed in every host, because the queue is a spec fact', () => {
		// Unlike review_cost, nothing here needs a disk: the proposals and their risk
		// are derivable from the spec alone, so a host that gates this would be
		// hiding a question it can answer.
		expect(platformTools(ctx).map((t) => t.name)).toContain('review_queue')
		expect(HOST_GATED).not.toContain('review_queue')
	})

	it('reports the groups, the risk reasons, and what cannot be batched', async () => {
		const queue = (await executePlatformTool(
			withQueue(),
			'review_queue',
			{},
		).then(payload)) as {
			pending: number
			groups: { batchableCount: number; targets: unknown[] }[]
			needsAttention: {
				target: { id: string }
				risk: { findings: unknown[] }
			}[]
			settleWith: string
		}
		expect(queue.pending).toBeGreaterThan(0)
		// N of M, not a binary: the risky field must not turn its two neighbours back
		// into individual decisions.
		const fields = queue.groups.find((g) => g.targets.length === 3)
		expect(fields?.batchableCount).toBe(2)

		const flagged = queue.needsAttention.find((p) => p.target.id === 'fld-role')
		expect(flagged).toBeTruthy()
		// The reason travels with the refusal. A refusal an agent cannot explain to
		// the maintainer is one they will route around.
		expect(flagged?.risk.findings.length).toBeGreaterThan(0)
	})

	it('names the surfaces that DO decide, in the payload', async () => {
		// Stated in the data, not only in the tool description: an agent that reads
		// the queue reaches for the next call, and the next call is not this tool.
		const queue = (await executePlatformTool(ctx, 'review_queue', {}).then(
			payload,
		)) as { settleWith: string }
		expect(queue.settleWith).toMatch(/maxstack review|workbench/)
	})

	it('writes nothing — no op is logged and no provenance moves', async () => {
		// The load-bearing invariant. An agent settling its own proposals is a rubber
		// stamp with a protocol in front of it, so this is asserted rather than left
		// to the absence of an `applyOp` call being noticed in review.
		const host = withQueue()
		const before = JSON.stringify(await host.spec.load())
		await executePlatformTool(host, 'review_queue', {})
		expect(JSON.stringify(await host.spec.load())).toBe(before)
	})

	it('batches nothing when the host cannot say what is owned', async () => {
		// This test is here because it caught the bug. The intuitive reading is that
		// an empty RiskContext is the conservative one; it is the opposite. Ownership
		// facts only ever RAISE risk — owning a surface is what makes a change to it
		// unbatchable — so a host with no manifest that passed `{}` would report the
		// most permissive queue possible, and a *failed* manifest read would silently
		// unlock a batch. Unknown therefore means "assume owned".
		const bare = (await executePlatformTool(
			withQueue(false),
			'review_queue',
			{},
		).then(payload)) as {
			groups: { batchableCount: number }[]
			needsAttention: { risk: { findings: { reason: string }[] } }[]
		}
		const total = (g: { batchableCount: number }[]) =>
			g.reduce((n, x) => n + x.batchableCount, 0)
		expect(total(bare.groups)).toBe(0)
		// And it says so, rather than looking like a project with nothing to batch.
		expect(
			bare.needsAttention.flatMap((p) => p.risk.findings.map((f) => f.reason)),
		).toContainEqual(expect.stringContaining('which surfaces you own'))

		// A host that read the manifest and found nothing owned says so explicitly,
		// and gets its batches back.
		const informed = (await executePlatformTool(
			{
				...withQueue(),
				ownership: {
					drift: () => ({ owned: [] }),
					riskContext: () => ({
						ownedEntityIds: [],
						ownedPageIds: [],
						ownershipKnown: true,
					}),
				},
			},
			'review_queue',
			{},
		).then(payload)) as { groups: { batchableCount: number }[] }
		expect(total(informed.groups)).toBeGreaterThan(0)
	})
})

// ===========================================================================
// workbench — the ordered what-needs-you surface
// ===========================================================================

describe('workbench', () => {
	const suggestedField = (id: string, name: string): FieldSpec => ({
		id: id as FieldSpec['id'],
		name,
		type: 'string',
		required: false,
		provenance: suggested(),
	})

	function host(): PlatformContext {
		const spec = newSpecSystem(tasklyPRD)
		spec.data.entities.push({
			...entity,
			fields: [
				suggestedField('fld-notes', 'notes'),
				suggestedField('fld-role', 'viewerRole'),
			],
		})
		return {
			...ctxFor(spec),
			attention: {
				inputs: () => ({
					risk: { ownedEntityIds: [], ownedPageIds: [], ownershipKnown: true },
					drift: [{ id: 'order', file: 'app/routes/order.tsx', drifted: true }],
					upgrades: [],
				}),
			},
		}
	}

	it('is listed in every host — the ordering is a spec fact', () => {
		expect(platformTools(ctx).map((t) => t.name)).toContain('workbench')
		expect(HOST_GATED).not.toContain('workbench')
	})

	it('answers "what should I look at" with named rows, worst first', async () => {
		const report = (await executePlatformTool(host(), 'workbench', {}).then(
			payload,
		)) as {
			items: { kind: string; title: string; because: string }[]
			headline: string
			unavailable: string[]
		}
		expect(report.items.length).toBeGreaterThan(0)
		// The access-control proposal outranks the drifted file, which outranks the
		// routine batch. Ordering is the whole product of this tool.
		const kinds = report.items.map((i) => i.kind)
		expect(kinds.indexOf('unbatchable')).toBeLessThan(kinds.indexOf('drift'))
		expect(kinds.indexOf('drift')).toBeLessThan(kinds.indexOf('routine'))
		// The headline is *about* the list: the worst category and how much is
		// behind it. It used to be `items[0].title` verbatim, so every renderer of
		// this tool printed the same sentence twice in a row.
		expect(report.headline).not.toBe(report.items[0]?.title)
		expect(report.headline).toMatch(/individual decision/)
		// Every category was answerable, so nothing is claimed unevaluated.
		expect(report.unavailable).toEqual([])
	})

	it('names the categories a bare host could not evaluate', async () => {
		// The failure mode this guards: a thin host's clean report reading exactly
		// like a complete all-clear.
		const report = (await executePlatformTool(ctx, 'workbench', {}).then(
			payload,
		)) as { unavailable: string[]; headline: string }
		expect(report.unavailable.length).toBeGreaterThan(0)
		expect(report.headline).not.toMatch(/Nothing needs you/)
	})

	it('reports the exposure section, live and latent together', async () => {
		const report = (await executePlatformTool(host(), 'workbench', {
			section: 'exposure',
		}).then(payload)) as {
			public: unknown[]
			latent: unknown[]
			note: string
		}
		// This fixture declares no portal, so the honest answer is "nothing", said
		// plainly rather than as two empty arrays a reader has to interpret.
		expect(report.public).toEqual([])
		expect(report.latent).toEqual([])
		expect(report.note).toMatch(/Nothing in this project is publicly reachable/)
	})

	it('explains one proposal as a change to the built application', async () => {
		const report = (await executePlatformTool(host(), 'workbench', {
			section: 'blast-radius',
			target: { kind: 'field', id: 'fld-notes', parentId: 'e-order' },
		}).then(payload)) as {
			added: { id: string }[]
			changed: { surface: { id: string } }[]
			summary: string
		}
		// A spec diff would say "one field added". This says which table, which REST
		// payload, which form — the things the reviewer is actually consenting to.
		expect(report.changed.map((c) => c.surface.id)).toContain('table:order')
		expect(report.summary).not.toBe('')
	})

	it('refuses a target that is not a pending proposal, by name', async () => {
		const res = await executePlatformTool(host(), 'workbench', {
			section: 'blast-radius',
			target: { kind: 'field', id: 'fld-nope', parentId: 'e-order' },
		})
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toMatch(/not a pending proposal/)
	})

	it('writes nothing — the projection is never saved', async () => {
		// The hypothetical accept is the one place this surface applies ops. If it
		// ever reached the store, the workbench would be settling reviews by being
		// looked at, which is the opposite of the whole design.
		const h = host()
		const before = JSON.stringify(await h.spec.load())
		await executePlatformTool(h, 'workbench', {})
		await executePlatformTool(h, 'workbench', { section: 'blast-radius' })
		expect(JSON.stringify(await h.spec.load())).toBe(before)
	})
})

// ===========================================================================
// Steering — the uniform warnings/next pair
// ===========================================================================

describe('steering (warnings + next on every result)', () => {
	/** A spec with one page, one entity, and a requirement carrying criteria. */
	function projectSpec(over: Partial<PageSpec> = {}): SpecSystem {
		const spec = newSpecSystem(tasklyPRD)
		spec.data.entities.push(entity)
		spec.pages.pages.push({ ...page, ...over })
		return spec
	}

	it('is present on every successful result, read tools included', async () => {
		for (const tool of ['query_spec', 'review_queue', 'workbench']) {
			const res = await executePlatformTool(ctxFor(projectSpec()), tool, {})
			const { warnings, next } = steering(res)
			expect(Array.isArray(warnings), tool).toBe(true)
			expect(Array.isArray(next), tool).toBe(true)
		}
	})

	it('wraps array payloads under `result` so the envelope is one shape', async () => {
		const res = await executePlatformTool(ctx, 'list_acceptance_criteria', {})
		const parsed = payload(res) as { result: unknown[]; warnings: string[] }
		expect(Array.isArray(parsed.result)).toBe(true)
		expect(parsed.warnings).toEqual([])
	})

	it('warns that a list-tuning op is shadowed by a replace-mode slot', async () => {
		// The op applies, the diff is real, and nothing a user can see changes.
		// A spec-shaped diff cannot say that; this is the field that can.
		const spec = projectSpec({
			blocks: [
				{ id: 'blk-list', type: 'table', provenance: manual() },
				{
					id: 'blk-custom',
					type: 'slot:board',
					mode: 'replace',
					provenance: manual(),
				},
			],
		})
		const res = await executePlatformTool(ctxFor(spec), 'apply_spec_change', {
			op: 'page.setBlockVariant',
			args: { pageId: 'pg-orders', blockId: 'blk-list', variant: 'cards' },
		})
		const { warnings } = steering(res)
		expect(warnings.join(' ')).toMatch(/replace-mode slot "board"/)
		expect(warnings.join(' ')).toMatch(/changes nothing a user can see/)
	})

	it('does not cry shadow when the page has no replacing slot', async () => {
		const spec = projectSpec({
			blocks: [{ id: 'blk-list', type: 'table', provenance: manual() }],
		})
		const res = await executePlatformTool(ctxFor(spec), 'apply_spec_change', {
			op: 'page.setBlockVariant',
			args: { pageId: 'pg-orders', blockId: 'blk-list', variant: 'cards' },
		})
		expect(steering(res).warnings.join(' ')).not.toMatch(/replace-mode/)
	})

	// Issue #345 — a number field named `rating` silently became a 5-star widget.
	// The inference is fine; its invisibility was not. `warnings` is the field
	// whose whole contract is "what you just did is not what you think you did".
	it('warns that a number field name picked a widget nothing declared', async () => {
		const res = await executePlatformTool(
			ctxFor(projectSpec()),
			'apply_spec_change',
			{
				op: 'data.addField',
				args: {
					entityId: 'e-order',
					field: {
						id: 'fld-rating',
						name: 'rating',
						type: 'number',
						required: false,
					},
				},
			},
		)
		const joined = steering(res).warnings.join(' ')
		expect(joined).toMatch(/renders and edits as a 5-star rating/)
		expect(joined).toMatch(/data\.setFieldDisplay/)
		expect(joined).toMatch(/format:"number"/)
	})

	it('goes quiet once the author has stated a presentation', async () => {
		for (const [name, display] of [
			['rating', { format: 'number' }],
			['rating', { format: 'rating', max: 10 }],
			['pages', undefined],
		] as const) {
			const res = await executePlatformTool(
				ctxFor(projectSpec()),
				'apply_spec_change',
				{
					op: 'data.addField',
					args: {
						entityId: 'e-order',
						field: {
							id: 'fld-x',
							name,
							type: 'number',
							required: false,
							...(display ? { display } : {}),
						},
					},
				},
			)
			expect(steering(res).warnings.join(' '), name).not.toMatch(
				/picks a widget from a number field/,
			)
		}
	})

	it('names the cheap verification chain for a page nothing verifies', async () => {
		const spec = projectSpec({ e2eTests: [] })
		const res = await executePlatformTool(ctxFor(spec), 'apply_spec_change', {
			op: 'page.addBlock',
			args: {
				pageId: 'pg-orders',
				block: { id: 'blk-new', type: 'table' },
			},
		})
		const { warnings, next } = steering(res)
		expect(warnings.join(' ')).toMatch(/declare no e2eTests/)
		expect(next.join(' ')).toMatch(/page\.setE2ETests/)
		expect(next.join(' ')).toMatch(/run_generator .*e2e-tests/)
		expect(next.join(' ')).toMatch(/run_checks/)
	})

	it('stays quiet about a page that already declares e2e tests', async () => {
		const res = await executePlatformTool(
			ctxFor(projectSpec()),
			'apply_spec_change',
			{
				op: 'page.addBlock',
				args: { pageId: 'pg-orders', block: { id: 'blk-new', type: 'table' } },
			},
		)
		expect(steering(res).warnings.join(' ')).not.toMatch(/e2eTests/)
	})

	it('reports a build behind the spec, counting the op just applied', async () => {
		const spec = projectSpec()
		const host: PlatformContext = {
			...ctxFor(spec),
			generation: { watermark: () => 0 },
		}
		const res = await executePlatformTool(host, 'apply_spec_change', {
			op: 'page.setE2ETests',
			args: { pageId: 'pg-orders', e2eTests: ['a user can archive an order'] },
		})
		const { warnings, next } = steering(res)
		expect(warnings.join(' ')).toMatch(/behind the spec/)
		expect(next.join(' ')).toMatch(/run_generator/)
	})

	it('says NOTHING about staleness when the host cannot see the build', async () => {
		// The house rule: an unanswerable fact is never answered optimistically.
		// No `generation` provider ⇒ no claim either way, rather than "up to date".
		const res = await executePlatformTool(
			ctxFor(projectSpec()),
			'apply_spec_change',
			{
				op: 'page.setE2ETests',
				args: {
					pageId: 'pg-orders',
					e2eTests: ['a user can archive an order'],
				},
			},
		)
		expect(steering(res).warnings.join(' ')).not.toMatch(/behind the spec/)
	})

	it('withholds build advice when the op was refused', async () => {
		const host: PlatformContext = {
			...ctxFor(projectSpec()),
			generation: { watermark: () => 0 },
		}
		const res = await executePlatformTool(host, 'apply_spec_change', {
			op: 'page.setE2ETests',
			args: { pageId: 'pg-nope', e2eTests: ['x'] },
		})
		// A refusal keeps its own shape — nothing was applied, so nothing is stale.
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toMatch(/unknown page/)
	})

	it('points a valid proposal at apply, which is the next call', async () => {
		const res = await executePlatformTool(ctx, 'propose_spec_change', {
			op: 'data.addEntity',
			args: { entity: { id: 'e-note', name: 'Note', fields: [] } },
		})
		expect(steering(res).next.join(' ')).toMatch(/apply_spec_change/)
	})
})

// ===========================================================================
// Declared-required enforcement — refuse rather than default
// ===========================================================================

describe('required arguments are refused, never manufactured', () => {
	it('writes NOTHING for a no-arg record_decision', async () => {
		// The bug this exists for: `?? ''` and `?? []` turned a malformed call into
		// a permanent, id-less entry in an append-only ledger. An error is
		// recoverable; a ledger entry is not.
		const before = JSON.stringify(await ctx.spec.load())
		const res = await executePlatformTool(ctx, 'record_decision', {})
		expect(res.isError).toBe(true)
		expect(JSON.stringify(await ctx.spec.load())).toBe(before)
	})

	it('names every missing argument, its type, and what it is for', async () => {
		const res = await executePlatformTool(ctx, 'record_decision', {})
		const text = res.content[0]?.text ?? ''
		for (const arg of ['id', 'question', 'options', 'rationale'])
			expect(text, `should name "${arg}"`).toContain(`"${arg}"`)
		// The message has to be sufficient to fix the call without a probe matrix.
		expect(text).toMatch(/Decision id \(d-…\)/)
		expect(text).toMatch(/will NOT be defaulted/)
		expect(text).toMatch(/Required arguments for this tool: /)
		expect(text).toMatch(/Nothing was written/)
	})

	it('refuses a null in a required slot rather than reading it as absent', async () => {
		const res = await executePlatformTool(ctx, 'record_decision', {
			id: 'd-x',
			question: null,
			options: [],
			rationale: 'because',
		})
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toMatch(/"question".*was null/)
	})

	it('names the type mismatch and the value that arrived', async () => {
		const res = await executePlatformTool(ctx, 'record_decision', {
			id: 'd-x',
			question: 'Which?',
			options: 'postgres',
			rationale: 'because',
		})
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toMatch(
			/"options" must be array; received string — "postgres"/,
		)
	})

	it('accepts a well-formed call unchanged', async () => {
		const res = await executePlatformTool(ctx, 'record_decision', {
			id: 'd-ok',
			question: 'Which store?',
			options: [{ id: 'o-pg', description: 'Postgres', pros: [], cons: [] }],
			rationale: 'managed + familiar',
		})
		expect(res.isError).toBeFalsy()
	})

	it('enforces the op tools’ required pair from the same one boundary', async () => {
		const res = await executePlatformTool(ctx, 'apply_spec_change', {
			op: 'data.addEntity',
		})
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toMatch(/missing required argument "args"/)
	})

	it('leaves optional arguments optional', async () => {
		const res = await executePlatformTool(ctx, 'query_spec', {})
		expect(res.isError).toBeFalsy()
	})
})

// ===========================================================================
// report_defect — a place to put a framework bug
// ===========================================================================

describe('report_defect', () => {
	const good = {
		title: 'PATCH rejects null on a nullable column',
		surface: 'rest-api',
		severity: 'workaround',
		what: 'PATCH /api/task/1 {"finishedOn": null}',
		expected: 'the column is cleared',
		actual: '422 {"finishedOn":["Invalid input"]}',
		workaround: 'wrote a sentinel date instead',
	}

	it('is listed on every host, wired sink or not', () => {
		// Unlike the other host-gated tools, and deliberately: an absent defect
		// tool does not produce silence, it produces misfiling. The session that
		// motivated this wrote a framework bug into the append-only decision
		// ledger as a resolved architectural choice, because record_decision was
		// the only write-shaped tool in reach.
		expect(platformTools(ctx).map((t) => t.name)).toContain('report_defect')
	})

	it('hands the report to the host sink and says where it went', async () => {
		const recorded: unknown[] = []
		const host: PlatformContext = {
			...ctx,
			defects: {
				record: (r) => {
					recorded.push(r)
					return 'defects.jsonl'
				},
			},
		}
		const res = payload(
			await executePlatformTool(host, 'report_defect', good),
		) as { recorded: boolean; where: string; note: string }
		expect(res.recorded).toBe(true)
		expect(res.where).toBe('defects.jsonl')
		expect(recorded).toHaveLength(1)
		expect(recorded[0]).toMatchObject({ title: good.title, origin: 'ai' })
	})

	it('succeeds with no sink, and says plainly that nothing was persisted', async () => {
		const res = payload(
			await executePlatformTool(ctx, 'report_defect', good),
		) as { recorded: boolean; where: null; note: string; report: unknown }
		expect(res.recorded).toBe(false)
		expect(res.where).toBeNull()
		expect(res.note).toMatch(/NOT persisted/)
		// The report comes back in full so it is not simply lost.
		expect(res.report).toMatchObject({ title: good.title })
		expect(res.note).toMatch(/rather than writing it into the decision ledger/)
	})

	it('changes nothing about the spec', async () => {
		const before = JSON.stringify(await ctx.spec.load())
		await executePlatformTool(ctx, 'report_defect', good)
		expect(JSON.stringify(await ctx.spec.load())).toBe(before)
	})

	it('refuses a report with no reproduction, like every other tool', async () => {
		const res = await executePlatformTool(ctx, 'report_defect', {
			title: 'it broke',
		})
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).toMatch(/missing required argument "surface"/)
	})

	it('warns on record_decision that the ledger is not the defect tracker', async () => {
		const res = await executePlatformTool(ctx, 'record_decision', {
			id: 'd-workaround',
			question: 'How do we clear finishedOn?',
			options: [
				{ id: 'o-sentinel', description: 'sentinel', pros: [], cons: [] },
			],
			chosenOptionId: 'o-sentinel',
			rationale: 'the API refuses null',
		})
		const { warnings } = steering(res)
		expect(warnings.join(' ')).toMatch(/append-only/)
		expect(warnings.join(' ')).toMatch(/report_defect/)
	})
})

// ===========================================================================
// The app-shaped effect on the mutation path
// ===========================================================================

describe('effect (what the op did to the application)', () => {
	function projectSpec(): SpecSystem {
		const spec = newSpecSystem(tasklyPRD)
		spec.data.entities.push(entity)
		spec.pages.pages.push(page)
		return spec
	}

	it('rides alongside the spec-shaped diff on apply', async () => {
		const res = await executePlatformTool(
			ctxFor(projectSpec()),
			'apply_spec_change',
			{
				op: 'data.addField',
				args: {
					entityId: 'e-order',
					field: {
						id: 'fld-note',
						name: 'note',
						type: 'string',
						required: false,
					},
				},
			},
		)
		const body = data(res) as {
			diff: { op: string }
			effect: { changesBuiltApp: boolean; added: string[] }
		}
		// Two answers to two different questions: the document changed (diff), and
		// the application changed (effect). Before #263 only the first was returned,
		// and a caller had no way to tell the two apart.
		expect(body.diff.op).toBe('data.addField')
		expect(body.effect.changesBuiltApp).toBe(true)
		expect(body.effect.added.join(' ')).toContain('order.note')
	})

	it('warns when the document moved and the application did not', async () => {
		const spec = projectSpec()
		const res = await executePlatformTool(ctxFor(spec), 'apply_spec_change', {
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-draft',
					name: 'Draft',
					fields: [],
					provenance: suggested(),
				},
			},
		})
		const body = data(res) as { effect: { changesBuiltApp: boolean } }
		expect(body.effect.changesBuiltApp).toBe(false)
		// Stated in `warnings` too, not only in `effect`: warnings is where an agent
		// looks for "that is not what you think you did", and the whole failure this
		// issue describes was a session reporting work the app never received.
		expect(steering(res).warnings.join(' ')).toMatch(
			/nothing about the built application/,
		)
	})

	it('does not accuse a presentation op of doing nothing', async () => {
		// It changes what renders; this inventory only sees structure. The shadowing
		// warning is the one that fires here, and only when a slot actually shadows.
		const spec = projectSpec()
		spec.pages.pages[0]?.blocks.push({
			id: 'blk-list',
			type: 'table',
			provenance: manual(),
		})
		const res = await executePlatformTool(ctxFor(spec), 'apply_spec_change', {
			op: 'page.setBlockVariant',
			args: { pageId: 'pg-orders', blockId: 'blk-list', variant: 'cards' },
		})
		const body = data(res) as { effect: { changesBuiltApp: null } }
		expect(body.effect.changesBuiltApp).toBeNull()
		expect(steering(res).warnings.join(' ')).not.toMatch(
			/nothing about the built application/,
		)
	})

	it('answers the same question on propose, and still writes nothing', async () => {
		const host = ctxFor(projectSpec())
		const before = JSON.stringify(await host.spec.load())
		const res = await executePlatformTool(host, 'propose_spec_change', {
			op: 'data.addField',
			args: {
				entityId: 'e-order',
				field: {
					id: 'fld-note',
					name: 'note',
					type: 'string',
					required: false,
				},
			},
		})
		const body = data(res) as {
			valid: boolean
			effect: { changesBuiltApp: boolean }
		}
		expect(body.valid).toBe(true)
		expect(body.effect.changesBuiltApp).toBe(true)
		// The projection is applied in memory and thrown away — consent comes first.
		expect(JSON.stringify(await host.spec.load())).toBe(before)
	})

	it('has no effect to report when the op is refused', async () => {
		const res = await executePlatformTool(
			ctxFor(projectSpec()),
			'propose_spec_change',
			{
				op: 'data.addField',
				args: {
					entityId: 'e-nope',
					field: { id: 'fld-x', name: 'x', type: 'string', required: false },
				},
			},
		)
		const body = data(res) as { valid: boolean; effect: unknown }
		expect(body.valid).toBe(false)
		expect(body.effect).toBeNull()
	})
})

/**
 * #343 — `maxstack init` seeds a structurally complete product doc so the PRD
 * validates, which means an agent calling `query_spec {section:"product"}` gets
 * fluent English about a persona, a competitor and a kill criterion whether or
 * not a human ever wrote a word of it. Grounding on that is grounding on
 * invention, and the payload gave no way to tell.
 */
describe('query_spec (#343 — an unauthored product doc says so)', () => {
	/** The doc a project has right after `maxstack init`. */
	function seededCtx(): PlatformContext {
		const seed = prdSeedProse('reader')
		return ctxFor(
			newSpecSystem(
				minimalPRD({
					title: 'reader',
					tldr: seed.tldr,
					problem: seed.problem,
					northStar: seed.northStar,
					persona: seed.persona,
					differentiation: seed.differentiation,
				}),
			),
		)
	}

	it('names the gap in the summary — the section every session reads', async () => {
		const res = data(
			await executePlatformTool(seededCtx(), 'query_spec', {}),
		) as { productDoc?: string }
		expect(res.productDoc).toContain('never been authored')
		expect(res.productDoc).toContain('problem.statement')
	})

	it('names it beside the doc itself, not only in the summary', async () => {
		const res = data(
			await executePlatformTool(seededCtx(), 'query_spec', {
				section: 'product',
			}),
		) as { unauthored?: { path: string }[]; note?: string; problem: unknown }
		// The content is still returned whole — the gap is annotation, not
		// redaction; an agent that wants to read the scaffold still can.
		expect(res.problem).toBeTruthy()
		expect(res.unauthored?.map((u) => u.path)).toContain('problem.statement')
		expect(res.note).toContain('never been authored')
	})

	it('says nothing at all once the doc is authored', async () => {
		const summary = data(await executePlatformTool(ctx, 'query_spec', {})) as {
			productDoc?: string
		}
		expect(summary.productDoc).toBeUndefined()
		const product = data(
			await executePlatformTool(ctx, 'query_spec', { section: 'product' }),
		) as { unauthored?: unknown; note?: unknown }
		expect(product.unauthored).toBeUndefined()
		expect(product.note).toBeUndefined()
	})
})
