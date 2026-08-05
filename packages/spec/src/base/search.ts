/**
 * Declared full-text search — "these fields, at these weights, are
 * what searching this entity means" as spec-as-data.
 *
 * One corpus ask fixes the shape: blog's *"ranked full-text search across every
 * post"*. The platform already had a search box — `ListOptions.search` compiles
 * to `ILIKE '%q%'` OR-ed across every text column — and it is worth being
 * precise about why that is not the same feature, because "we already have
 * search" is the objection this primitive has to answer.
 *
 * An unanchored `ILIKE` cannot use an index, so it is a sequential scan of every
 * row on every keystroke. It has no notion of a word, so `cat` matches
 * `certificate`. It does not stem, so `running` does not find `run`. And it has
 * no rank at all: results come back in whatever order the table happens to be
 * in, which means the best match is on page four. Each of those is the *whole*
 * of what a person means when they ask for search.
 *
 * ## The five properties, in the order they constrain the design
 *
 * 1. **Ranking is the feature, and ranking needs weights.** A term in a title
 *    means something different from the same term in the body, and no amount of
 *    tuning at query time recovers that — it has to be in the index. So
 *    {@link SearchField} carries a weight, and it is Postgres's own `A`–`D`
 *    rather than a number this module would have to map onto them. There is
 *    exactly one representation of a weight, so nothing can drift.
 * 2. **The declaration must not be able to leak a row.** Search is a read path
 *    that returns rows the caller did not name, which is precisely the shape of
 *    an access-control bug that looks like a feature. So there is no index
 *    spanning entities: one index belongs to one entity, and searching several
 *    is a fan-out where each entity passes its *own* `read` gate. A shared index
 *    would necessarily hold rows from tables with different rules and could only
 *    ever be gated once, for all of them.
 * 3. **The DDL stays additive.** The index is an *expression* index — no stored
 *    column, so nothing is added to the row, no table is rewritten, and no form,
 *    REST payload or generated type grows a field. It also makes the hardest
 *    half of the additive rule free: an expression index contains no data that
 *    is not derivable from the columns, so dropping one cannot lose anything.
 *    That is what makes {@link SearchIndexSpec.indexed} safe to be a lever
 *    somebody flips at 3am rather than a migration.
 * 4. **Index maintenance is a declared cost, not a hidden one.** A GIN index is
 *    paid for on every insert and update of the indexed columns, and on a
 *    write-heavy table that is a real bill. {@link SearchIndexSpec.indexed} is
 *    the opt-out, and the property that makes it honest is that it changes only
 *    the cost: the same query runs, over the same expression, returning the same
 *    ranked rows, as a sequential scan. Nobody has to choose between "fast" and
 *    "correct", which is the choice that makes people leave the index on a table
 *    that cannot afford it.
 * 5. **Local and deployed must agree.** Everything here is core Postgres —
 *    `to_tsvector`, `setweight`, `ts_rank`, GIN — with no extension and no
 *    `CREATE EXTENSION` privilege question, so pglite and a managed Postgres run
 *    byte-identical SQL. The local backend silently lacking search would be the
 *    worst possible version of this feature.
 *
 * ## What is deliberately not here
 *
 * **Facets.** The corpus ask is ranking, and the platform already derives facets
 * from `ColumnMetadata.filterable`. A second, search-specific facet concept
 * would be two things to keep in step that answer the same question, so a search
 * result is filtered and faceted by exactly what a list is.
 *
 * **A query language.** The query string is handed to `websearch_to_tsquery`,
 * which is the one tsquery parser that cannot throw on hostile input —
 * `to_tsquery('a &')` raises, and a search box that 500s on a stray ampersand is
 * a bug nobody can reproduce on purpose. It already understands quoted phrases,
 * `OR`, and `-term`, which is what people type.
 *
 * **Synonyms, typo tolerance and per-query curation.** These are query-time
 * policy keyed on the query string; everything here is document-time policy
 * keyed on the field. They are a different mechanism, they are what a product
 * reaches for a search *service* to get, and pretending a weight vector covers
 * them would be the vocabulary claiming ground it does not hold.
 */

import type { EntityId, FieldId, ISODate, SearchIndexId } from './ids.ts'
import { getAcceptedOrAll, type Provenanced } from './provenance.ts'
import type { SpecSystem } from './spec-system.ts'

// ===========================================================================
// The declaration
// ===========================================================================

/**
 * A field's contribution to the rank, in Postgres's own vocabulary.
 *
 * `A` is the strongest and `D` the weakest; the numeric multipliers behind them
 * are `ts_rank`'s defaults (1.0 / 0.4 / 0.2 / 0.1). They are letters rather than
 * numbers because that is what `setweight` takes and what the index physically
 * stores — inventing a 0–100 scale here would mean a mapping, and a mapping is a
 * second representation that can disagree with the first.
 *
 * Four levels is not a limitation this module chose; it is how many a `tsvector`
 * can hold. Saying so is better than offering a knob that silently rounds.
 */
export type SearchWeight = 'A' | 'B' | 'C' | 'D'

/** Runtime guard for {@link SearchWeight} — ops arrive as JSON. */
export const SEARCH_WEIGHTS = [
	'A',
	'B',
	'C',
	'D',
] as const satisfies readonly SearchWeight[]

/** What each weight multiplies a match by, for prose and docs. `ts_rank`'s defaults. */
export const SEARCH_WEIGHT_FACTORS: Record<SearchWeight, number> = {
	A: 1.0,
	B: 0.4,
	C: 0.2,
	D: 0.1,
}

/**
 * The text-search configuration: which stemmer and stop-word list the index is
 * built with.
 *
 * It is on the index rather than global because it is a property of the *text*,
 * and it cannot be changed at query time: the query has to be parsed with the
 * same configuration the index was built with or the lexemes do not match. A
 * deployment-level setting would therefore be a setting that silently
 * invalidates every index when someone changes it.
 *
 * `simple` is the escape hatch and does no stemming or stop-word removal at all
 * — the right answer for identifiers, tags, SKUs and any corpus that is not
 * prose in one language.
 */
export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number]

/**
 * The configurations a declaration may name. Restricted to the set core
 * Postgres ships (verified present in pglite's build) so a spec cannot name a
 * configuration that exists on the deployment and not on the laptop — and,
 * because this value reaches SQL as a literal `regconfig`, an enum is also what
 * keeps it structurally incapable of being an injection point.
 */
export const SEARCH_LANGUAGES = [
	'simple',
	'arabic',
	'armenian',
	'basque',
	'catalan',
	'danish',
	'dutch',
	'english',
	'estonian',
	'finnish',
	'french',
	'german',
	'greek',
	'hindi',
	'hungarian',
	'indonesian',
	'irish',
	'italian',
	'lithuanian',
	'nepali',
	'norwegian',
	'portuguese',
	'romanian',
	'russian',
	'serbian',
	'spanish',
	'swedish',
	'tamil',
	'turkish',
	'yiddish',
] as const

/** One field's place in the index. */
export interface SearchField {
	/** A `string`-typed field of the index's entity. See {@link searchableFieldTypes}. */
	fieldId: FieldId
	weight: SearchWeight
}

/**
 * A declared full-text index over one entity.
 *
 * **One per entity**, enforced at validate time. Two indexes over the same table
 * would be two answers to "what does searching a post mean", both paid for on
 * every write, with nothing in the vocabulary to say which one a search box
 * gets. The weights already express the thing a second index would have been
 * for.
 */
export interface SearchIndexSpec extends Provenanced {
	id: SearchIndexId
	/**
	 * The stable key the index carries in DDL, `EXPLAIN` output and logs. Separate
	 * from {@link id} for the reason a schedule's key is: it is the string a
	 * person types when they go looking for why a write got slow.
	 */
	key: string
	/** What this index is for, in one line. Rendered in admin and the workbench. */
	description: string
	/** The entity whose rows this index ranks. */
	entityId: EntityId
	language: SearchLanguage
	/** At least one, at most {@link MAX_SEARCH_FIELDS}, no duplicates. */
	fields: SearchField[]
	/**
	 * Whether the GIN index physically exists.
	 *
	 * **Required, not optional with a default.** "Do we pay for this index on
	 * every write" is a decision about someone's production database, and a
	 * default is how that decision gets made by whoever wrote the code generator
	 * rather than by whoever owns the table.
	 *
	 * `false` is the write-heavy opt-out, and the whole design of this primitive
	 * is arranged so that it changes *only* the cost: search still works, over
	 * the same expression, with the same ranking, as a sequential scan. Turning
	 * it off never changes an answer, and turning it back on is one additive
	 * statement — an expression index stores nothing that is not derivable from
	 * the columns, so it can be dropped and rebuilt without risking a row.
	 */
	indexed: boolean
	/** The day the index was declared, stamped by `applyOp` from `appliedAt`. */
	declaredAt: ISODate
}

export interface SearchSpec {
	indexes: SearchIndexSpec[]
}

// ===========================================================================
// Shapes and bounds
// ===========================================================================

/** An index key: the same shape as a flag's, and for the same reasons. */
export const SEARCH_KEY_RE = /^[a-z][a-z0-9-]*$/

/**
 * How long an index key may be.
 *
 * This is not a style rule. The key becomes a database identifier
 * (`search_<key>`), and Postgres silently **truncates** identifiers past 63
 * bytes — so two long keys that share a prefix would resolve to the same index
 * name, and the second `CREATE INDEX` would either collide or, worse, appear to
 * succeed against the first one's definition. 48 leaves room for the prefix with
 * margin, and refusing a long key is the only way to keep the mapping from key
 * to index name injective.
 */
export const MAX_SEARCH_KEY_LENGTH = 48

/** The database identifier for an index's key. Unique because keys are. */
export function searchIndexName(key: string): string {
	return `search_${key.replace(/-/g, '_')}`
}

/**
 * How many fields one index may rank over.
 *
 * Eight is not arbitrary. Every indexed field is re-tokenized on every write to
 * the row, and a `tsvector` only has four weight levels — so past eight fields
 * the declaration is necessarily assigning the same weight to several of them,
 * which is a way of saying the weighting has stopped carrying information.
 */
export const MAX_SEARCH_FIELDS = 8

/**
 * The field types an index may rank over, and the reason is one line per
 * exclusion rather than a blanket "text only":
 *
 * - `string` — yes, unless it is a reference or a rank key (below).
 * - `enum` — yes. A fixed vocabulary is still words, and "find the posts marked
 *   `archived`" is a real search.
 * - `number`, `boolean`, `date` — no. Their text form is not language, stemming
 *   is meaningless on it, and every one of them is already a *filter*, which is
 *   the precise, indexed, correct way to ask that question. Ranking by them
 *   would return worse answers than the facility that already exists.
 * - `json` — no. Its text form is punctuation and key names; indexing it makes
 *   `type` match every row that has a `type` key.
 * - `file` — no. The column holds an opaque storage key, never the bytes and
 *   never the filename, so the only thing an index over it could match is a key
 *   nobody types. Extracting text from an uploaded document is a genuine
 *   capability and it is not this one.
 */
export const searchableFieldTypes: readonly string[] = ['string', 'enum']

// ===========================================================================
// Reading the layer
// ===========================================================================

/** Every declared index, or `[]` for a spec that has never declared one. */
export function listSearchIndexes(
	spec: Pick<SpecSystem, 'search'>,
): SearchIndexSpec[] {
	return spec.search?.indexes ?? []
}

/**
 * The indexes a runtime actually searches: grounded by the same
 * accepted-else-all rule every other layer uses. An index an agent proposed and
 * nobody accepted does not start costing writes.
 */
export function activeSearchIndexes(
	spec: Pick<SpecSystem, 'search'>,
): SearchIndexSpec[] {
	return getAcceptedOrAll(listSearchIndexes(spec))
}

/** The declared index for an entity, if it has one. */
export function findSearchIndex(
	spec: Pick<SpecSystem, 'search'>,
	entityId: EntityId,
): SearchIndexSpec | undefined {
	return activeSearchIndexes(spec).find((i) => i.entityId === entityId)
}

/**
 * The index's fields in rank order (`A` first), then by declaration order.
 *
 * Sorting here rather than trusting declaration order is what makes the emitted
 * SQL independent of the order somebody happened to list fields in — two specs
 * that declare the same weighting produce the same index, and therefore the same
 * `CREATE INDEX` statement, which the combination-safety gate requires.
 */
export function orderedSearchFields(index: SearchIndexSpec): SearchField[] {
	return [...index.fields].sort(
		(a, b) =>
			SEARCH_WEIGHTS.indexOf(a.weight) - SEARCH_WEIGHTS.indexOf(b.weight) ||
			a.fieldId.localeCompare(b.fieldId),
	)
}

/** One line of prose for an index — the diff summary and the admin caption. */
export function describeSearchIndex(index: SearchIndexSpec): string {
	const fields = orderedSearchFields(index)
		.map((f) => `${f.fieldId}:${f.weight}`)
		.join(', ')
	const cost = index.indexed ? 'indexed' : 'unindexed (scan)'
	return `${index.language} over ${fields || 'no fields'} — ${cost}`
}
