/**
 * Live channels at the runtime layer — the grounded shape of a
 * declared subscription, and the one object that fans changes out to the people
 * allowed to see them.
 *
 * The spec layer (`@maxstack/spec`'s `live.ts`) owns *what may be declared*.
 * This module owns three things and deliberately nothing else: the projection
 * from field ids to column names, the per-message authorization, and the two
 * bounds (subscriber count, message rate).
 *
 * ## Every message is authorized, not every connection
 *
 * This is the issue's hardest exit criterion and the reason the fan-out is
 * written the way it is. A connection-time check answers "may this person read
 * this table *right now*", and a live connection outlives the answer: somebody
 * gets removed from a project, has their role changed, or has their api key
 * scope narrowed, and a connect-time gate keeps pushing rows to them until they
 * close the tab.
 *
 * So {@link LiveChannel.publish} re-runs the gate for **every subscriber on
 * every change**, in two steps that answer two different questions:
 *
 *  1. **May this identity still read this resource at all?** `canPerformAction`,
 *     row-less — the identical check `opList` makes through `authorize`, so an
 *     api-key scope narrowed mid-session, a portal paused mid-session and a role
 *     revoked mid-session all read as denied here. A subscriber that fails this
 *     is **disconnected**, not merely skipped: leaving a revoked identity holding
 *     an open socket that happens to receive nothing is a permission decision
 *     that depends on nobody changing a row.
 *  2. **May this identity see *this row*, right now?** {@link liveRead}, which
 *     goes through `opList`. A row that is gone, soft-deleted, in another tenant,
 *     outside the portal's bound or no longer owned by this subscriber comes back
 *     empty, and the subscriber gets a `remove` rather than a row. A row that
 *     just *became* visible comes back present, and is pushed — which is the
 *     behaviour a board needs (a card assigned to you appears) and is asserted
 *     directly rather than left to be discovered.
 *
 * ## Both paths go through `opList`, structurally
 *
 * {@link liveRead} is the **only** function here that reaches a row, and it
 * calls `opList`. The push path calls it with the changed row's id; the polling
 * fallback ({@link pollLive}) calls it with none. There is no second query, no
 * store access and no import of the store in this module, so the pushed view and
 * the polled view cannot disagree about what a subscriber may see — they are the
 * same op with a different filter.
 *
 * That matters because the polling fallback is not a degraded mode somebody
 * checks occasionally; it is what every subscriber falls back to when the stream
 * errors or the channel is paused, which is exactly when nobody is watching.
 *
 * One consequence of that inheritance is worth stating rather than discovering:
 * **a resource whose read rule is the `owner` shortcut cannot carry a `query`
 * channel.** A row-less `owner` rule reads as denied, which is already how
 * `opList` and `opSearch` behave, and a live query channel is a list that moves.
 * The subscriber is disconnected on the first message instead of holding a
 * socket that never delivers. Inventing "quietly push the caller's own rows"
 * here would make the push path the one read surface with its own access model,
 * which is how two access models drift apart.
 *
 * ## Backpressure: shed, never buffer
 *
 * A subscriber over its declared rate is **disconnected with a reason**. An
 * unbounded buffer is how one slow client takes the process down; a bounded
 * buffer that silently drops leaves a subscriber whose view is wrong with
 * nothing telling it so. Disconnect is the only honest option, because the
 * client reconnects and re-reads — a correct view rather than a stale one.
 *
 * A connection past `maxSubscribers` is refused with a stated reason rather than
 * queued: a queue for connections is a slower way to run out of file
 * descriptors.
 *
 * ## Nothing here schedules anything
 *
 * There is no timer, no interval and no clock read inside this module. Presence
 * expiry is computed from a `nowMs` the caller passes in. That is partly
 * testability — a live handler holding a real interval open hangs a vitest run —
 * and mostly determinism: a module that schedules is a module whose behaviour
 * depends on when you looked.
 *
 * ## The stated bound
 *
 * Fan-out is **in-process**. One {@link LiveChannel} holds one subscriber list
 * in one container's memory. A multi-instance deploy needs a broker — Postgres
 * `LISTEN`/`NOTIFY` is the obvious upgrade path, since every instance already
 * shares the database — and this module ships neither it nor an abstraction
 * shaped like it, because a broker interface nobody has run against a real
 * broker is worse than a bound that is written down. See `docs/live.md`.
 */

import { type OpContext, opList } from './operations.ts'

// ===========================================================================
// The declaration that cannot work
// ===========================================================================

/**
 * Why a declared channel can never deliver, or `null` when it can.
 *
 * A `query` channel over a resource whose `read` access is the `owner` shortcut
 * disconnects every subscriber on its first message. The cause is inherited and
 * the behaviour is *correct*: a row-less `owner` rule evaluates to denied —
 * already how `opList` and `opSearch` behave — and step 1 of the per-message gate
 * asks exactly that row-less question. Pushing "quietly, just the caller's own
 * rows" would make the push path the one read surface with its own access model,
 * which is #186's finding restated, so inventing an exception would be the wrong
 * fix.
 *
 * What was wrong is *when you find out*. Everything else in this layer refuses at
 * declaration time with a named reason; this one refused at runtime, by
 * disconnecting people. The obvious mental model for "live over an owner-scoped
 * table" is "push me my own rows", and the platform's answer was a socket that
 * closed.
 *
 * Stated here rather than in `@maxstack/spec` because it is not a spec fact: the
 * read rule lives on the registry's `ResourceConfig`, which the spec layer cannot
 * see — the same reason there is no spec-layer tenancy check. This is the first
 * layer that holds both halves, so it is where the refusal belongs.
 *
 * `presence` is unaffected: it carries no rows, so there is nothing for an owner
 * rule to deny.
 */
export function liveDeclarationRefusal(
	plan: Pick<LivePlan, 'key' | 'kind' | 'resource' | 'scope'>,
	access: { read?: unknown } | undefined,
): string | null {
	if (plan.kind !== 'query') return null
	if (access?.read !== 'owner') return null
	return (
		`live channel "${plan.key}" is a query over "${plan.resource}", whose read access is the ` +
		'`owner` shortcut. Every subscriber would be disconnected on the first message: an ' +
		'owner rule with no row to test evaluates to denied, and a query channel is a list, ' +
		'so the per-message gate refuses it the same way `opList` does. ' +
		'If you meant "push each subscriber their own rows", declare the bound explicitly — ' +
		`scope: { kind: 'filtered', fieldId: <the owner column> } — which is a channel the gate ` +
		'can actually satisfy. If you meant a shared feed, the resource needs a read rule that ' +
		'a row-less check can pass.'
	)
}

import {
	canPerformAction,
	createAccessContext,
	type SproutUser,
} from './permissions.ts'
import type { Row } from './store.ts'

// `@maxstack/core` does not depend on `@maxstack/spec` (see `from-spec.ts`), so
// the presentation-free unions the spec layer defines are restated here. They
// are string literals with no behaviour, and the pair is pinned by the grounding
// layer in `apps/web/app/spec-sprout.ts`, which assigns one to the other and
// would not compile if they drifted.
export type LiveKind = 'query' | 'presence'

/** The grounded bound — column names rather than field ids. */
export type LiveScopePlan =
	| { kind: 'row' }
	| { kind: 'filtered'; field: string }
	| { kind: 'all' }

/**
 * A declared live channel with the spec's field ids already resolved to column
 * names.
 *
 * Rides on `ResourceConfig` exactly as `search`, `documents`, `importers` and
 * `portals` do, which is what puts it at the depth `authorize()` runs at.
 */
export interface LivePlan {
	key: string
	description: string
	/** The Sprout resource this channel follows. */
	resource: string
	kind: LiveKind
	/** Column names, in declaration order. Always empty for `presence`. */
	fields: string[]
	scope: LiveScopePlan
	maxSubscribers: number
	maxMessagesPerMinute: number
	/** Present iff `kind === 'presence'`. */
	presenceTtlSeconds?: number
	/** Present iff `kind === 'presence'`. */
	maxPresent?: number
	/** Whether this channel opened a user-owned slot for bespoke live UI. */
	slot: boolean
	paused: boolean
}

/**
 * How long a polling subscriber waits between reads when the stream is
 * unavailable.
 *
 * Five seconds rather than something adaptive, and the reason is the failure
 * mode this constant exists for: the fallback engages when the stream is
 * *broken*, which is usually when the process is already under load. A backoff
 * curve would be one more thing behaving unpredictably at exactly the wrong
 * moment. A fixed, boring interval is a load somebody can multiply by the
 * subscriber count and reason about.
 */
export const LIVE_POLL_INTERVAL_MS = 5_000

// ===========================================================================
// Messages
// ===========================================================================

/**
 * What a subscriber receives.
 *
 * Three shapes and no fourth, and in particular **no shape a caller composes**.
 * A `row` exists because a row changed; a `remove` exists because a row stopped
 * being visible to *this* subscriber; a `presence` message is a list of
 * identities. There is no `event`, no `payload` and no `data` — see
 * `@maxstack/spec`'s `LiveKind` for the argument, which is that a
 * caller-composed message has no row to authorize against.
 */
export type LiveMessage =
	| { type: 'row'; id: string; row: Row }
	| {
			/**
			 * This row is no longer visible to this subscriber — deleted, soft-deleted,
			 * moved out of the bound, moved to another tenant, or reassigned away from
			 * an `owner`-gated reader.
			 *
			 * Deliberately one message rather than five. A subscriber that learns *why*
			 * a row left its view learns something about rows it may not see, which is
			 * the leak `opGet`'s 404-not-403 rule already refuses to make.
			 */
			type: 'remove'
			id: string
	  }
	| { type: 'presence'; present: LivePresenceEntry[]; truncated: boolean }

/**
 * One entry on a presence channel: **an identity and nothing else.**
 *
 * No cursor, no selection, no "currently typing", no free-form payload. The
 * absence is the design — a payload field is where a cursor protocol grows, and
 * issue #179's scope line puts cursor-level co-editing out by recorded decision
 * (`d-live-last-write-wins`). `since` is the millisecond the entry was first
 * seen, which is what a UI needs to order faces and is not a channel for
 * anything else.
 */
export interface LivePresenceEntry {
	identity: string
	since: number
}

/** Why a subscriber was disconnected. Always stated; never a silent close. */
export type LiveCloseReason =
	/** The channel was paused. Fall back to polling. */
	| 'paused'
	/** This subscriber exceeded the declared per-minute rate and was shed. */
	| 'rate-exceeded'
	/** This identity may no longer read this resource. The exit-criterion case. */
	| 'permission-revoked'
	/** The channel was closed wholesale (shutdown, `live.remove`). */
	| 'closed'

/** Why a connection was refused. */
export type LiveRefusal = 'paused' | 'channel-full' | 'scope-required'

// ===========================================================================
// Subscribers
// ===========================================================================

/**
 * One open connection.
 *
 * `ctx` carries the **subscriber's own** identity, which is what makes the
 * per-message gate meaningful: the channel never holds a privileged context and
 * has no way to read a row as anybody but the person it is about to send to.
 *
 * `send` and `close` are supplied by the transport (the SSE route), so this
 * module never touches a socket, a `Response` or a stream. That is what lets the
 * whole fan-out be tested without a server.
 */
export interface LiveSubscriber {
	/** A per-connection id — the transport's, not the user's. */
	id: string
	/** The subscriber's own op context, with their own identity on it. */
	ctx: OpContext
	/** Required for `scope: 'filtered'` — the value this subscriber follows. */
	scopeValue?: string | number | boolean
	/** Required for `scope: 'row'` — the one row this subscriber follows. */
	rowId?: string
	send: (message: LiveMessage) => void
	close: (reason: LiveCloseReason) => void
}

/** The result of trying to open a connection. Refusals always carry a reason. */
export type LiveSubscribeResult =
	| { ok: true }
	| { ok: false; reason: LiveRefusal }

/** Per-subscriber bookkeeping. Never exposed; the channel owns it. */
interface SubscriberState {
	subscriber: LiveSubscriber
	/** Sliding-window send timestamps, newest last. Bounded by the rate itself. */
	sent: number[]
}

// ===========================================================================
// Reading — the one path to a row
// ===========================================================================

/**
 * The **only** way anything in this module reaches a row, for both the push path
 * and the polling fallback.
 *
 * It calls `opList`, so every scope the platform already forces applies without
 * this layer knowing they exist: the resource's own access rule, the api-key
 * narrowing, the portal narrowing and projection, the tenant filter, the
 * soft-delete filter, and the portal's declared bound. A row this returns is a
 * row `GET /api/<resource>` would have returned to the same caller.
 *
 * The channel's own bound is applied *as a filter* rather than as a check after
 * the fact, which matters for the `remove` semantics: a row that moved out of
 * the bound comes back absent, exactly as a row that was deleted does, and the
 * subscriber gets the same message for both. A subscriber must not be able to
 * tell "moved to another project" from "deleted" — that distinction is a fact
 * about rows they may no longer see.
 *
 * The live projection is applied last and **intersects** with whatever `opList`
 * already applied. For a portal identity `projectForPortal` has already dropped
 * every column outside the portal's own allowlist, and this keeps only the keys
 * still present — so the narrower of the two declarations always wins, without
 * either layer having to know about the other.
 */
async function liveRead(
	plan: LivePlan,
	subscriber: LiveSubscriber,
	primaryKey: string,
	opts: { id?: string; limit?: number } = {},
): Promise<Row[]> {
	const filter: Record<string, string | number | boolean> = {}
	if (plan.scope.kind === 'filtered' && subscriber.scopeValue !== undefined)
		filter[plan.scope.field] = subscriber.scopeValue
	if (plan.scope.kind === 'row' && subscriber.rowId !== undefined)
		filter[primaryKey] = subscriber.rowId
	if (opts.id !== undefined) filter[primaryKey] = opts.id
	const rows = await opList(subscriber.ctx, plan.resource, {
		filter,
		limit: opts.limit ?? (opts.id !== undefined ? 1 : 100),
	})
	return rows.map((row) => projectForLive(plan, primaryKey, row))
}

/**
 * Rebuild a row from **only** the channel's declared columns, plus the primary
 * key.
 *
 * The primary key is always included on `projectForPortal`'s argument, sharpened
 * by what a live message is for: a `row` message with no id cannot be reconciled
 * against anything a subscriber already has, so it would not be an update, it
 * would be a mystery.
 *
 * `if (key in row)` rather than an unconditional copy is where the intersection
 * with a portal projection happens. It is one line and it is the whole of the
 * "narrower always wins" property.
 */
export function projectForLive(
	plan: LivePlan,
	primaryKey: string,
	row: Row,
): Row {
	const allowed = new Set([primaryKey, ...plan.fields])
	const out: Row = {}
	for (const key of allowed) if (key in row) out[key] = row[key]
	return out
}

/**
 * The polling fallback: the same rows, through the same op, at an interval.
 *
 * A subscriber calls this when the stream errored or the channel is paused. It
 * shares {@link liveRead} with the push path *by construction* rather than by
 * convention, which is the point — a fallback that used a different query would
 * eventually show different rows than the push path, and it would do so only
 * while the push path was broken, which is the one time nobody is looking.
 *
 * It takes no timer. The caller schedules; this returns one page.
 */
export async function pollLive(
	plan: LivePlan,
	subscriber: LiveSubscriber,
	primaryKey: string,
	opts: { limit?: number } = {},
): Promise<Row[]> {
	return liveRead(plan, subscriber, primaryKey, opts)
}

// ===========================================================================
// The channel
// ===========================================================================

/** What changed. The only thing a publisher may say. */
export interface LiveChange {
	/** The row's primary key value. */
	id: string
}

/**
 * One declared channel's live subscribers, and the fan-out over them.
 *
 * No parameter properties: this package runs under Node's strip-only type
 * stripping (see `operations.ts`).
 */
export class LiveChannel {
	readonly plan: LivePlan
	readonly primaryKey: string
	private readonly subscribers = new Map<string, SubscriberState>()
	/** rowId → identity → LAST-SEEN ms. Only used by `presence` channels. */
	private readonly presence = new Map<string, Map<string, number>>()
	/**
	 * `rowId + ' ' + identity` → FIRST-seen ms, kept beside the last-seen map so a
	 * heartbeat refreshes liveness without changing order. Without it a face
	 * jumps around the list every time somebody's tab wakes up, which reads as
	 * people joining and leaving.
	 */
	private readonly firstSeen = new Map<string, number>()

	constructor(plan: LivePlan, primaryKey: string) {
		this.plan = plan
		this.primaryKey = primaryKey
	}

	/** How many connections this channel currently holds. */
	get size(): number {
		return this.subscribers.size
	}

	/**
	 * Open a connection, or refuse it with a stated reason.
	 *
	 * Refusals are `{ ok: false, reason }` rather than throws so the transport can
	 * answer with a status and a body a client can act on — a client that knows it
	 * was refused for `channel-full` retries later, and one that knows it was
	 * refused for `paused` falls back to polling immediately.
	 *
	 * A `filtered` channel requires a scope value and a `row` channel requires a
	 * row id, both refused rather than defaulted: a subscriber with no bound would
	 * otherwise silently receive the whole table, which is precisely what the
	 * declaration exists to prevent.
	 */
	subscribe(subscriber: LiveSubscriber): LiveSubscribeResult {
		if (this.plan.paused) return { ok: false, reason: 'paused' }
		if (this.subscribers.size >= this.plan.maxSubscribers)
			return { ok: false, reason: 'channel-full' }
		if (
			this.plan.scope.kind === 'filtered' &&
			subscriber.scopeValue === undefined
		)
			return { ok: false, reason: 'scope-required' }
		if (this.plan.scope.kind === 'row' && subscriber.rowId === undefined)
			return { ok: false, reason: 'scope-required' }
		this.subscribers.set(subscriber.id, { subscriber, sent: [] })
		return { ok: true }
	}

	/** Drop a connection the transport already closed. Idempotent. */
	unsubscribe(id: string): void {
		this.subscribers.delete(id)
	}

	/**
	 * Fan one change out, authorizing **per subscriber, per message**.
	 *
	 * The order of the two checks is the design rather than an implementation
	 * detail:
	 *
	 *  1. `canPerformAction(resource, access, 'read', { user })` — row-less, the
	 *     identical check `opList` makes. Failure means the *identity* lost access
	 *     and the connection is closed with `permission-revoked`. This is issue
	 *     #179's exit criterion, and it is checked first so a revoked identity is
	 *     disconnected even when the changed row would have been invisible to them
	 *     anyway.
	 *  2. {@link liveRead} — the row through `opList`, under every forced scope.
	 *     Empty means "not visible to you *now*" and produces a `remove`; present
	 *     means a `row`, including for a row that just became visible.
	 *
	 * A subscriber over its declared rate is shed before either check, because the
	 * cheapest message to authorize is one you are not going to send.
	 */
	async publish(change: LiveChange, nowMs: number): Promise<void> {
		if (this.plan.kind !== 'query') return
		for (const state of [...this.subscribers.values()]) {
			const { subscriber } = state
			if (!this.spend(state, nowMs)) {
				this.drop(subscriber, 'rate-exceeded')
				continue
			}
			const entry = subscriber.ctx.registry.get(this.plan.resource)
			const allowed = entry
				? await canPerformAction(
						this.plan.resource,
						entry.config.access,
						'read',
						createAccessContext(subscriber.ctx.user),
					)
				: false
			if (!allowed) {
				// Disconnected, not merely skipped. A revoked identity holding an open
				// socket that happens to receive nothing is a permission decision that
				// depends on nobody changing a row.
				this.drop(subscriber, 'permission-revoked')
				continue
			}
			let rows: Row[]
			try {
				rows = await liveRead(this.plan, subscriber, this.primaryKey, {
					id: change.id,
				})
			} catch {
				// A throw from the read path is the row-level version of the same
				// answer: this subscriber cannot see this row. It is never a reason to
				// close the connection — a row they may not see is not a fact about
				// their session.
				rows = []
			}
			const row = rows[0]
			subscriber.send(
				row
					? { type: 'row', id: change.id, row }
					: { type: 'remove', id: change.id },
			)
		}
	}

	/**
	 * Record that an identity is present on a row, and return the current list.
	 *
	 * Idempotent per identity: a repeated heartbeat refreshes the entry's
	 * liveness without changing `since`, so a face does not jump around a list
	 * because somebody's tab woke up.
	 *
	 * Takes `nowMs` rather than reading a clock, for the reason at the top of the
	 * file: a module that reads a clock is a module whose output depends on when
	 * you looked, and a presence table that expires on its own schedule is a
	 * timer nothing in a test can drain.
	 */
	heartbeat(rowId: string, identity: string, nowMs: number): void {
		if (this.plan.kind !== 'presence') return
		let onRow = this.presence.get(rowId)
		if (!onRow) {
			onRow = new Map()
			this.presence.set(rowId, onRow)
		}
		this.expire(onRow, nowMs)
		const since = onRow.get(identity)
		// `since` is preserved across heartbeats; the map value is the LAST-SEEN
		// time and `since` rides in the returned entry, so a refresh keeps order
		// stable. Both are the same number on the first beat.
		if (since === undefined) this.firstSeen.set(`${rowId} ${identity}`, nowMs)
		onRow.set(identity, nowMs)
	}

	/** Explicitly drop one identity from a row — a clean tab close. */
	leave(rowId: string, identity: string): void {
		this.presence.get(rowId)?.delete(identity)
		this.firstSeen.delete(`${rowId} ${identity}`)
	}

	/**
	 * Who is present on this row, expired and capped.
	 *
	 * `truncated` is returned beside the list rather than folded into it, because
	 * "and 40 more" is a count and a list of 40 more identities is a directory
	 * export. A UI that wants a number gets one without the channel ever having
	 * sent the names.
	 *
	 * Sorted by `since` so the order is a fact about the room rather than about
	 * `Map` iteration, which would otherwise make two subscribers see two
	 * different orderings of the same set.
	 */
	present(
		rowId: string,
		nowMs: number,
	): { present: LivePresenceEntry[]; truncated: boolean } {
		const onRow = this.presence.get(rowId)
		if (!onRow) return { present: [], truncated: false }
		this.expire(onRow, nowMs)
		const all = [...onRow.keys()]
			.map((identity) => ({
				identity,
				since: this.firstSeen.get(`${rowId} ${identity}`) ?? nowMs,
			}))
			.sort((a, b) => a.since - b.since || a.identity.localeCompare(b.identity))
		const cap = this.plan.maxPresent ?? all.length
		return { present: all.slice(0, cap), truncated: all.length > cap }
	}

	/** Close every connection with a stated reason. Used on shutdown and pause. */
	close(reason: LiveCloseReason = 'closed'): void {
		for (const { subscriber } of [...this.subscribers.values()])
			this.drop(subscriber, reason)
		this.presence.clear()
		this.firstSeen.clear()
	}

	/**
	 * Spend one message from this subscriber's sliding-window budget.
	 *
	 * A sliding window rather than a fixed bucket: a fixed bucket lets a
	 * subscriber send its whole minute's budget in the last second of one window
	 * and again in the first second of the next, which is two minutes' worth of
	 * fan-out in two seconds and is exactly the burst the ceiling exists to stop.
	 */
	private spend(state: SubscriberState, nowMs: number): boolean {
		const cutoff = nowMs - 60_000
		while (state.sent.length > 0 && (state.sent[0] ?? 0) <= cutoff)
			state.sent.shift()
		if (state.sent.length >= this.plan.maxMessagesPerMinute) return false
		state.sent.push(nowMs)
		return true
	}

	/** Close one connection and forget it. The close reason is always stated. */
	private drop(subscriber: LiveSubscriber, reason: LiveCloseReason): void {
		this.subscribers.delete(subscriber.id)
		subscriber.close(reason)
	}

	/** Drop presence entries whose last heartbeat is older than the TTL. */
	private expire(onRow: Map<string, number>, nowMs: number): void {
		const ttl = (this.plan.presenceTtlSeconds ?? 0) * 1000
		if (ttl <= 0) return
		for (const [identity, lastSeen] of [...onRow.entries()])
			if (nowMs - lastSeen > ttl) onRow.delete(identity)
	}
}

/**
 * The identity a presence entry reports.
 *
 * Derived from the user rather than supplied by the client, which is the whole
 * of why presence cannot be spoofed into a directory: a client that could name
 * its own presence identity could name somebody else's, and "who is viewing
 * this" would become "who says they are viewing this".
 *
 * An anonymous or portal identity reports its own opaque id — the same string
 * the audit log carries — rather than being refused. A portal reader appearing
 * as `portal:client-invoice/tok-…` in a presence list is correct: somebody *is*
 * viewing it, and the identity names the credential to revoke rather than a
 * person who does not exist.
 */
export function liveIdentityOf(user: SproutUser | null): string {
	return user?.id ?? 'anonymous'
}
