/**
 * Framework-agnostic REST handlers. An RR7 `api.$resource` route is a thin
 * adapter over these: parse the request, call the handler, return the JSON.
 * All authorization/validation lives in operations.ts.
 */

import {
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
	opSearch,
	opSearchCount,
	opUpdate,
	UnknownResourceError,
	UnsupportedOperationError,
	ValidationError,
} from './operations.ts'
import { PermissionError } from './permissions.ts'
import type { ListOptions, Row } from './store.ts'

export interface ApiResponse<T = unknown> {
	status: number
	body: T
}

function fail(e: unknown): ApiResponse {
	if (e instanceof ValidationError) {
		// Every 422 is repair instructions: `error` names the
		// resource, the operation and every rejected field; `fieldErrors` states
		// per field what was expected, what arrived and an example that works; and
		// `fields` carries the same contract machine-readably, so a client can act
		// on it without parsing prose.
		return {
			status: 422,
			body: { error: e.message, fieldErrors: e.fieldErrors, fields: e.fields },
		}
	}
	// A declared WIP limit. 422 with `fieldErrors`, exactly like a
	// validation refusal — it *is* one, just one whose rule is about the other
	// rows rather than about this one — plus the numbers a UI wants to render.
	if (e instanceof LimitExceededError) {
		return {
			status: 422,
			body: {
				error: e.message,
				fieldErrors: e.fieldErrors,
				limit: {
					field: e.field,
					value: e.value,
					limit: e.limit,
					current: e.current,
				},
			},
		}
	}
	if (e instanceof PermissionError) {
		return { status: 403, body: { error: e.message } }
	}
	if (e instanceof NotFoundError) {
		return { status: 404, body: { error: e.message } }
	}
	if (e instanceof UnknownResourceError) {
		return { status: 404, body: { error: e.message } }
	}
	if (e instanceof UnsupportedOperationError) {
		return { status: 422, body: { error: e.message } }
	}
	return {
		status: 500,
		body: { error: e instanceof Error ? e.message : String(e) },
	}
}

export async function listHandler(
	ctx: OpContext,
	resource: string,
	opts?: ListOptions,
): Promise<ApiResponse> {
	try {
		return { status: 200, body: await opList(ctx, resource, opts) }
	} catch (e) {
		return fail(e)
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
		return fail(e)
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
		return fail(e)
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
		return fail(e)
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
		return fail(e)
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
		return fail(e)
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
		return fail(e)
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
		return fail(e)
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
		return fail(e)
	}
}
