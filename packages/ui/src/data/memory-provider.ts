/**
 * `createMemoryDataProvider` (Plan v5 task 47) — a second `DataProvider` adapter,
 * backed by in-memory arrays instead of REST. Its purpose is to prove the REST
 * dialect isn't load-bearing: the same `<ResourceList>`/`<Show>` and the whole
 * hook family run unchanged against it (the task-47 exit criterion). It's also
 * the fixture backend for tests, demos, and offline/optimistic prototyping — no
 * server required.
 *
 * It implements the full `DataProvider` contract (list with
 * filter/range/sort/pagination/search, getOne/getMany, CRUD) plus the optional
 * {@link AggregateProvider} extension (`count`/`aggregate`), which it can serve
 * cheaply because it holds every row. The REST provider defers aggregates to a
 * backend endpoint; a provider that has the data answers directly.
 */

import type {
	DataProvider,
	GetListParams,
	GetListResult,
	RecordId,
} from './data-provider.ts'

type Rec = Record<string, unknown>

/** The optional aggregate extension a provider may implement. Hooks feature-detect
 * it (`'aggregate' in provider`) so a REST provider without a count endpoint stays
 * valid — it simply doesn't offer `useCount`/`useAggregate`. */
export interface AggregateProvider {
	/** Number of records matching the (optional) list filter/search. */
	count(resource: string, params?: GetListParams): Promise<number>
	/** A single numeric aggregate over a column. */
	aggregate(
		resource: string,
		op: AggregateOp,
		field: string,
		params?: GetListParams,
	): Promise<number>
}

export type AggregateOp = 'sum' | 'avg' | 'min' | 'max' | 'count'

export interface MemoryDataProviderOptions {
	/** Seed data keyed by resource name. */
	data?: Record<string, Rec[]>
	/** Primary-key field (default `id`). */
	idField?: string
	/** Id generator for `create` when the record carries none. Deterministic by
	 * default (a per-resource counter) so tests don't need a clock/rng. */
	generateId?: (resource: string, existing: Rec[]) => RecordId
}

function defaultIdGen(idField: string) {
	const counters = new Map<string, number>()
	return (resource: string, existing: Rec[]): RecordId => {
		const start = counters.get(resource) ?? existing.length
		let n = start + 1
		const ids = new Set(existing.map((r) => String(r[idField])))
		while (ids.has(String(n))) n++
		counters.set(resource, n)
		return String(n)
	}
}

function matchesFilter(row: Rec, params: GetListParams): boolean {
	const { filter, range, search, searchFields } = params
	for (const [k, v] of Object.entries(filter ?? {})) {
		if (v == null) continue
		// Loose equality so `filter: { published: true }` matches a `1`/`"true"`
		// the way a query string round-trips would.
		if (String(row[k]) !== String(v)) return false
	}
	for (const [k, r] of Object.entries(range ?? {})) {
		const cell = row[k]
		if (r.gte != null && r.gte !== '' && !(compareLoose(cell, r.gte) >= 0))
			return false
		if (r.lte != null && r.lte !== '' && !(compareLoose(cell, r.lte) <= 0))
			return false
	}
	if (search && search.trim() !== '') {
		const needle = search.toLowerCase()
		const fields =
			searchFields && searchFields.length > 0 ? searchFields : Object.keys(row)
		const hit = fields.some((f) =>
			String(row[f] ?? '')
				.toLowerCase()
				.includes(needle),
		)
		if (!hit) return false
	}
	return true
}

function compareLoose(a: unknown, b: unknown): number {
	const na = typeof a === 'number' ? a : Number(a)
	const nb = typeof b === 'number' ? b : Number(b)
	if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
	return String(a).localeCompare(String(b))
}

function applyList(rows: Rec[], params: GetListParams): Rec[] {
	let out = rows.filter((r) => matchesFilter(r, params))
	if (params.sort) {
		const { field, order } = params.sort
		out = [...out].sort((a, b) => {
			const c = compareLoose(a[field], b[field])
			return order === 'desc' ? -c : c
		})
	}
	return out
}

export function createMemoryDataProvider(
	options: MemoryDataProviderOptions = {},
): DataProvider & AggregateProvider {
	const idField = options.idField ?? 'id'
	const gen = options.generateId ?? defaultIdGen(idField)
	// Deep-ish clone the seed so callers can't mutate our store by reference.
	const store = new Map<string, Rec[]>()
	for (const [resource, rows] of Object.entries(options.data ?? {})) {
		store.set(
			resource,
			rows.map((r) => ({ ...r })),
		)
	}

	const rowsOf = (resource: string): Rec[] => {
		let rows = store.get(resource)
		if (!rows) {
			rows = []
			store.set(resource, rows)
		}
		return rows
	}
	const find = (resource: string, id: RecordId): Rec | undefined =>
		rowsOf(resource).find((r) => String(r[idField]) === String(id))

	return {
		async getList(resource, params = {}): Promise<GetListResult> {
			const filtered = applyList(rowsOf(resource), params)
			const total = filtered.length
			let page = filtered
			if (params.pagination) {
				const { page: p, perPage } = params.pagination
				const start = (p - 1) * perPage
				page = filtered.slice(start, start + perPage)
			}
			return { data: page.map((r) => ({ ...r })), total }
		},

		async getOne(resource, id) {
			const row = find(resource, id)
			if (!row) throw new Error(`${resource} ${id} not found`)
			return { ...row }
		},

		async getMany(resource, ids) {
			const set = new Set(ids.map(String))
			return rowsOf(resource)
				.filter((r) => set.has(String(r[idField])))
				.map((r) => ({ ...r }))
		},

		async create(resource, data) {
			const rows = rowsOf(resource)
			const id =
				data[idField] != null ? String(data[idField]) : gen(resource, rows)
			const record = { ...data, [idField]: id }
			rows.push(record)
			return { ...record }
		},

		async update(resource, id, data) {
			const row = find(resource, id)
			if (!row) throw new Error(`${resource} ${id} not found`)
			Object.assign(row, data, { [idField]: row[idField] })
			return { ...row }
		},

		async delete(resource, id) {
			const rows = rowsOf(resource)
			const i = rows.findIndex((r) => String(r[idField]) === String(id))
			if (i >= 0) rows.splice(i, 1)
			return { id }
		},

		async count(resource, params = {}) {
			return applyList(rowsOf(resource), params).length
		},

		async aggregate(resource, op, field, params = {}) {
			const rows = applyList(rowsOf(resource), params)
			if (op === 'count') return rows.length
			const nums = rows
				.map((r) => Number(r[field]))
				.filter((n) => Number.isFinite(n))
			if (nums.length === 0) return 0
			switch (op) {
				case 'sum':
					return nums.reduce((a, b) => a + b, 0)
				case 'avg':
					return nums.reduce((a, b) => a + b, 0) / nums.length
				case 'min':
					return Math.min(...nums)
				case 'max':
					return Math.max(...nums)
			}
		},
	}
}
