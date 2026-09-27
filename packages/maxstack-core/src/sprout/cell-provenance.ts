/**
 * Per-cell provenance — who last wrote each cell, and whether a later writer
 * outranks them (#460).
 *
 * Provenance in this platform used to stop at the spec: who *proposed* an
 * entity or a field. Nothing recorded who wrote a *value*, so "a human
 * corrected this field; stop overwriting it" had no expression, and every sync
 * integration — a declared source, an importer with an upsert key, an agent over
 * MCP — silently reverted every hand edit on its next run.
 *
 * This module is the pure half: what a stamp is, whose stamp counts as a
 * person's, and how one write is merged against the stamps a row already
 * carries. `opCreate`/`opUpdate` are the only callers, so REST, MCP, the page
 * actions, a source run and an import all meet one rule.
 *
 * ## Where the stamps live, and why there
 *
 * The issue left the storage question open — "a stamp per cell is a shadow
 * table or a JSON column, and both are unattractive at width". The answer here
 * is **one `jsonb` column on the entity's own table**, {@link
 * CELL_PROVENANCE_COLUMN}, keyed by column name, and **only for fields that
 * declare a merge policy**:
 *
 *  - **Atomic with the value it describes.** `SproutStore` has no transaction.
 *    A shadow table is a second write after `store.update`, and the window
 *    between the two is exactly the bug this exists to close: a hand edit that
 *    lands without its stamp is a hand edit the next sync reverts. In the same
 *    row, the value and its stamp are one `UPDATE`.
 *  - **The cost scales with what was declared, not with width.** A table with
 *    forty columns and one declared policy stamps one key per row. Per-field-
 *    group stamps would buy nothing over that and would make "which writer set
 *    *this* cell" unanswerable.
 *  - **It dies with the row.** A deleted row takes its stamps with it; a shadow
 *    table accumulates orphans nobody reconciles.
 *  - **It is the reference implementation's shape.** aicanvas keeps
 *    `field_provenance` as a jsonb column beside the object's data, for the
 *    same atomicity reason.
 *
 * The column is added by `from-spec.ts` only to an entity with at least one
 * declared policy, so every table that declares none is byte-for-byte what it
 * was. It is `hidden` + `readOnly`, left out of every input schema, and stripped
 * from any payload — a caller can read the stamps (that is the visibility half
 * of the issue) and can never write one.
 */

import type { IdentityOrigin, SproutUser } from './permissions.ts'
import type { Row } from './store.ts'
import type { SproutColumn } from './types.ts'

/**
 * The column a row's stamps live in. Mirrors `CELL_PROVENANCE_COLUMN` in
 * `@maxstack/spec`, which reserves the name — core cannot import the spec, so
 * the literal is carried twice and `apps/web`'s grounding test pins them equal.
 */
export const CELL_PROVENANCE_COLUMN = '_maxstack_provenance'

/**
 * Who last wrote one cell. Facts, not a verdict: whether the writer counts as a
 * person is decided at read time by {@link isHumanStamp}, so a change to that
 * rule never needs a backfill.
 */
export interface CellStamp {
	/** The identity's id — a user, `service:<role>`, a portal credential. */
	by: string
	/** How that identity reached the write — see {@link IdentityOrigin}. */
	origin: IdentityOrigin
	/** The declared source whose run wrote it, when one did. */
	source?: string
	/** The declared importer whose apply wrote it, when one did. */
	importer?: string
	/** ISO-8601. Carried so an expiry can be declared later without a migration. */
	at: string
}

/** A row's stamps, by column name. Only columns with a merge policy appear. */
export type CellStamps = Record<string, CellStamp>

/**
 * What a write says about itself beyond the identity: an import is a machine
 * write even when a person pressed the button, because the cells are the
 * file's, not theirs.
 */
export interface CellWriteVia {
	importer?: string
}

/** The stamp one write would leave on every cell it changes. */
export function stampFor(
	user: SproutUser | null,
	via: CellWriteVia = {},
	at: string = new Date().toISOString(),
): CellStamp {
	return {
		by: user?.id ?? 'anonymous',
		// Defaulted exactly as the audit entry defaults it (`record` in
		// operations.ts), so a stamp and the audit line for the same write never
		// disagree about who made it.
		origin: user?.origin ?? 'session',
		...(user?.sourceKey ? { source: user.sourceKey } : {}),
		...(via.importer ? { importer: via.importer } : {}),
		at,
	}
}

/**
 * Whether a stamp records a *person's* write — the one kind `humanEditWins`
 * protects.
 *
 * A person is a signed-in session or somebody on a declared portal form. Every
 * other writer is a machine: an agent over MCP, an api key (a script holding a
 * person's credential is still a script), a system job — and any write carrying
 * a source or importer key, whatever its origin, because a manual source run
 * borrows the operator's identity without the operator having typed the value.
 * Deny-by-default in that direction on purpose: a new origin nobody classified
 * is a machine, so it can never quietly pin a cell against a sync.
 */
export function isHumanStamp(stamp: CellStamp | undefined): boolean {
	if (!stamp) return false
	if (stamp.source || stamp.importer) return false
	return stamp.origin === 'session' || stamp.origin === 'portal'
}

/**
 * The stamps a stored row carries, tolerating the shapes a driver can hand back
 * (an object from pglite/postgres.js, a string from anything that did not parse
 * `jsonb`) and anything malformed. A row with unreadable stamps reads as
 * unstamped — last-wins, the behaviour before this existed — rather than as a
 * failed write.
 */
export function readStamps(row: Row | null | undefined): CellStamps {
	let raw: unknown = row?.[CELL_PROVENANCE_COLUMN]
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			return {}
		}
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
	const out: CellStamps = {}
	for (const [column, stamp] of Object.entries(raw)) {
		if (
			stamp &&
			typeof stamp === 'object' &&
			typeof (stamp as CellStamp).by === 'string' &&
			typeof (stamp as CellStamp).origin === 'string' &&
			typeof (stamp as CellStamp).at === 'string'
		)
			out[column] = stamp as CellStamp
	}
	return out
}

/** Whether a column is the stamps column itself. */
export function isCellProvenanceColumn(column: SproutColumn): boolean {
	return column.meta.cellProvenance === true
}

const isEmpty = (value: unknown) =>
	value === null || value === undefined || value === ''

/**
 * Whether a write leaves a cell holding what it already held.
 *
 * This is what keeps a full-form save from claiming every cell on the form: the
 * edit page posts every field, and a person who changed the title has not
 * "written" the cover URL they never touched. Dates are compared as instants,
 * because the driver hands back `2026-01-02 03:04:05` for a value a form sent as
 * `2026-01-02T03:04:05` and those are the same cell.
 */
function sameValue(
	column: SproutColumn,
	next: unknown,
	prev: unknown,
): boolean {
	if (isEmpty(next) && isEmpty(prev)) return true
	if (column.type === 'date') {
		const instant = (v: unknown) =>
			v instanceof Date
				? v.getTime()
				: typeof v === 'string'
					? Date.parse(v.replace(' ', 'T'))
					: Number.NaN
		const a = instant(next)
		const b = instant(prev)
		if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b
	}
	return JSON.stringify(next) === JSON.stringify(prev)
}

/** One write, merged against the stamps its row already carries. */
export interface CellMerge {
	/** The payload to hand the store — held cells removed, stamps added. */
	data: Row
	/**
	 * Columns this write named and did not get, because a person's value holds
	 * them. Only columns whose value would have *changed* are listed: a sync that
	 * re-sends the value a person already set is not being refused anything.
	 */
	held: string[]
}

/**
 * Merge one write against a row's stamps — the whole rule, in one place.
 *
 * For every column the payload names that declares a merge policy:
 *
 *  1. A **machine** writer, a column with `humanEditWins`, and a cell whose last
 *     writer was a **person** → the column is dropped from the payload and
 *     reported in `held`. The write's other columns still land: one held cell is
 *     not a reason to refuse a sync its other nineteen.
 *  2. Otherwise, if the value actually changes (or, on a create, is non-empty),
 *     the cell is stamped with this write's stamp.
 *
 * A column with no policy is untouched in both directions — no stamp, no hold —
 * so a resource with no declared policy gets back exactly the payload it sent.
 * A person always outranks a person: the rule is about machines overwriting
 * people, not about freezing a cell.
 */
export function mergeCellWrite(args: {
	columns: readonly SproutColumn[]
	/** The row as stored, or `null` for a create. */
	existing: Row | null
	/** The validated payload. */
	data: Row
	stamp: CellStamp
}): CellMerge {
	const { columns, existing, data, stamp } = args
	const governed = columns.filter((c) => c.meta.merge)
	if (governed.length === 0) return { data, held: [] }

	const prior = readStamps(existing)
	const human = isHumanStamp(stamp)
	const out: Row = { ...data }
	const next: CellStamps = { ...prior }
	const held: string[] = []
	let stamped = false

	for (const column of governed) {
		const name = column.name
		if (!(name in data)) continue
		const value = data[name]
		if (existing) {
			const unchanged = sameValue(column, value, existing[name])
			if (
				!human &&
				column.meta.merge?.humanEditWins === true &&
				isHumanStamp(prior[name])
			) {
				delete out[name]
				if (!unchanged) held.push(name)
				continue
			}
			if (unchanged) continue
		} else if (isEmpty(value)) {
			// A blank field on a create form is not a person deciding the cell
			// should stay blank — stamping it would stop an enrichment from ever
			// filling the cover a person simply had not looked up yet.
			continue
		}
		next[name] = stamp
		stamped = true
	}

	if (stamped) out[CELL_PROVENANCE_COLUMN] = next
	return { data: out, held }
}
