/**
 * Live-channel enforcement, against a real pglite database.
 *
 * **Every test is named after the thing it prevents**, on `portals.test.ts`'
 * rule and for its reason: this suite is read once when it is written and once
 * by somebody in an incident asking "could a live channel have been how it got
 * out?", and `applies the projection` answers that for nobody.
 *
 * Two structural properties carry the file:
 *
 *  - **Non-vacuity.** Every assertion of absence opens by proving the ungated
 *    read genuinely returns the row or column it then requires to be missing.
 *    Without that, a projection test passes just as happily against an empty
 *    table.
 *  - **No timers.** Nothing here schedules, and nothing in `live.ts` does
 *    either — presence expiry takes a `nowMs`, and the fan-out is a plain
 *    `await`. A live suite that opened a real interval would hang the run, and
 *    the honest fix is a module that never schedules rather than a test that
 *    remembers to clean up.
 */

import type { PGlite } from '@electric-sql/pglite'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzleStore } from '../demo/store.ts'
import { bootPglite } from '../testing/pglite-snapshot.ts'
import {
	LiveChannel,
	type LiveCloseReason,
	type LiveMessage,
	type LivePlan,
	type LiveSubscriber,
	liveDeclarationRefusal,
	pollLive,
	projectForLive,
} from './live.ts'
import {
	type OpContext,
	opCreate,
	opDelete,
	opList,
	opUpdate,
} from './operations.ts'
import { PermissionError, type SproutUser } from './permissions.ts'
import { type PortalPlan, portalIdentity } from './portals.ts'
import { ResourceRegistry } from './registry.ts'
import { withMeta } from './schema-builder.ts'

// ---------------------------------------------------------------------------
// A task table with exactly the columns worth not pushing.
// ---------------------------------------------------------------------------

const task = pgTable('task', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: withMeta(text('title'), {}),
	status: withMeta(text('status'), {}),
	project: withMeta(text('project'), {}),
	/** The one no channel declares, and the one every test checks for. */
	internalNotes: withMeta(text('internalNotes'), {}),
	userId: withMeta(text('userId'), {}),
	deletedAt: timestamp('deletedAt'),
})

const DDL = `
CREATE TABLE IF NOT EXISTS task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  status text,
  project text,
  "internalNotes" text,
  "userId" text,
  "deletedAt" timestamp
);
`

/** The board channel: a project's tasks, title and status only. */
const BOARD: LivePlan = {
	key: 'board',
	description: 'Push task changes to whoever has the board open.',
	resource: 'task',
	kind: 'query',
	fields: ['title', 'status'],
	scope: { kind: 'filtered', field: 'project' },
	maxSubscribers: 100,
	maxMessagesPerMinute: 120,
	slot: true,
	paused: false,
}

/** Who is looking at one task. Identities only, by construction. */
const VIEWERS: LivePlan = {
	key: 'viewers',
	description: 'Who is looking at this task right now.',
	resource: 'task',
	kind: 'presence',
	fields: [],
	scope: { kind: 'row' },
	maxSubscribers: 100,
	maxMessagesPerMinute: 60,
	presenceTtlSeconds: 30,
	maxPresent: 3,
	slot: false,
	paused: false,
}

/**
 * A public portal over the same table that exposes only `title` — narrower than
 * the channel, which declares `title` AND `status`. The intersection test needs
 * the two declarations to genuinely disagree.
 */
const PORTAL: PortalPlan = {
	key: 'board-share',
	description: 'A read-only public view of one project’s board.',
	resource: 'task',
	audience: 'public',
	scope: 'collection',
	readFields: ['title'],
	writes: [],
	filter: { field: 'project', equals: 'apollo' },
	layout: 'table',
	paused: false,
}

let client: PGlite
let registry: ResourceRegistry
let store: ReturnType<typeof createDrizzleStore>
let apolloId: string
let geminiId: string

/** A context whose identity is whatever the caller passes. */
function ctxFor(user: SproutUser | null): OpContext {
	return { registry, store, user }
}

/** A recording subscriber. `sent`/`closed` are the whole assertion surface. */
function recorder(
	id: string,
	ctx: OpContext,
	over: Partial<LiveSubscriber> = {},
): LiveSubscriber & { sent: LiveMessage[]; closed: LiveCloseReason[] } {
	const sent: LiveMessage[] = []
	const closed: LiveCloseReason[] = []
	return {
		id,
		ctx,
		scopeValue: 'apollo',
		sent,
		closed,
		send: (m) => sent.push(m),
		close: (r) => closed.push(r),
		...over,
	}
}

beforeAll(async () => {
	client = await bootPglite()
	await client.exec(DDL)
	registry = new ResourceRegistry()
	registry.register(task, { portals: [PORTAL] })
	store = createDrizzleStore(drizzle({ client }), registry, (t, p) =>
		client
			.query(t, p as unknown[] | undefined)
			.then((r) => r.rows as Record<string, unknown>[]),
	)
	const admin = ctxFor(null)
	const apollo = await opCreate(admin, 'task', {
		title: 'Ship the board',
		status: 'doing',
		project: 'apollo',
		internalNotes: 'SEVERANCE TERMS',
		userId: 'u-ann',
	})
	apolloId = String(apollo.id)
	const gemini = await opCreate(admin, 'task', {
		title: 'Other project',
		status: 'todo',
		project: 'gemini',
		internalNotes: 'do not push',
		userId: 'u-bob',
	})
	geminiId = String(gemini.id)
})

afterAll(async () => {
	await client.close()
})

// ===========================================================================
// 0. Non-vacuity.
// ===========================================================================

describe('the ungated read really does reach what a channel must not push', () => {
	it('returns both projects, the internal note and the owner column', async () => {
		const rows = await opList(ctxFor(null), 'task', { limit: 10 })
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => r.project).sort()).toEqual(['apollo', 'gemini'])
		expect(rows.map((r) => r.internalNotes)).toContain('SEVERANCE TERMS')
		expect(rows.every((r) => 'userId' in r)).toBe(true)
	})
})

// ===========================================================================
// 1. A column nobody declared never reaches the wire.
// ===========================================================================

describe('a column nobody declared never reaches the wire', () => {
	it('pushes exactly the declared fields plus the primary key, and nothing else', async () => {
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		expect(channel.subscribe(sub).ok).toBe(true)
		await channel.publish({ id: apolloId }, 0)
		const [message] = sub.sent
		if (message?.type !== 'row') throw new Error('expected a row message')
		// `toEqual` on the key set, not a spot check: a spot check passes while a
		// column nobody thought of rides along.
		expect(Object.keys(message.row).sort()).toEqual(['id', 'status', 'title'])
	})

	it('drops a derived value the channel did not declare', () => {
		// Derived values arrive AFTER the store, which is exactly the
		// kind of value nobody remembers to think of as pushed.
		expect(
			projectForLive(BOARD, 'id', {
				id: 'x',
				title: 't',
				status: 's',
				openCount: 12,
			}),
		).toEqual({ id: 'x', title: 't', status: 's' })
	})
})

// ===========================================================================
// 2. The bound.
// ===========================================================================

describe('a subscriber never receives a row outside its own bound', () => {
	it('sends a removal, not a row, for a change in another project', async () => {
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		await channel.publish({ id: geminiId }, 0)
		expect(sub.sent).toEqual([{ type: 'remove', id: geminiId }])
	})

	it('refuses a filtered subscription that names no bound rather than defaulting to all rows', async () => {
		const channel = new LiveChannel(BOARD, 'id')
		const result = channel.subscribe(
			recorder('c1', ctxFor(null), { scopeValue: undefined }),
		)
		expect(result).toEqual({ ok: false, reason: 'scope-required' })
	})

	it('cannot tell "moved to another project" from "deleted" — both are one message', async () => {
		// A subscriber that learned WHY a row left its view would learn something
		// about rows it may not see.
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		const admin = ctxFor(null)
		const moved = await opCreate(admin, 'task', {
			title: 'Moving',
			status: 'todo',
			project: 'apollo',
		})
		const movedId = String(moved.id)
		await opUpdate(admin, 'task', movedId, { project: 'gemini' })
		await channel.publish({ id: movedId }, 0)

		const gone = await opCreate(admin, 'task', {
			title: 'Going',
			status: 'todo',
			project: 'apollo',
		})
		const goneId = String(gone.id)
		await opDelete(admin, 'task', goneId)
		await channel.publish({ id: goneId }, 0)

		expect(sub.sent).toEqual([
			{ type: 'remove', id: movedId },
			{ type: 'remove', id: goneId },
		])
	})
})

// ===========================================================================
// 3. Per-message RBAC — the exit criterion.
// ===========================================================================

describe('a permission revoked mid-session takes effect on the next message', () => {
	it('disconnects a subscriber whose read access was revoked while the stream was open', async () => {
		// THE revocation test. The subscriber connects while allowed, the resource's
		// rule changes under them, and the very next change disconnects them —
		// rather than continuing to push until they close the tab.
		const gated = new ResourceRegistry()
		let mayRead = true
		gated.register(task, { access: { read: () => mayRead } })
		const gatedStore = createDrizzleStore(drizzle({ client }), gated, (t, p) =>
			client
				.query(t, p as unknown[] | undefined)
				.then((r) => r.rows as Record<string, unknown>[]),
		)
		const ctx: OpContext = {
			registry: gated,
			store: gatedStore,
			user: { id: 'u-ann' },
		}
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctx)
		channel.subscribe(sub)

		// Non-vacuous: while allowed, the row genuinely arrives.
		await channel.publish({ id: apolloId }, 0)
		expect(sub.sent.at(-1)?.type).toBe('row')
		expect(sub.closed).toEqual([])

		mayRead = false
		await channel.publish({ id: apolloId }, 1)
		// Disconnected, and told why — not merely skipped.
		expect(sub.closed).toEqual(['permission-revoked'])
		// And forgotten, so a later change reaches nobody.
		expect(channel.size).toBe(0)
		const before = sub.sent.length
		await channel.publish({ id: apolloId }, 2)
		expect(sub.sent).toHaveLength(before)
	})

	it('re-checks on EVERY message, not once at connect time', async () => {
		// The property stated as a count: three changes, three authorizations.
		const counting = new ResourceRegistry()
		let checks = 0
		counting.register(task, {
			access: {
				read: () => {
					checks += 1
					return true
				},
			},
		})
		const countingStore = createDrizzleStore(
			drizzle({ client }),
			counting,
			(t, p) =>
				client
					.query(t, p as unknown[] | undefined)
					.then((r) => r.rows as Record<string, unknown>[]),
		)
		const channel = new LiveChannel(BOARD, 'id')
		channel.subscribe(
			recorder('c1', {
				registry: counting,
				store: countingStore,
				user: { id: 'u-ann' },
			}),
		)
		checks = 0
		await channel.publish({ id: apolloId }, 0)
		await channel.publish({ id: apolloId }, 1)
		await channel.publish({ id: apolloId }, 2)
		// At least one per message — the row-level read runs the rule again too,
		// which is the point: nothing is cached across messages.
		expect(checks).toBeGreaterThanOrEqual(3)
	})

	it('refuses an owner-gated resource wholesale, exactly as opList does', async () => {
		// A row-less `owner` rule reads as DENIED — that is `opList`'s and
		// `opSearch`'s existing behaviour, and a live query channel is a list that
		// moves, so it inherits it rather than inventing a row-filter semantics of
		// its own. The consequence is worth pinning rather than discovering: an
		// entity whose read rule is the `owner` shortcut cannot carry a query
		// channel at all, and the subscriber is told so on the first message
		// instead of holding a socket that never delivers.
		//
		// Inventing "quietly push the caller's own rows" here would make the push
		// path the one read surface with its own access model, which is how two
		// access models drift.
		const owned = new ResourceRegistry()
		owned.register(task, { access: { read: 'owner' } })
		const ownedStore = createDrizzleStore(drizzle({ client }), owned, (t, p) =>
			client
				.query(t, p as unknown[] | undefined)
				.then((r) => r.rows as Record<string, unknown>[]),
		)
		const ctx: OpContext = {
			registry: owned,
			store: ownedStore,
			user: { id: 'u-ann' },
		}
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c-owner', ctx)
		channel.subscribe(sub)
		await channel.publish({ id: apolloId }, 0)
		expect(sub.closed).toEqual(['permission-revoked'])
		// The polling fallback agrees, which is the property that matters: it
		// refuses too, rather than quietly returning the caller's own rows.
		await expect(pollLive(BOARD, sub, 'id')).rejects.toThrow(PermissionError)
	})

	it('stops pushing a row that left this subscriber’s tenant, and pushes one that joined it', async () => {
		// Row-level visibility through a scope `opList` genuinely enforces. BOTH
		// directions are asserted, because "a row that becomes visible is pushed" is
		// a behaviour a board needs — a card moved into your project appears — and
		// would otherwise be discovered rather than chosen.
		const scoped = new ResourceRegistry()
		scoped.register(task, { tenantField: 'project' })
		const scopedStore = createDrizzleStore(
			drizzle({ client }),
			scoped,
			(t, p) =>
				client
					.query(t, p as unknown[] | undefined)
					.then((r) => r.rows as Record<string, unknown>[]),
		)
		const admin: OpContext = {
			registry: scoped,
			store: scopedStore,
			user: { id: 'u-root', orgId: 'gemini' },
		}
		const row = await opCreate(admin, 'task', {
			title: 'Moving between projects',
			status: 'todo',
		})
		const id = String(row.id)

		const channel = new LiveChannel({ ...BOARD, scope: { kind: 'all' } }, 'id')
		const ann = recorder(
			'c-ann',
			{
				registry: scoped,
				store: scopedStore,
				user: { id: 'u-ann', orgId: 'apollo' },
			},
			{ scopeValue: undefined },
		)
		channel.subscribe(ann)

		// In gemini, not apollo: a removal, and Ann stays connected — a row she may
		// not see is not a fact about her session.
		await channel.publish({ id }, 0)
		expect(ann.sent.at(-1)).toEqual({ type: 'remove', id })
		expect(ann.closed).toEqual([])

		// Moved into apollo: pushed.
		await opUpdate(
			{ ...admin, user: { id: 'u-root', orgId: 'gemini' } },
			'task',
			id,
			{ title: 'Moved' },
		)
		await scopedStore.update('task', id, { project: 'apollo' })
		await channel.publish({ id }, 1)
		const arrived = ann.sent.at(-1)
		if (arrived?.type !== 'row') throw new Error('expected the row to arrive')
		expect(arrived.row.title).toBe('Moved')

		// And away again.
		await scopedStore.update('task', id, { project: 'gemini' })
		await channel.publish({ id }, 2)
		expect(ann.sent.at(-1)).toEqual({ type: 'remove', id })
	})

	it('pushes the INTERSECTION of a portal projection and the channel’s — narrower always wins', async () => {
		// The channel declares title + status; the portal exposes title only. What
		// goes on the wire is title. Neither layer knows about the other: `opList`
		// applies `projectForPortal`, and `projectForLive` copies only keys that
		// survived it.
		const identity = portalIdentity(PORTAL, { clientId: '203.0.113.9' })
		expect(identity).not.toBeNull()
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c-portal', ctxFor(identity))
		channel.subscribe(sub)
		await channel.publish({ id: apolloId }, 0)
		const message = sub.sent.at(-1)
		if (message?.type !== 'row') throw new Error('expected a row message')
		expect(Object.keys(message.row).sort()).toEqual(['id', 'title'])
		// Non-vacuous: the channel really does declare `status`, and an ordinary
		// identity really does receive it.
		expect(BOARD.fields).toContain('status')
	})

	it('disconnects a portal identity whose portal was paused mid-session', async () => {
		// The same revocation property, reached through the narrowing rather than
		// through the resource's rule — `portalGrants` denies a paused portal's
		// resource, so step 1 of the gate catches it.
		const identity = portalIdentity(PORTAL, { clientId: '203.0.113.9' })
		if (!identity?.portal) throw new Error('expected a portal identity')
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c-portal', ctxFor(identity))
		channel.subscribe(sub)
		await channel.publish({ id: apolloId }, 0)
		expect(sub.sent.at(-1)?.type).toBe('row')
		// Revoke by narrowing the identity's own grant, which is what a re-built
		// identity from a paused portal produces.
		identity.portal.resource = 'something-else'
		await channel.publish({ id: apolloId }, 1)
		expect(sub.closed).toEqual(['permission-revoked'])
	})
})

// ===========================================================================
// 4. Backpressure and connection limits.
// ===========================================================================

describe('a broadcast storm cannot take the process down', () => {
	it('sheds a subscriber over its declared rate rather than buffering for it', async () => {
		const slow: LivePlan = { ...BOARD, maxMessagesPerMinute: 2 }
		const channel = new LiveChannel(slow, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		await channel.publish({ id: apolloId }, 0)
		await channel.publish({ id: apolloId }, 10)
		expect(sub.sent).toHaveLength(2)
		await channel.publish({ id: apolloId }, 20)
		// Disconnected with a reason, and NOT buffered: still two messages.
		expect(sub.sent).toHaveLength(2)
		expect(sub.closed).toEqual(['rate-exceeded'])
		expect(channel.size).toBe(0)
	})

	it('uses a sliding window, so a burst cannot straddle two fixed buckets', async () => {
		// A fixed bucket lets a subscriber spend a whole minute's budget in the last
		// second of one window and again in the first second of the next — two
		// minutes of fan-out in two seconds, which is the burst the ceiling exists
		// to stop.
		const slow: LivePlan = { ...BOARD, maxMessagesPerMinute: 2 }
		const channel = new LiveChannel(slow, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		await channel.publish({ id: apolloId }, 59_000)
		await channel.publish({ id: apolloId }, 59_500)
		await channel.publish({ id: apolloId }, 60_100)
		expect(sub.closed).toEqual(['rate-exceeded'])
	})

	it('lets the window slide, so a subscriber within its budget is never shed', async () => {
		const slow: LivePlan = { ...BOARD, maxMessagesPerMinute: 2 }
		const channel = new LiveChannel(slow, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		await channel.publish({ id: apolloId }, 0)
		await channel.publish({ id: apolloId }, 1_000)
		await channel.publish({ id: apolloId }, 70_000)
		expect(sub.closed).toEqual([])
		expect(sub.sent).toHaveLength(3)
	})

	it('refuses a connection past the declared subscriber ceiling, with a stated reason', () => {
		const tiny: LivePlan = { ...BOARD, maxSubscribers: 1 }
		const channel = new LiveChannel(tiny, 'id')
		expect(channel.subscribe(recorder('c1', ctxFor(null)))).toEqual({
			ok: true,
		})
		// Refused, not queued: a queue for connections is a slower way to run out
		// of file descriptors.
		expect(channel.subscribe(recorder('c2', ctxFor(null)))).toEqual({
			ok: false,
			reason: 'channel-full',
		})
		expect(channel.size).toBe(1)
	})

	it('refuses every connection while the channel is paused', () => {
		const paused: LivePlan = { ...BOARD, paused: true }
		expect(
			new LiveChannel(paused, 'id').subscribe(recorder('c1', ctxFor(null))),
		).toEqual({ ok: false, reason: 'paused' })
	})
})

// ===========================================================================
// 5. Presence — bounded, ephemeral, and identities only.
// ===========================================================================

describe('presence reports who is here and nothing else about them', () => {
	it('carries an identity and a join time, and has nowhere to put anything else', () => {
		const channel = new LiveChannel(VIEWERS, 'id')
		channel.heartbeat(apolloId, 'u-ann', 1_000)
		const { present } = channel.present(apolloId, 1_000)
		expect(present).toEqual([{ identity: 'u-ann', since: 1_000 }])
		// The absence IS the design: no cursor, no selection, no payload.
		expect(Object.keys(present[0] ?? {}).sort()).toEqual(['identity', 'since'])
	})

	it('expires an entry whose tab crashed and sent no goodbye', () => {
		const channel = new LiveChannel(VIEWERS, 'id')
		channel.heartbeat(apolloId, 'u-ann', 0)
		expect(channel.present(apolloId, 29_000).present).toHaveLength(1)
		// 30s TTL: past it the entry is gone, with nobody having sent anything.
		expect(channel.present(apolloId, 31_000).present).toEqual([])
	})

	it('keeps a face still while its tab heartbeats — a refresh is not a rejoin', () => {
		const channel = new LiveChannel(VIEWERS, 'id')
		channel.heartbeat(apolloId, 'u-ann', 0)
		channel.heartbeat(apolloId, 'u-bob', 1_000)
		channel.heartbeat(apolloId, 'u-ann', 20_000)
		expect(
			channel.present(apolloId, 20_000).present.map((p) => p.identity),
		).toEqual(['u-ann', 'u-bob'])
	})

	it('caps the list and reports a count instead of the rest', () => {
		// "and 40 more" is a count; a list of 40 more identities is a directory
		// export with a live feed attached.
		const channel = new LiveChannel(VIEWERS, 'id')
		for (const n of [1, 2, 3, 4, 5])
			channel.heartbeat(apolloId, `u-${n}`, n * 10)
		const { present, truncated } = channel.present(apolloId, 100)
		expect(present).toHaveLength(VIEWERS.maxPresent ?? 0)
		expect(truncated).toBe(true)
	})

	it('is scoped to one row — presence on another row is a different room', () => {
		const channel = new LiveChannel(VIEWERS, 'id')
		channel.heartbeat(apolloId, 'u-ann', 0)
		expect(channel.present(geminiId, 0).present).toEqual([])
	})

	it('drops an identity that left cleanly', () => {
		const channel = new LiveChannel(VIEWERS, 'id')
		channel.heartbeat(apolloId, 'u-ann', 0)
		channel.leave(apolloId, 'u-ann')
		expect(channel.present(apolloId, 0).present).toEqual([])
	})

	it('never pushes rows — a presence channel publishes nothing at all', async () => {
		const channel = new LiveChannel(VIEWERS, 'id')
		const sub = recorder('c1', ctxFor(null), { rowId: apolloId })
		channel.subscribe(sub)
		await channel.publish({ id: apolloId }, 0)
		expect(sub.sent).toEqual([])
	})
})

// ===========================================================================
// 6. The polling fallback — the same rows, through the same op.
// ===========================================================================

describe('the polling fallback cannot disagree with the push path', () => {
	it('returns exactly the rows and columns the push path would have sent', async () => {
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		await channel.publish({ id: apolloId }, 0)
		const pushed = sub.sent.at(-1)
		if (pushed?.type !== 'row') throw new Error('expected a row message')

		const polled = await pollLive(BOARD, sub, 'id')
		const same = polled.find((r) => r.id === apolloId)
		expect(same).toEqual(pushed.row)
	})

	it('applies the same bound, so a poll cannot see what a push would not have sent', async () => {
		const sub = recorder('c1', ctxFor(null))
		const polled = await pollLive(BOARD, sub, 'id')
		expect(polled.every((r) => r.id !== geminiId)).toBe(true)
		// Non-vacuous: the row exists and an ungated list returns it.
		const all = await opList(ctxFor(null), 'task', { limit: 50 })
		expect(all.some((r) => r.id === geminiId)).toBe(true)
	})

	it('applies the same portal projection, so falling back never widens the wire', async () => {
		const identity = portalIdentity(PORTAL, { clientId: '203.0.113.9' })
		const sub = recorder('c-portal', ctxFor(identity))
		const polled = await pollLive(BOARD, sub, 'id')
		expect(polled.length).toBeGreaterThan(0)
		for (const row of polled)
			expect(Object.keys(row).sort()).toEqual(['id', 'title'])
	})
})

// ===========================================================================
// 7. Closing.
// ===========================================================================

describe('closing a channel always states a reason', () => {
	it('closes every open connection and forgets them', () => {
		const channel = new LiveChannel(BOARD, 'id')
		const a = recorder('c1', ctxFor(null))
		const b = recorder('c2', ctxFor(null))
		channel.subscribe(a)
		channel.subscribe(b)
		channel.close('paused')
		expect(a.closed).toEqual(['paused'])
		expect(b.closed).toEqual(['paused'])
		expect(channel.size).toBe(0)
	})

	it('unsubscribing a connection the transport already dropped is idempotent', () => {
		const channel = new LiveChannel(BOARD, 'id')
		channel.subscribe(recorder('c1', ctxFor(null)))
		channel.unsubscribe('c1')
		channel.unsubscribe('c1')
		expect(channel.size).toBe(0)
	})
})

// ===========================================================================
// 8. The write path feeds the channel — end to end.
//
// Everything above proves the channel is correct once something publishes to
// it. This block proves something does: `OpContext.live` is called by the
// mutation ops after they commit, exactly as `OpContext.audit` is, and the host
// routes that call into the open channels. Without these tests the whole layer
// is a bounded, gated channel nobody feeds — a stated capability the runtime
// does not have.
// ===========================================================================

describe('a committed write reaches the channel', () => {
	/**
	 * The host's publisher, as `apps/web/app/sprout.server.ts` wires it: route a
	 * resource+id to whatever `query` channels are open over that resource. It is
	 * deliberately the same shape — a plain function on the context — because the
	 * thing being tested is the seam, not a test double's cleverness.
	 */
	function publisherFor(...channels: LiveChannel[]) {
		return async (resource: string, id: string) => {
			for (const channel of channels)
				if (channel.plan.resource === resource && channel.plan.kind === 'query')
					await channel.publish({ id }, 0)
		}
	}

	it('pushes the row an opUpdate just committed, projected and gated', async () => {
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		const writer: OpContext = { ...ctxFor(null), live: publisherFor(channel) }

		await opUpdate(writer, 'task', apolloId, { title: 'Renamed by Ann' })

		const message = sub.sent.at(-1)
		if (message?.type !== 'row') throw new Error('expected a row message')
		expect(message.id).toBe(apolloId)
		// The new value, so this is genuinely the post-commit row and not a stale
		// one the channel happened to be holding.
		expect(message.row.title).toBe('Renamed by Ann')
		// The projection is applied on the way out, not by the writer.
		expect(Object.keys(message.row).sort()).toEqual(['id', 'status', 'title'])
	})

	it('pushes the row an opCreate just committed', async () => {
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		const writer: OpContext = { ...ctxFor(null), live: publisherFor(channel) }

		const created = await opCreate(writer, 'task', {
			title: 'Created live',
			status: 'todo',
			project: 'apollo',
			internalNotes: 'NOT ON THE WIRE',
		})

		const message = sub.sent.at(-1)
		if (message?.type !== 'row') throw new Error('expected a row message')
		expect(message.id).toBe(String(created.id))
		expect(message.row.title).toBe('Created live')
		expect(Object.keys(message.row)).not.toContain('internalNotes')
	})

	it('pushes a REMOVAL when a row is deleted, never a row', async () => {
		// The spec layer promises "a soft-deleted row pushes a removal, never a
		// row", and this is where that promise is kept: the write site announces
		// the id and nothing else, and the read path decides what it means.
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		const writer: OpContext = { ...ctxFor(null), live: publisherFor(channel) }

		const doomed = await opCreate(writer, 'task', {
			title: 'Going away',
			status: 'todo',
			project: 'apollo',
		})
		const id = String(doomed.id)
		expect(sub.sent.at(-1)?.type).toBe('row')

		await opDelete(writer, 'task', id)
		expect(sub.sent.at(-1)).toEqual({ type: 'remove', id })
	})

	it('pushes nothing at all for a write to a resource nobody is following', async () => {
		// The publisher is keyed on the resource, so a busy table with no channel
		// over it costs a map lookup and nothing else.
		const channel = new LiveChannel({ ...BOARD, resource: 'other' }, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		const writer: OpContext = { ...ctxFor(null), live: publisherFor(channel) }

		await opUpdate(writer, 'task', apolloId, { title: 'Nobody is watching' })
		expect(sub.sent).toEqual([])
	})

	it('writes exactly as it did before when no publisher is wired', async () => {
		// `OpContext.live` is optional and the absence must be inert: a host that
		// wires none behaves exactly as it did before this layer existed.
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		const updated = await opUpdate(ctxFor(null), 'task', apolloId, {
			title: 'Unpublished',
		})
		expect(updated.title).toBe('Unpublished')
		expect(sub.sent).toEqual([])
	})

	it('commits the write even when the fan-out throws', async () => {
		// A broken socket, or a subscriber whose gate now throws, must never fail a
		// write that already committed — `publish()` swallows, exactly as
		// `record()` does for the audit sink.
		const writer: OpContext = {
			...ctxFor(null),
			live: () => {
				throw new Error('the subscriber went away mid-fan-out')
			},
		}
		const updated = await opUpdate(writer, 'task', apolloId, {
			title: 'Committed anyway',
		})
		expect(updated.title).toBe('Committed anyway')
		const rows = await opList(ctxFor(null), 'task', {
			filter: { id: apolloId },
			limit: 1,
		})
		expect(rows[0]?.title).toBe('Committed anyway')
	})

	it('announces AFTER the commit, so a refused write pushes nothing', async () => {
		// A channel must not announce a row that a validation error prevented from
		// existing.
		const channel = new LiveChannel(BOARD, 'id')
		const sub = recorder('c1', ctxFor(null))
		channel.subscribe(sub)
		const writer: OpContext = { ...ctxFor(null), live: publisherFor(channel) }
		await expect(
			opUpdate(writer, 'task', 'not-a-real-id', { title: 'x' }),
		).rejects.toThrow()
		expect(sub.sent).toEqual([])
	})
})

// ===========================================================================
// The declaration that cannot work, refused where it is made
// ===========================================================================

describe('liveDeclarationRefusal', () => {
	const queryPlan = {
		key: 'board',
		kind: 'query' as const,
		resource: 'task',
		scope: { kind: 'all' as const },
	}

	it('refuses a query channel over an owner-read resource, with the alternative', () => {
		// The behaviour it describes is correct and stays: a row-less `owner` rule
		// evaluates to denied, exactly as `opList` does, so the per-message gate
		// disconnects. What changes is that you learn it at declaration time rather
		// than by watching subscribers drop.
		const refusal = liveDeclarationRefusal(queryPlan, { read: 'owner' })
		expect(refusal).toBeTruthy()
		expect(refusal).toMatch(/disconnected on the first message/)
		// A refusal that does not say what to do instead is a wall.
		expect(refusal).toMatch(/filtered/)
	})

	it('allows the same channel on any read rule a row-less check can pass', () => {
		for (const read of ['public', 'authenticated', 'admin', undefined]) {
			expect(liveDeclarationRefusal(queryPlan, { read })).toBeNull()
		}
	})

	it('leaves presence alone', () => {
		// Presence carries no rows, so there is nothing for an owner rule to deny.
		expect(
			liveDeclarationRefusal(
				{ ...queryPlan, kind: 'presence' },
				{ read: 'owner' },
			),
		).toBeNull()
	})

	it('says nothing about a resource with no declared access', () => {
		expect(liveDeclarationRefusal(queryPlan, undefined)).toBeNull()
	})
})
