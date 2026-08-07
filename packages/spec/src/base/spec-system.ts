/**
 * The spec system — the three coordinated layers as one typed document.
 *
 * §3-L1: the spec is three layers (product / data / page) designed *together*,
 * with native cross-layer references and with provenance + the decision ledger +
 * typed spec-ops built into the base types. This module is the aggregate those
 * ops mutate:
 *
 *   - **Product layer** — the full `PRD` (prd.types v3). Owns its own ids.
 *   - **Data layer** — entities/fields. In the running platform this is the
 *     Drizzle schema enriched with `withMeta` (Sprout derives everything from
 *     it); here we hold the layer's *base shape* so ops are typed and diffable
 *     before that wiring lands (later in Phase 1).
 *   - **Page/UX layer** — pages/blocks; the seed of the `mconfig` template
 *     registry.
 *   - **Pricing** — the business-model tiers the `pricing.addTier` op targets.
 *
 * Every data/page/pricing entity carries {@link Provenance} — the base columns
 * are not a product-layer-only concern. Cross-references are branded ids
 * (spec-ops point at `EntityId`/`PageId`/…), so a page id can't be passed where
 * an entity id is wanted.
 */

import type { PRD } from '../prd/prd.types.ts'
import type { DecisionLedger } from './decision-ledger.ts'
import type { DocumentsSpec } from './documents.ts'
import type { FlagsSpec } from './flags.ts'
import type {
	BlockId,
	DerivedId,
	EntityId,
	FieldId,
	PageId,
	TierId,
} from './ids.ts'
import type { ImportsSpec } from './imports.ts'
import type { LiveSpec } from './live.ts'
import type { PortalsSpec } from './portals.ts'
import {
	type AutoAcceptPolicy,
	DEFAULT_AUTO_ACCEPT,
	type Provenanced,
} from './provenance.ts'
import type { SchedulesSpec } from './schedules.ts'
import type { SearchSpec } from './search.ts'
import type { SourcesSpec } from './sources.ts'
import type { AppliedOp } from './spec-ops.ts'

// ===========================================================================
// Data layer
// ===========================================================================

export type FieldType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'date'
	| 'enum'
	| 'json'
	| 'file'

/**
 * The canonical {@link FieldType} values as a runtime set. The union above is
 * erased at compile time, so ops arriving as JSON (an agent posting through the
 * MCP `apply_spec_change` tool) need a runtime guard — otherwise an unknown
 * `type` (e.g. the CLI-sugar `"text"`, which the terminal DSL aliases to
 * `string` but the raw op wire format does not) lands in the spec and crashes
 * every derived `/admin*` route at render with no rollback. `validateOp` checks
 * `field.type` against this set. Keep it in sync with {@link FieldType}.
 */
export const FIELD_TYPES: readonly FieldType[] = [
	'string',
	'number',
	'boolean',
	'date',
	'enum',
	'json',
	'file',
]

/** An enum option — label shown, value stored. */
export interface FieldOption {
	label: string
	value: string
}

// ---------------------------------------------------------------------------
// File fields
//
// A `file` field stores a **storage key**, never a URL and never bytes. The
// column is text; the bytes live behind the storage bundle's provider, and the
// read path re-signs the key into a short-lived URL on every render. Storing a
// URL would bake an expiry into the row.
//
// The declaration is where the security posture lives, which is why the two
// hard limits are **required, not optional**: uploads are the classic
// remote-code-execution and storage-exhaustion surface, and a field that forgot
// to state its allowlist would be a field that accepts `application/x-httpd-php`
// at 4GB. `fieldFileErrors` refuses to let that field into a spec at all, so
// "the server enforces a cap" is a property of the vocabulary rather than a
// thing each app remembers to wire.
// ---------------------------------------------------------------------------

/**
 * A declared image derivative — a resized variant materialized at upload time
 * and addressable as `<key>@<name>`. Declared here rather than hand-wired at
 * the call site so a thumbnail is spec-as-data like everything else: the
 * runtime knows every variant that exists without reading application code.
 */
export interface FileDerivativeSpec {
	/** Slug, unique within the field — the `@thumb` in `<key>@thumb`. */
	name: string
	/** Target width in pixels (the bound that is always applied). */
	width: number
	/** Target height; omitted means "scale to `width`, preserve aspect ratio". */
	height?: number
	/** How the source is fitted when both bounds are given. Default `cover`. */
	fit?: 'cover' | 'contain'
}

/** The declared constraints on a `type: 'file'` field. Both limits are required. */
export interface FileFieldSpec {
	/**
	 * MIME allowlist. Each entry is either an exact type (`application/pdf`) or a
	 * one-level wildcard (`image/*`). `*` / `*&#47;*` are rejected: "allow
	 * everything" is not a policy, and the whole point of declaring the field is
	 * that the server has something specific to enforce.
	 */
	accept: string[]
	/** Hard per-file size cap in bytes, enforced server-side before any write. */
	maxSizeBytes: number
	/** Image variants to materialize at upload. Only for image-only allowlists. */
	derivatives?: FileDerivativeSpec[]
}

/**
 * The largest `maxSizeBytes` a field may declare (100MB). Not a statement about
 * what any given deployment can afford — it is the point past which "a file
 * field on a CRUD form" is the wrong primitive and a resumable/multipart upload
 * is the right one, which this vocabulary does not express.
 */
export const FILE_MAX_SIZE_CEILING = 100 * 1024 * 1024

/** The largest derivative edge, in pixels. A "thumbnail" larger than this is
 * the original, and generating it is a denial-of-service amplifier. */
export const FILE_DERIVATIVE_MAX_DIMENSION = 4096

/** `image/png`, `image/*` — one level of wildcard, never bare `*`. */
const MIME_PATTERN =
	/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/

/** Whether `pattern` is a syntactically valid `accept` entry. */
export function isAcceptPattern(pattern: string): boolean {
	return MIME_PATTERN.test(pattern)
}

/** Whether an `accept` entry can only ever match an image — the precondition
 * for declaring derivatives, since there is nothing to resize otherwise. */
export function isImageAcceptPattern(pattern: string): boolean {
	return isAcceptPattern(pattern) && pattern.startsWith('image/')
}

/** Whether `contentType` is allowed by an `accept` allowlist. The single
 * matcher both the client hint and the server wall go through. */
export function acceptsContentType(
	accept: readonly string[],
	contentType: string,
): boolean {
	const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
	return accept.some((pattern) => {
		const p = pattern.toLowerCase()
		if (p.endsWith('/*')) return type.startsWith(p.slice(0, -1))
		return type === p
	})
}

export interface FieldSpec extends Provenanced {
	id: FieldId
	name: string
	type: FieldType
	required: boolean
	/**
	 * Target entity id when this field is a belongs-to foreign key. The field
	 * stores that entity's id; the runtime resolves it to the entity's title
	 * field (Sprout introspection carries the reference through as
	 * `meta.reference`, the read side renders `<ReferenceField>`, and the form
	 * side renders an FK picker). The single sanctioned spec touch of Plan v5
	 * task 32 — a reference is data, not presentation.
	 *
	 * Besides spec entities, a well-known *virtual* entity id may be named —
	 * `e-user` grounds to the auth bundle's user table, so
	 * "belongs to a user" is expressible without the identity tables being
	 * spec entities. See `virtual-entities.ts`.
	 */
	reference?: EntityId
	/**
	 * The entities this field *could* point at, when the answer is a project's to
	 * give.
	 *
	 * ## Why a second kind of reference exists
	 *
	 * A catalog bundle sometimes ships a column that holds an id whose target is
	 * genuinely ambiguous **in the catalog and never in an app**. The case that
	 * forced it is billing: `subscription.subject` is "whatever this app bills" —
	 * a user id in a per-seat product, an organization id in a per-workspace one.
	 * {@link reference} names exactly one entity, so there was no honest value to
	 * write, and both columns shipped as bare strings with the loss recorded as a
	 * "cannot": no `<ReferenceField>`, no edge in the relation graph, no `via`
	 * traversal for a rollup — for the two tables where billing questions are
	 * actually asked.
	 *
	 * A polymorphic reference — one column, many targets, a discriminator — was
	 * the obvious alternative and is the shape every ORM that has tried it has
	 * found expensive: the database cannot enforce the key, the join is
	 * conditional, and introspection, rollups, reference resolution and the
	 * compliance graph each grow a branch. This is the cheaper answer, and it is
	 * cheaper because it matches where the ambiguity actually lives: a *catalog*
	 * cannot know, a *project* always does.
	 *
	 * ## What it means
	 *
	 * "This holds an id of one of these, and the project says which." A field
	 * declaring it is **not yet a reference**: it emits the same `text` column it
	 * did before, nothing resolves it, and no rollup may traverse it. A project
	 * narrows it with `data.setFieldReference`, which refuses any target not on
	 * this list — that refusal is the whole value of declaring the candidates
	 * rather than leaving `reference` merely absent.
	 *
	 * ## Un-narrowed is a refusal, never a default
	 *
	 * There is deliberately no "pick the first one" and no "unknown target means
	 * any target". A rollup whose `via` names an un-narrowed field is refused by
	 * name, with the narrowing op in the message. The alternative is a rollup
	 * that aggregates across whatever ids happen to be in the column, which for a
	 * billing ledger is a number nobody can audit and everybody believes.
	 */
	openReference?: EntityId[]
	/**
	 * Enum option list for `type: 'enum'` fields. Without it an `enum` field
	 * lands as free text (the pre-task-32 behavior); with it the value list is
	 * carried through to `withMeta.options` so the form renders a select and the
	 * read side renders a colored chip.
	 */
	options?: FieldOption[]
	/**
	 * Required for `type: 'file'`, and rejected on every other type — the
	 * allowlist + size cap the upload path enforces, plus any declared image
	 * derivatives. See {@link FileFieldSpec}.
	 */
	file?: FileFieldSpec
	/**
	 * Marks a `string` field as a **manual-ordering key**: an opaque
	 * sort key a person sets by dragging, not by typing. Only meaningful on
	 * `string` fields, and rejected everywhere else.
	 *
	 * Three properties follow from the declaration, and all three are why this is
	 * a *data* fact rather than a board's private business:
	 *
	 *  - **The column is never null.** It is emitted with a database default, so
	 *    every row — including the ones that predate the declaration — has a key
	 *    the moment the column exists. A nullable rank column has an unordered
	 *    region in it, and no single-row write can place a card relative to rows
	 *    that have no position.
	 *  - **It is not user-editable.** The column is hidden and read-only in forms;
	 *    a person orders rows by moving them, and a text box holding `0000…17x`
	 *    is a bug report waiting to happen.
	 *  - **Order is expressed by the key, not by the row.** Two keys can be
	 *    compared, and a new key can always be made between any two — which is
	 *    what makes a reorder one row's write instead of a renumbering of the
	 *    whole column. See `rankBetween` in `@maxstack/ui`.
	 */
	rank?: boolean
	/**
	 * Per-value row caps on an `enum` field — the declared form of a
	 * Kanban WIP limit: `{ doing: 3 }` means at most three rows may hold
	 * `status = "doing"` at once.
	 *
	 * **This lives on the field, not on the board, on purpose.** A limit that a
	 * board enforces is a limit an agent driving the REST API or an MCP tool
	 * walks straight past, and "the rule only holds if you came in through the
	 * UI" is not a rule. Declared here, it is enforced by the same create/update
	 * path every caller shares, and the board merely *shows* it.
	 *
	 * Keys are declared option values; the value is the cap (a positive integer,
	 * ≤ {@link MAX_VALUE_LIMIT}). An option with no key is uncapped — a limit is
	 * an opt-in per column, since most boards cap only the in-progress ones.
	 *
	 * Scope: rows visible in the writer's tenant (the resource's org scope when
	 * it has one, the whole table when it does not). Anything narrower — a limit
	 * per swimlane, per sprint, per assignee — is deliberately not expressible;
	 * see `docs/board-views.md`.
	 */
	limits?: Record<string, number>
	/**
	 * How a `number` field is *presented*, and the scale it is presented on.
	 * Only meaningful on `number` fields, and rejected everywhere else.
	 *
	 * ## Why this exists (#345)
	 *
	 * The read/write field library infers a widget from a column's **name** when
	 * its type carries no signal — a number called `rating` renders as stars, one
	 * called `durationSeconds` as `3m 20s`. The inference is usually right and it
	 * is the reason a spec that says almost nothing still produces a usable app.
	 * But before this key it was **unopposable and unreachable**: there was no way
	 * to say "this number named `rating` is a plain number", and no way to say
	 * "this rating is out of 10" — `meta.min`/`max`/`step` existed in the runtime
	 * and drove the rating, slider and duration widgets, but no spec op wrote
	 * field metadata, so the only layer a user is supposed to write in could not
	 * reach them. A `reader` app rating books out of 10 got a 5-star widget with
	 * no declaration that could correct it.
	 *
	 * So: {@link format} states the widget outright and **wins over the name in
	 * both directions** — `'number'` keeps a column called `rating` a plain
	 * number, and `'rating'` makes a column called `score` a star widget.
	 * {@link min}/{@link max}/{@link step} state the scale.
	 *
	 * ## Presentation only
	 *
	 * Nothing here constrains what may be *stored*: the column stays a `real`, and
	 * a value outside `min`/`max` is accepted by the API and displayed honestly
	 * rather than clamped into a lie. A declared range is what the editor offers
	 * and what the read side measures against, not a check. Enforcement of value
	 * ranges is a separate question from how a number is drawn, and conflating the
	 * two would make "show this out of 10" silently start rejecting rows.
	 */
	display?: FieldDisplaySpec
}

/**
 * The number presentations a field may declare. Deliberately closed, and
 * deliberately number-only: every member is a way of drawing a number, and the
 * validator refuses `display` on any other field type. The string-side
 * heuristics (`multiline`, `email`/`url`/`image`) have their own escape hatches
 * or none, and widening this to cover them is a separate design.
 *
 *  - `number` — a plain formatted number. **The escape hatch**: the one value
 *    whose whole job is to say "no widget, whatever this column is called".
 *  - `grouped` / `percent` / `currency` — the same plain number, formatted.
 *  - `rating` — stars, on the declared {@link FieldDisplaySpec.max} (default 5).
 *  - `slider` — a range input over `min`/`max`/`step`; reads as a number.
 *  - `duration` — seconds, read as `1h 2m 3s`.
 */
export type NumberDisplayFormat =
	| 'number'
	| 'grouped'
	| 'percent'
	| 'currency'
	| 'rating'
	| 'slider'
	| 'duration'

/** Runtime guard for {@link NumberDisplayFormat} — same rationale as {@link FIELD_TYPES}. */
export const NUMBER_DISPLAY_FORMATS: readonly NumberDisplayFormat[] = [
	'number',
	'grouped',
	'percent',
	'currency',
	'rating',
	'slider',
	'duration',
]

/** A `number` field's declared presentation. See {@link FieldSpec.display}. */
export interface FieldDisplaySpec {
	/** The widget, stated rather than guessed from the field's name. */
	format?: NumberDisplayFormat
	/** Low end of the declared scale — the slider's floor. */
	min?: number
	/** High end of the declared scale — the star count, the slider's ceiling. */
	max?: number
	/** Granularity of the declared scale — the slider's step. */
	step?: number
}

/**
 * The largest per-value cap a field may declare. A bound, not a default: a
 * "limit" of a million is a column with no limit, and stating it in the spec
 * suggests a constraint the product does not actually have.
 */
export const MAX_VALUE_LIMIT = 10_000

// ---------------------------------------------------------------------------
// Derived values — computed fields and rollups.
//
// The gap this closes: Sprout derives a CRUD surface, and aggregation is what
// turns a CRUD app into a product. Before this, "total spend per client",
// "shopping list across a week's recipes" and "1RM over time" had no op and no
// slot — they were `off-surface` asks in three unrelated benchmarks, the largest
// cluster in the L2 roadmap.
//
// Two rules shape the design:
//
//   1. **The spec declares the computation; the runtime evaluates it.** Nothing
//      here affects code generation, so determinism (§L4A) is untouched by
//      construction — a rollup changes what a page *shows*, never what the
//      generator *writes*.
//   2. **No expression language.** `ComputedExpr` is a closed AST, not a parsed
//      string. There is no `eval`, no user-supplied SQL, and every leaf is a
//      field id the validator resolves against the entity. A string DSL would
//      have needed a parser, a grammar, and an injection story; the AST needs
//      none of the three and is trivially serializable through the codec.
// ---------------------------------------------------------------------------

/** Aggregate functions a rollup may apply. */
export type AggFn = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'

/** Runtime guard for {@link AggFn} — same rationale as {@link FIELD_TYPES}. */
export const AGG_FNS: readonly AggFn[] = [
	'count',
	'countDistinct',
	'sum',
	'avg',
	'min',
	'max',
]

/**
 * Aggregates that need a target field. `count` counts rows and takes none;
 * everything else aggregates a column's values.
 */
export const AGG_FNS_NEEDING_FIELD: readonly AggFn[] = [
	'countDistinct',
	'sum',
	'avg',
	'min',
	'max',
]

/** Aggregates that only make sense over a numeric column. */
export const NUMERIC_AGG_FNS: readonly AggFn[] = ['sum', 'avg']

/** Date-truncation buckets for a time-series rollup. */
export type TimeBucket = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** Runtime guard for {@link TimeBucket}. */
export const TIME_BUCKETS: readonly TimeBucket[] = [
	'day',
	'week',
	'month',
	'quarter',
	'year',
]

/** Arithmetic operators a computed field may use. */
export type ComputedOperator = '+' | '-' | '*' | '/'

/** Runtime guard for {@link ComputedOperator}. */
export const COMPUTED_OPERATORS: readonly ComputedOperator[] = [
	'+',
	'-',
	'*',
	'/',
]

/**
 * A closed arithmetic expression over one row's own numeric fields — the whole
 * computed-field language. Deliberately not a string: see the module note above.
 *
 * `gymlog`'s estimated one-rep-max (the Epley formula, `weight * (1 + reps/30)`)
 * is the corpus ask that fixes this shape — it needs multiplication, division,
 * a literal, and two field references, and nothing more.
 */
export type ComputedExpr =
	| { kind: 'field'; field: FieldId }
	| { kind: 'literal'; value: number }
	| {
			kind: 'binary'
			op: ComputedOperator
			left: ComputedExpr
			right: ComputedExpr
	  }

/**
 * How deep a {@link ComputedExpr} may nest. A bound exists so a malicious or
 * generated op can't hand the runtime a megabyte-deep tree to walk; 16 is far
 * past anything a real formula needs (Epley is depth 4).
 */
export const MAX_COMPUTED_DEPTH = 16

/** A value derived from a row's own fields, evaluated on read. */
export interface ComputedFieldSpec extends Provenanced {
	id: DerivedId
	/** Accessor name, unique among the entity's fields *and* derived values. */
	name: string
	expr: ComputedExpr
}

/**
 * One equality constraint narrowing which child rows a rollup aggregates —
 * "sum `amount` **where kind = 'billed'**". Equality only, on purpose: this is
 * the scope bound, not a query language. Anything richer belongs in a real
 * reporting surface, not in the field vocabulary.
 */
export interface RollupFilter {
	field: FieldId
	equals: string | number | boolean
}

/**
 * How a rollup's results are grouped. Without `bucket` the group key is the
 * field's value (shopping list grouped by ingredient name); with `bucket` the
 * key is a truncated date (usage metered by month), which is what a time-series
 * chart actually is. A grouped rollup yields a *series*; an ungrouped one yields
 * a scalar.
 */
export interface RollupGroupBy {
	field: FieldId
	bucket?: TimeBucket
}

/**
 * An aggregate over another entity's rows, exposed on this entity as a derived
 * value.
 *
 * `via` is the foreign key on `over` pointing back at the owning entity, which
 * makes the rollup *per row* — each meal plan sums only its own ingredients.
 * Omit it for a table-wide aggregate (the same number on every row), which is
 * what a dashboard tile wants.
 */
export interface RollupSpec extends Provenanced {
	id: DerivedId
	/** Accessor name, unique among the entity's fields *and* derived values. */
	name: string
	/** The entity whose rows are aggregated — the "many" side. */
	over: EntityId
	/**
	 * The path of reference fields leading from `over` **up to** the owning entity.
	 * When set the rollup is scoped per owning row; when omitted it is table-wide.
	 *
	 * A single `FieldId` is the common case (an FK on `over` pointing straight at
	 * the owner). An array is a multi-hop path, each element an FK on the previous
	 * hop's target:
	 *
	 * ```
	 * // recipebox: a meal plan's shopping list sums ingredients of its recipes.
	 * over: 'e-ingredient',
	 * via:  ['fld-ingredient-recipe', 'fld-recipe-mealplan'],
	 * //     ingredient → recipe        recipe → mealplan
	 * ```
	 *
	 * Multi-hop exists because the corpus demanded it, not for generality:
	 * "aggregate ingredients across every planned recipe" is two hops, and a
	 * one-hop-only primitive would have left that ask off-surface while looking
	 * like it had absorbed it. Bounded by {@link MAX_ROLLUP_HOPS} — every hop is a
	 * join, so the path length is a cost the spec states out loud.
	 */
	via?: FieldId | readonly FieldId[]
	fn: AggFn
	/**
	 * The value on `over` being aggregated. Required for every `fn` but `count`.
	 *
	 * May be a **stored field** or a **computed field** — the latter is what makes
	 * `gymlog`'s corpus ask expressible: estimated 1RM is computed per log entry,
	 * then `max`-ed into a weekly series. It may never be another rollup.
	 *
	 * **Why that keeps the graph acyclic, with no cycle detector.** A computed
	 * field's leaves are stored numeric fields *on its own entity* (enforced by
	 * `computedExprErrors`). So the only edges that exist are
	 * `rollup → computed → stored` and `rollup → stored`: derived references form
	 * a DAG of depth ≤ 2 by construction. Allowing `rollup → rollup` is the single
	 * change that would break that argument, which is exactly why it is rejected.
	 */
	field?: FieldId | DerivedId
	/** Equality constraints on `over`'s fields (AND-ed). */
	where?: RollupFilter[]
	/** Group the aggregate, producing a series rather than a scalar. */
	groupBy?: RollupGroupBy
	/**
	 * Maximum groups returned. **Required whenever `groupBy` is set** — an
	 * unbounded `GROUP BY` over a growing table is the performance foot-gun this
	 * op family could most easily become, so the spec has to state its bound
	 * rather than discovering it in production. Ignored for scalar rollups, which
	 * are bounded already.
	 */
	limit?: number
}

/**
 * The largest `limit` a grouped rollup may declare. A cap, not a default: the
 * point is that a rollup renders a card or a chart, and a spec asking for 50,000
 * groups has mistaken the field vocabulary for a reporting engine.
 */
export const MAX_ROLLUP_LIMIT = 1000

/**
 * How many reference hops a rollup's `via` path may traverse. Each hop is a join,
 * so this is a cost bound in the same spirit as {@link MAX_ROLLUP_LIMIT}. Three
 * covers the corpus (recipebox's shopping list is two) with one to spare; a spec
 * needing four has a modelling problem a rollup will not fix.
 */
export const MAX_ROLLUP_HOPS = 3

export interface EntitySpec extends Provenanced {
	id: EntityId
	name: string
	description?: string
	fields: FieldSpec[]
	/**
	 * Values derived from each row's own fields. Never stored, never
	 * written, evaluated on read.
	 */
	computed?: ComputedFieldSpec[]
	/** Aggregates over related entities' rows. */
	rollups?: RollupSpec[]
}

export interface DataSpec {
	entities: EntitySpec[]
}

// ===========================================================================
// Page/UX layer
// ===========================================================================

/** Server-side row ordering for a list/`table` block (spec-as-data ranking). */
export interface BlockOrder {
	/** The entity field to sort by (e.g. `points`). */
	field: string
	/** Sort direction; defaults to `asc` when omitted. */
	direction?: 'asc' | 'desc'
}

/**
 * How a list/`table` block presents its rows. `table` is the classic admin
 * grid; `cards` is a responsive card grid; `feed` is a stacked
 * title/description/date reading list. Presentation is spec-as-data: "make it
 * look like a gallery" is a `page.setBlockVariant` op, not an eject.
 */
export type BlockVariant = 'table' | 'cards' | 'feed'

/**
 * Runtime guard for {@link BlockVariant} — same rationale as
 * {@link FIELD_TYPES}: the union is erased at compile time and ops arrive as
 * JSON. Keep in sync with {@link BlockVariant}.
 */
export const BLOCK_VARIANTS: readonly BlockVariant[] = [
	'table',
	'cards',
	'feed',
]

// ---------------------------------------------------------------------------
// Date-arranged views
//
// A calendar, a heatmap and a Gantt chart are the same rows arranged by a date
// column. That is a *view* primitive, not three bespoke features, so it is a
// declared block with a declared date field rather than an eject.
//
// Two lines are drawn here on purpose, because they are where the scope creep
// of every calendar feature lives:
//
//   1. **Presentation only.** A view arranges rows the spec already declares.
//      Streak-freeze rules, critical-path rescheduling and recurrence expansion
//      are *derivations*, and they belong to the data layer (`computed`,
//      `rollups`) or nowhere — never to a block that draws a grid.
//   2. **The timezone is declared, never inferred.** A view that buckets rows
//      into days by the *server's* local zone silently disagrees with the same
//      view in another zone; a view that buckets by the *browser's* renders
//      differently for two people looking at one screen. Both are the classic
//      calendar bug. `timezone` is required for exactly that reason.
// ---------------------------------------------------------------------------

/**
 * How a `calendar` block draws its date column. `month`/`week` place each row on
 * its day; `heatmap` draws density — rows per day over a rolling year, the
 * contribution-graph shape.
 */
export type CalendarDisplay = 'month' | 'week' | 'heatmap'

/** Runtime guard for {@link CalendarDisplay} — same rationale as {@link FIELD_TYPES}. */
export const CALENDAR_DISPLAYS: readonly CalendarDisplay[] = [
	'month',
	'week',
	'heatmap',
]

/**
 * A `calendar` block's declaration: which date column places a row,
 * how the grid is drawn, and the timezone the days are bucketed in.
 */
export interface CalendarSpec {
	/** The `date` field each row is placed by. */
	dateField: string
	/**
	 * An optional second `date` field ending a multi-day entry. Absent = each row
	 * occupies the single day of {@link dateField}.
	 */
	endField?: string
	/** How the grid is drawn. See {@link CalendarDisplay}. */
	display: CalendarDisplay
	/** IANA timezone the days are bucketed in (e.g. `America/New_York`). */
	timezone: string
	/** The field rendered as an entry's label; defaults to the title heuristic. */
	titleField?: string
	/**
	 * Whether an entry may be moved to another day — by drag or by keyboard.
	 * A move is an ordinary update of {@link dateField} through the same
	 * server-side validation, permission and audit path as editing that field in
	 * a form; the view never gets a write path of its own. Defaults to false, so
	 * a read-only calendar is the read-only thing it looks like.
	 *
	 * Meaningless on a `heatmap`, which draws counts rather than entries, and
	 * refused there rather than silently ignored.
	 */
	reschedule?: boolean
}

/**
 * A `timeline` block's declaration: the same rows drawn as bars
 * across a date range, optionally with dependency edges.
 */
export interface TimelineSpec {
	/** The `date` field a bar starts at. */
	startField: string
	/** The `date` field a bar ends at. A bar has two ends; both are required. */
	endField: string
	/** IANA timezone the days are bucketed in (e.g. `America/New_York`). */
	timezone: string
	/** The field rendered as a bar's label; defaults to the title heuristic. */
	titleField?: string
	/**
	 * A field referencing the *same* entity, whose value is the row this row
	 * follows — drawn as an arrow. Presentation of a declared relation and
	 * nothing more: the timeline draws the edge, it does not reschedule
	 * dependents, detect cycles, or compute a critical path.
	 */
	dependsOn?: string
	/** Whether a bar may be moved. Same contract as {@link CalendarSpec.reschedule};
	 * a move shifts `startField` and `endField` together, preserving duration. */
	reschedule?: boolean
}

// ---------------------------------------------------------------------------
// Board views
//
// A Kanban board is not a new kind of app. It is: group rows by an enum column,
// order them within each group, and change the enum by dragging. Every piece of
// that already existed as data — enums carry their options, a manual-ordering
// key is a column, and a drag is an update of one field — so the board is a
// declared arrangement, the same shape as #171's calendar.
//
// Two lines are drawn here, and both are where "add a board" usually goes wrong:
//
//   1. **The rule lives where the write does.** A WIP limit belongs to the
//      *field* (`FieldSpec.limits`), not to the board, because the board is one
//      of several ways to write that field and the least privileged one. See the
//      note on `limits`.
//   2. **The board declares presentation and nothing else.** Which column a card
//      is in is data; what happens *because* it moved — notify someone, start a
//      timer, create an invoice — is not modelled here and is not smuggled in
//      under "board".
// ---------------------------------------------------------------------------

/**
 * A `board` block's declaration: which column groups the cards,
 * which key orders them within a group, and whether cards can be moved.
 */
export interface BoardSpec {
	/**
	 * The `enum` field whose value places a card in a column. It must carry
	 * declared `options` — those are the board's columns, in the order declared,
	 * and a board over an undeclared value list is a board with no columns.
	 */
	groupField: string
	/**
	 * A `rank: true` field on the same entity persisting manual order *within* a
	 * column. Absent = cards are ordered by the page's own list order and a move
	 * only changes columns, never position. See {@link FieldSpec.rank}.
	 */
	rankField?: string
	/** The field rendered as a card's title; defaults to the title heuristic. */
	titleField?: string
	/**
	 * Extra fields rendered on the card under its title — an enum lands as a
	 * chip, anything else as text. Absent = title only.
	 */
	cardFields?: string[]
	/**
	 * Whether a card may be moved — by drag or by keyboard. A move is an ordinary
	 * update of {@link groupField} (and {@link rankField}) through the same
	 * server-side validation, permission, WIP-limit and audit path as editing
	 * that field in a form; the board never gets a write path of its own.
	 * Defaults to false, so a read-only board is the read-only thing it looks
	 * like.
	 */
	move?: boolean
}

// ---------------------------------------------------------------------------
// Aggregate views (#299)
//
// Every other view block arranges **rows**. An `aggregate` block arranges a
// **GROUP BY** — the shape a dashboard is made of, and the one gap that pushed
// half of a real app's pages out of the spec and into owned code.
//
// Three lines are drawn here, and each of them is a security or honesty
// property rather than taste:
//
//   1. **Everything that reaches SQL comes from the spec.** The grouped column,
//      the measure column and the aggregate function are resolved against the
//      registry at read time; no query parameter contributes to the query. A
//      `GROUP BY` over a caller-supplied column is an injection surface, and
//      there is no request-shaped path to this declaration at all.
//   2. **The read is a read of many rows, so it runs the read gate.** The
//      aggregate is computed in SQL *under* the same permission check, tenant
//      scope and soft-delete scope a list runs under (`opAggregate`). A count
//      that crosses a tenant boundary is a leak whether or not the rows come
//      back with it.
//   3. **Only a dimension may be grouped.** See {@link AggregateSpec.groupField}.
// ---------------------------------------------------------------------------

/** How an {@link AggregateSpec}'s buckets are drawn. */
export type AggregateDisplay = 'bar' | 'table'

/** Runtime guard for {@link AggregateDisplay}. */
export const AGGREGATE_DISPLAYS: readonly AggregateDisplay[] = ['bar', 'table']

/**
 * Field types a {@link AggregateSpec.groupField} may name.
 *
 * `string`, `number`, `json` and `file` are **refused**, and the reason is not
 * taste: a `GROUP BY` over free text has unbounded cardinality, so the block's
 * cost becomes a property of the *data* rather than of the declaration — a tile
 * that is four bars in dev and forty thousand in production, which the `limit`
 * cap can truncate but cannot make meaningful. A dashboard groups by a
 * *dimension*, and this is the declaration saying which fields are one.
 *
 * `reference` is not here **yet** — a grouped FK renders as raw ids unless the
 * titles are resolved, and that resolution is a real scope addition rather than
 * a validation relaxation.
 */
export const AGGREGATE_GROUP_TYPES: readonly FieldSpec['type'][] = [
	'enum',
	'boolean',
	'date',
]

/**
 * An `aggregate` block's declaration: one grouped measure over the page's
 * backing entity.
 *
 * Presentation only, exactly like {@link BoardSpec} — it says which dimension
 * splits the rows and what number is drawn per bucket, and nothing about what
 * happens *because* a bucket is large.
 */
export interface AggregateSpec {
	/**
	 * The field NAME whose value places a row in a bucket. Must be one of
	 * {@link AGGREGATE_GROUP_TYPES}.
	 */
	groupField: string
	/**
	 * How a `date` {@link groupField} is truncated into buckets. **Required iff**
	 * `groupField` is a date, and refused otherwise: grouping raw timestamps
	 * gives one bucket per row, which is a list with extra steps, and a bucket on
	 * a non-date column is a declaration the runtime would have to ignore.
	 */
	bucket?: TimeBucket
	/** The aggregate drawn per bucket. Reuses the rollup vocabulary. */
	fn: AggFn
	/**
	 * The field NAME aggregated. **Required iff** {@link fn} is in
	 * {@link AGG_FNS_NEEDING_FIELD}, refused for `count` (which counts rows and
	 * has no column), and required to be numeric for {@link NUMERIC_AGG_FNS}.
	 */
	measureField?: string
	/**
	 * Equality predicates narrowing which rows are aggregated — "open tickets by
	 * priority". Declared, never request-supplied, and AND-ed **under** the
	 * tenant, soft-delete and portal scopes, so nothing here can widen the read.
	 */
	where?: AggregateFilter[]
	/** How the buckets are drawn. Defaults to `bar`. */
	display?: AggregateDisplay
	/**
	 * Maximum buckets returned, largest measure first. Defaults to
	 * {@link AGGREGATE_LIMIT_DEFAULT} and is capped at
	 * {@link AGGREGATE_LIMIT_MAX} — the cap is the honest half of allowing a
	 * bounded-cardinality dimension to still be wider than a chart can draw.
	 */
	limit?: number
}

/** One declared equality predicate on an {@link AggregateSpec}. */
export interface AggregateFilter {
	/** Field NAME on the page's backing entity. */
	field: string
	/** The value it must equal. `null` tests IS NULL. */
	equals: string | number | boolean | null
}

/** Buckets an aggregate returns when it declares no `limit`. */
export const AGGREGATE_LIMIT_DEFAULT = 12

/** The most buckets an aggregate may declare. */
export const AGGREGATE_LIMIT_MAX = 50

/**
 * Block types that arrange rows by something other than a list (
 * #172). None carries a {@link BlockVariant}: the arrangement *is* the variant,
 * and it lives on the view declaration where it can be validated against the
 * fields it names.
 */
export const VIEW_BLOCK_TYPES = [
	'calendar',
	'timeline',
	'board',
	'aggregate',
] as const

export interface BlockSpec extends Provenanced {
	id: BlockId
	/** A template key from the page registry (`table`, `form`, `hero`, …). */
	type: string
	/**
	 * For `calendar` blocks: the date column, display and timezone the rows are
	 * arranged by. Set via `page.addCalendar`.
	 */
	calendar?: CalendarSpec
	/**
	 * For `timeline` blocks: the date range each bar spans and the optional
	 * dependency relation drawn between bars. Set via
	 * `page.addTimeline`.
	 */
	timeline?: TimelineSpec
	/**
	 * For `board` blocks: the column the cards are grouped by, the key they are
	 * ordered by within a column, and whether they can be moved. Set
	 * via `page.addBoard`.
	 */
	board?: BoardSpec
	/**
	 * For `aggregate` blocks: the dimension the rows are grouped by and the
	 * measure drawn per bucket. Set via `page.addAggregate`.
	 */
	aggregate?: AggregateSpec
	/**
	 * For `table`/list blocks: which presentation the runtime renders the rows
	 * with (defaults to `table`). See {@link BlockVariant}; set via the
	 * `page.setBlockVariant` op. Ignored by non-list block types.
	 */
	variant?: BlockVariant
	/**
	 * For `table`/list blocks: how the runtime orders the rows. Makes "ranked by
	 * <field>" expressible in spec-as-data (Bar 1) instead of requiring owned
	 * code — e.g. a news front page ranked by `points desc`. Ignored by
	 * non-list block types.
	 */
	order?: BlockOrder
	/**
	 * For `table`/list blocks: which entity fields the list renders, in the
	 * order given. Undefined = the zero-config heuristics (first
	 * N visible columns; per-variant title/description/date picks).
	 *
	 * This exists because the variants' inferred picks are a guess: a reviews
	 * feed inferred as title/author/date hides the rating and the review, which
	 * are the whole point of the app. Without it "also show these two fields" is
	 * a `mode: "replace"` slot — a hand-written component for a presentation
	 * tweak, which pushes people off the spec ladder far too early.
	 *
	 * Names are entity field names (not ids), validated against the page's
	 * backing entity. The first name is the list's title/primary column.
	 * Ignored by non-list block types.
	 */
	fields?: string[]
	/**
	 * For `table`/list blocks: which entity fields edit **in place**, in the list,
	 * without a trip to the form. Undefined or empty = none, so a
	 * list is the read surface it looks like until someone declares otherwise.
	 *
	 * Two lines are drawn here, and they are the same two the board draws:
	 *
	 *  1. **The list never gets a write path of its own.** A cell edit is
	 *     submitted to the record's ordinary edit route, in the record's ordinary
	 *     encoding — the same route, action and content type the form posts to —
	 *     so it runs the identical server-side validation, permission check,
	 *     value-limit enforcement and audit entry. There is no inline-edit
	 *     endpoint, by construction; see `apps/web/app/inline-edit.ts`.
	 *  2. **The capability is declared, not defaulted.** Naming the fields is what
	 *     makes "this list can be written from" a reviewable line in the spec
	 *     rather than a global switch that quietly widens every list's write
	 *     surface the day it ships.
	 *
	 * Names are entity field names (not ids), validated against the page's backing
	 * entity *and* against what a cell can actually edit: a reference, a file, a
	 * `json` blob and a rank key are refused at op time, because an editor that
	 * cannot represent the value is a cell that silently corrupts it. Ignored by
	 * non-list block types. Set via the `page.setBlockEditable` op.
	 */
	editable?: string[]
	/**
	 * For `slot:<name>` blocks: whether the slot's owned component renders
	 * *below* the page's default list (`append`, the default) or *instead of* it
	 * (`replace`).
	 *
	 * `replace` exists so "make this page look different" is a spec change
	 * rather than an eject. Without it the customization ladder had
	 * no middle rung: a slot could only append, so any real redesign meant
	 * ejecting the whole route and permanently losing regeneration. A replacing
	 * slot keeps the page spec-driven — new fields still flow into the data it
	 * reads — while the presentation is entirely the user's.
	 *
	 * Only meaningful on slot blocks. Takes effect only when the slot is
	 * actually filled; a declared-but-empty `replace` slot leaves the default
	 * list in place, so the page is never blank mid-authoring.
	 */
	mode?: 'append' | 'replace'
	/**
	 * The key of a declared flag gating this block. When the flag is
	 * off for the viewer the block is not composed into the page — the *route*
	 * still exists and the generated code is unchanged, because a flag never
	 * reaches the generator. Validated against `flags` at op time, so a gate on
	 * an undeclared key cannot land.
	 */
	flag?: string
}

export interface PageSpec extends Provenanced {
	id: PageId
	name: string
	route: string
	blocks: BlockSpec[]
	/** The data entity this page is derived from, when it is a CRUD page. */
	entityId?: EntityId
	/**
	 * Natural-language end-to-end tests for this page (mxscratchpad convention,
	 * the design). The `gen:e2e-tests` generator scaffolds one Playwright
	 * `test()` per string; the agent fills the body. These become the app's own
	 * eval once complete (§3-L4B: acceptance/e2e specs as the oracle).
	 */
	e2eTests?: string[]
	/**
	 * The key of a declared flag gating this whole page. Off for the
	 * viewer ⇒ the page is not navigable and its slug 404s, exactly as if it had
	 * not been accepted. The generated route module is emitted either way.
	 */
	flag?: string
}

export interface PagesSpec {
	pages: PageSpec[]
}

// ===========================================================================
// Pricing / business model layer
// ===========================================================================

export interface PricingTier extends Provenanced {
	id: TierId
	name: string
	priceMonthly: number
	features: string[]
}

export interface PricingSpec {
	tiers: PricingTier[]
}

// ===========================================================================
// Theme layer
// ===========================================================================

/**
 * Curated theme presets. Each expands to a full light+dark shadcn-token
 * palette (`@maxstack/ui`'s `THEME_PALETTES` — the values live UI-side so this
 * package stays free of presentation deps; the preset *names* are the spec's
 * vocabulary and the UI table is typed `Record<ThemePreset, …>` so the two
 * can't drift). `zinc` is the platform default — a `theme.set` to zinc with no
 * overrides is a visual no-op.
 */
export type ThemePreset =
	| 'zinc'
	| 'ocean'
	| 'forest'
	| 'sunset'
	| 'mono'
	| 'rose'
	| 'amber'

/** Runtime guard for {@link ThemePreset} (JSON-borne ops). Keep in sync. */
export const THEME_PRESETS: readonly ThemePreset[] = [
	'zinc',
	'ocean',
	'forest',
	'sunset',
	'mono',
	'rose',
	'amber',
]

/** Corner rounding scale, mapped to the Tailwind `--radius-*` variables. */
export type ThemeRadius = 'sm' | 'md' | 'lg' | 'full'
export const THEME_RADII: readonly ThemeRadius[] = ['sm', 'md', 'lg', 'full']

/** Default rendering density of generated pages (tables, lists). */
export type ThemeDensity = 'comfortable' | 'compact'
export const THEME_DENSITIES: readonly ThemeDensity[] = [
	'comfortable',
	'compact',
]

/**
 * Typeface personality via curated *system* font stacks — no webfont files to
 * ship, still a visible identity change. The stacks themselves live UI-side
 * (`FONT_STACKS`).
 */
export type ThemeFont = 'sans' | 'serif' | 'mono' | 'rounded' | 'humanist'
export const THEME_FONTS: readonly ThemeFont[] = [
	'sans',
	'serif',
	'mono',
	'rounded',
	'humanist',
]

/** Type-size scale, mapped to the Tailwind `--text-*` variables. */
export type ThemeTypeScale = 'compact' | 'default' | 'relaxed'
export const THEME_TYPE_SCALES: readonly ThemeTypeScale[] = [
	'compact',
	'default',
	'relaxed',
]

/** `#rgb` / `#rrggbb` — the only accepted accent format. */
export const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * The app's visual design as spec-as-data: a curated preset plus
 * a few high-leverage overrides, so "make it beautiful" is a `theme.set` op
 * rather than an eject. Deliberately NOT `Provenanced`: it is whole-document
 * last-wins state, not a reviewable row — the audit trail is the `theme.set`
 * entry in the op log (origin + timestamp + diff), same as any op.
 *
 * Forward-compat: this stays an object keyed by option names so a later
 * granular `overrides?: Partial<Record<TokenName, string>>` key (per-token
 * palette control) is purely additive — no codec or format change needed.
 */
export interface ThemeSpec {
	preset: ThemePreset
	/**
	 * Accent hue as `#rgb`/`#rrggbb` (validated by {@link ACCENT_RE}). Overrides
	 * the preset's `--primary`/`--ring`; the readable foreground is derived by
	 * luminance UI-side.
	 */
	accent?: string
	radius?: ThemeRadius
	density?: ThemeDensity
	font?: ThemeFont
	typeScale?: ThemeTypeScale
}

/** The theme every spec has before a `theme.set` lands. */
export const DEFAULT_THEME: ThemeSpec = { preset: 'zinc' }

/**
 * The theme a spec renders with — the stored one, or the zinc default when no
 * `theme.set` has ever been applied. Read sites go through this so "absent"
 * never leaks past the spec package.
 */
export function resolveTheme(spec: Pick<SpecSystem, 'theme'>): ThemeSpec {
	return spec.theme ?? DEFAULT_THEME
}

// ===========================================================================
// The aggregate
// ===========================================================================

export interface SpecSystem extends AutoAcceptPolicy {
	product: PRD
	data: DataSpec
	pages: PagesSpec
	pricing: PricingSpec
	/**
	 * Visual design. Optional — absent means {@link DEFAULT_THEME};
	 * use {@link resolveTheme}. Kept optional so pre-theme spec dirs decode
	 * unchanged (no format bump) and untouched projects grow no `theme.json`.
	 */
	theme?: ThemeSpec
	/**
	 * Declared feature flags. Optional — absent means the project has
	 * never declared one, so pre-#187 spec dirs decode unchanged and untouched
	 * projects grow no `flags.json`. See `flags.ts` for the evaluation rule.
	 */
	flags?: FlagsSpec
	/**
	 * Declared schedules. Optional on the same absence-means-nothing
	 * rule as {@link flags}: a project that has never declared recurrence grows no
	 * `schedules.json`, so pre-#181 spec dirs round-trip byte-identical. See
	 * `schedules.ts` for the next-fire rule.
	 */
	schedules?: SchedulesSpec
	/**
	 * Declared external data sources. Optional on the same
	 * absence-means-nothing rule as {@link flags} and {@link schedules}: a project
	 * that has never declared one grows no `sources.json`, so pre-#173 spec dirs
	 * round-trip byte-identical. See `sources.ts` — nothing there does IO, so
	 * declaring a source cannot make generation reach the network.
	 */
	sources?: SourcesSpec
	/**
	 * Declared full-text search indexes. Optional on the same
	 * absence-means-nothing rule as the layers above: a project that has never
	 * declared one grows no `search.json`, so pre-#174 spec dirs round-trip
	 * byte-identical. See `search.ts` — an index is an *expression* index, so
	 * declaring one adds no column and rewrites no table.
	 */
	search?: SearchSpec
	/**
	 * Declared document templates. Optional on the same
	 * absence-means-nothing rule as the layers above: a project that has never
	 * declared one grows no `documents.json`, so pre-#176 spec dirs round-trip
	 * byte-identical. See `documents.ts` — a template adds no column and no table,
	 * because a document is a *rendering* of rows that already exist.
	 */
	documents?: DocumentsSpec
	/**
	 * Declared importers. Optional on the same absence-means-nothing
	 * rule as the layers above: a project that has never declared one grows no
	 * `imports.json`, so pre-#175 spec dirs round-trip byte-identical. See
	 * `imports.ts` — an importer adds no column and no table either; it is a
	 * declared *way in* to rows that already have a shape.
	 */
	imports?: ImportsSpec
	/**
	 * Declared public and token-scoped surfaces. Optional on the same
	 * absence-means-nothing rule as the layers above, and here the rule carries
	 * the strongest meaning it has anywhere: **absent means nothing in this spec
	 * is reachable without a session.** A project that has never declared a portal
	 * grows no `portals.json`, so every pre-#177 spec dir round-trips
	 * byte-identical *and* reads as having no outside, which is the correct
	 * default rather than a convenient one.
	 *
	 * A portal adds no column and no table. It is a declared *audience* for rows
	 * that already have a shape — see `portals.ts`, and note that nothing about
	 * the enforcement lives in a route.
	 */
	portals?: PortalsSpec
	/**
	 * Declared live subscriptions. Optional on the same
	 * absence-means-nothing rule as the layers above: a project that has never
	 * declared one grows no `live.json`, so pre-#179 spec dirs round-trip
	 * byte-identical *and* read as holding no connection open — every derived
	 * surface is a snapshot, which is the correct default rather than a
	 * convenient one.
	 *
	 * A subscription adds no column and no table. It is a declared *bound* on
	 * which changes to rows that already have a shape get pushed to whom — see
	 * `live.ts`, and note that fan-out is in-process by stated design.
	 */
	live?: LiveSpec
	/** Append-only decision ledger (§3-L1). */
	ledger: DecisionLedger
	/** The applied-op audit trail — every mutation is logged and diffable. */
	opLog: AppliedOp[]
}

/** A fresh system wrapping a PRD, with empty data/page/pricing/ledger/log. */
export function newSpecSystem(
	product: PRD,
	opts: { autoAccept?: boolean } = {},
): SpecSystem {
	return {
		product,
		data: { entities: [] },
		pages: { pages: [] },
		pricing: { tiers: [] },
		ledger: [],
		opLog: [],
		autoAccept: opts.autoAccept ?? DEFAULT_AUTO_ACCEPT,
	}
}
