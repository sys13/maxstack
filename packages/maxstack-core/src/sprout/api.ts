/**
 * Framework-agnostic REST handlers. An RR7 `api.$resource` route is a thin
 * adapter over these: parse the request, call the handler, return the JSON.
 * All authorization/validation lives in operations.ts.
 */

import { ConflictError, ConstraintViolationError } from './constraints.ts'
import type { ErrorContext } from './error-id.ts'
import { nextErrorId, reportInternalError } from './error-id.ts'
import {
	EmptyUpdateError,
	InvalidActionChoiceError,
	LimitExceededError,
	NotFoundError,
	type OpContext,
	opCount,
	opCreate,
	opDelete,
	opGet,
	opGetMany,
	opList,
	opRestore,
	opRunAction,
	opSearch,
	opSearchCount,
	opUpdate,
	RateLimitedError,
	SelectionTooLargeError,
	UnknownActionError,
	UnknownResourceError,
	UnsupportedOperationError,
	ValidationError,
} from './operations.ts'
import { PermissionError } from './permissions.ts'
import type { Refusal, RefusalCode } from './refusal.ts'
import { refusal, refusalStatus, retryAfterHeader } from './refusal.ts'
import type { ListOptions, Row } from './store.ts'

export interface ApiResponse<T = unknown> {
	status: number
	body: T
	/**
	 * Response headers the adapter must set. Present only where a header carries
	 * something the body cannot: today that is `Retry-After` on a refusal whose
	 * envelope says when it clears. An adapter that ignores it degrades to the
	 * pre-#450 behaviour rather than serving something wrong.
	 */
	headers?: Record<string, string>
}

/**
 * The failure boundary for every REST body.
 *
 * The split it draws is between an error *we* constructed — a 404, a 403, a 422
 * validation refusal, a 429 budget — which was written for the caller and goes
 * back verbatim, and anything else, which arrived from the driver or the store.
 * A driver error's `message` is the failed statement: the SQL, every column name
 * in the projection, and the bound parameters. Returning it published the
 * table's shape — including columns a read policy deliberately omits from the
 * serialized row — plus whatever the caller had just sent, to an unauthenticated
 * `GET` (#336). So the fallback is a fixed string plus a correlation id, and the
 * detail goes to stderr.
 *
 * The boundary is *class* membership, never a scan of the message text: an error
 * type added later is generic until someone deliberately maps it here, which is
 * the safe direction to fail.
 */
/**
 * Build the refusal response for a code: the envelope, the status it maps to,
 * `Retry-After` where the envelope can name a delay, and whatever per-refusal
 * detail this particular class already returned.
 *
 * The status comes from `refusal.ts`'s table rather than being written here, so
 * the statuses this file returns and the ones the envelope's `fault`/`retry`
 * were chosen against cannot drift apart. `detail` is spread *beside* the
 * envelope and never inside it — `fieldErrors`, `conflict`, `options` are
 * shapes clients already read, and moving them would have been a break for the
 * sake of tidiness.
 */
function refuse(
	code: RefusalCode,
	message: string,
	detail: Record<string, unknown> = {},
	options: { rule?: string; retryAfter?: number } = {},
): ApiResponse {
	const envelope: Refusal = refusal(code, message, options)
	const after = retryAfterHeader(envelope)
	return {
		status: refusalStatus(code),
		// `error` stays first and stays the message: every existing client reads
		// it, and #450 is an addition to the body, not a replacement of it.
		body: { error: message, ...detail, ...envelope },
		...(after === undefined ? {} : { headers: { 'Retry-After': after } }),
	}
}

function fail(e: unknown, context: ErrorContext): ApiResponse {
	// An update body with nothing writable in it (#388). **400, not the 422 every
	// other validation refusal gets, and above `ValidationError` because it is a
	// subclass** — reordering these two would turn it back into a 422. 422 says
	// the shape was understood and a value was wrong; here no value arrived at
	// all, `fieldErrors` is necessarily empty, and a client that reads a 422 by
	// walking `fieldErrors` would be told nothing. The named key lists are the
	// repair instruction: they say which of the keys the caller sent were
	// dropped, and why.
	if (e instanceof EmptyUpdateError) {
		return refuse('empty_update', e.message, {
			fieldErrors: e.fieldErrors,
			unknownFields: e.unknownFields,
			immutableFields: e.immutableFields,
		})
	}
	if (e instanceof ValidationError) {
		// Every 422 is repair instructions: `error` names the
		// resource, the operation and every rejected field; `fieldErrors` states
		// per field what was expected, what arrived and an example that works; and
		// `fields` carries the same contract machine-readably, so a client can act
		// on it without parsing prose.
		return refuse('validation_failed', e.message, {
			fieldErrors: e.fieldErrors,
			fields: e.fields,
		})
	}
	// A declared WIP limit. 422 with `fieldErrors`, exactly like a
	// validation refusal — it *is* one, just one whose rule is about the other
	// rows rather than about this one — plus the numbers a UI wants to render.
	if (e instanceof LimitExceededError) {
		return refuse(
			'limit_exceeded',
			e.message,
			{
				fieldErrors: e.fieldErrors,
				limit: {
					field: e.field,
					value: e.value,
					limit: e.limit,
					current: e.current,
				},
			},
			// A declared WIP limit is a rule with a name, so the envelope can point
			// at the declaration rather than at the wall.
			{ rule: `limit.${e.field}` },
		)
	}
	// A duplicate. The one driver failure that is a fact about the *caller's own
	// request* rather than about the platform, so it is the one that must not be
	// swallowed by the fallback below: before #336 it came back as Postgres's
	// prose with a 500 and after #336 as `Internal error` with a 500, and neither
	// lets a client tell "change one field and retry" from "the database is down"
	// (#352). It arrives here already classified by SQLSTATE at the store
	// boundary (`constraints.ts`) — the class is constructed, so this is the same
	// class test every branch above makes, not a new sniff at a driver string.
	//
	// The body names the offending fields and the constraint's identifier and
	// nothing else. Those are schema — the caller is addressing the table by name
	// already, and they are what makes the 409 actionable rather than merely
	// distinct. The statement, the projection, the bound parameters and the
	// driver's `detail` (which quotes the conflicting row's value) stay on the
	// original error, which never reaches a body.
	if (e instanceof ConflictError) {
		return refuse('conflict', e.message, {
			fieldErrors: e.fieldErrors,
			conflict: { fields: e.fields, constraint: e.constraint },
		})
	}
	// Every other integrity violation — a foreign key that points nowhere, a
	// check the row breaks, a NOT NULL column left empty. 422 with `fieldErrors`,
	// exactly like `ValidationError`, because that is what it is: a validation
	// refusal whose rule happens to live in the schema rather than in the Zod
	// layer. Below `ConflictError` because that is a subclass — reordering these
	// two would turn every 409 into a 422.
	if (e instanceof ConstraintViolationError) {
		return refuse('constraint_violation', e.message, {
			fieldErrors: e.fieldErrors,
			constraint: { kind: e.kind, name: e.constraint, fields: e.fields },
		})
	}
	if (e instanceof PermissionError) {
		// `rule` is the whole point on this branch: four gates produce this same
		// 403 and the caller's next move differs for each. See PermissionGate.
		return refuse('forbidden', e.message, {}, { rule: e.rule })
	}
	if (e instanceof NotFoundError) {
		return refuse('not_found', e.message)
	}
	if (e instanceof UnknownResourceError) {
		return refuse('unknown_resource', e.message)
	}
	if (e instanceof UnsupportedOperationError) {
		return refuse('unsupported_operation', e.message)
	}
	// A declared portal's hourly write budget, spent. Constructed by
	// `opCreate`/`opUpdate` and addressed to the caller ("try again later"), so it
	// belongs on this side of the boundary — and it has to be named explicitly,
	// because the generic fallback below would otherwise turn a rate-limit refusal
	// into an unactionable 500 the caller retries immediately.
	if (e instanceof RateLimitedError) {
		// The one refusal that is policy *and* clears by itself. The declared
		// budget is per hour, so the wait is bounded and the envelope says so —
		// and `Retry-After` on the response is that field, projected.
		return refuse(
			'rate_limited',
			e.message,
			{},
			{ rule: `portal.${e.portalKey}.rateLimit` },
		)
	}
	// A run aimed at more rows than the declaration allows, or at none. 400
	// rather than 422: no value was wrong, the *size* of the request was, so
	// `fieldErrors` would be empty and a client walking it would be told nothing —
	// `EmptyUpdateError`'s reasoning, applied to the selection instead of the body.
	if (e instanceof SelectionTooLargeError) {
		return refuse('selection_too_large', e.message, {
			requested: e.requested,
			maxSelection: e.maxSelection,
		})
	}
	// A chosen value outside the declared options. 400 with the options, so the
	// refusal is a repair instruction rather than a "no".
	if (e instanceof InvalidActionChoiceError) {
		return refuse('invalid_action_choice', e.message, {
			column: e.column,
			options: e.options,
		})
	}
	// An action this resource does not declare. 404 rather than 403 — an action
	// key is a declaration, not a secret, and "there is no such operation" is the
	// honest answer.
	if (e instanceof UnknownActionError) {
		return refuse('unknown_action', e.message)
	}
	const errorId = nextErrorId()
	reportInternalError(e, errorId, context)
	// The fallback keeps the fixed string and the correlation id (#336) and adds
	// only what the envelope is for: `fault: 'platform'` says this one is not the
	// caller's to fix, which is the fact a retrying agent was missing.
	return refuse('internal', 'Internal error', { errorId })
}

export async function listHandler(
	ctx: OpContext,
	resource: string,
	opts?: ListOptions,
): Promise<ApiResponse> {
	try {
		return { status: 200, body: await opList(ctx, resource, opts) }
	} catch (e) {
		return fail(e, { resource, operation: 'list' })
	}
}

/**
 * Ranked full-text search over one resource.
 *
 * Returns `{ query, total, results: [{ rank, row }] }` — the hit is an envelope
 * rather than the rank merged onto the row, because merging would add a key the
 * entity never declared, and the first thing that breaks is a client that round-
 * trips a search result back into an update.
 *
 * `total` comes from `opSearchCount`, which runs under identical predicates, so
 * a caller can never be told there are more matches than it is allowed to page
 * to. Every refusal `opSearch` can raise is already in `fail()`'s vocabulary: a
 * denied read is 403 and an undeclared index is 422 saying so, never an empty
 * result set that reads as "nothing matched".
 */
export async function searchHandler(
	ctx: OpContext,
	resource: string,
	query: string,
	opts?: Parameters<typeof opSearch>[3],
): Promise<ApiResponse> {
	try {
		const [results, total] = await Promise.all([
			opSearch(ctx, resource, query, opts),
			// Same predicates, minus paging: a total that counted rows the results
			// half excludes is a total the caller can never page to — and in the
			// tenant case it is a cross-tenant row count, which is a leak whether or
			// not the rows come back.
			opSearchCount(ctx, resource, query, {
				includeDeleted: opts?.includeDeleted,
				filter: opts?.filter,
				range: opts?.range,
			}),
		])
		return { status: 200, body: { query, total, results } }
	} catch (e) {
		return fail(e, { resource, operation: 'search' })
	}
}

export async function getHandler(
	ctx: OpContext,
	resource: string,
	id: string,
): Promise<ApiResponse> {
	try {
		return { status: 200, body: await opGet(ctx, resource, id) }
	} catch (e) {
		return fail(e, { resource, operation: 'get' })
	}
}

export async function countHandler(
	ctx: OpContext,
	resource: string,
	opts?: ListOptions,
): Promise<ApiResponse> {
	try {
		return { status: 200, body: { count: await opCount(ctx, resource, opts) } }
	} catch (e) {
		return fail(e, { resource, operation: 'count' })
	}
}

export async function getManyHandler(
	ctx: OpContext,
	resource: string,
	ids: readonly string[],
): Promise<ApiResponse> {
	try {
		return { status: 200, body: await opGetMany(ctx, resource, ids) }
	} catch (e) {
		return fail(e, { resource, operation: 'getMany' })
	}
}

export async function createHandler(
	ctx: OpContext,
	resource: string,
	data: Row,
): Promise<ApiResponse> {
	try {
		return { status: 201, body: await opCreate(ctx, resource, data) }
	} catch (e) {
		return fail(e, { resource, operation: 'create' })
	}
}

export async function updateHandler(
	ctx: OpContext,
	resource: string,
	id: string,
	data: Row,
): Promise<ApiResponse> {
	try {
		return { status: 200, body: await opUpdate(ctx, resource, id, data) }
	} catch (e) {
		return fail(e, { resource, operation: 'update' })
	}
}

export async function deleteHandler(
	ctx: OpContext,
	resource: string,
	id: string,
): Promise<ApiResponse> {
	try {
		return { status: 200, body: { success: await opDelete(ctx, resource, id) } }
	} catch (e) {
		return fail(e, { resource, operation: 'delete' })
	}
}

/** Restore a soft-deleted row — the undo for `deleteHandler` on a
 * `softDelete: true` resource. */
export async function restoreHandler(
	ctx: OpContext,
	resource: string,
	id: string,
): Promise<ApiResponse> {
	try {
		return { status: 200, body: await opRestore(ctx, resource, id) }
	} catch (e) {
		return fail(e, { resource, operation: 'restore' })
	}
}

/**
 * Run a declared list action — `POST /api/:resource/actions/:key`.
 *
 * A **POST to a named operation**, not a `PATCH` over a collection, and the
 * distinction is the whole design: the server decides what is written, from the
 * declaration. A collection `PATCH` would take the write from the body, which is
 * the client-side bulk update this layer exists not to be — there would be
 * nothing in the spec for a reviewer to read, and nothing bounding what one call
 * could set.
 *
 * The body is `{ ids, choice? }` and nothing else. `ids` is an explicit list;
 * there is deliberately no `filter` spelling, because "everything matching the
 * current filter" resolves the set server-side *after* the operator read a
 * count — `planBulkReview` refused exactly that shape for review batching, and a
 * row selection has the same defect.
 *
 * `batchId` is supplied by the caller rather than minted here, so the id that
 * correlates the batch audit entry with its per-row ones is the same id the
 * request carried — which is what lets a caller find its own run in the log.
 *
 * Status 200 even when some rows failed, with the per-row report in the body.
 * A partial run is a real outcome rather than an error: the successes committed,
 * and a 4xx over them would tell a caller to retry writes that already landed.
 * The two 4xx cases above — a selection too large and an undeclared choice —
 * happen *before* any row is written, which is what makes them refusals of the
 * whole request rather than reports about part of it.
 */
export async function runActionHandler(
	ctx: OpContext,
	resource: string,
	actionKey: string,
	input: { ids: readonly string[]; choice?: string; batchId: string },
): Promise<ApiResponse> {
	try {
		return {
			status: 200,
			body: await opRunAction(ctx, resource, actionKey, input),
		}
	} catch (e) {
		return fail(e, { resource, operation: `action:${actionKey}` })
	}
}
