/**
 * The refusal envelope — one shape every "no" fills in, on every surface.
 *
 * ## The gap this closes (#450)
 *
 * A declared action already emits three surfaces from one declaration: the
 * admin UI, `POST /api/:resource/actions/:key`, and the MCP `run_action` tool.
 * When one of them refused, the three did not say the same thing, and none of
 * them said enough. A refusal was whatever the throwing site happened to write:
 * REST answered `{ error: '<message>' }` with a status, MCP answered the bare
 * message string, and a slot's UI got whichever of the two it had called.
 *
 * A status code carries one bit of what a caller needs. Two more decide what
 * happens next, and neither is derivable from it:
 *
 *   - **Whose rule this was.** {@link RefusalFault} separates a request that was
 *     wrong (`caller`) from a request that was well-formed and refused by a rule
 *     (`policy`) from a failure that is nobody's request at all (`platform`).
 *     `422` and `403` are both "no" and want opposite reactions.
 *   - **Whether it clears by itself.** {@link RefusalRetry} is a *separate*
 *     field from fault, because the two do not line up: a spent portal budget is
 *     a `policy` refusal that lifts in an hour, and a client reading only the
 *     status gives up forever on a refusal that would have cleared.
 *
 * An agent is a first-class caller of the apps we generate, and the MCP surface
 * is the one we lead with. A human reading `403 Forbidden` goes and asks
 * somebody; an agent reading it can retry, give up, or invent a reason, and all
 * three are bad.
 *
 * ## Two structural rules, both load-bearing
 *
 * **This module imports nothing.** Not the store, not drizzle, not zod, not the
 * error classes it describes. A refusal is rendered into a toast by a component,
 * so anything this module imports lands in the client bundle — and importing
 * `operations.ts` to reach `instanceof` would drag the database client in behind
 * it. That is #446's failure mode arrived at from the other direction. The
 * class → {@link RefusalCode} mapping therefore lives at each boundary that
 * already imports the classes ({@link file://./api.ts}, {@link file://./mcp.ts});
 * what lives here is the part that is the *same* on every surface.
 *
 * **The classification is pure.** Everything below is a total function of a code
 * — no request, no session, no clock — so the contract is asserted as a table of
 * inputs rather than by standing up a database and provoking each refusal. The
 * table is the test.
 *
 * ## What this is not
 *
 * Not a spec-op, and not a new vocabulary an app declares. The codes are the
 * framework's own refusals, closed deliberately: a code that is not in
 * {@link REFUSAL_CATALOG} cannot be constructed, so a surface cannot quietly
 * invent one that no client knows how to read.
 */

/**
 * Whose rule refused.
 *
 * Deliberately three values and not two. The split that matters to a caller is
 * not "my fault / your fault" but *what to change*: the request (`caller`), the
 * permission to make it (`policy`), or nothing, because it is the platform's
 * problem and not the caller's (`platform`).
 */
export type RefusalFault = 'caller' | 'policy' | 'platform'

/**
 * Whether this refusal clears on its own, and when.
 *
 * `after` is seconds, matching HTTP `Retry-After`'s delta-seconds form so the
 * header is a projection of this field rather than a second source of truth. It
 * is absent when the refusal is retryable but nothing here can say when — a
 * platform failure clears when it is fixed, and inventing a number would be a
 * client's retry storm with our name on it.
 */
export interface RefusalRetry {
	retryable: boolean
	after?: number
}

/**
 * One refusal, in the shape every surface renders.
 *
 * `message` is the human sentence the throwing site already wrote — this
 * envelope adds to it and never replaces it, which is why adopting it broke no
 * existing message. The per-refusal detail each boundary already returned
 * (`fieldErrors`, `conflict`, `options`, …) is unchanged and sits beside this,
 * not inside it: those shapes are specific to one refusal and clients already
 * read them.
 */
export interface Refusal {
	code: RefusalCode
	message: string
	fault: RefusalFault
	/**
	 * What refused, by declared id — `access.book.update`, `portal.public-form`,
	 * `limit.wip`. Free-form as a string, but every value the framework
	 * constructs names something that exists in the spec or the registry, because
	 * a `rule` that names nothing is a `message` with extra steps. #447's `access`
	 * namespace is what made the permission cases able to say it.
	 */
	rule?: string
	retry?: RefusalRetry
	/**
	 * What the caller may do about it, in one sentence.
	 *
	 * Derived from the code, never hand-written per throw site. The field most
	 * likely to rot into a lie is the one written by hand at 40 call sites and
	 * reviewed at none — so it is written once, here, beside the fault and the
	 * retry it has to agree with.
	 */
	next?: string
}

/**
 * The closed vocabulary. One entry per refusal the framework constructs
 * deliberately, plus `internal` for everything that reaches a boundary
 * unclassified.
 */
export type RefusalCode =
	/** An update body with nothing writable in it (#388). */
	| 'empty_update'
	/** A value failed its declared contract. */
	| 'validation_failed'
	/** A declared WIP limit: the rule is about the other rows, not this one. */
	| 'limit_exceeded'
	/** A duplicate — a unique constraint the caller's own values broke. */
	| 'conflict'
	/** Any other integrity violation: fk, check, not-null. */
	| 'constraint_violation'
	/** An access rule, an api-key scope or a portal narrowing said no. */
	| 'forbidden'
	/** The row is not there — or is not visible, which reads the same on purpose. */
	| 'not_found'
	/** No such resource in the spec. */
	| 'unknown_resource'
	/** The operation exists but this resource does not support it. */
	| 'unsupported_operation'
	/** A declared portal's write budget, spent. */
	| 'rate_limited'
	/** A run aimed at more rows than the declaration allows, or at none. */
	| 'selection_too_large'
	/** A chosen value outside the declared options. */
	| 'invalid_action_choice'
	/** An action key this resource does not declare. */
	| 'unknown_action'
	/** Unclassified: the driver, the store, a bug. Never the caller's to fix. */
	| 'internal'

/** The invariant part of a code: everything true of it before a request exists. */
export interface RefusalDescriptor {
	/** The HTTP status this code maps to. One place, so REST and docs agree. */
	status: number
	fault: RefusalFault
	retry: RefusalRetry
	next: string
}

/**
 * The table. Every property a surface needs beyond the message, keyed by code.
 *
 * Read it as the contract: the statuses here are the statuses `api.ts` returns,
 * and its own test asserts that correspondence rather than restating it.
 */
export const REFUSAL_CATALOG: Readonly<Record<RefusalCode, RefusalDescriptor>> =
	{
		empty_update: {
			status: 400,
			fault: 'caller',
			retry: { retryable: false },
			next: 'Send at least one writable field. The refusal names which of the keys you sent were dropped and why.',
		},
		validation_failed: {
			status: 422,
			fault: 'caller',
			retry: { retryable: false },
			next: 'Fix the fields named in `fieldErrors` and send the request again.',
		},
		limit_exceeded: {
			status: 422,
			fault: 'policy',
			retry: { retryable: false },
			next: 'The declared limit is full. Move or close an existing row before adding this one.',
		},
		conflict: {
			status: 409,
			fault: 'caller',
			retry: { retryable: false },
			// Deliberately avoids the phrase "already exists" — postgres's own
			// duplicate-key `detail` ends in it, and `constraints.ts`'s leak guard
			// scans the serialized body for that prose. Canned advice that happens to
			// quote the driver would blunt a check that is worth keeping sharp.
			next: 'A row with these values is already there. Change the conflicting field, or update that row instead.',
		},
		constraint_violation: {
			status: 422,
			fault: 'caller',
			retry: { retryable: false },
			next: 'Fix the fields named in `fieldErrors` and send the request again.',
		},
		forbidden: {
			// Never retryable: the identity is what was refused, and repeating the
			// request with the same identity gets the same answer. A caller who
			// acquires a role is making a *different* request, not a retry.
			status: 403,
			fault: 'policy',
			retry: { retryable: false },
			next: 'This identity is not permitted this action. `rule` names what refused; changing what you send will not change the answer.',
		},
		not_found: {
			status: 404,
			fault: 'caller',
			retry: { retryable: false },
			next: 'Check the id. A row you may not see is reported the same way as one that does not exist.',
		},
		unknown_resource: {
			status: 404,
			fault: 'caller',
			retry: { retryable: false },
			next: 'Check the resource name against the ones this app declares.',
		},
		unsupported_operation: {
			status: 422,
			fault: 'caller',
			retry: { retryable: false },
			next: 'This resource does not support that operation. The message names what it does support.',
		},
		rate_limited: {
			// The one refusal that is `policy` **and** retryable, and the reason
			// `retry` is its own field rather than a reading of `fault`. A budget is
			// declared per hour, so the wait is bounded and stateable.
			status: 429,
			fault: 'policy',
			retry: { retryable: true, after: 3600 },
			next: 'The declared write budget for this portal is spent. Wait for the window to roll over and send it again.',
		},
		selection_too_large: {
			status: 400,
			fault: 'caller',
			retry: { retryable: false },
			next: 'Select fewer rows — `maxSelection` is the cap — and run the action again.',
		},
		invalid_action_choice: {
			status: 400,
			fault: 'caller',
			retry: { retryable: false },
			next: 'Choose one of the values in `options`.',
		},
		unknown_action: {
			status: 404,
			fault: 'caller',
			retry: { retryable: false },
			next: 'Check the action key against the ones this resource declares.',
		},
		internal: {
			// Retryable with no `after`: it may well clear, and nothing here can
			// honestly say when. See RefusalRetry.
			status: 500,
			fault: 'platform',
			retry: { retryable: true },
			next: 'Nothing you can change in the request. Quote `errorId` when reporting it.',
		},
	}

/**
 * Build the envelope for a code.
 *
 * `rule` is the only per-throw input, because it is the only fact that is about
 * *this* refusal rather than about the kind: which access rule, which portal,
 * which declared limit. Everything else comes from the table, so two surfaces
 * refusing the same way cannot disagree.
 */
export function refusal(
	code: RefusalCode,
	message: string,
	options: { rule?: string; retryAfter?: number } = {},
): Refusal {
	const descriptor = REFUSAL_CATALOG[code]
	const retry: RefusalRetry =
		options.retryAfter === undefined
			? descriptor.retry
			: { retryable: true, after: options.retryAfter }
	return {
		code,
		message,
		fault: descriptor.fault,
		...(options.rule === undefined ? {} : { rule: options.rule }),
		retry,
		next: descriptor.next,
	}
}

/** The status a code maps to. The single source both REST and the docs read. */
export function refusalStatus(code: RefusalCode): number {
	return REFUSAL_CATALOG[code].status
}

/**
 * The `Retry-After` header value for a refusal, or `undefined` when there is
 * nothing honest to put in it.
 *
 * A projection of {@link RefusalRetry}, not a parallel decision: a refusal that
 * is retryable but cannot say when gets no header, because `Retry-After: 0` is
 * an instruction to retry immediately and that is the opposite of what an
 * unbounded platform failure wants.
 */
export function retryAfterHeader(r: Refusal): string | undefined {
	if (!r.retry?.retryable) return undefined
	if (r.retry.after === undefined) return undefined
	return String(r.retry.after)
}

/**
 * The refusal as the one-line block a CLI prints to stderr and an MCP tool
 * returns after the message.
 *
 * Deliberately not JSON. It follows a message a human or an agent is already
 * reading, and the three facts it adds are the three that decide what happens
 * next — a JSON blob at that position is read past by a person and, on MCP,
 * competes with the repair instructions some refusals already serialize there.
 */
export function formatRefusal(r: Refusal): string {
	const parts = [`fault=${r.fault}`]
	if (r.rule !== undefined) parts.push(`rule=${r.rule}`)
	if (r.retry?.retryable) {
		parts.push(
			r.retry.after === undefined
				? 'retry=yes'
				: `retry=after ${r.retry.after}s`,
		)
	} else {
		parts.push('retry=no')
	}
	return `[${r.code}] ${parts.join(' ')}${r.next === undefined ? '' : `\n${r.next}`}`
}
