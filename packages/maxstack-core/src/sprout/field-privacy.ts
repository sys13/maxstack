/**
 * Where a field's `encrypted` / `mask` declaration is *enforced*.
 *
 * `field-crypto.ts` holds the primitive; this module is the policy, and it lives
 * one layer above the store so that every caller passes it. That placement is
 * the whole security argument, and it is the same one that moved authorization
 * out of the routes: REST, the MCP tools, the admin loaders, a rendered
 * document, an import, a live push and a related-records panel all reach rows
 * through `operations.ts` and through nothing else. A mask applied in a table
 * cell would be a mask five of those six callers skip.
 *
 * Three things happen here and nowhere else:
 *
 *  1. **Seal on write.** A declared-encrypted column is sealed after validation
 *     (so the *plaintext* is what gets length-checked and pattern-checked) and
 *     immediately before the store write, so no code path between them can see
 *     a plaintext row it might log.
 *  2. **Open on read, for callers who hold the capability.** Everyone else gets
 *     the masked form. "The capability" is a declared role allowlist, and its
 *     default is nobody — an omitted allowlist must never read as "everyone".
 *  3. **Refuse the probes.** Ordering or filtering by a column the caller reads
 *     masked is a comparison oracle over the exact value the mask hid, so it is
 *     refused rather than ignored — the same argument `assertPortalReadShape`
 *     makes, one declaration over.
 *
 * A column that holds an unsealed value — a row that predates the declaration,
 * a demo seed written through the store directly — is **read back as-is and
 * still masked**. Throwing would take the whole table down over one legacy row,
 * and masking is what keeps that tolerance from being a leak.
 */

import {
	configuredFieldKey,
	isSealed,
	type MaskMeta,
	MissingFieldKeyError,
	maskValue,
	openValue,
	requireFieldKey,
	sealValue,
} from './field-crypto.ts'
import type { SproutUser } from './permissions.ts'
import type { RegisteredResource } from './registry.ts'
import type { Row } from './store.ts'

/** One column's declared privacy posture, as the ops layer reads it. */
export interface ColumnPrivacy {
	column: string
	encrypted: boolean
	mask?: MaskMeta
}

/**
 * The privacy-relevant columns of a resource, derived from the introspected
 * column metadata the spec bridge stamped.
 *
 * Cached per registry entry: this runs on every row of every read, and the
 * answer is a property of the schema rather than of the request.
 */
const planCache = new WeakMap<RegisteredResource, ColumnPrivacy[]>()

export function columnPrivacy(entry: RegisteredResource): ColumnPrivacy[] {
	const cached = planCache.get(entry)
	if (cached) return cached
	const plan: ColumnPrivacy[] = []
	for (const column of entry.resource.columns) {
		const encrypted = column.meta.encrypted === true
		const mask = column.meta.mask as MaskMeta | undefined
		if (encrypted || mask)
			plan.push({ column: column.name, encrypted, ...(mask ? { mask } : {}) })
	}
	planCache.set(entry, plan)
	return plan
}

/** The AAD every seal and every keyed mask is bound to: a value belongs to one
 * column of one table, and a ciphertext moved out of it must not open. */
function binding(resource: string, column: string): string {
	return `${resource}:${column}`
}

/**
 * Whether this caller reads the column unmasked.
 *
 * Closed by default in all three directions that matter:
 *
 *  - **No allowlist means nobody.** A field declared `mask` with no
 *    `unmaskRoles` is masked for every caller the platform has, and the
 *    plaintext is reachable only by owned code holding the key. An omitted list
 *    reading as "everyone" would make the safest-looking declaration the most
 *    permissive one.
 *  - **A portal never unmasks.** An outside identity holds a declared, narrow
 *    capability over one resource; it has no role, and inventing one for it is
 *    how a public page ends up printing a tax id.
 *  - **An anonymous caller never unmasks**, for the same reason.
 */
export function canUnmask(
	user: SproutUser | null,
	mask: MaskMeta | undefined,
): boolean {
	if (!mask) return true
	if (user?.portal) return false
	const role = user?.role
	if (typeof role !== 'string' || role === '') return false
	return (mask.unmaskRoles ?? []).includes(role)
}

/**
 * Refuse to boot when a spec declares field encryption and the deployment has
 * no key.
 *
 * Called from `registerSpecEntities`, so it fires while the app is coming up
 * rather than on the first write. That ordering is the point: the alternative —
 * discovering it at write time — means the first person to save a credential
 * gets an error, and every path that swallows errors stores plaintext instead.
 *
 * A `hash` mask needs the key too, and for a reason worth stating: the token is
 * an HMAC, not a bare digest, because an unsalted SHA-256 of a nine-digit
 * number is a lookup table rather than a mask.
 */
export function assertFieldKeyForSpec(
	entities: readonly {
		name: string
		fields: readonly { name: string; encrypted?: boolean; mask?: MaskMeta }[]
	}[],
): void {
	for (const entity of entities) {
		for (const field of entity.fields) {
			const needsKey = field.encrypted === true || field.mask?.style === 'hash'
			if (!needsKey) continue
			// `configuredFieldKey` throws on a key that is set but unusable, which is
			// the other half of "fail loudly": a truncated paste must not degrade to
			// "no key configured" and then to plaintext.
			if (!configuredFieldKey())
				throw new MissingFieldKeyError(`field "${entity.name}.${field.name}"`)
		}
	}
}

/**
 * Seal every declared-encrypted column in a write payload.
 *
 * Idempotent by construction: a value that is already an envelope passes
 * through, so a caller that echoed a row back (the admin form's round trip,
 * an importer's upsert) cannot double-seal it into something nothing can open.
 * `null`/`undefined` pass through too — an absent value is not a secret, and
 * sealing one would make "is this column set?" unanswerable by a query.
 */
export async function sealRow(
	entry: RegisteredResource,
	data: Row,
): Promise<Row> {
	const plan = columnPrivacy(entry).filter((p) => p.encrypted)
	if (plan.length === 0) return data
	const out: Row = { ...data }
	for (const { column } of plan) {
		if (!(column in out)) continue
		const value = out[column]
		if (value === null || value === undefined || value === '') continue
		if (isSealed(value)) continue
		const key = requireFieldKey(`column "${entry.resource.name}.${column}"`)
		out[column] = await sealValue(
			String(value),
			key,
			binding(entry.resource.name, column),
		)
	}
	return out
}

/**
 * Open and/or mask every privacy-declared column on the way out.
 *
 * Order matters and is deliberate: **decrypt first, then mask**. A `last4` mask
 * over a ciphertext would render the last four characters of base64, which is
 * not a mask of the value — it is a mask of the envelope, and it looks
 * convincing enough that nobody would check.
 */
export async function openRows(
	entry: RegisteredResource,
	user: SproutUser | null,
	rows: readonly Row[],
): Promise<Row[]> {
	const plan = columnPrivacy(entry)
	if (plan.length === 0 || rows.length === 0) return [...rows]
	const key = configuredFieldKey()
	const out: Row[] = []
	for (const row of rows) {
		const next: Row = { ...row }
		for (const { column, encrypted, mask } of plan) {
			if (!(column in next)) continue
			let value = next[column]
			if (value === null || value === undefined) continue
			if (encrypted && isSealed(value)) {
				// A row this process cannot open must not fall through to the caller as
				// ciphertext: an envelope in a REST payload is the stored bytes, handed
				// out. It reads as `null` — the column is unreadable here, which is the
				// honest answer — and the reason is thrown only when the caller was
				// entitled to the plaintext.
				if (!key) {
					next[column] = null
					continue
				}
				try {
					value = await openValue(
						String(value),
						key,
						binding(entry.resource.name, column),
						column,
					)
				} catch (error) {
					if (canUnmask(user, mask)) throw error
					next[column] = null
					continue
				}
			}
			next[column] = canUnmask(user, mask)
				? value
				: await maskValue(
						value,
						mask ?? { style: 'redact' },
						key,
						binding(entry.resource.name, column),
					)
		}
		out.push(next)
	}
	return out
}

/**
 * Drop a masked column from an update payload when the caller is handing back
 * the mask they were shown.
 *
 * Without this, the platform's own admin form is a data-loss bug: it loads a
 * row, renders `••••1234`, and submits every field — writing the bullets over
 * the value. Comparing against the mask of the *stored* value (rather than
 * against a bullet pattern) is what makes it precise: a caller who typed a new
 * value that happens to look like a mask still writes it, and a caller who
 * changed nothing writes nothing.
 */
export async function stripEchoedMasks(
	entry: RegisteredResource,
	user: SproutUser | null,
	existing: Row,
	data: Row,
): Promise<Row> {
	const plan = columnPrivacy(entry).filter(
		(p) => p.mask && !canUnmask(user, p.mask),
	)
	if (plan.length === 0) return data
	const [opened] = await openRows(entry, user, [existing])
	if (!opened) return data
	const out: Row = { ...data }
	for (const { column } of plan) {
		if (!(column in out)) continue
		if (out[column] === opened[column]) delete out[column]
	}
	return out
}

/**
 * Refuse a read that orders, filters or searches by a column this caller reads
 * masked.
 *
 * This is the same real attack `assertPortalReadShape` documents. `ORDER BY
 * ssn` never shows a value, but the *permutation* of rows the caller can see is
 * a comparison oracle, and a few dozen paged requests reconstruct the ordering
 * exactly; an equality filter is the blunter version, answering "is this row's
 * value X?" one guess at a time. An encrypted column is worse than useless as a
 * predicate on top of that — every row has a fresh IV, so equality never
 * matches and ordering is over random bytes — which makes refusing it a
 * correction as well as a defense.
 *
 * Refused, never silently ignored: a leak that stops working quietly is
 * indistinguishable, to whoever is probing, from one that still works.
 */
export function assertNoMaskedProbe(
	entry: RegisteredResource,
	user: SproutUser | null,
	opts: {
		orderBy?: string
		filter?: Record<string, unknown>
		searchFields?: readonly string[]
	},
	deny: (column: string) => never,
): void {
	const plan = columnPrivacy(entry)
	if (plan.length === 0) return
	const opaque = new Set(
		plan
			.filter((p) => p.encrypted || !canUnmask(user, p.mask))
			.map((p) => p.column),
	)
	if (opaque.size === 0) return
	if (opts.orderBy !== undefined && opaque.has(opts.orderBy)) deny(opts.orderBy)
	for (const key of Object.keys(opts.filter ?? {}))
		if (opaque.has(key)) deny(key)
	for (const field of opts.searchFields ?? [])
		if (opaque.has(field)) deny(field)
}
