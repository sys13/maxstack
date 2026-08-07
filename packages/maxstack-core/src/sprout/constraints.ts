/**
 * Driver constraint violations, turned into errors the caller can act on.
 *
 * `fail()` (api.ts) draws its boundary at *class membership*: an error the
 * platform constructed goes back verbatim, and anything that arrived from the
 * driver becomes a generic 500 with a correlation id, because a driver error's
 * `message` is the failed statement — the SQL, the projection and the bound
 * parameters (#336). That is right for every driver failure but one.
 *
 * A unique violation is a fact **about the caller's own request**: they sent a
 * value some other row already has. Before #336 it came back as Postgres's
 * prose with a 500; after #336 it came back as `Internal error` with a 500. In
 * neither case could a client tell "you sent a duplicate" — retryable by
 * changing one field — from "the database is on fire" (#352). So the small
 * family of violations that are statements about the request get classified
 * *here*, at the store boundary, and re-thrown as a constructed error the
 * boundary already knows how to render: 409 for a duplicate, 422 for the rest.
 *
 * Two rules shape everything below.
 *
 *  1. **Classification is by SQLSTATE, never by message text.** Matching prose
 *     is how the leak got in: a matcher that reads the message is one that has
 *     the message in hand, and the next person forwards it. `code` is a
 *     five-character enum defined by Postgres, stable across versions, locales
 *     and drivers.
 *  2. **The constructed error carries fields, never the driver's strings.** The
 *     column and constraint identifiers are schema — the caller is already
 *     addressing the table by name — so naming them is safe and is the whole
 *     point. The driver's `message`, `detail` (`Key (email)=(a@b.c) already
 *     exists.`), `query` and `params` are the statement and the row, so they
 *     never cross: they stay on the original error, which the store re-throws
 *     unchanged when nothing here recognises it, and which `fail()` still
 *     reports to stderr under the correlation id.
 */

/** The violation families this module recognises, one per SQLSTATE below. */
export type ConstraintKind =
	| 'unique'
	| 'foreignKey'
	| 'check'
	| 'notNull'
	| 'exclusion'

/**
 * SQLSTATE → family. Class 23 is "integrity constraint violation" — every
 * member is a rule the *data* broke, which is what makes the whole class safe
 * to hand back: none of them is a fault in the platform, and each one is
 * repairable by the caller changing what they sent.
 *
 * Deliberately a closed table rather than a `code.startsWith('23')` test. A
 * code that is not listed stays a generic 500, which is the safe direction to
 * fail — the same reason `fail()` maps by class and leaves the unmapped
 * generic.
 */
const CONSTRAINT_SQLSTATE: Readonly<Record<string, ConstraintKind>> = {
	'23502': 'notNull',
	'23503': 'foreignKey',
	'23505': 'unique',
	'23514': 'check',
	'23P01': 'exclusion',
}

/** Suffixes Postgres appends when it names a constraint after its columns. */
const CONSTRAINT_SUFFIXES = [
	'_key',
	'_unique',
	'_pkey',
	'_fkey',
	'_check',
	'_excl',
]

/**
 * A write the database refused because it broke a declared rule.
 *
 * Constructed by {@link classifyConstraintViolation} at the store boundary and
 * rendered as 422 by `fail()` — it is a validation refusal whose rule happens
 * to live in the schema rather than in the Zod layer, so it is answered in the
 * same shape (`fieldErrors`) every write surface already renders.
 */
export class ConstraintViolationError extends Error {
	readonly resource: string
	readonly kind: ConstraintKind
	/** The DB constraint's identifier, when the driver named one. Schema, not
	 * statement text: it is what an operator greps the migration for. */
	readonly constraint?: string
	/** The resource's *declared* columns the constraint covers, resolved against
	 * the registry — so this can only ever contain names the caller could have
	 * sent. Empty when the constraint's name did not resolve to any of them. */
	readonly fields: string[]

	constructor(
		resource: string,
		kind: ConstraintKind,
		detail: { constraint?: string; fields?: string[] } = {},
	) {
		super(describeViolation(resource, kind, detail.constraint, detail.fields))
		this.name = 'ConstraintViolationError'
		this.resource = resource
		this.kind = kind
		this.constraint = detail.constraint
		this.fields = detail.fields ?? []
	}

	/** The refusal in the shape every write surface already renders. Empty when
	 * no declared column was resolvable — a form then shows the message alone
	 * rather than pinning it to a field it guessed at. */
	get fieldErrors(): Record<string, string[]> {
		return Object.fromEntries(this.fields.map((f) => [f, [this.message]]))
	}
}

/**
 * A write refused because another row already holds the value.
 *
 * Its own class rather than a `kind === 'unique'` test at the boundary, for the
 * reason `fail()`'s comment gives: the boundary switches on class membership,
 * so the one violation with a *different* HTTP answer (409, not 422) has to be
 * a different class or the next person adding a family here silently changes
 * an existing status. 409 is the honest code: nothing about the request is
 * malformed, it simply lost a race against the rows that already exist.
 */
export class ConflictError extends ConstraintViolationError {
	constructor(
		resource: string,
		detail: { constraint?: string; fields?: string[] } = {},
	) {
		super(resource, 'unique', detail)
		this.name = 'ConflictError'
	}
}

/**
 * What the caller is told. Names the offending *field* when one resolved, and
 * falls back to the constraint's identifier when none did — a caller with
 * neither has been told only that something failed, which is the state #352 is
 * about. Never interpolates anything that came off the driver as prose.
 */
function describeViolation(
	resource: string,
	kind: ConstraintKind,
	constraint: string | undefined,
	fields: string[] | undefined,
): string {
	const named =
		fields && fields.length > 0
			? fields.join(' + ')
			: constraint
				? `the "${constraint}" rule`
				: undefined
	const on = named ?? 'a rule'
	switch (kind) {
		case 'unique':
			return `Already taken: another ${resource} has this ${on}`
		case 'foreignKey':
			return `Unknown reference: ${on} on ${resource} must point at a row that exists`
		case 'notNull':
			return `Required: ${on} on ${resource} cannot be empty`
		case 'check':
			return `Not allowed: ${on} on ${resource} breaks a rule the schema declares`
		case 'exclusion':
			return `Conflicts with an existing ${resource}: ${on} overlaps a row that is already there`
	}
}

/** The driver-error shape this module reads. Every field is optional because a
 * cause chain is untyped — nothing here assumes more than "it might be there". */
interface DriverError {
	code?: unknown
	constraint?: unknown
	column?: unknown
	table?: unknown
	cause?: unknown
}

/**
 * Find the driver error carrying a SQLSTATE.
 *
 * Drizzle wraps every failure in a `DrizzleQueryError` whose own `message` is
 * the statement, and hangs the driver's error off `cause` — so the SQLSTATE is
 * one level down under both pglite and postgres.js. The chain is walked rather
 * than assumed one deep, and bounded, because a cause chain can be cyclic.
 */
function driverErrorOf(error: unknown): DriverError | undefined {
	let current = error
	for (let depth = 0; depth < 5 && current != null; depth++) {
		if (typeof current === 'object') {
			const candidate = current as DriverError
			if (
				typeof candidate.code === 'string' &&
				candidate.code in CONSTRAINT_SQLSTATE
			)
				return candidate
			current = candidate.cause
		} else return undefined
	}
	return undefined
}

/**
 * The declared columns a constraint covers.
 *
 * Postgres names an auto-generated constraint `<table>_<columns>_<suffix>`, so
 * the columns are recoverable from the identifier — but the identifier is
 * *not* trusted to produce them: the candidates are the resource's declared
 * column names, and a name is returned only when the constraint's identifier
 * contains it as a whole `_`-delimited run. So the output is always a subset of
 * the schema the caller can already see, never a fragment of whatever the DBA
 * called a hand-written constraint.
 *
 * A not-null violation names its column outright (`column`), which is exact, so
 * that wins when present. Anything unresolvable yields `[]` and the message
 * falls back to the constraint's name.
 */
function fieldsOf(driver: DriverError, columns: readonly string[]): string[] {
	if (typeof driver.column === 'string') {
		const exact = columns.find((c) => c === driver.column)
		if (exact) return [exact]
	}
	if (typeof driver.constraint !== 'string') return []
	let inner = driver.constraint
	for (const suffix of CONSTRAINT_SUFFIXES) {
		if (inner.toLowerCase().endsWith(suffix)) {
			inner = inner.slice(0, -suffix.length)
			break
		}
	}
	if (typeof driver.table === 'string') {
		const prefix = `${driver.table.toLowerCase()}_`
		if (inner.toLowerCase().startsWith(prefix))
			inner = inner.slice(prefix.length)
	}
	const haystack = `_${inner.toLowerCase()}_`
	return columns.filter((c) => haystack.includes(`_${c.toLowerCase()}_`))
}

/**
 * Classify a failure that came out of a store call, or return `undefined` for
 * anything that is not a constraint violation.
 *
 * `undefined` is the important half of the contract: the store re-throws the
 * original error untouched, so an unrecognised failure keeps reaching `fail()`
 * as the generic 500 with the detail on stderr. Nothing here can *widen* what a
 * response says — it can only replace a 500 with an answer built from the
 * registry.
 */
export function classifyConstraintViolation(
	error: unknown,
	resource: string,
	columns: readonly string[],
): ConstraintViolationError | undefined {
	const driver = driverErrorOf(error)
	if (!driver) return undefined
	const kind = CONSTRAINT_SQLSTATE[driver.code as string]
	if (!kind) return undefined
	const detail = {
		constraint:
			typeof driver.constraint === 'string' ? driver.constraint : undefined,
		fields: fieldsOf(driver, columns),
	}
	return kind === 'unique'
		? new ConflictError(resource, detail)
		: new ConstraintViolationError(resource, kind, detail)
}
