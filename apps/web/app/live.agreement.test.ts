/**
 * The live layer's web-side chain, end to end.
 *
 * `packages/maxstack-core/src/sprout/live.test.ts` proves the channel is correct
 * once something publishes to it, and that the mutation ops publish. This file
 * proves the **other half of the sentence** — that a *declared* subscription in
 * a spec becomes an open channel this runtime can find and feed:
 *
 *   `live.declare` → `groundLive` → `ResourceConfig.live` → `registry.findLive`
 *   → `LiveChannel` → an `opUpdate` on the grounded resource → a projected
 *   message on the wire
 *
 * Without this the layer is a bounded, gated channel nobody feeds, which is a
 * stated capability the runtime does not have. It is the same relationship
 * `portals.agreement.test.ts` has with `sprout/portals.test.ts`: the enforcement
 * is tested there, the *wiring from a declaration* is tested here.
 *
 * The HTTP frame itself (`routes/api.live.$key.tsx`) is deliberately not covered
 * — see issue #179, which records that gap rather than
 * claiming it.
 */

import {
	createSpecDb,
	LiveChannel,
	type LiveMessage,
	opCreate,
	opDelete,
	opList,
	opUpdate,
	ResourceRegistry,
	registerSpecEntities,
} from '@maxstack/core'
import {
	applyOp,
	type LiveSubscriptionSpec,
	newSpecSystem,
	type SpecOp,
	type SpecSystem,
	validateSpecSystem,
} from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { groundedEntityShapes } from './spec-sprout'

const meta = (n: number) => ({
	id: `op-lv-${n}` as const,
	origin: 'human' as const,
	appliedAt: '2026-07-29' as const,
	actor: { surface: 'harness' as const },
})

const PROVENANCE = {
	isSuggested: false,
	isAccepted: true,
	isAddedManually: true,
	suggestedDescription: null,
	priority: 'medium',
} as const

/** A task entity with one column the channel declares and one it must not push. */
function baseSpec(): SpecSystem {
	return applyOp(
		newSpecSystem(tasklyPRD),
		{
			op: 'data.addEntity',
			args: {
				entity: {
					id: 'e-task',
					name: 'Task',
					description: 'A unit of work.',
					fields: [
						{ id: 'fld-title', name: 'title', type: 'string', required: true },
						{ id: 'fld-status', name: 'status', type: 'enum', required: false },
						{
							id: 'fld-project',
							name: 'project',
							type: 'string',
							required: false,
						},
						{
							id: 'fld-notes',
							name: 'internalNotes',
							type: 'string',
							required: false,
						},
					],
				},
			},
		} as SpecOp,
		meta(1),
	)
}

const BOARD: LiveSubscriptionSpec = {
	id: 'lv-board',
	key: 'board',
	description: 'Push task changes to whoever has the board open.',
	entityId: 'e-task',
	kind: 'query',
	fields: ['fld-title', 'fld-status'],
	scope: { kind: 'filtered', fieldId: 'fld-project' },
	maxSubscribers: 50,
	maxMessagesPerMinute: 120,
	slot: true,
	paused: false,
	declaredAt: '2026-07-29',
	provenance: PROVENANCE,
}

function specWithChannel(over: Partial<LiveSubscriptionSpec> = {}): SpecSystem {
	return applyOp(
		baseSpec(),
		{
			op: 'live.declare',
			args: { subscription: { ...BOARD, ...over } },
		} as SpecOp,
		meta(2),
	)
}

/** Ground a spec into a live runtime, exactly as `sprout.server.ts` does. */
async function runtimeFor(spec: SpecSystem) {
	const shapes = groundedEntityShapes(spec)
	const registry = new ResourceRegistry()
	registerSpecEntities(registry, shapes)
	const { store } = await createSpecDb(registry, shapes)
	return { registry, store }
}

/** A recording subscriber, as the SSE route builds one. */
function recorder(ctx: { registry: ResourceRegistry; store: unknown }) {
	const sent: LiveMessage[] = []
	return {
		id: 'c1',
		ctx: { ...ctx, user: null } as never,
		scopeValue: 'apollo',
		sent,
		send: (m: LiveMessage) => sent.push(m),
		close: () => {},
	}
}

describe('a declared subscription becomes a channel this runtime feeds', () => {
	it('grounds field ids to column names and lands on the registry', async () => {
		const spec = specWithChannel()
		expect(() => validateSpecSystem(spec)).not.toThrow()
		const { registry } = await runtimeFor(spec)

		const found = registry.findLive('board')
		expect(found).toBeDefined()
		// Column names, not field ids — the projection the runtime applies has to
		// be in the store's vocabulary, not the spec's.
		expect(found?.plan.fields).toEqual(['title', 'status'])
		expect(found?.plan.scope).toEqual({ kind: 'filtered', field: 'project' })
		expect(found?.plan.resource).toBe('task')
		// The ceilings survive grounding: they are what the channel enforces.
		expect(found?.plan.maxSubscribers).toBe(50)
		expect(found?.plan.maxMessagesPerMinute).toBe(120)
	})

	it('an opUpdate on the grounded resource arrives on the channel, projected', async () => {
		// THE end-to-end assertion. Nothing in this test touches `LiveChannel`
		// except to open one from the plan the registry produced.
		const { registry, store } = await runtimeFor(specWithChannel())
		const found = registry.findLive('board')
		if (!found) throw new Error('expected the board channel')
		const channel = new LiveChannel(found.plan, found.entry.resource.primaryKey)
		const sub = recorder({ registry, store })
		expect(channel.subscribe(sub as never).ok).toBe(true)

		// The publisher the web composition root wires onto every OpContext.
		const live = async (resource: string, id: string) => {
			if (resource === channel.plan.resource) await channel.publish({ id }, 0)
		}
		const ctx = { registry, store, user: null, live }

		const created = await opCreate(ctx, 'task', {
			title: 'Ship the board',
			status: 'doing',
			project: 'apollo',
			internalNotes: 'NOT ON THE WIRE',
		})
		const id = String(created.id)

		// Non-vacuity: an ungated read genuinely returns the column the assertion
		// below requires to be absent.
		const ungated = await opList({ registry, store, user: null }, 'task')
		expect(ungated[0]?.internalNotes).toBe('NOT ON THE WIRE')

		await opUpdate(ctx, 'task', id, { status: 'done' })
		const message = sub.sent.at(-1)
		if (message?.type !== 'row') throw new Error('expected a row message')
		expect(message.id).toBe(id)
		expect(message.row.status).toBe('done')
		// Exactly the declared columns plus the primary key. `toEqual` on the key
		// set, not a spot check: a spot check passes while a column nobody thought
		// of rides along.
		expect(Object.keys(message.row).sort()).toEqual(['id', 'status', 'title'])
	})

	it('a delete arrives as a removal, not as a row', async () => {
		const { registry, store } = await runtimeFor(specWithChannel())
		const found = registry.findLive('board')
		if (!found) throw new Error('expected the board channel')
		const channel = new LiveChannel(found.plan, found.entry.resource.primaryKey)
		const sub = recorder({ registry, store })
		channel.subscribe(sub as never)
		const live = async (resource: string, id: string) => {
			if (resource === channel.plan.resource) await channel.publish({ id }, 0)
		}
		const ctx = { registry, store, user: null, live }

		const created = await opCreate(ctx, 'task', {
			title: 'Going away',
			project: 'apollo',
		})
		const id = String(created.id)
		expect(sub.sent.at(-1)?.type).toBe('row')
		await opDelete(ctx, 'task', id)
		expect(sub.sent.at(-1)).toEqual({ type: 'remove', id })
	})

	it('a spec that declares no channel grounds no plan at all', async () => {
		// The absence is the common case and must cost nothing: an entity with no
		// declared channel puts no `live` on its registry config, so the SSE route
		// finds nothing and no fan-out exists to feed.
		const { registry } = await runtimeFor(baseSpec())
		expect(registry.findLive('board')).toBeUndefined()
		expect(registry.get('task')?.config.live).toBeUndefined()
	})

	it('a paused channel still grounds, so pausing does not rewrite the app', async () => {
		// It grounds with `paused: true`, which `LiveChannel.subscribe` refuses —
		// and the surface polls instead. Dropping the plan would make a paused
		// channel indistinguishable from an undeclared one.
		const { registry } = await runtimeFor(specWithChannel({ paused: true }))
		const found = registry.findLive('board')
		expect(found?.plan.paused).toBe(true)
		const channel = new LiveChannel(found?.plan as never, 'id')
		expect(channel.subscribe({ id: 'c1' } as never)).toEqual({
			ok: false,
			reason: 'paused',
		})
	})
})

describe('the composition root actually wires the publisher', () => {
	it('getContext sets `live` on every OpContext it builds', async () => {
		// The one line connecting the ops to the channel table. It is a single
		// property on a single object, which is exactly the kind of wiring that
		// gets dropped in a refactor and produces a layer that is correct
		// everywhere and fed nowhere.
		const { readFile } = await import('node:fs/promises')
		const src = await readFile(
			new URL('./sprout.server.ts', import.meta.url),
			'utf8',
		)
		// Since issue #236 the hooks live in `contextForUser`, which `getContext`
		// delegates to — precisely so a context built for background work (a source
		// run) cannot be a context missing one of them. Both halves are asserted:
		// the hook exists, and the request path still goes through it.
		const built = src.split('export async function contextForUser(')[1] ?? ''
		expect(built).toContain('live:')
		expect(built).toContain('publishLiveChange')
		const delegating = src.split('export async function getContext(')[1] ?? ''
		expect(
			delegating.split('export async function contextForUser(')[0],
		).toContain('return contextForUser(user)')
	})
})

/**
 * The bespoke-surface seam, from the emitted stub to the host that renders it
 *.
 *
 * Issue #235 generated `live/<key>.live.tsx` and re-exported the registry, and
 * #236's finding was that nothing read it: the props type is generated per
 * channel and the registry erases the component's type, so a host that does not
 * match the emitted shape is a host whose mismatch nothing catches. There is no
 * import that can pin it — `@maxstack/core`'s emitter cannot reach a type in
 * `apps/web` — so the duplicate is checked rather than deleted, the posture
 * `spec-sprout.ts` takes with `LiveKind`.
 */
describe('the generated surface and its host agree on props', () => {
	const descriptor = {
		key: 'task-board',
		description: 'The live board',
		kind: 'query',
		resource: 'task',
		bound: 'one project',
		fields: ['title', 'status'],
		slot: true,
	}

	it('every prop the stub declares is a prop the host supplies', async () => {
		const { emitLiveComponentStub } = await import('@maxstack/core/ownership')
		const stub = emitLiveComponentStub(descriptor)
		// The four props the host passes. A prop added to the stub without a host
		// to supply it would render as `undefined` in every generated project.
		for (const prop of ['rows', 'present', 'truncated', 'polling'])
			expect(stub).toContain(`\t${prop}`)
		// The shapes the host commits to, spelled the way the stub spells them.
		expect(stub).toContain('\t\tid: string')
		expect(stub).toContain('present: { identity: string; since: number }[]')
		expect(stub).toContain('truncated: boolean')
		expect(stub).toContain('polling: boolean')
	})

	it('the host normalizes the primary key into the `id` the stub promises', async () => {
		const { withRowIds } = await import('./live-surface')
		// A resource whose primary key is not called `id` — the case that makes the
		// generated `id: string` a lie unless somebody translates it.
		expect(withRowIds([{ taskId: 7, title: 'Ship' }], 'taskId')).toEqual([
			{ taskId: 7, title: 'Ship', id: '7' },
		])
	})

	it('an ungenerated channel degrades to the generic surface, not a blank page', async () => {
		const { hasLiveSurface } = await import('./live-surface')
		// `OWNED_LIVE_SURFACES` is the committed empty stub in this build, so a
		// declared-but-ungenerated channel must read as absent and let the caller
		// fall through to the list it would otherwise have rendered.
		expect(hasLiveSurface('task-board')).toBe(false)
		expect(hasLiveSurface(undefined)).toBe(false)
	})

	it('both hosts gate on the declaration AND on the registry', async () => {
		const { readFile } = await import('node:fs/promises')
		for (const route of [
			'routes/project.page.tsx',
			'routes/project.edit.tsx',
		]) {
			const src = await readFile(new URL(`./${route}`, import.meta.url), 'utf8')
			expect(src).toContain('hasLiveSurface(liveSlot?.key)')
			expect(src).toContain('<LiveSurface')
		}
	})

	it('the heartbeat beats the declared TTL rather than guessing', async () => {
		const { heartbeatIntervalMs } = await import('./use-live-presence')
		// A third of the TTL: two beats may be lost before an entry expires, which
		// is ordinary packet loss rather than an unusual amount. An interval slower
		// than the TTL would make the list flicker people out and back in.
		expect(heartbeatIntervalMs(60)).toBe(20_000)
		expect(heartbeatIntervalMs(90)).toBe(30_000)
		// …floored, so a 1-second TTL cannot ask a browser for three requests a
		// second, and defined for a `query` channel that declares no TTL at all.
		expect(heartbeatIntervalMs(1)).toBe(5_000)
		expect(heartbeatIntervalMs(undefined)).toBe(5_000)
	})
})
