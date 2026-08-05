/**
 * Live subscriptions and bounded presence — the `live` layer.
 *
 * Two corpus asks fix the shape: taskly's *"a real-time collaborative board with
 * presence cursors"* and bookclub's *"a threaded, live-typing discussion
 * thread"*. Both were frozen as `eject`, and both were reaching for the same
 * missing idea — every surface this platform derives is a *snapshot*, and a
 * product where two people work at once needs the snapshot to move.
 *
 * ## The scope line, and why it is a line rather than a roadmap
 *
 * **We push changes and we report presence. That is the whole of it.**
 *
 * Real-time collaborative editing is a multi-year product on its own. Operational
 * transforms and CRDTs are not a feature you add to a layer like this; they are a
 * replication model that reaches into every write path, every conflict, every
 * offline resume and every schema migration. Adopting one would consume this
 * program, which is why issue #179's own gating names scope discipline as the
 * entire risk of the work.
 *
 * So conflict resolution beyond **last-write-wins** is out — and out as a
 * *recorded decision* (`d-live-last-write-wins` in `packages/spec/src/maxstack.prd.ts`,
 * the `d-live-last-write-wins` entry in the ledger)
 * rather than as an assumption somebody later "fixes." An assumption gets fixed
 * by whoever finds it inconvenient; a decision record has to be argued down.
 *
 * Concretely out, and each is out because it is a different problem rather than
 * a bigger version of this one:
 *
 *  - **Cursor-level co-editing.** A cursor position is a per-pointer, per-frame
 *    ephemeral channel with its own rate class. {@link LiveSubscriptionSpec}
 *    carries no free-form payload precisely so this cannot grow here by
 *    accretion — see {@link LiveKind}.
 *  - **Intention-preserving concurrent edits.** Two people editing one string is
 *    OT or a CRDT. What ships writes the whole value, last write wins, and says
 *    so.
 *  - **Offline replication and convergent merge.** A subscriber that reconnects
 *    re-reads; it does not replay a divergent local log.
 *
 * ## Where the pushes are enforced
 *
 * Nothing in this layer is enforced by the route that holds the stream open.
 * Issue #186's finding stands and is sharper here than anywhere: `/mcp` and the
 * admin loaders reach the data layer without passing a route-level gate, so a
 * "the stream only sends these columns" design would be a copy of the rule that
 * three of four callers skip. Enforcement lives in `permissions.ts` and in the
 * read ops, and a live message is **authorized per message** rather than at
 * connect time — see `packages/maxstack-core/src/sprout/live.ts`.
 *
 * ## The four refusals this layer is built out of
 *
 * 1. **A subscription is never unbounded by omission.** {@link LiveSubscriptionSpec.scope}
 *    is required, and even the deliberate `all` spelling must carry a
 *    subscriber ceiling at or below {@link MAX_UNBOUNDED_SUBSCRIBERS}. "Follow
 *    this whole table" is a legitimate ops dashboard and a disaster on a
 *    customer-facing list; the bound is where an author says which one they
 *    meant.
 * 2. **Load is declared, never defaulted.** {@link LiveSubscriptionSpec.maxSubscribers}
 *    and {@link LiveSubscriptionSpec.maxMessagesPerMinute} are required, on the
 *    argument `SearchIndexSpec.indexed` and `ImporterSpec.maxRows` already make:
 *    how much load a declaration puts on somebody's deployment is a decision
 *    about *their* deployment, and a default is that decision made by whoever
 *    wrote the generator.
 * 3. **A push is a read, so the projection is opt-in.** {@link LiveSubscriptionSpec.fields}
 *    is an allowlist with no "all" and no "all except" — a portal's argument
 * applied to the wire: an exclusion list silently pushes every column
 *    added after it was written.
 * 4. **Presence reports identities and nothing else.** No row data, no cursor,
 *    no free-form payload. A payload field is where a cursor protocol grows, and
 *    the cheapest way to not ship one is to have nowhere to put it.
 *
 * ## What a live subscription deliberately is not
 *
 * **Not a message bus.** There is no publish op, no custom event, no topic a
 * caller names. A message exists because a *row changed*, which is why every
 * message can be authorized as a read of that row.
 *
 * **Not a second read model.** The polling fallback and the push path both go
 * through `opList`, structurally (`packages/maxstack-core/src/sprout/live.ts`),
 * so they cannot disagree about what a subscriber may see.
 *
 * **Multi-instance since issue #228.** The subscriber table is per process — a
 * subscriber is a socket that process holds — but the *announcement* travels
 * over a shared coordinator (Postgres `LISTEN`/`NOTIFY`), so every instance
 * fans a change out to its own subscribers. See {@link LiveSpec} for the one
 * bound that remains.
 */

import type { EntityId, FieldId, ISODate, LiveId } from './ids.ts'
import type { Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

// ===========================================================================
// The declaration
// ===========================================================================

/**
 * What a channel carries.
 *
 * - `query` — **rows.** A change to a row inside the declared bound is pushed to
 *   every subscriber that may read it, carrying the declared columns. This is
 *   what makes a derived list, board or calendar update without a refresh.
 * - `presence` — **identities.** Who is currently looking at one record, and
 *   nothing else about them.
 *
 * There is deliberately no third kind, and in particular no `event` or `custom`
 * kind that would let a caller push a payload it composed. Every message on a
 * `query` channel exists because a row changed, which is exactly what makes it
 * authorizable as a read of that row; a caller-composed payload has no row to
 * check and would need an access model of its own. That second access model is
 * how a live layer becomes a message bus, and a message bus is where cursor
 * protocols, typing indicators and "just one more field" arrive.
 */
export type LiveKind = 'query' | 'presence'

/** Runtime guard for {@link LiveKind} — ops arrive as JSON. */
export const LIVE_KINDS = [
	'query',
	'presence',
] as const satisfies readonly LiveKind[]

/**
 * Which rows a subscriber may follow. **Required, and never unbounded by
 * omission** — a subscription with no bound is a broadcast of the whole table,
 * which is the storm issue #179's gating names.
 *
 * - `row` — the one row a subscriber names. The only legal scope for
 *   `presence`, because "who is viewing *this record*" is the bounded primitive
 *   the issue asks for; anything wider is a live directory of everyone in the
 *   app, which nobody asked for and which leaks who is working on what.
 * - `filtered` — the rows sharing one column value with the subscriber's own
 *   (a project's tasks, a thread's posts). The common shape, and the one that
 *   scales, because the fan-out set is a fraction of the table.
 * - `all` — every row. Legitimate for a small internal ops dashboard and a
 *   disaster for a customer-facing list, which is why it is *allowed* but
 *   capped: see {@link MAX_UNBOUNDED_SUBSCRIBERS}.
 */
export type LiveScope =
	| { kind: 'row' }
	| { kind: 'filtered'; fieldId: FieldId }
	| { kind: 'all' }

/** Runtime guard for a scope's discriminant. */
export const LIVE_SCOPE_KINDS = ['row', 'filtered', 'all'] as const

/**
 * A declared live channel.
 *
 * **At most one `query` and one `presence` subscription per entity.** This is
 * `search.declare`'s cardinality argument, and it is the same argument: every
 * write to the table pays for every declared channel over it, so two answers to
 * "what does following this table mean" are two costs on every insert, forever,
 * with nothing to say which one a surface should use. A portal and a document
 * can be several per entity because they are *audiences* — an audience is chosen
 * by the reader. A subscription is a write-path cost chosen by nobody.
 */
export interface LiveSubscriptionSpec extends Provenanced {
	id: LiveId
	/**
	 * The channel name in logs, metrics, the SSE URL (`/api/live/<key>`) and the
	 * generated slot module. Separate from {@link id} for a source's or an
	 * importer's reason: it is what a person types and an incident report quotes.
	 */
	key: string
	/**
	 * What this channel is for, in one line. It is what the workbench and
	 * `maxstack validate` print beside the limits — a channel nobody can explain
	 * is a channel nobody can decide to pause at 3am.
	 */
	description: string
	entityId: EntityId
	kind: LiveKind
	/**
	 * `query`: which columns a change notification carries. Opt-in, like a
	 * portal's projection and for the same reason — a push is a read, and a read
	 * that says "all columns" exposes every column added later.
	 *
	 * `presence`: **must be empty.** Presence reports identities, never row data.
	 */
	fields: FieldId[]
	/**
	 * The bound on which rows a subscriber may follow. Required, never unbounded:
	 * a subscription with no bound is a broadcast of the whole table, which is
	 * the storm this issue's gating names.
	 */
	scope: LiveScope
	/**
	 * Max concurrent subscribers on this channel. **Required, never defaulted.**
	 *
	 * The connection over the cap is refused with a stated status rather than
	 * queued: a queue for connections is a slower way to run out of file
	 * descriptors. Bounded by {@link MAX_LIVE_SUBSCRIBERS}, and by the much
	 * tighter {@link MAX_UNBOUNDED_SUBSCRIBERS} when the scope is `all`.
	 */
	maxSubscribers: number
	/**
	 * Max messages per subscriber per minute before the server sheds. **Required,
	 * never defaulted.**
	 *
	 * A subscriber over the rate is *disconnected with a reason*, not buffered.
	 * An unbounded buffer is how one slow client takes the process down, and a
	 * bounded buffer that silently drops is a subscriber whose view is wrong in a
	 * way nothing tells it about. Disconnect is the only honest option: the
	 * client reconnects and re-reads, which is a correct view rather than a stale
	 * one. Bounded by {@link MAX_LIVE_MESSAGE_RATE}.
	 */
	maxMessagesPerMinute: number
	/**
	 * `presence` only: how long an entry lives without a heartbeat, in seconds.
	 * Required iff `kind === 'presence'`, refused otherwise.
	 *
	 * There is no non-expiring presence entry and no default that would produce
	 * one. A browser tab that crashed sends no goodbye, and the only thing that
	 * removes it is a TTL somebody chose. 1..{@link MAX_PRESENCE_TTL_SECONDS}.
	 */
	presenceTtlSeconds?: number
	/**
	 * `presence` only: hard cap on entries reported for one row. Required iff
	 * `kind === 'presence'`, refused otherwise.
	 *
	 * A cap rather than a page: "212 people are viewing this" is a count, and a
	 * list of 212 identities is a directory export with a live feed attached.
	 * 1..{@link MAX_PRESENT}.
	 */
	maxPresent?: number
	/**
	 * Opens a user-owned slot for bespoke live UI over this channel.
	 *
	 * `false` is the honest common case and emits **nothing**: a derived list,
	 * board or calendar over an entity with a `query` subscription simply
	 * updates, and the declaration is the whole implementation. `true` says the
	 * surface is genuinely bespoke — a drag-and-drop board, a threaded reader —
	 * and the platform's job is to say where that code goes and never overwrite
	 * it.
	 */
	slot: boolean
	/**
	 * Whether the channel accepts connections. **Required, never defaulted** —
	 * the posture `SourceSpec.paused`, `ImporterSpec.paused` and
	 * `PortalSpec.paused` take.
	 *
	 * This is the 3am lever, and it is safe to pull *because* of the polling
	 * fallback: a paused channel refuses the stream, every subscriber falls back
	 * to an interval poll of the same list op, and the app is slower rather than
	 * broken. Shedding a channel without losing the declaration is the whole
	 * point of `live.pause` existing separately from `live.remove`.
	 */
	paused: boolean
	/** The day the channel was declared, stamped by `applyOp` from `appliedAt`. */
	declaredAt: ISODate
}

/**
 * The live layer.
 *
 * **Fan-out crosses instances, and the bound that remains is
 * delivery rather than reach.** Announcements travel over Postgres
 * `LISTEN`/`NOTIFY` — the database is already the thing every instance shares —
 * so a subscriber on one instance sees a write handled by another. What a
 * `NOTIFY` does not do is replay: an instance whose listener connection drops
 * misses whatever was announced while it was down, and its subscribers are
 * stale until they poll. That is the line at which a broker with an offset
 * would start being worth its deployment cost, and it is why every live surface
 * keeps a polling fallback.
 *
 * The abstraction was deliberately refused until #228, and that refusal is not
 * disowned: a broker-shaped interface nobody has run against a real broker is
 * worse than a written-down bound. What changed is that issue #227's rate
 * limiter turned out to need the *same* shared store, and one seam with two
 * callers is a shape somebody has actually run. See `docs/live.md`.
 */
export interface LiveSpec {
	subscriptions: LiveSubscriptionSpec[]
}

// ===========================================================================
// Shapes and bounds
// ===========================================================================

/** A channel key: the same shape as a portal's or an importer's, for the same reasons. */
export const LIVE_KEY_RE = /^[a-z][a-z0-9-]*$/

/**
 * How long a channel key may be. It is a URL segment (`/api/live/<key>`), a
 * metric label and a generated module name; 48 matches the portal, importer and
 * search-index bounds.
 */
export const MAX_LIVE_KEY_LENGTH = 48

/**
 * How many columns one `query` message may carry.
 *
 * A bound rather than a limit anybody meets. Past this a push stops being a
 * notification and becomes a row dump on every write, and the per-message
 * authorization below has to project a payload nobody reads. Thirty-two matches
 * `MAX_PORTAL_FIELDS`, which is the same decision about the same kind of list.
 */
export const MAX_LIVE_FIELDS = 32

/**
 * The most concurrent subscribers any one channel may declare.
 *
 * Ten thousand long-lived connections is already past what a single Node
 * process serves comfortably, and the point of the number is not to be the
 * operating limit — it is to make an author who writes `1_000_000` stop and
 * notice that they have described a deployment nobody has.
 */
export const MAX_LIVE_SUBSCRIBERS = 10_000

/**
 * The most concurrent subscribers a **`scope: 'all'`** channel may declare.
 *
 * The number is arguable and the argument is the point, so here it is. An
 * unfiltered channel fans every write out to every subscriber: cost is
 * `writes × subscribers`, with no term that shrinks as the product grows. At 100
 * subscribers a table taking 10 writes/second costs 1,000 messages/second, which
 * one process serves. At 10,000 subscribers the same table costs 100,000
 * messages/second, which it does not — and the failure is not gradual, because
 * the send buffer for every subscriber fills at once.
 *
 * A hundred is chosen as *the size of a team, not the size of a customer base*.
 * An internal ops dashboard, a support console, an on-call board — those are the
 * honest `all` cases and they are all bounded by headcount. Anything
 * customer-facing is bounded by signups, which is unbounded, and needs
 * `filtered`. So the cap is not really a performance number: it is the line
 * between "everyone who can see this is on the team" and "everyone who can see
 * this signed up", and declaring more than 100 on an unfiltered channel is the
 * clearest possible signal that the author meant the second one and reached for
 * the first one's spelling.
 */
export const MAX_UNBOUNDED_SUBSCRIBERS = 100

/**
 * The most messages per subscriber per minute a channel may declare.
 *
 * Ten a second is a busy board with several people moving cards. Past that a
 * human cannot read the surface anyway, so the extra messages buy nothing and
 * cost a shed connection; the honest shape for a firehose is a poll of an
 * aggregate, not a push of every row.
 */
export const MAX_LIVE_MESSAGE_RATE = 600

/** The longest a presence entry may live without a heartbeat — five minutes. */
export const MAX_PRESENCE_TTL_SECONDS = 300

/**
 * The most presence entries a channel may report for one row.
 *
 * Beyond this the honest UI is a count, not a list of faces, and a list of a
 * hundred identities pushed on every join is a directory export on a timer.
 */
export const MAX_PRESENT = 100

/**
 * The field types a `query` channel may push.
 *
 * `file` is excluded, and it is the same exclusion `portals.ts` makes for the
 * same mechanical reason: a file column holds a **storage key**, which is an
 * object path rather than a value. Putting one on a push hands out a URL into
 * the bucket to everybody holding the channel open, and it does so on every
 * write rather than on a request somebody made. Serving a live surface's images
 * is a real capability and it is not this one.
 *
 * Everything else is allowed, including `json`, which pushes whole — there is no
 * traversal, so a subscriber gets the entire document or nothing.
 */
export const pushableFieldTypes: readonly string[] = [
	'string',
	'number',
	'boolean',
	'date',
	'enum',
	'json',
]

/** The column a `filtered` scope may bind. A bound has to be an equality
 * somebody can read: a date bound matches a microsecond and a json bound matches
 * a serialization, exactly as `portalFilterFieldTypes` argues. */
export const liveScopeFieldTypes: readonly string[] = [
	'string',
	'number',
	'boolean',
	'enum',
]

// ===========================================================================
// Reading the layer
// ===========================================================================

/** Every declared subscription, or `[]` for a spec that has never declared one. */
export function listLiveSubscriptions(
	spec: Pick<SpecSystem, 'live'>,
): LiveSubscriptionSpec[] {
	return spec.live?.subscriptions ?? []
}

/**
 * The channels a runtime will actually answer on: accepted-else-all, minus the
 * paused ones.
 *
 * `getAcceptedOrAll`'s convention rather than `activePortals`' accepted-only
 * departure, and the asymmetry is deliberate in both directions. A portal is
 * accepted-only because the worst case of the fallback is *a public surface
 * nobody reviewed*. A live subscription reaches nobody a read op would not
 * already reach: every message is authorized per message against the
 * subscriber's own identity, so the worst case of an unreviewed suggestion is a
 * surface that updates by itself for people who could already see it. That is a
 * performance decision, not an exposure one, and `maxSubscribers` /
 * `maxMessagesPerMinute` are already required rather than defaulted precisely so
 * the performance decision cannot be made by omission either.
 */
export function activeLiveSubscriptions(
	spec: Pick<SpecSystem, 'live'>,
): LiveSubscriptionSpec[] {
	const all = listLiveSubscriptions(spec)
	const accepted = all.filter((s) => s.provenance.isAccepted === true)
	const base = accepted.length > 0 ? accepted : all
	return base.filter((s) => !s.paused)
}

/**
 * The declared subscription of one kind over one entity, if any.
 *
 * Returns *the* subscription rather than a list, and that is the cardinality
 * rule made visible in the reader's type: one `query` and one `presence` per
 * entity, enforced by the validator. A caller that wants "the live query for
 * this table" should not have to decide what to do with two answers.
 */
export function findLiveSubscription(
	spec: Pick<SpecSystem, 'live'>,
	entityId: EntityId,
	kind: LiveKind,
): LiveSubscriptionSpec | undefined {
	return listLiveSubscriptions(spec).find(
		(s) => s.entityId === entityId && s.kind === kind,
	)
}

/** The declared subscription with this key, if any. Keys are unique spec-wide. */
export function findLiveSubscriptionByKey(
	spec: Pick<SpecSystem, 'live'>,
	key: string,
): LiveSubscriptionSpec | undefined {
	return listLiveSubscriptions(spec).find((s) => s.key === key)
}

/**
 * One line of prose for a channel — the diff summary, the admin caption, the
 * workbench row.
 *
 * It always names the **bound** and the **limits**, because those are the two
 * facts that decide whether this declaration is a nice live board or an outage,
 * and the two nobody reconstructs from an id.
 */
export function describeLiveSubscription(sub: LiveSubscriptionSpec): string {
	const bound =
		sub.scope.kind === 'filtered'
			? `rows matching ${sub.scope.fieldId}`
			: sub.scope.kind === 'row'
				? 'one row'
				: 'every row'
	const shape =
		sub.kind === 'presence'
			? `presence (≤${sub.maxPresent ?? '?'} shown, ${sub.presenceTtlSeconds ?? '?'}s TTL)`
			: `${sub.fields.length} field(s)`
	const slot = sub.slot ? ', bespoke slot' : ''
	const paused = sub.paused ? ', paused' : ''
	return `${sub.kind} over ${sub.entityId} — ${bound}, ${shape}, ≤${sub.maxSubscribers} subscribers at ≤${sub.maxMessagesPerMinute}/min${slot}${paused}`
}

// ===========================================================================
// The load report — the review artifact
// ===========================================================================

/**
 * One channel's declared cost, flattened for review.
 *
 * The question a reviewer is actually asking before approving a `live.declare`
 * is "**what does this do to the app under load?**", and that question is
 * answered by a flat table of ceilings, not by reading a nested declaration.
 */
export interface LiveLoadRow {
	key: string
	entityId: EntityId
	kind: LiveKind
	/** `row` | `filtered:<fieldId>` | `all`. */
	bound: string
	maxSubscribers: number
	maxMessagesPerMinute: number
	/** The worst case this channel can put on one process: subscribers × rate. */
	peakMessagesPerMinute: number
	paused: boolean
}

/**
 * Every declared channel's ceiling, sorted by key.
 *
 * `peakMessagesPerMinute` is the product rather than either factor, because
 * neither factor alone is the number that hurts. A thousand subscribers at one
 * message a minute is fine; ten subscribers at six hundred is fine; the product
 * is what the process has to serialize and send. Stating it here means a
 * reviewer sees the multiplication rather than performing it, which is the
 * difference between catching a bad declaration and approving one.
 *
 * Paused channels are included and marked, on `portalExposureReport`'s rule: a
 * paused channel is one op away from live, and a report that hid it would answer
 * "what could this cost" with "what it costs today".
 */
export function liveLoadReport(spec: Pick<SpecSystem, 'live'>): LiveLoadRow[] {
	return listLiveSubscriptions(spec)
		.map((sub) => ({
			key: sub.key,
			entityId: sub.entityId,
			kind: sub.kind,
			bound:
				sub.scope.kind === 'filtered'
					? `filtered:${sub.scope.fieldId}`
					: sub.scope.kind,
			maxSubscribers: sub.maxSubscribers,
			maxMessagesPerMinute: sub.maxMessagesPerMinute,
			peakMessagesPerMinute: sub.maxSubscribers * sub.maxMessagesPerMinute,
			paused: sub.paused,
		}))
		.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * The reviewable paragraph — what the workbench prints above the table.
 *
 * It leads with the **peak**, because that is the number somebody skimming needs
 * to see, and it says "no live channels" in words rather than printing an empty
 * table: an empty load report and a missing one look identical and mean opposite
 * things.
 */
export function summarizeLiveLoad(report: readonly LiveLoadRow[]): string {
	if (report.length === 0)
		return 'No live channels declared — every derived surface is a snapshot, and nothing holds a connection open.'
	const peak = report.reduce((n, r) => n + r.peakMessagesPerMinute, 0)
	const paused = report.filter((r) => r.paused).length
	const entities = new Set(report.map((r) => r.entityId))
	return (
		`${report.length} channel(s) over ${entities.size} entit(y/ies): ` +
		`up to ${peak.toLocaleString('en-US')} messages/minute across all subscribers at the declared ceilings` +
		(paused > 0 ? `, ${paused} paused` : '') +
		// Peak load is per *deployment*, not per container, and has been since
		// #228 — every instance now fans the same change out to its own
		// subscribers. Saying so here rather than only in the docs, because this
		// sentence is what somebody reads when they size the deployment.
		'. Fan-out is shared across instances over Postgres; on pglite there is only ever one instance.'
	)
}
