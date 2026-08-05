/**
 * Cross-instance coordination — the one shared store behind live fan-out and
 * rate limiting (which absorbed the first half of #227).
 *
 * ## Why the two are one thing
 *
 * They were filed as two bounds and they are the same bound wearing two hats.
 * `LiveChannel` holds its subscriber table in one process's memory, so a write
 * handled by instance A reaches nobody connected to instance B. The token-bucket
 * limiter holds its buckets in one process's memory, so two instances serve a
 * declared `rateLimitPerHour` at *twice* the declared number. Both are "this
 * process believes it is the only one", and both are fixed by the same thing:
 * somewhere every instance can see. Building that twice would have produced two
 * half-tested notions of "shared", so there is one seam here and two callers.
 *
 * ## The seam
 *
 * A {@link Coordinator} does exactly two things — announce something to every
 * instance, and take one token from a bucket every instance shares — and
 * deliberately nothing else. It is not a cache, not a lock service and not a
 * queue; the queue already exists (`JobQueue`) and a lock service is a thing
 * nobody here has needed. Two are shipped:
 *
 *  - {@link createInProcessCoordinator} — the behaviour that exists today,
 *    unchanged, and still the default. Announcements loop straight back to this
 *    process's own handlers and buckets live in a `Map`.
 *  - {@link createPostgresCoordinator} — `LISTEN`/`NOTIFY` for announcements and
 *    one row per bucket for tokens, over the database every instance is already
 *    connected to.
 *
 * ## Postgres, and not a broker
 *
 * #228 named Postgres `LISTEN`/`NOTIFY` as the upgrade path and the reason still
 * holds: every instance already shares the database, so this adds no service to
 * deploy, no credential to rotate and no second thing that can be down. Redis
 * would be a better *broker* and a worse *dependency*, and the traffic here is a
 * few hundred bytes per write.
 *
 * The honest cost, stated because it decides when this stops being the right
 * answer: `NOTIFY` is fire-and-forget with no replay. An instance whose listener
 * connection is down for two seconds misses those two seconds of changes and
 * nothing tells it — the same failure the polling fallback already exists to
 * cover, which is why every live surface keeps one. A broker with an offset
 * would fix that, and this is not that.
 *
 * ## pglite gets the in-process one, and that is not a degradation
 *
 * pglite is embedded and single-writer by construction puts an
 * `O_EXCL` lock on the data dir precisely so a second process *cannot* open it.
 * A second instance is therefore impossible on that backend, so the bound the
 * shared store fixes cannot be reached there, and the in-process coordinator is
 * not a lesser implementation of anything. It is the correct one.
 */

import type { StoreBackend } from './backend.ts'

// ===========================================================================
// Announcements
// ===========================================================================

/**
 * One announcement.
 *
 * `topic` routes it and `payload` is opaque to this module — a string, because
 * whatever crosses `NOTIFY` has to be one and pretending otherwise would put a
 * serialization decision in two places.
 */
export interface CoordinatorMessage {
	topic: string
	payload: string
}

export type CoordinatorHandler = (message: CoordinatorMessage) => void

/**
 * The largest payload {@link Coordinator.announce} will accept.
 *
 * Postgres caps a `NOTIFY` payload at 8000 bytes and **fails the statement**
 * over it. This refuses at 7000 with a message naming the topic, so the
 * transport's limit surfaces as a bug in whatever built the payload rather than
 * as a database error underneath a write that already committed. The in-process
 * coordinator enforces the same ceiling, or a payload that worked in every test
 * would fail on the deployment shape this exists for.
 */
export const COORDINATOR_MAX_PAYLOAD_BYTES = 7000

// ===========================================================================
// Token buckets
// ===========================================================================

/** What one `take` decided. Mirrors `RateLimitResult` in `@maxstack/features`,
 * which is the consumer — core cannot import it (features depends on core). */
export interface TokenVerdict {
	allowed: boolean
	/** Tokens left in the bucket after this call, floored, never negative. */
	remaining: number
	/** Epoch ms at which the bucket is next expected to hold a whole token. */
	resetAt: number
	limit: number
}

/** One bucket's terms, passed per call rather than configured per bucket: the
 * authority for a budget is the declaration, which is re-read every request. */
export interface TokenRequest {
	key: string
	/** Capacity, in tokens. */
	max: number
	/** How long a full refill takes, in ms. */
	windowMs: number
	/** Epoch ms. Passed in so a test can drive the clock, and so both
	 * implementations agree about *when* rather than each asking. */
	now: number
}

export interface Coordinator {
	/** Which shape this is. Surfaced so a host can say so out loud at boot —
	 * "your budgets multiply by instance count" is a fact an operator should be
	 * able to read, not infer from a config file. */
	readonly kind: 'in-process' | 'postgres'
	/** Tell every instance, including this one. Best-effort by contract: the
	 * caller is a committed write, and a failed announcement means somebody's
	 * board is stale until it polls. */
	announce(message: CoordinatorMessage): Promise<void>
	/** Hear every instance, including this one. Returns its own removal. */
	listen(handler: CoordinatorHandler): () => void
	/** Take one token, or refuse. */
	take(request: TokenRequest): Promise<TokenVerdict>
	dispose(): Promise<void>
}

/**
 * Refill, spend and describe one bucket — the arithmetic, with no storage.
 *
 * Both implementations run *this* function or its literal SQL translation, and
 * an agreement test drives the two against the same sequence and demands the
 * same verdicts. Two token buckets that drift apart is how a deployment gets a
 * different budget than its tests measured.
 *
 * A budget that changed since the last call (the key was edited, or a portal's
 * `rateLimitPerHour` was raised) **rescales** the fill level instead of resetting
 * it — half a bucket stays half a bucket — so raising a limit grants headroom
 * without granting amnesty to a caller who already drained one.
 */
export function spendToken(
	bucket: { tokens: number; updatedAt: number; max: number } | undefined,
	request: TokenRequest,
): {
	verdict: TokenVerdict
	next: { tokens: number; updatedAt: number; max: number }
} {
	const { max, windowMs, now } = request
	const refillPerMs = max / windowMs
	const scaled =
		bucket === undefined
			? max
			: bucket.max !== max && bucket.max > 0
				? (bucket.tokens / bucket.max) * max
				: bucket.tokens
	const elapsed = bucket === undefined ? 0 : Math.max(0, now - bucket.updatedAt)
	const refilled = Math.min(max, scaled + elapsed * refillPerMs)
	const allowed = refilled >= 1
	const tokens = allowed ? refilled - 1 : refilled
	return {
		verdict: {
			allowed,
			remaining: Math.max(0, Math.floor(tokens)),
			resetAt: now + Math.ceil((1 - tokens) / refillPerMs),
			limit: max,
		},
		next: { tokens, updatedAt: now, max },
	}
}

// ===========================================================================
// In process
// ===========================================================================

/**
 * The single-instance coordinator: the behaviour that shipped with #177 and
 * #179, unchanged and still the default.
 *
 * An announcement is delivered to this process's own handlers **synchronously**,
 * which is what makes the existing tests deterministic — `await announce()` and
 * the fan-out has happened. The Postgres one cannot promise that (see its own
 * doc comment), and the difference is stated rather than papered over.
 */
export function createInProcessCoordinator(): Coordinator {
	const handlers = new Set<CoordinatorHandler>()
	const buckets = new Map<
		string,
		{ tokens: number; updatedAt: number; max: number }
	>()
	return {
		kind: 'in-process',
		async announce(message) {
			assertPayloadFits(message)
			for (const handler of handlers) handler(message)
		},
		listen(handler) {
			handlers.add(handler)
			return () => {
				handlers.delete(handler)
			}
		},
		async take(request) {
			if (!(request.max >= 1)) return refuseUnbudgeted(request)
			const { verdict, next } = spendToken(buckets.get(request.key), request)
			buckets.set(request.key, next)
			return verdict
		},
		async dispose() {
			handlers.clear()
			buckets.clear()
		},
	}
}

/** A bucket with no capacity is refused without touching any store. `max` is
 * validated by every caller, so reaching this means a declaration said zero —
 * which is a budget of none, not a budget of unlimited. */
function refuseUnbudgeted(request: TokenRequest): TokenVerdict {
	return {
		allowed: false,
		remaining: 0,
		resetAt: request.now + request.windowMs,
		limit: request.max,
	}
}

function assertPayloadFits(message: CoordinatorMessage): void {
	// `TextEncoder` rather than `Buffer`: this module is in the `@maxstack/core`
	// barrel, which route modules import, so it has to hold in a browser bundle
	// even though nothing there ever announces anything.
	const bytes = new TextEncoder().encode(message.payload).length
	if (bytes > COORDINATOR_MAX_PAYLOAD_BYTES)
		throw new Error(
			`coordinator payload for topic "${message.topic}" is ${bytes} bytes, over the ${COORDINATOR_MAX_PAYLOAD_BYTES}-byte limit a Postgres NOTIFY carries — announce an id and let the receiver read the row`,
		)
}

// ===========================================================================
// Postgres
// ===========================================================================

/** The one `LISTEN` channel. One channel with the topic *in* the payload rather
 * than one channel per topic: a channel per topic means a `LISTEN` per topic,
 * issued at whatever moment a caller first subscribed, and a listener that
 * missed its `LISTEN` looks exactly like a topic with no traffic. */
export const COORDINATOR_CHANNEL = 'maxstack_coordination'

/** The bucket table. Additive and idempotent, in the house style — and brand
 * new, so there is no older shape for `CREATE TABLE IF NOT EXISTS` to silently
 * leave in place (the trap `api-keys/schema.ts` documents). Later columns go in
 * as guarded `ADD COLUMN IF NOT EXISTS` lines beneath, not into the `CREATE`. */
export const COORDINATION_DDL = `
CREATE TABLE IF NOT EXISTS maxstack_rate_bucket (
	key text PRIMARY KEY,
	tokens double precision NOT NULL,
	updated_at double precision NOT NULL,
	max_tokens double precision NOT NULL,
	allowed boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS maxstack_rate_bucket_updated_at_idx
	ON maxstack_rate_bucket (updated_at);
`

/**
 * How full the bucket is *before* this call spends from it, as SQL.
 *
 * This is {@link spendToken}'s `refilled`, line for line, and the agreement test
 * `coordination.agreement.test.ts` drives both against one sequence rather than
 * trusting the transcription. `b` is the stored row and `EXCLUDED` is what this
 * call proposed, so `EXCLUDED.max_tokens` is the budget in force *now* and
 * `b.max_tokens` is the one the stored fill level was measured against.
 */
function refillExpr(windowParam: string): string {
	return `LEAST(
		EXCLUDED.max_tokens,
		(CASE WHEN b.max_tokens <> EXCLUDED.max_tokens AND b.max_tokens > 0
			THEN b.tokens / b.max_tokens * EXCLUDED.max_tokens
			ELSE b.tokens END)
		+ GREATEST(0, EXCLUDED.updated_at - b.updated_at)
			* EXCLUDED.max_tokens / ${windowParam}
	)`
}

/**
 * One statement, and that is the whole point.
 *
 * Read-then-write would be two round trips with a race between them, and the
 * race is not theoretical: it is exactly the burst the limiter exists to catch,
 * so the moments it would be wrong are the moments it matters. `INSERT … ON
 * CONFLICT DO UPDATE` takes the row lock for the duration, so concurrent takers
 * on the same bucket serialize and each sees the previous one's spend.
 *
 * `allowed` is a stored column rather than something derived from the returned
 * token count, because it cannot be derived: a bucket that refilled to 1.5 and
 * spent one is left holding 0.5, and so is a bucket that refilled to 0.5 and
 * spent nothing. The verdict has to be written down by the statement that made
 * it.
 */
const TAKE_SQL = `
INSERT INTO maxstack_rate_bucket AS b (key, tokens, updated_at, max_tokens, allowed)
VALUES ($1, $2::double precision - 1, $3::double precision, $2::double precision, true)
ON CONFLICT (key) DO UPDATE SET
	tokens = CASE WHEN ${refillExpr('$4::double precision')} >= 1
		THEN ${refillExpr('$4::double precision')} - 1
		ELSE ${refillExpr('$4::double precision')} END,
	updated_at = EXCLUDED.updated_at,
	max_tokens = EXCLUDED.max_tokens,
	allowed = ${refillExpr('$4::double precision')} >= 1
RETURNING tokens, max_tokens, allowed
`

/**
 * How long an untouched bucket is kept.
 *
 * A bucket idle for longer than its own window is full, and a full bucket is
 * indistinguishable from one that never existed — so deleting it changes no
 * verdict. Without the sweep the table grows one row per distinct caller
 * forever, which turns a bounded memory leak into an unbounded table: strictly
 * worse than what this replaced. Four hours covers the longest window anything
 * declares (a portal's hour) with room to spare.
 */
export const BUCKET_RETENTION_MS = 4 * 60 * 60 * 1000

/** How often a process sweeps. Opportunistic — driven by traffic rather than a
 * timer, so an idle instance does no work and a busy one pays a `DELETE` every
 * ten minutes. Every instance sweeps; the statement is idempotent. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

export interface PostgresCoordinatorOptions {
	/** Called when the listener connection fails. Defaults to a `console.warn`:
	 * an instance that has silently stopped hearing about changes is the failure
	 * this whole module exists to make visible, so it is never swallowed. */
	onListenerError?: (error: unknown) => void
}

/**
 * The shared coordinator, over the database every instance already has.
 *
 * Two behaviours differ from the in-process one and both are deliberate:
 *
 *  1. **An announcement is asynchronous even to the announcing process.** It
 *     goes out as `pg_notify` and comes back on the listener connection, so
 *     `await announce()` means "the database has it", not "every handler has run".
 *     Delivering locally *as well* would double-deliver to the instance that
 *     published, and de-duplicating that needs an instance id on every message —
 *     a header nobody reads, to avoid a round trip nobody is waiting on.
 *  2. **A missed announcement is not replayed.** See the module comment; the
 *     polling fallback is the answer and every live surface keeps one.
 */
export async function createPostgresCoordinator(
	backend: StoreBackend,
	options: PostgresCoordinatorOptions = {},
): Promise<Coordinator> {
	if (!backend.listen)
		throw new Error(
			'this backend cannot LISTEN, so a shared coordinator over it would take tokens correctly and never deliver a change — refusing rather than half-working (see createPostgresCoordinator)',
		)
	await backend.exec(COORDINATION_DDL)
	const handlers = new Set<CoordinatorHandler>()
	const onError =
		options.onListenerError ??
		((error: unknown) => {
			console.error('[coordination] undeliverable announcement', error)
		})
	let subscribes = 0
	const unlisten = await backend.listen(
		COORDINATOR_CHANNEL,
		(raw) => {
			let message: CoordinatorMessage
			try {
				const parsed = JSON.parse(raw) as Partial<CoordinatorMessage>
				if (
					typeof parsed.topic !== 'string' ||
					typeof parsed.payload !== 'string'
				)
					throw new Error('not a coordinator message')
				message = { topic: parsed.topic, payload: parsed.payload }
			} catch (error) {
				// Somebody else's NOTIFY on our channel, or a truncated one. Dropped
				// loudly rather than thrown: this runs on a driver callback, where a
				// throw is an unhandled rejection that takes the connection with it.
				onError(error)
				return
			}
			for (const handler of handlers) handler(message)
		},
		() => {
			// The second and later subscribes are reconnections, and a `NOTIFY` sent
			// while the connection was down is gone — nothing replays one. Said out
			// loud, because the alternative is an instance quietly serving stale
			// live surfaces with no line anywhere admitting there was a gap.
			subscribes += 1
			if (subscribes > 1)
				console.warn(
					'[coordination] the LISTEN connection re-subscribed after dropping. ' +
						'Announcements made while it was down were not replayed, so live ' +
						'surfaces on this instance may have missed changes until their next ' +
						'poll. Rate limiting is unaffected: it reads the shared table per ' +
						'call rather than over this connection.',
				)
		},
	)

	let sweptAt = 0
	async function sweep(now: number): Promise<void> {
		if (now - sweptAt < SWEEP_INTERVAL_MS) return
		sweptAt = now
		try {
			await backend.query(
				'DELETE FROM maxstack_rate_bucket WHERE updated_at < $1',
				[now - BUCKET_RETENTION_MS],
			)
		} catch (error) {
			// A failed sweep costs table size, never a verdict. Warning rather than
			// throwing keeps a full disk from becoming a refused write.
			console.warn('[coordination] rate-bucket sweep failed', error)
		}
	}

	return {
		kind: 'postgres',
		async announce(message) {
			assertPayloadFits(message)
			await backend.query('SELECT pg_notify($1, $2)', [
				COORDINATOR_CHANNEL,
				JSON.stringify(message),
			])
		},
		listen(handler) {
			handlers.add(handler)
			return () => {
				handlers.delete(handler)
			}
		},
		async take(request) {
			if (!(request.max >= 1)) return refuseUnbudgeted(request)
			const rows = await backend.query(TAKE_SQL, [
				request.key,
				request.max,
				request.now,
				request.windowMs,
			])
			const row = rows[0] as
				| { tokens: number; max_tokens: number; allowed: boolean }
				| undefined
			// No row back means the statement did not run the way this module
			// believes it does. Refusing is the only safe reading: a limiter that
			// allows when it cannot tell is not a limiter.
			if (!row) return refuseUnbudgeted(request)
			const tokens = Number(row.tokens)
			const limit = Number(row.max_tokens)
			void sweep(request.now)
			return {
				allowed: row.allowed === true,
				remaining: Math.max(0, Math.floor(tokens)),
				resetAt:
					request.now + Math.ceil((1 - tokens) / (limit / request.windowMs)),
				limit,
			}
		},
		async dispose() {
			handlers.clear()
			await unlisten()
		},
	}
}
