/**
 * The `DataProvider` — the single seam between the typed hooks and a backend.
 * `createRestDataProvider` speaks Sprout's REST dialect exactly as the
 * `api.$resource` routes expose it (`?limit`/`?offset`/`?orderBy`/`?orderDir`,
 * repeatable `?searchField=`, `?filter.<col>=`, and `?ids=` batch-get). Swapping
 * the provider (e.g. for tests or a non-REST backend) leaves every hook and
 * component untouched — the react-admin architecture, minus the config.
 */

export interface SortParam {
	field: string
	order: 'asc' | 'desc'
}

export interface PaginationParam {
	/** 1-based page number. */
	page: number
	perPage: number
}

export interface GetListParams {
	filter?: Record<string, string | number | boolean | null>
	/** Inclusive `>=`/`<=` bounds per column — the numeric/date range dual of the
	 * equality-only {@link filter}. Encoded as `?filter.<col>.gte=`/`.lte=`. */
	range?: Record<string, { gte?: string | number; lte?: string | number }>
	sort?: SortParam
	pagination?: PaginationParam
	/** Case-insensitive substring search across {@link searchFields}. */
	search?: string
	searchFields?: string[]
}

export interface GetListResult<T = Record<string, unknown>> {
	data: T[]
	/** Best-effort total. Sprout's list endpoint returns a bare array, so this
	 * falls back to the page length; a backend that reports a count can override
	 * it via a `X-Total-Count` header. */
	total: number
}

export type RecordId = string

/** The transport is intentionally record-typed, not generic: a concrete
 * implementation (or a test mock) has to be *assignable* to this, which a
 * caller-chosen `<T>` on each method would forbid. The per-record typing lives
 * one layer up, on the hooks (`useList<Post>`), which cast these results — the
 * public DX is fully typed, the seam stays mockable. */
export interface DataProvider {
	getList(resource: string, params?: GetListParams): Promise<GetListResult>
	getOne(resource: string, id: RecordId): Promise<Record<string, unknown>>
	getMany(
		resource: string,
		ids: readonly RecordId[],
	): Promise<Record<string, unknown>[]>
	create(
		resource: string,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>>
	update(
		resource: string,
		id: RecordId,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>>
	delete(resource: string, id: RecordId): Promise<{ id: RecordId }>
}

/** Thrown for a non-2xx response. Carries the status and parsed body so a
 * caller can surface `fieldErrors` (422) or a permission message (403). */
export class DataProviderError extends Error {
	readonly status: number
	readonly body: unknown
	constructor(status: number, body: unknown) {
		const message =
			body && typeof body === 'object' && 'error' in body
				? String((body as { error: unknown }).error)
				: `Request failed with status ${status}`
		super(message)
		this.name = 'DataProviderError'
		this.status = status
		this.body = body
	}
}

/**
 * Pull the per-field validation errors out of a failed mutation, ready to hand
 * to `<DynamicForm serverErrors={…}>`. Sprout's API returns 422 with a
 * `{ fieldErrors: { <field>: string[] } }` body (see sprout/api.ts); this reads
 * that shape off a {@link DataProviderError} and returns `undefined` for any
 * other failure (network, 403, 500), so a caller can wire it in one line:
 *
 * ```ts
 * try { await create(values) }
 * catch (e) { setServerErrors(fieldErrorsFrom(e)) }
 * ```
 */
export function fieldErrorsFrom(
	error: unknown,
): Record<string, string[]> | undefined {
	if (!(error instanceof DataProviderError) || error.status !== 422)
		return undefined
	const body = error.body
	if (!body || typeof body !== 'object' || !('fieldErrors' in body))
		return undefined
	const fieldErrors = (body as { fieldErrors: unknown }).fieldErrors
	if (!fieldErrors || typeof fieldErrors !== 'object') return undefined
	return fieldErrors as Record<string, string[]>
}

export interface RestDataProviderOptions {
	/** API mount point, no trailing slash (default `/api`). */
	apiBase?: string
	/** Injectable `fetch` — lets tests assert URLs without a network. */
	fetch?: typeof fetch
}

export function createRestDataProvider(
	options: RestDataProviderOptions = {},
): DataProvider {
	const apiBase = (options.apiBase ?? '/api').replace(/\/$/, '')
	const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

	async function request<T = Record<string, unknown>>(
		url: string,
		init?: RequestInit,
	): Promise<T> {
		const res = await doFetch(url, {
			...init,
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				...init?.headers,
			},
		})
		const body = res.status === 204 ? null : await res.json().catch(() => null)
		if (!res.ok) throw new DataProviderError(res.status, body)
		return body as T
	}

	function totalFrom(res: Response | null, data: unknown[]): number {
		const header = res?.headers.get('x-total-count')
		const n = header != null ? Number.parseInt(header, 10) : Number.NaN
		return Number.isFinite(n) ? n : data.length
	}

	return {
		async getList(resource, params = {}) {
			const url = new URL(`${apiBase}/${resource}`, listBase())
			const { pagination, sort, filter, range, search, searchFields } = params
			if (pagination) {
				url.searchParams.set('limit', String(pagination.perPage))
				url.searchParams.set(
					'offset',
					String((pagination.page - 1) * pagination.perPage),
				)
			}
			if (sort) {
				url.searchParams.set('orderBy', sort.field)
				url.searchParams.set('orderDir', sort.order)
			}
			if (search) url.searchParams.set('search', search)
			for (const f of searchFields ?? [])
				url.searchParams.append('searchField', f)
			for (const [k, v] of Object.entries(filter ?? {}))
				if (v != null) url.searchParams.set(`filter.${k}`, String(v))
			for (const [k, r] of Object.entries(range ?? {})) {
				if (r.gte != null && r.gte !== '')
					url.searchParams.set(`filter.${k}.gte`, String(r.gte))
				if (r.lte != null && r.lte !== '')
					url.searchParams.set(`filter.${k}.lte`, String(r.lte))
			}

			const res = await doFetch(pathOf(url), {
				headers: { accept: 'application/json' },
			})
			const data = res.status === 204 ? [] : await res.json()
			if (!res.ok) throw new DataProviderError(res.status, data)
			const rows = (Array.isArray(data) ? data : []) as Record<
				string,
				unknown
			>[]
			return { data: rows, total: totalFrom(res, rows) }
		},

		getOne(resource, id) {
			return request(`${apiBase}/${resource}/${encodeURIComponent(id)}`)
		},

		async getMany(resource, ids) {
			if (ids.length === 0) return []
			const q = new URLSearchParams({ ids: ids.join(',') })
			return request<Record<string, unknown>[]>(
				`${apiBase}/${resource}?${q.toString()}`,
			)
		},

		create(resource, data) {
			return request(`${apiBase}/${resource}`, {
				method: 'POST',
				body: JSON.stringify(data),
			})
		},

		update(resource, id, data) {
			return request(`${apiBase}/${resource}/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				body: JSON.stringify(data),
			})
		},

		async delete(resource, id) {
			await request(`${apiBase}/${resource}/${encodeURIComponent(id)}`, {
				method: 'DELETE',
			})
			return { id }
		},
	}
}

/** A base for `new URL` when `apiBase` is a relative path and there's no
 * `window` (SSR/tests). The origin is discarded by {@link pathOf}. */
function listBase(): string {
	return typeof window !== 'undefined' && window.location
		? window.location.origin
		: 'http://localhost'
}

/** Emit a relative URL when the origin is the synthetic base, so requests stay
 * same-origin exactly as a hand-written `fetch('/api/...')` would. */
function pathOf(url: URL): string {
	return `${url.pathname}${url.search}`
}
