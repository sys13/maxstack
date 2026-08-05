/**
 * The server half of a declared live channel: find the plan, hold
 * the process's open channels, and turn a request into a subscriber context.
 *
 * **Nothing here decides what may be read.** Not a column list, not a row
 * filter, not an access check. Every one of those lives in the permission layer
 * and in the read ops, and `LiveChannel.publish` re-runs them **per message**,
 * because issue #186's finding was that a route-level gate is a gate `/mcp` and
 * the admin loaders never pass — and a live connection makes that worse, since
 * it outlives the answer a connect-time gate gave.
 *
 * The consequence worth stating, as `portals.server.ts` states it: if this file
 * were deleted, nothing would become *more* exposed. The live route would 404
 * and every other caller would behave exactly as it does today.
 *
 * ## The subscriber table is per process; the announcement is not
 *
 * {@link channels} is still a module-scope map, and it has to be: a subscriber
 * is an open socket held by *this* process, and no other process can write to
 * it. What used to be per-process as well was the **announcement** — a write
 * handled by instance A reached nobody connected to instance B — and that is
 * what moved. {@link publishLiveChange} now hands the change to the
 * `Coordinator`, which is Postgres `LISTEN`/`NOTIFY` when the deployment has a
 * Postgres backend and a direct loop-back when it does not, and each instance
 * fans out over its own subscribers when it hears one.
 *
 * The bound that remains, stated because it is real: a `NOTIFY` is not replayed.
 * An instance whose listener connection drops misses whatever was announced
 * while it was down, and learns nothing about the gap beyond a warning in its
 * own log. That is why every live surface keeps its polling fallback. See
 * `docs/live.md`.
 */

import {
	type CoordinatorMessage,
	LiveChannel,
	liveDeclarationRefusal,
	type OpContext,
} from '@maxstack/core'
import { getCoordinator } from './coordination.server'
import { getAuditSink, getSprout, resolveUser } from './sprout.server'

const liveScope = globalThis as typeof globalThis & {
	__maxstackLiveChannels?: Map<string, LiveChannel>
}

/**
 * The process's open channels, keyed by declared key.
 *
 * Module scope rather than per-request, because subscribers from different
 * requests have to land in the same fan-out set — which is exactly the property
 * that does not survive a second container.
 */
function channels(): Map<string, LiveChannel> {
	liveScope.__maxstackLiveChannels ??= new Map()
	return liveScope.__maxstackLiveChannels
}

/**
 * The open channel for a declared key, creating it on first use.
 *
 * Re-created when the grounded plan changed, so a `live.setLimits` or a
 * `live.pause` takes effect without a restart — and every existing subscriber is
 * closed with a stated reason rather than left on a channel running under a
 * ceiling nobody declared any more. Closing loudly is the point: a client that
 * is told `closed` reconnects and picks up the new plan, where one left dangling
 * would keep receiving at the old rate until it noticed.
 */
export async function liveChannelFor(
	key: string,
): Promise<LiveChannel | undefined> {
	const { registry } = await getSprout()
	const found = registry.findLive(key)
	if (!found) return undefined
	// Before the first subscriber, not after: a channel that opened and then
	// started listening would miss every change announced in between, and the
	// window is exactly the moment a client connects and expects to be current.
	await ensureLiveListener()
	// A declaration that can never deliver is refused here rather than at the
	// first message. It used to open, accept subscribers, and then
	// disconnect every one of them the moment anything changed — so the operator
	// learned about a mis-declared channel from a support ticket about a socket
	// that keeps closing. Thrown, because this is a declaration bug in the
	// project, not a condition the caller can handle: the route turns it into a
	// 500 with the reason, which is a stack trace naming the fix.
	const refusal = liveDeclarationRefusal(found.plan, found.entry.config.access)
	if (refusal) throw new Error(refusal)
	const existing = channels().get(key)
	if (existing && JSON.stringify(existing.plan) === JSON.stringify(found.plan))
		return existing
	existing?.close('closed')
	const channel = new LiveChannel(found.plan, found.entry.resource.primaryKey)
	channels().set(key, channel)
	return channel
}

/**
 * Announce a row change to every open `query` channel over a resource.
 *
 * Exported so a write surface can call it; deliberately **not** called from
 * inside the ops. A push is an observation, and wiring it into `opCreate` would
 * make every write in the process wait on a fan-out — which is how one slow
 * subscriber becomes a slow write, i.e. the exact failure the shed-don't-buffer
 * posture exists to avoid, reintroduced one layer down.
 */
export async function publishLiveChange(
	resource: string,
	id: string,
): Promise<void> {
	const coordinator = await getCoordinator()
	await coordinator.announce({
		topic: LIVE_TOPIC,
		payload: JSON.stringify({ resource, id } satisfies LiveAnnouncement),
	})
}

/** The coordinator topic live changes travel on. One topic for every resource:
 * the resource is *in* the payload, so an instance holds one subscription
 * regardless of how many resources it serves. */
const LIVE_TOPIC = 'live.change'

/** What crosses the wire. An id, never a row — the receiving instance re-reads
 * through `opList` per subscriber, which is the whole per-message authorization
 * design. A row on the wire would be a row read under the *publisher's*
 * identity and handed to whoever the receiver happens to be serving. */
interface LiveAnnouncement {
	resource: string
	id: string
}

/**
 * Fan an announcement out over this process's own subscribers.
 *
 * Separate from `publishLiveChange` and reached only through the coordinator, so
 * there is exactly one path from "a row changed" to "a socket got a frame" —
 * whether the row changed here or on another instance. A local shortcut beside
 * this would be a second path that only runs in single-instance deploys, which
 * is how a fan-out bug becomes reproducible in production and nowhere else.
 */
async function fanOutLocally(message: CoordinatorMessage): Promise<void> {
	if (message.topic !== LIVE_TOPIC) return
	const { resource, id } = JSON.parse(message.payload) as LiveAnnouncement
	const now = Date.now()
	for (const channel of channels().values())
		if (channel.plan.resource === resource && channel.plan.kind === 'query')
			await channel.publish({ id }, now)
}

/**
 * Attach this process's fan-out to the coordinator, once.
 *
 * Called from {@link liveChannelFor} rather than at module load, because the
 * coordinator needs the store backend and reaching for it at import time would
 * make every route that touches this module wait on the database. A deployment
 * that never opens a live channel never opens a listener either.
 */
const liveListenerScope = globalThis as typeof globalThis & {
	__maxstackLiveListener?: Promise<void>
}
function ensureLiveListener(): Promise<void> {
	liveListenerScope.__maxstackLiveListener ??= (async () => {
		const coordinator = await getCoordinator()
		coordinator.listen((message) => {
			// A handler on a driver callback: a rejection here has nowhere to go, and
			// a fan-out failure grants nothing (`OpLivePublisher`'s reasoning), so it
			// is logged rather than thrown.
			void fanOutLocally(message).catch((error) => {
				console.error('[live] fan-out failed for an announced change', error)
			})
		})
	})()
	return liveListenerScope.__maxstackLiveListener
}

/**
 * The declared `query` channel key for a resource, if it has one.
 *
 * This is what makes "declared live queries update derived surfaces" real rather
 * than available: a generated list, board, calendar or timeline asks for it in
 * its loader, and subscribes when the answer is not `undefined`. A resource with
 * no channel gets `undefined` and the surface stays exactly what it was — a
 * snapshot — with no client code running at all.
 *
 * A **paused** channel is deliberately still returned. The surface subscribes,
 * the connection is refused with `paused`, and the client falls back to polling
 * the same op — which is the whole reason pausing is safe to do at 3am. Hiding
 * the key here would make a paused channel indistinguishable from an undeclared
 * one, and the surface would silently stop updating instead of updating slower.
 */
export async function liveQueryKeyFor(
	resource: string,
): Promise<string | undefined> {
	const { registry } = await getSprout()
	return registry.get(resource)?.config.live?.find((l) => l.kind === 'query')
		?.key
}

/**
 * What a host needs in order to render a channel's bespoke surface.
 *
 * The point of returning a shape rather than a boolean: the surface's props are
 * generated *per channel* (`live/<key>.live.tsx`), so the host has to know the
 * channel's kind, its primary key and — for presence — how often to heartbeat,
 * or the component it renders would be handed props that do not match the
 * declaration it was generated from.
 */
export interface LiveSlot {
	key: string
	kind: 'query' | 'presence'
	/** The resource's primary key column, which is what a row's `id` prop is. */
	primaryKey: string
	/** Present iff `kind === 'presence'` — the TTL a heartbeat must beat. */
	presenceTtlSeconds?: number
}

/**
 * The declared channel over `resource` that asked for a bespoke surface, if any
 *.
 *
 * `kind` is a parameter rather than a search because the two kinds compose into
 * *different* surfaces and the caller knows which one it is: a `query` slot
 * replaces a list, a `presence` slot sits beside a record. Asking for the wrong
 * one on the wrong page would render a component against props its declaration
 * never promised.
 *
 * A **paused** channel still returns its slot, on `liveQueryKeyFor`'s reasoning:
 * the surface renders, the connection is refused with a reason, and the rows
 * arrive by poll. Hiding it here would swap a bespoke surface for the generic
 * one the moment somebody paused a channel at 3am, which is the loudest possible
 * way to make pausing unsafe.
 */
export async function liveSlotFor(
	resource: string,
	kind: 'query' | 'presence',
): Promise<LiveSlot | undefined> {
	const { registry } = await getSprout()
	const entry = registry.get(resource)
	const plan = entry?.config.live?.find((l) => l.slot && l.kind === kind)
	if (!plan || !entry) return undefined
	return {
		key: plan.key,
		kind: plan.kind,
		primaryKey: entry.resource.primaryKey,
		...(plan.presenceTtlSeconds !== undefined
			? { presenceTtlSeconds: plan.presenceTtlSeconds }
			: {}),
	}
}

export interface LiveRequest {
	channel: LiveChannel
	/** The caller's OWN context. The channel never holds a privileged one. */
	ctx: OpContext
	scopeValue?: string
	rowId?: string
}

/**
 * Resolve `/api/live/:key` into an open channel plus the caller's own context,
 * or `null`.
 *
 * `null` covers every reason a channel is unreachable — unknown key, never
 * declared, not grounded — and the route answers one 404 for all of them, on
 * `portalRequest`'s reasoning: distinguishing them tells a caller which channel
 * keys exist.
 *
 * The context carries no rate limiter, and that is correct rather than an
 * omission: a live channel performs no writes, and its own ceilings
 * (`maxSubscribers`, `maxMessagesPerMinute`) are enforced inside `LiveChannel`
 * from the declaration.
 */
export async function liveRequest(
	request: Request,
	key: string,
): Promise<LiveRequest | null> {
	const channel = await liveChannelFor(key)
	if (!channel) return null
	const { registry, store } = await getSprout()
	const url = new URL(request.url)
	const scopeValue = url.searchParams.get('scope') ?? undefined
	const rowId = url.searchParams.get('row') ?? undefined
	return {
		channel,
		ctx: {
			registry,
			store,
			user: await resolveUser(request),
			audit: getAuditSink(),
		},
		...(scopeValue !== undefined ? { scopeValue } : {}),
		...(rowId !== undefined ? { rowId } : {}),
	}
}
