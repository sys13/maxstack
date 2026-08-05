/**
 * **Inbound webhook receivers**.
 *
 * An inbound webhook is an unauthenticated write path. There is no session, no
 * api key, and no human — just a POST from the public internet that the
 * application is expected to trust and turn into a database write. That is the
 * most dangerous shape in the product, so the design constraint is not "make
 * verification easy to do" but **"make skipping it impossible to express."**
 *
 * Three things follow from that, and they are the whole module:
 *
 * 1. **An unsigned receiver cannot be declared.** {@link ReceiverDeclaration}
 *    has no `verify: false`, no `skipSignature`, and no optional secret.
 *    `declareReceiver` refuses an empty or short secret at declaration time,
 *    which is *before* anything is listening. A flag that turns verification off
 *    is a flag that gets turned off in staging and stays off.
 * 2. **The payload becomes a validated write, never a raw one.** A receiver maps
 *    the provider's body onto an op through a `map` function whose result is
 *    validated by the same path every other write uses. A receiver that could
 *    write directly would be a REST API with no authentication in front of it.
 * 3. **Failures are indistinguishable from outside.** Every rejection is a bare
 *    401 with no body. A receiver that says "bad signature" versus "unknown
 *    event" versus "replayed" is an oracle: it tells an attacker which half of
 *    their guess was right. The *reason* is recorded on our side, where it is
 *    diagnosis rather than assistance.
 */

import type { AuditSink } from '../audit/index.ts'
import {
	createMemoryNonceStore,
	type NonceStore,
	REPLAY_WINDOW_SECONDS,
	type VerifyFailure,
	verifySignedRequest,
} from './signing.ts'

/** The minimum secret a receiver may be declared with. */
export const MIN_RECEIVER_SECRET_LENGTH = 32

/** What a verified inbound payload is turned into: a validated write. */
export interface ReceiverWrite {
	/** The resource the write targets — validated by the caller's write path. */
	resource: string
	action: 'create' | 'update' | 'delete'
	id?: string
	values?: Record<string, unknown>
}

/**
 * A declared inbound receiver.
 *
 * Note what is absent: any way to say "don't verify". The secret is required and
 * `declareReceiver` enforces its length, so the unsafe configuration is not a
 * discouraged option — it is unspellable.
 */
export interface ReceiverDeclaration {
	/** Path segment the receiver mounts at, e.g. `stripe`. */
	key: string
	/** Shared secret, from the provider's dashboard. Required. */
	secret: string
	/**
	 * Map a verified body onto writes. Returning `[]` is how a receiver ignores
	 * an event type it does not care about — a normal outcome, not an error.
	 */
	map: (body: unknown) => ReceiverWrite[] | Promise<ReceiverWrite[]>
	/** Override the replay window (seconds). Defaults to the shared 5 minutes. */
	windowSeconds?: number
}

export class ReceiverDeclarationError extends Error {}

/** The outcome of handling one inbound request, for our logs — not the caller's. */
export interface ReceiverOutcome {
	receiver: string
	accepted: boolean
	/** Present when `accepted` is false. Never sent to the caller. */
	failure?: VerifyFailure | 'unknown-receiver' | 'map-failed'
	writes: ReceiverWrite[]
}

/**
 * Validate a receiver declaration. Exported so a composition root can fail at
 * boot rather than on the first delivery.
 */
export function receiverErrors(declaration: ReceiverDeclaration): string[] {
	const errors: string[] = []
	if (!/^[a-z][a-z0-9-]*$/.test(declaration.key))
		errors.push(`receiver key "${declaration.key}" must be kebab-case`)
	if (typeof declaration.secret !== 'string' || !declaration.secret.trim())
		errors.push(
			`receiver "${declaration.key}" has no secret — an unsigned receiver is an unauthenticated write endpoint, and cannot be declared`,
		)
	else if (declaration.secret.length < MIN_RECEIVER_SECRET_LENGTH)
		errors.push(
			`receiver "${declaration.key}" has a ${declaration.secret.length}-character secret; ` +
				`at least ${MIN_RECEIVER_SECRET_LENGTH} is required (a guessable secret is the same as no secret)`,
		)
	if (typeof declaration.map !== 'function')
		errors.push(`receiver "${declaration.key}" has no map function`)
	return errors
}

export interface ReceiverRegistryOptions {
	nonces?: NonceStore
	/** Delivery attempts are audit entries with real provenance. */
	audit?: AuditSink
	now?: () => Date
}

/**
 * The declared receivers, and the one entry point that handles a request.
 *
 * `handle` returns a `Response` rather than throwing, and every unhappy path
 * returns the *same* 401 with no body — see constraint 3 in the module note.
 */
export class ReceiverRegistry {
	private readonly receivers = new Map<string, ReceiverDeclaration>()
	private readonly nonces: NonceStore
	private readonly audit: AuditSink | undefined
	private readonly now: () => Date

	constructor(opts: ReceiverRegistryOptions = {}) {
		this.nonces = opts.nonces ?? createMemoryNonceStore()
		this.audit = opts.audit
		this.now = opts.now ?? (() => new Date())
	}

	/** Declare a receiver. Throws on any violation — at boot, not at delivery. */
	declare(declaration: ReceiverDeclaration): this {
		const errors = receiverErrors(declaration)
		if (errors.length) throw new ReceiverDeclarationError(errors.join('; '))
		if (this.receivers.has(declaration.key))
			throw new ReceiverDeclarationError(
				`receiver "${declaration.key}" is already declared`,
			)
		this.receivers.set(declaration.key, declaration)
		return this
	}

	keys(): string[] {
		return [...this.receivers.keys()]
	}

	/**
	 * Verify and map one inbound request.
	 *
	 * The returned writes are **not** applied here. Applying them is the caller's
	 * job, through the same validated write path a human's form submission uses —
	 * which is the point: a receiver produces intent, not rows.
	 */
	async handle(
		key: string,
		request: { body: string; headers: Headers | Record<string, string> },
	): Promise<{ response: Response; outcome: ReceiverOutcome }> {
		const declaration = this.receivers.get(key)
		if (!declaration) {
			// Same 401 as a bad signature. A 404 here would enumerate which
			// receivers exist, for free, to anyone who asks.
			return this.reject(key, 'unknown-receiver')
		}

		const verified = await verifySignedRequest({
			secret: declaration.secret,
			body: request.body,
			headers: request.headers,
			now: this.now(),
			nonces: this.nonces,
			windowSeconds: declaration.windowSeconds ?? REPLAY_WINDOW_SECONDS,
		})
		if (!verified.ok) return this.reject(key, verified.failure)

		let writes: ReceiverWrite[]
		try {
			writes = await declaration.map(JSON.parse(request.body))
		} catch {
			// A body that verified but did not parse or map is *our* problem, not a
			// caller's — the signature proves it came from the provider. 400 rather
			// than 401 so a retrying provider distinguishes "wrong secret" (never
			// retry) from "we broke" (do retry).
			await this.record(key, false, 'map-failed', [])
			return {
				response: new Response(null, { status: 400 }),
				outcome: {
					receiver: key,
					accepted: false,
					failure: 'map-failed',
					writes: [],
				},
			}
		}

		await this.record(key, true, undefined, writes)
		return {
			response: new Response(null, { status: 204 }),
			outcome: { receiver: key, accepted: true, writes },
		}
	}

	private async reject(
		key: string,
		failure: ReceiverOutcome['failure'],
	): Promise<{ response: Response; outcome: ReceiverOutcome }> {
		await this.record(key, false, failure, [])
		return {
			// Bare 401, no body, no header. Identical for every failure.
			response: new Response(null, { status: 401 }),
			outcome: { receiver: key, accepted: false, failure, writes: [] },
		}
	}

	private async record(
		key: string,
		accepted: boolean,
		failure: ReceiverOutcome['failure'],
		writes: ReceiverWrite[],
	): Promise<void> {
		// The reason lives here, where it is diagnosis rather than an oracle.
		await this.audit?.({
			userId: `webhook:${key}`,
			action: accepted
				? 'webhook.inbound.accepted'
				: 'webhook.inbound.rejected',
			resource: 'webhook_receiver',
			resourceId: key,
			// `system`, not a person: nobody was logged in, and attributing an
			// unauthenticated callback to a user would put a fiction in the log
			// somebody will later read as fact.
			origin: 'system',
			metadata: { failure: failure ?? null, writes: writes.length },
		})
	}
}
