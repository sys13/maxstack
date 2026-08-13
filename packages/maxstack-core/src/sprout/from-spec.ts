/**
 * Spec→Sprout bridge — materialize a spec's data layer as live Sprout
 * resources, so the admin CRUD (and everything else the registry drives) runs
 * over a *project's own* entities instead of the demo schema.
 *
 * Layering: `@maxstack/core` does not depend on `@maxstack/spec`, so the
 * bridge takes a structural {@link SpecEntityShape} (name + typed fields).
 * The caller (e.g. apps/web) grounds the spec first — `getAcceptedOrAll`
 * over entities and fields — and hands the shapes in.
 *
 * Schema evolution is **additive-only by construction**: the v1 spec-op
 * vocabulary can only add entities/fields, so `ensureSpecSchema` is
 * `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` — idempotent, and
 * safe to re-run against a live database every time the spec grows. Columns
 * are nullable at the DB layer (a required field added to a table with
 * existing rows must not fail the ALTER); requiredness is enforced where the
 * platform already enforces it — the `withMeta({ required })` → Zod
 * validation path.
 */

// Type-only: keep the Node-only pglite driver out of this module's static
// import graph — it flows through the `@maxstack/core` barrel into client
// bundles. `createSpecDb` (the only pglite instantiation, test-only) lazy-loads
// the driver, like `sprout/backend.ts` does for postgres.js / node:fs.
import type { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import {
	type AnyPgColumnBuilder,
	boolean,
	jsonb,
	type PgTable,
	pgTable,
	real,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { createDrizzleStore } from '../demo/store.ts'
import type { ActionPlan } from './actions.ts'
import type { StoreBackend } from './backend.ts'
import type { ComputedShape, RollupShape } from './derived.ts'
import type { DocumentPlan } from './documents.ts'
import type { ImportPlanShape } from './imports.ts'
import type { LivePlan } from './live.ts'
import {
	type ResourceAccess,
	type SproutAction,
	toAccessRule,
} from './permissions.ts'
import type { PortalPlan } from './portals.ts'
import type { RegisteredResource, ResourceRegistry } from './registry.ts'
import { formatLabel } from './registry.ts'
import { withMeta } from './schema-builder.ts'
import { type SearchIndexPlan, searchIndexDdl } from './search.ts'
import type { SproutStore } from './store.ts'
import type {
	ColumnMetadata,
	FileDerivativeMeta,
	SproutColumnReference,
} from './types.ts'

/** Mirrors the spec layer's `FieldType` (structurally, not by import). */
export type SpecFieldType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'date'
	| 'enum'
	| 'json'
	| 'file'

/**
 * A declared file field's constraints, mirrored structurally from
 * the spec's `FileFieldSpec`. The column itself is plain `text` holding a
 * **storage key** — the bytes live behind the storage bundle's provider and the
 * read path re-signs the key on every render, so nothing here is a URL.
 */
export interface SpecFileShape {
	accept: string[]
	maxSizeBytes: number
	derivatives?: FileDerivativeMeta[]
}

export interface SpecFieldShape {
	name: string
	type: SpecFieldType
	required: boolean
	/**
	 * A belongs-to foreign key: this field stores `reference.table`'s id and the
	 * read side resolves it to `reference.displayField`. Resolved by the caller
	 * (`groundedEntityShapes`) from the spec's `field.reference` entity id — core
	 * stays free of the `e-` id convention. When set, the column is an id-typed
	 * FK (`uuid`, or `text` when `reference.idType` says so — bundle infra tables
	 * like better-auth's user) carrying `meta.reference`, so
	 * introspection surfaces it as a relation.
	 */
	reference?: SproutColumnReference
	/** Enum option list — carried into `meta.options`/`meta.enumValues` so the
	 * form renders a select and the read side a chip (was dropped pre-task-32). */
	options?: { label: string; value: string }[]
	/** Required when `type` is `'file'` — carried into `meta.isFile` /
	 * `meta.fileAccept` / `meta.fileMaxSize` / `meta.fileDerivatives`, which is
	 * what makes the upload widget and the server-side wall agree. */
	file?: SpecFileShape
	/**
	 * A manual-ordering key. The column is `text` with a database
	 * default, so it is populated for every row the instant it exists — including
	 * the rows that predate the declaration. That is the property the whole
	 * reorder design rests on: with a nullable rank column there is an unordered
	 * region no single-row write can place a card into.
	 */
	rank?: boolean
	/**
	 * Per-value row caps on an enum column — a WIP limit. Carried
	 * into `meta.valueLimits`, which `opCreate`/`opUpdate` enforce, so the cap
	 * binds REST and MCP callers exactly as it binds the UI.
	 */
	limits?: Record<string, number>
	/**
	 * A number column's declared presentation — the spec's `field.display`
	 * (#345). Carried into `meta.format` / `meta.min` / `meta.max` / `meta.step`,
	 * which is where the field library already looked: the rating, slider and
	 * duration widgets read exactly these, and the only thing that was missing
	 * was a path from the spec to them.
	 *
	 * `format` also *opposes* the widget inference the field library does from a
	 * column's name — `format: 'number'` keeps a column called `rating` a plain
	 * number input. Dropping this here would leave the author's declaration
	 * written down and silently ignored, which is the failure the whole key
	 * exists to end.
	 */
	display?: {
		format?: string
		min?: number
		max?: number
		step?: number
	}
	/**
	 * A column's declared filter control — the spec's `field.filter` (#414).
	 * Carried into `meta.filterable` (a key the list-filter derivation already
	 * honoured in both directions, and which no op could write until now — the
	 * same shape `display` had before #345) and `meta.filterOperators`.
	 *
	 * It reaches further than the derivation: `opList` refuses a REST filter on a
	 * column declared un-filterable, so the declaration means the same thing on
	 * the page and over the API rather than being a hint one surface honours.
	 */
	filter?: {
		filterable?: boolean
		operators?: string[]
	}
}

/**
 * The database default for a rank column: the current time in
 * microseconds, zero-padded to a fixed width, with a trailing `1`.
 *
 * Three things it has to be, and each is why it looks like this:
 *
 *  - **Digits only.** Rank keys are compared by *Postgres*, under whatever
 *    collation the deployment has. Restricting the alphabet to `0-9` makes the
 *    key order identical under every collation there is — a base-36 key would be
 *    betting that `'a'` sorts after `'9'` everywhere, and nothing needs that bet.
 *  - **Fixed width, so it is monotone.** Padding makes lexicographic order and
 *    numeric order the same, which is what makes a newly created row land at the
 *    *end* of its column rather than somewhere in the middle.
 *  - **Never ending in `0`.** `rankBetween` treats a key as a decimal fraction,
 *    and a trailing zero is a second spelling of a shorter key. The `|| '1'`
 *    guarantees the invariant no matter what the clock reads.
 *
 * Existing rows are backfilled by the `ADD COLUMN … DEFAULT` itself; rows that
 * land in the same microsecond tie, and a tie is broken by primary key, so the
 * order is always total even if it is arbitrary.
 */
export const RANK_DEFAULT_SQL =
	"lpad(((extract(epoch from clock_timestamp()) * 1000000)::bigint)::text, 17, '0') || '1'"

export interface SpecEntityShape {
	/** Used as the DB table name (and thus the registry resource name). */
	name: string
	description?: string
	fields: SpecFieldShape[]
	/**
	 * Derived values, resolved to column/table names by the caller.
	 * These get **no DDL and no column** — `specSchemaDdl` and
	 * `tableFromSpecEntity` both ignore them, because a derived value is
	 * evaluated on read (`sprout/derived.ts`). They travel on the shape so the
	 * read path knows what to compute.
	 */
	computed?: ComputedShape[]
	rollups?: RollupShape[]
	/**
	 * A declared full-text index, with the spec's field ids already
	 * resolved to column names by the caller.
	 *
	 * It rides on the entity shape rather than in a parallel list because the
	 * spec allows exactly one index per entity, so the two are the same
	 * cardinality — and because `specSchemaDdl` already walks entities in
	 * canonical name order, which is what makes the emitted DDL order-independent
	 * for free. Like `computed`/`rollups` it adds **no column**: the
	 * index is an expression index, so the row shape, the forms and the REST
	 * payload are all untouched by declaring one.
	 */
	search?: SearchIndexPlan
	/**
	 * Declared document templates for this entity, with the spec's
	 * field ids already resolved to column names by the caller.
	 *
	 * Rides on the entity shape for the reason `search` does, minus the
	 * cardinality argument — there may be several, since an invoice, a receipt and
	 * a statement are three documents about one row. It contributes **no DDL at
	 * all**: a document is a rendering of rows that already exist, so declaring one
	 * adds no column, no index and no table. The only thing it changes is what the
	 * registry knows, which is what puts `opRenderDocument` at the same depth
	 * `authorize()` runs at.
	 */
	documents?: DocumentPlan[]
	/**
	 * Declared importers for this entity, with the spec's field ids
	 * already resolved to column names by the caller.
	 *
	 * Rides on the entity shape for the reason `documents` does, and contributes
	 * **no DDL at all**: an importer is a declared way *in* to rows that already
	 * have a shape, so declaring one adds no column, no index and no table. The
	 * only thing it changes is what the registry knows — which is what puts
	 * `planImport`/`opApplyImport` at the same depth `authorize()` runs at.
	 */
	importers?: ImportPlanShape[]
	/**
	 * Declared portals for this entity, with the spec's field ids
	 * already resolved to column names by the caller.
	 *
	 * Contributes **no DDL**: a portal adds no column, no index and no table. What
	 * it changes is the registry — and, through
	 * {@link accessWithPortals}, the entity's own access rules, which is the only
	 * place in this file where a declaration *widens* anything.
	 */
	portals?: PortalPlan[]
	/**
	 * Declared live channels for this entity, with the spec's field
	 * ids already resolved to column names by the caller.
	 *
	 * Contributes **no DDL**: a channel adds no column, no index and no table —
	 * it is a declared bound on which changes to rows that already have a shape
	 * get pushed to whom. Unlike {@link portals} it also widens nothing: a live
	 * message is authorized per message through the ops the caller could already
	 * reach, so declaring a channel cannot make anything readable that was not.
	 * What it changes is the registry, which is what lets the SSE route find a
	 * plan without ever deciding anything with it.
	 */
	live?: LivePlan[]
	/**
	 * Declared list actions, with the spec's field ids already resolved
	 * to column names by the caller. These get no DDL and no column: an action is
	 * a declared, capped, role-gated *write* over rows that already have a shape.
	 * They travel on the shape so the registry — and therefore `opRunAction`, and
	 * therefore every one of the three surfaces that can run one — finds the same
	 * cap and the same write set.
	 */
	actions?: ActionPlan[]
}

// A reference field lands as a `uuid` FK carrying `meta.reference`; an enum with
// options carries them through to `meta.options`/`meta.enumValues` (task 32).
// An enum without options still lands as permissive text — the pre-task-32
// behavior — rather than inventing a value list the spec never stated.
function columnFor(
	field: SpecFieldShape,
	resourceName?: string,
): AnyPgColumnBuilder {
	const meta: ColumnMetadata = {
		label: formatLabel(field.name),
		required: field.required,
	}
	if (field.options && field.options.length > 0) {
		meta.options = field.options
		meta.enumValues = field.options.map((o) => o.value)
	}
	// A WIP limit. Carried on the column because that is where both
	// halves read it: the board draws "2 / 3" from it and `opCreate`/`opUpdate`
	// refuse the write from it, so the number shown and the number enforced are
	// one declaration rather than two that agree today.
	if (field.limits && Object.keys(field.limits).length > 0)
		meta.valueLimits = { ...field.limits }
	// A number column's declared presentation (#345). These four keys are the
	// ones the field library already consults; what was missing was any way for
	// the spec to set them, so the widget was decided by the column's *name* and
	// the scale was fixed at the code's default. Only applied to `number` fields
	// — every declarable format is a way of drawing a number, and the spec-op
	// validator refuses the combination anywhere else, so this is not the place
	// to re-litigate it.
	if (field.display && field.type === 'number') {
		if (field.display.format !== undefined) meta.format = field.display.format
		if (field.display.min !== undefined) meta.min = field.display.min
		if (field.display.max !== undefined) meta.max = field.display.max
		if (field.display.step !== undefined) meta.step = field.display.step
	}
	// A column's declared filter control (#414). `filterable` was already read by
	// the derivation and reachable from nothing; `filterOperators` is new, and
	// narrows the spellings the control offers to the ones the author named. Both
	// are carried verbatim — the op validator has already refused a `range` on a
	// column that has no ordering, so this is not the place to re-litigate it.
	if (field.filter) {
		if (field.filter.filterable !== undefined)
			meta.filterable = field.filter.filterable
		if (field.filter.operators?.length)
			meta.filterOperators = [...field.filter.operators]
	}
	// A rank key is a text column with a database default, hidden and
	// read-only in the UI: it is written by moving a row, never by typing.
	// `readOnly` is a rendering hint only — the validation schema still accepts the
	// column, which is what lets a board move write it through the record's
	// ordinary edit route instead of needing a private endpoint.
	if (field.rank && field.type === 'string' && !field.reference) {
		return withMeta(text(field.name).default(sql.raw(RANK_DEFAULT_SQL)), {
			...meta,
			rankKey: true,
			hidden: true,
			readOnly: true,
			required: false,
		})
	}
	// A reference field is an id-holding FK regardless of the declared spec type.
	// The column matches the referenced id's type: uuid for spec entities,
	// text for bundle infra tables (`reference.idType`).
	if (field.reference) {
		meta.reference = field.reference
		const column =
			field.reference.idType === 'text' ? text(field.name) : uuid(field.name)
		return withMeta(column, meta)
	}
	// A file field is a text column holding a storage key. Everything that makes
	// it a *file* — the allowlist, the cap, the declared variants — travels as
	// metadata, so the upload widget, the REST schema and the server-side wall
	// all read the same declaration.
	if (field.type === 'file' && field.file) {
		return withMeta(text(field.name), {
			...meta,
			isFile: true,
			fileAccept: field.file.accept.join(','),
			fileMaxSize: field.file.maxSizeBytes,
			...(field.file.derivatives?.length
				? { fileDerivatives: field.file.derivatives }
				: {}),
			...(resourceName ? { fileResource: resourceName } : {}),
		})
	}
	switch (field.type) {
		case 'string':
		case 'enum':
		// A `file` field whose declaration did not survive grounding lands as
		// plain text rather than an upload widget: without an allowlist there is
		// nothing to enforce, and rendering an unbounded uploader would be worse
		// than rendering a text box. `fieldFileErrors` makes this unreachable
		// from a validated spec.
		case 'file':
			return withMeta(text(field.name), meta)
		case 'number':
			return withMeta(real(field.name), meta)
		case 'boolean':
			return withMeta(boolean(field.name), meta)
		case 'date':
			// mode 'string': JSON/form clients send ISO strings; the default
			// (Date-object) mode throws `value.toISOString is not a function` on
			// exactly the values the generated Zod schema accepts.
			return withMeta(timestamp(field.name, { mode: 'string' }), meta)
		case 'json':
			return withMeta(jsonb(field.name), meta)
		default: {
			const exhaustive: never = field.type
			throw new Error(`Unhandled spec field type: ${String(exhaustive)}`)
		}
	}
}

/** Build the live drizzle table for one spec entity: `id uuid` PK + one typed,
 * meta-carrying column per field. */
export function tableFromSpecEntity(entity: SpecEntityShape): PgTable {
	const columns: Record<string, AnyPgColumnBuilder> = {
		id: uuid('id').primaryKey().defaultRandom(),
	}
	for (const field of entity.fields) {
		if (field.name === 'id') continue
		columns[field.name] = columnFor(field, entity.name)
	}
	return pgTable(entity.name, columns)
}

const SQL_TYPES: Record<SpecFieldType, string> = {
	string: 'text',
	enum: 'text',
	number: 'real',
	boolean: 'boolean',
	date: 'timestamp',
	json: 'jsonb',
	// A storage key, not the bytes.
	file: 'text',
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * A guarded type reconciliation for a **reference** column.
 *
 * `ADD COLUMN IF NOT EXISTS` cannot change a column that already exists, which
 * is normally the point. It becomes a trap in exactly one case: a field that
 * shipped as a bare `string` is later *declared* to be a foreign key. The
 * declaration changes the emitted type (`text` → `uuid` for a spec-entity
 * target), the `ADD COLUMN` silently does nothing on an existing database, and
 * the app then runs with drizzle believing the column is `uuid` while Postgres
 * still holds `text` — a mismatch that surfaces much later as a confusing
 * operator error inside an unrelated query.
 *
 * So this is the one non-additive statement the platform emits, and it is
 * narrowly scoped:
 *
 *   - **Only for declared references.** A plain field's type cannot change,
 *     because no op can change it — there is no `data.setFieldType`.
 *   - **Guarded**, so it is a no-op (no lock, no table rewrite) once the column
 *     is already the right type. Re-running the DDL on every boot stays cheap.
 *   - **Loud on bad data.** The `USING … ::uuid` cast fails the migration if a
 *     row holds something that is not an id, rather than dropping it. A failure
 *     here means the column was never really a foreign key, which is worth
 *     finding out at migration time.
 *
 * Widening (`uuid` → `text`) casts implicitly; narrowing needs the explicit
 * `USING`, so both directions are spelled the same way.
 */
/**
 * Above this many rows, a reference reconciliation refuses to run itself
 *.
 *
 * `ALTER COLUMN … TYPE` takes an **ACCESS EXCLUSIVE** lock and rewrites the whole
 * table, and the schema sync runs at **application boot** rather than from an
 * operator-invoked migration. So on a deployed app, upgrading a bundle that
 * declares a new reference means the app blocks on startup for the length of a
 * full table rewrite, and every reader and writer of that table blocks with it —
 * from a one-line spec change whose DDL diff looks like two extra statements.
 *
 * On a dev-sized database it is imperceptible, which is exactly why nobody would
 * notice until it mattered.
 *
 * The threshold turns a surprise outage into a **blocked deploy**: below it the
 * rewrite is cheap and proceeds (with a notice, because a stall nobody explained
 * is its own problem); above it the boot fails with the exact statement to run in
 * a window somebody chose. A blocked deploy is the better failure — it is visible,
 * it is reversible, and it happens before traffic rather than during it.
 *
 * 10,000 is a deliberately unclever number: small enough that anything past it is
 * plausibly a production table, large enough that no dev database or fixture
 * trips it. Override with `MAXSTACK_REFERENCE_REWRITE_LIMIT` when you know your
 * own shape — including `0` to refuse every automatic rewrite, which is the right
 * setting for anyone who wants the migration to be a deliberate act.
 *
 * This is the issue's option 2. Option 3 — moving DDL out of boot into a real
 * `maxstack migrate` the deploy runs first, with the boot-time sync asserting
 * rather than performing — is still the honest long-term answer, and is a posture
 * change for the whole DDL story rather than a patch to this statement.
 */
export const DEFAULT_REFERENCE_REWRITE_LIMIT = 10_000

/**
 * The configured limit. Read at emit time rather than baked in, so an operator
 * who knows their own table sizes can set it — including to `0`, which refuses
 * every automatic rewrite and makes the migration a deliberate act.
 */
export function referenceRewriteLimit(): number {
	const raw =
		typeof process === 'undefined'
			? undefined
			: process.env.MAXSTACK_REFERENCE_REWRITE_LIMIT
	if (raw === undefined) return DEFAULT_REFERENCE_REWRITE_LIMIT
	const n = Number.parseInt(raw, 10)
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REFERENCE_REWRITE_LIMIT
}

function reconcileReferenceColumn(
	tableName: string,
	columnName: string,
	sqlType: string,
	rewriteLimit: number = referenceRewriteLimit(),
): string {
	// `information_schema.columns.data_type` reports unquoted, lower-case names
	// that match our emitted types for the two id shapes we use.
	const literal = (s: string) => `'${s.replaceAll("'", "''")}'`
	const alter = `ALTER TABLE ${quote(tableName)} ALTER COLUMN ${quote(columnName)} TYPE ${sqlType} USING ${quote(columnName)}::${sqlType}`
	// The count, the decision and the rewrite are one statement on purpose: a
	// caller that counted first and then decided would be racing every writer
	// between the two, and the whole point is that this runs while the app is
	// coming up.
	return [
		'DO $$',
		'DECLARE affected bigint;',
		'BEGIN',
		'  IF EXISTS (',
		'    SELECT 1 FROM information_schema.columns',
		`    WHERE table_name = ${literal(tableName)}`,
		`      AND column_name = ${literal(columnName)}`,
		`      AND data_type <> ${literal(sqlType)}`,
		'  ) THEN',
		`    EXECUTE ${literal(`SELECT count(*) FROM ${quote(tableName)}`)} INTO affected;`,
		`    IF affected > ${rewriteLimit} THEN`,
		"      RAISE EXCEPTION 'maxstack refused to rewrite %.% at boot: % rows is over the " +
			`${rewriteLimit}-row limit, and ALTER COLUMN ... TYPE takes an ACCESS EXCLUSIVE lock ` +
			'for the whole rewrite. Run this in a window you chose, then start the app again: ' +
			`%. Raise or remove the limit with MAXSTACK_REFERENCE_REWRITE_LIMIT.', ` +
			`${literal(tableName)}, ${literal(columnName)}, affected, ${literal(alter)};`,
		'    END IF;',
		"    RAISE NOTICE 'maxstack: reconciling %.% (% rows) — this locks the table', " +
			`${literal(tableName)}, ${literal(columnName)}, affected;`,
		`    EXECUTE ${literal(alter)};`,
		'  END IF;',
		'END $$;',
	].join('\n')
}

/**
 * Idempotent DDL for the entities — safe to re-run as the spec grows.
 *
 * Additive apart from one guarded exception: a column that gains a declared
 * `reference` is reconciled to the referenced id's type. See
 * {@link reconcileReferenceColumn} for why that exception exists and how it is
 * bounded.
 *
 * Emitted in **table-name order, then column-name order**, not in the order the
 * caller happened to ground the entities in or the order the fields
 * happened to be declared in. The statements are an unordered,
 * `IF NOT EXISTS` set — no statement depends on an earlier one — so their
 * sequence carries no meaning, but it is *output*: install the same bundles in a
 * different order and an input-ordered emitter hands two developers two
 * different schema files for the same app. The combination-safety gate asserts
 * this file is byte-identical across every valid install order, and that is only
 * true if the order is canonical here rather than inherited.
 *
 * The **column** sort is the same argument one axis over, and issue #195's
 * upgrade-safety gate is what found it. A codemod appends: `billing` 0.1.0 →
 * 0.2.0 adds `currentPeriodEnd` after `updatedAt`, while a fresh 0.3.0 install
 * declares it in the middle. Both are the same app at the same version, and an
 * input-ordered emitter hands them different files forever — a diff no
 * regeneration can ever settle, because no migration reorders a Postgres table.
 * Sorting here does not make the two *databases* identical (it cannot; physical
 * column order is history), which is exactly why the emitted file must stop
 * claiming a difference the platform can never remove.
 */
export function specSchemaDdl(entities: readonly SpecEntityShape[]): string {
	const statements: string[] = []
	const ordered = [...entities].sort((a, b) => a.name.localeCompare(b.name))
	for (const entity of ordered) {
		const table = quote(entity.name)
		statements.push(
			`CREATE TABLE IF NOT EXISTS ${table} (\n  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid()\n);`,
		)
		const fields = [...entity.fields].sort((a, b) =>
			a.name.localeCompare(b.name),
		)
		for (const field of fields) {
			if (field.name === 'id') continue
			// A reference field stores the referenced id (uuid for spec entities,
			// text for bundle infra tables), regardless of its declared type.
			const sqlType = field.reference
				? (field.reference.idType ?? 'uuid')
				: SQL_TYPES[field.type]
			// A rank column carries its default in the DDL, so adding it
			// to a table that already has rows backfills every one of them. That is
			// the point: a nullable rank column has an unordered region in it, and no
			// single-row write can place a card relative to rows with no position.
			const columnDefault =
				field.rank && !field.reference && field.type === 'string'
					? ` DEFAULT (${RANK_DEFAULT_SQL})`
					: ''
			statements.push(
				`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quote(field.name)} ${sqlType}${columnDefault};`,
			)
			// The column may predate the reference declaration, in
			// which case it exists with the wrong type and the statement above did
			// nothing.
			if (field.reference)
				statements.push(
					reconcileReferenceColumn(entity.name, field.name, sqlType),
				)
		}
		// The search index last, after every column it names exists.
		// Additive in both directions: `CREATE INDEX IF NOT EXISTS` adds no column
		// and rewrites no table, and the `DROP INDEX IF EXISTS` an `indexed: false`
		// declaration emits cannot lose data, because an expression index stores
		// nothing that is not recomputable from the columns it reads.
		if (entity.search)
			statements.push(searchIndexDdl(entity.name, entity.search))
	}
	return statements.join('\n')
}

/**
 * The secure-by-default rule set for spec entities: writes require
 * a session, reads stay public. `authorize()` is open-by-default, so entities
 * registered with *no* rules are anonymous-writable over REST/MCP — fine for a
 * local data dir, dangerous deployed. Callers with auth wired (the web runtime
 * when the auth bundle is installed) pass this as `access`.
 */
export const AUTHENTICATED_WRITES: ResourceAccess = {
	create: 'authenticated',
	update: 'authenticated',
	delete: 'authenticated',
}

/**
 * Reconcile the deployment's write posture with an entity's declared portals
 *.
 *
 * `AUTHENTICATED_WRITES` exists because `authorize()` is open-by-default, so a
 * spec entity registered with no rules is anonymous-writable over REST and MCP.
 * A declared portal is the one thing that is *supposed* to reach past it — and
 * the wrong way to allow that would be to drop the posture for the whole entity,
 * which is what "the portal route writes its own rows" amounts to.
 *
 * So the reconciliation is per action, and narrow:
 *
 *  - An action **no portal on this entity declares** keeps the base rule
 *    untouched. A public portal that only reads does not make the entity
 *    anonymously writable, and one that declares `create` does not make it
 *    anonymously *updatable*. That is the issue's "a public portal's declared
 *    writes are the only anonymous writes that survive."
 *  - An action **some portal declares** gets a rule that admits a portal
 *    identity and otherwise falls through to the base rule unchanged. Every
 *    other caller — session, api key, MCP — sees exactly what they saw before.
 *
 * **This is where the grant lives, and that is deliberate.** `portalGrants` is a
 * pure narrowing and can never be the reason something became reachable; the
 * reason is here, derived mechanically from the declaration, and therefore
 * visible in `portalExposureReport`. A reviewer approving the declaration is
 * approving this. Splitting it the other way — a permissive `portalGrants` and
 * an untouched resource rule — would put the grant somewhere no report can see.
 *
 * A portal identity that reaches this rule has *already* passed `portalGrants`,
 * which refused every resource but its own and every action its portal did not
 * declare. So `isPortal` here is not "any portal may write", it is "the portal
 * this rule was generated for, doing the thing it declared."
 */
export function accessWithPortals(
	base: ResourceAccess | undefined,
	portals: readonly PortalPlan[] | undefined,
): ResourceAccess | undefined {
	if (!portals || portals.length === 0) return base
	const next: ResourceAccess = { ...base }
	const declared = new Set<SproutAction>(['read'])
	for (const portal of portals)
		for (const write of portal.writes) declared.add(write.action)
	for (const action of declared) {
		const rule = base?.[action]
		next[action] = (ctx) => {
			if (ctx.user?.portal) return true
			if (rule === undefined) return true
			return toAccessRule(rule)(ctx)
		}
	}
	return next
}

/**
 * Pick an entity's display/title field: a name-ish plain-string
 * field (`name`, then `title`) when one exists, else the first string field
 * that isn't itself a reference — an FK's stored value is the *referenced*
 * row's id, so picking one renders a doubly-wrong raw uuid as the "title".
 *
 * Shape-agnostic on purpose: spec entity fields carry `reference`, Sprout
 * columns carry `references`; either mark disqualifies the field.
 */
export function pickTitleField(
	fields: readonly {
		name: string
		type: string
		reference?: unknown
		references?: unknown
	}[],
): string | undefined {
	const candidates = fields.filter(
		(f) => f.type === 'string' && !f.reference && !f.references,
	)
	return (
		candidates.find((f) => f.name === 'name')?.name ??
		candidates.find((f) => f.name === 'title')?.name ??
		candidates[0]?.name
	)
}

/** Register every entity as a Sprout resource (title via
 * {@link pickTitleField} — an id makes a meaningless title). */
export function registerSpecEntities(
	registry: ResourceRegistry,
	entities: readonly SpecEntityShape[],
	config: { group?: string; access?: ResourceAccess } = {},
): RegisteredResource[] {
	return entities.map((entity) =>
		registry.register(tableFromSpecEntity(entity), {
			group: config.group ?? 'App',
			titleField: pickTitleField(entity.fields),
			// Carried onto the registry so `opSearch` reads it at the same depth
			// `authorize()` runs at — a search that had to be assembled per route
			// would be the route-level gate issue #186 removed, wearing a new hat.
			search: entity.search,
			// Same argument for documents: rendering is a read, so the
			// template has to be reachable from below the routes.
			documents: entity.documents,
			// And for importers, where the argument is sharper still:
			// an import is a WRITE, so it has to be reachable from the layer that
			// stamps tenancy, enforces per-value caps and attributes the audit entry.
			importers: entity.importers,
			// And for portals — the plan the public route looks up, and
			// the input to the one access reconciliation in this file.
			portals: entity.portals,
			// And for live channels. The weakest argument of the five
			// and worth saying so: the SSE route needs a plan to look up, and the
			// enforcement is already below it — `LiveChannel.publish` re-authorizes
			// per message through `opList`, so a route that never found the plan
			// serves nothing rather than serving something ungated.
			live: entity.live,
			// And for list actions, where the argument is the sharpest of
			// the six: an action is a write one click aims at many rows, so its cap,
			// its role and its write set must be reachable from the layer that
			// authorizes and audits, not from the toolbar that renders the button.
			actions: entity.actions,
			// The declared portals reconcile with the deployment's write posture
			// rather than silently overriding it. See `accessWithPortals`.
			access: accessWithPortals(config.access, entity.portals),
		}),
	)
}

/** Bring a live database up to date with the (grown) spec. Idempotent. */
export async function ensureSpecSchema(
	client: PGlite,
	entities: readonly SpecEntityShape[],
): Promise<void> {
	if (entities.length === 0) return
	await client.exec(specSchemaDdl(entities))
}

export interface SpecDb {
	client: PGlite
	store: SproutStore
}

/**
 * A Sprout database materialized from spec entities. With `dir` the data
 * persists on disk (pglite's filesystem backend) and reopening the same dir
 * resumes it; without, it is in-memory (tests). Pass an existing `client` to
 * re-sync a live database after the spec grew (the schema is additive-only,
 * so this is safe mid-flight) — `dir` is ignored in that case.
 */
export async function createSpecDb(
	registry: ResourceRegistry,
	entities: readonly SpecEntityShape[],
	opts: { dir?: string; client?: PGlite } = {},
): Promise<SpecDb> {
	const { PGlite } = await import('@electric-sql/pglite')
	const { drizzle } = await import('drizzle-orm/pglite')
	const client = opts.client ?? (opts.dir ? new PGlite(opts.dir) : new PGlite())
	await ensureSpecSchema(client, entities)
	const store = createDrizzleStore(
		drizzle({ client }),
		registry,
		(text, params) =>
			client
				.query(text, params as unknown[] | undefined)
				.then((r) => r.rows as Record<string, unknown>[]),
	)
	return { client, store }
}

/**
 * The backend-agnostic form of {@link createSpecDb}: bring any {@link
 * StoreBackend} (pglite or Postgres) up to the spec schema and return a store
 * over it. Same additive DDL, same `createDrizzleStore` — so a project running
 * on Postgres and one on pglite exercise identical code, which is what makes
 * "the same tests green on both backends" (task 22) true by construction.
 */
export async function createSpecStore(
	backend: StoreBackend,
	registry: ResourceRegistry,
	entities: readonly SpecEntityShape[],
): Promise<SproutStore> {
	if (entities.length > 0) await backend.exec(specSchemaDdl(entities))
	// The backend's raw runner is what makes ranked search available; a store
	// built without one refuses to search rather than degrading to an unranked
	// ILIKE scan behind a name that promises ranking.
	return createDrizzleStore(backend.db, registry, (text, params) =>
		backend.query(text, params),
	)
}
