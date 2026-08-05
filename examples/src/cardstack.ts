/**
 * Example app: cardstack (spaced-repetition flashcards).
 *
 * Grounded in the ported `cardstackPRD` fixture (the richest archive PRD,
 * A study-loop domain (decks, cards, reviews) with a dated review
 * record — closer to todotracker's shape than taskly's, but its own vocabulary.
 *
 * Its backlog is the moat's hard case: a study loop wants a scheduling
 * algorithm, an interactive review mode, and importers — asks with no op or
 * slot to express them. So it scores a *low* spec-op share (three off-surface
 * changes), which is exactly the honest signal the ratio should carry.
 */

import { cardstackPRD } from './deps.ts'
import {
	addField,
	addPage,
	crudExample,
	ejectPage,
	entity,
	field,
	fillImportParser,
	fillSlot,
	importer,
	offSurface,
	page,
	retitle,
	schedule,
	slot,
	table,
} from './kit.ts'

const entities = [
	entity('e-deck', 'Deck', 'A named collection of flashcards.', [
		field('fld-deck-name', 'name', 'string', true),
		field('fld-deck-archived', 'archived', 'boolean'),
	]),
	entity('e-card', 'Card', 'A front/back flashcard in a deck.', [
		// SPEC EDIT 2026-07-28: a card carries the note GUID it was
		// imported under. Every flashcard app that can read a deck has this column
		// or an equivalent, because it is what makes re-importing an updated deck
		// an update rather than a second copy of everybody's collection. It is a
		// property of the product, not a request somebody made, so it is spec and
		// not backlog. See docs/corpus/cardstack-anki-import.md.
		field('fld-card-guid', 'guid', 'string'),
		field('fld-card-front', 'front', 'string', true),
		field('fld-card-back', 'back', 'string', true),
		field('fld-card-ease', 'ease', 'number'),
	]),
	entity('e-review', 'Review', 'A dated record that a card was reviewed.', [
		field('fld-review-date', 'date', 'date', true),
		field('fld-review-grade', 'grade', 'enum', true),
	]),
]

const decksPage = page({
	id: 'pg-decks',
	name: 'Decks',
	route: '/app/decks',
	entityId: 'e-deck',
	blocks: [table('blk-decks-table'), slot('blk-decks-due', 'dueBadge')],
	e2eTests: [
		'A learner can create a deck and see it in the list',
		'A deck with cards due today shows a due badge',
	],
})

const cardsPage = page({
	id: 'pg-cards',
	name: 'Cards',
	route: '/app/cards',
	entityId: 'e-card',
	blocks: [table('blk-cards-table'), slot('blk-cards-actions', 'cardActions')],
	e2eTests: [
		'A learner can add a card with a front and back',
		'Grading a card again shortens its next interval',
	],
})

const reviewsPage = page({
	id: 'pg-reviews',
	name: 'Reviews',
	route: '/app/reviews',
	entityId: 'e-review',
	blocks: [table('blk-reviews-table')],
	e2eTests: [
		'A learner sees today’s review count',
		'The empty state shows before any reviews exist',
	],
})

/**
 * The nightly re-ordering of the due queue (a `spec-edit` under
 * docs/corpus/cardstack-due-queue-schedule.md).
 *
 * The platform declares *when* it runs, in which timezone, and as whom. It
 * deliberately does not declare *what* it computes: absorbing SM-2 into the op
 * vocabulary would be the framework-as-cage failure — the next flashcard app
 * wants FSRS, or Leitner, or something nobody has written yet. The algorithm
 * lands in the generated handler slot instead, which is what moves
 * `ch-sm2-scheduler` from off-surface to slot-fill.
 */
const dueQueueSchedule = schedule({
	id: 'sch-card-due-queue',
	key: 'card.due-queue',
	description: 'Recompute the due queue order for every learner.',
	timezone: 'UTC',
	recurrence: { kind: 'daily', atTime: '03:00' },
	runAs: { kind: 'service', role: 'scheduler' },
	entityId: 'e-card',
})

/**
 * SPEC EDIT 2026-07-28 — the Anki importer the app declares.
 *
 * Declared as part of what the app *is*, on the same terms schedules were in
 * #181 and sources in #173: the backlog ask below is what is *asked of it*.
 *
 * Two choices carry the argument, and both are the honest one rather than the
 * convenient one:
 *
 *  - `format: 'custom'`. A `.apkg` is a zip holding a SQLite database, a media
 *    manifest and positional note fields. The platform cannot read it and does
 *    not pretend to; it names the module that can, and everything downstream of
 *    that module is the same code a CSV takes.
 *  - `upsertFieldId` is the note GUID, **not** `null`. A deck import is
 *    re-imported: a learner pulls the shared deck again after the author fixed
 *    forty cards. Insert-only would mean a second copy of the whole collection
 *    with the review history attached to the wrong half, which is worse than an
 *    overwrite and much harder to notice. Anki keys on the GUID for exactly this
 *    reason. Declaring it makes "this can overwrite your cards" a reviewable
 *    line in the spec rather than a property of the parser.
 *
 * See docs/corpus/cardstack-anki-import.md.
 */
const ankiImporter = importer({
	id: 'imp-anki',
	key: 'anki-deck',
	description: 'Import a shared deck from an Anki .apkg archive.',
	entityId: 'e-card',
	format: 'custom',
	parserSlot: 'anki-deck',
	columns: [
		{ column: 'guid', fieldId: 'fld-card-guid' },
		{ column: 'front', fieldId: 'fld-card-front' },
		{ column: 'back', fieldId: 'fld-card-back' },
	],
	upsertFieldId: 'fld-card-guid',
	maxRows: 20_000,
	paused: false,
	declaredAt: '2026-07-28',
})

export const cardstackExample = crudExample({
	id: 'cardstack',
	title: 'Cardstack — spaced-repetition flashcards',
	prd: cardstackPRD,
	entities,
	pages: [decksPage, cardsPage],
	schedules: [dueQueueSchedule],
	imports: [ankiImporter],
	changes: [
		addField(
			'ch-card-tags',
			'Add a tags field to cards (spec op).',
			'e-card',
			'fld-card-tags',
			'tags',
			'string',
		),
		addPage(
			'ch-add-reviews',
			'Add the Reviews history page (spec op).',
			reviewsPage,
		),
		retitle(
			'ch-retitle-decks',
			'Rename Decks to “Decks & Due” (regeneration-as-diff).',
			'deck',
			'Decks & Due',
		),
		fillSlot(
			'ch-due-badge-slot',
			'Fill the due-badge slot on the Decks page (slot fill).',
			'deck',
			'dueBadge',
			[
				'// User-owned: the "cards due today" badge on a deck row.',
				'export function dueBadge() {',
				'\treturn <span aria-label="cards due">0 due</span>',
				'}',
			].join('\n'),
		),
		addField(
			'ch-deck-color',
			'Add a color field to decks for at-a-glance grouping (spec op).',
			'e-deck',
			'fld-deck-color',
			'color',
			'string',
		),
		fillSlot(
			'ch-card-actions-slot',
			'Fill the card-actions slot with edit/suspend controls (slot fill).',
			'card',
			'cardActions',
			[
				'// User-owned: per-card edit + suspend controls.',
				'export function cardActions() {',
				'\treturn <button type="button">Suspend</button>',
				'}',
			].join('\n'),
		),
		addField(
			'ch-review-duration',
			'Record how long each review took (spec op).',
			'e-review',
			'fld-review-duration',
			'durationMs',
			'number',
		),
		ejectPage(
			'ch-eject-reviews',
			'Eject the Reviews page for a bespoke session-summary layout (eject).',
			'review',
		),
		fillSlot(
			// RECLASSIFIED 2026-07-27 by issue #181, from off-surface/unexpressible.
			// The platform did not learn SM-2 — that would be the cage. It declared
			// the schedule, generated a typed handler slot, and promised never to
			// overwrite it. See docs/corpus/cardstack-sm2-slot.md.
			'ch-sm2-scheduler',
			'An SM-2 spaced-repetition scheduler that reorders the due queue by grade, in the schedule’s handler slot (slot fill).',
			'card',
			'schedule:card.due-queue',
			[
				'// User-owned: SM-2 next-interval computation. The platform schedules',
				'// this and never rewrites it; the algorithm is ours.',
				"import type { ScheduleHandlerContext } from '@maxstack/features/jobs'",
				'',
				'export default async function handler(ctx: ScheduleHandlerContext) {',
				'\tvoid ctx',
				'}',
			].join('\n'),
		),
		fillSlot(
			// RECLASSIFIED 2026-07-28 by issue #178, from off-surface/eject. A study
			// player is legitimately bespoke and should stay that way; what changed
			// is that taking over the *list region* no longer costs the whole
			// surface. See docs/corpus/cardstack-study-mode-slot.md.
			'ch-study-mode',
			'An interactive study mode (card-flip animation, keyboard grading) in the decks list slot (slot fill).',
			'deck',
			'deck__list',
			[
				'// User-owned: the study player. Rows arrive loaded, ordered, and with',
				'// references resolved; the page frame, nav and routing keep',
				'// regenerating around this component.',
				"import type { ListSlotProps } from '@maxstack/ui'",
				'',
				'// The page-level slot this file already owned — one user-owned module',
				'// holds every slot for the resource, block-level and declared alike.',
				'export function dueBadge() {',
				'\treturn null',
				'}',
				'',
				'export function deck__list(props: ListSlotProps) {',
				'\tvoid props',
				'\treturn null',
				'}',
			].join('\n'),
		),
		fillImportParser(
			// RECLASSIFIED 2026-07-28 by issue #175, from off-surface/unexpressible.
			// The platform did not learn to read a zip full of SQLite — that would be
			// the cage, and the next app wants.xlsx or a vendor dump. It declared the
			// importer (format, mapping, an explicit upsert key, a row ceiling),
			// generated a typed parser slot, and promised never to overwrite it. The
			// parser yields records; the mapping, the per-row validation, the gated
			// upsert lookup and the write are the platform's, identically to a CSV's.
			// See docs/corpus/cardstack-anki-import.md.
			'ch-anki-import',
			'Read an Anki .apkg archive (a zip holding a SQLite collection) into card records, in the importer’s parser slot (slot fill).',
			'card',
			'anki-deck',
			[
				'// User-owned: the .apkg reader. The platform declared the importer and',
				'// never rewrites this; the archive format is ours to know.',
				"import type { ImportRecord } from '@maxstack/core'",
				'',
				'export default async function* parse(',
				'\tchunks: AsyncIterable<Uint8Array>,',
				'): AsyncGenerator<ImportRecord> {',
				'\tfor await (const chunk of chunks) void chunk',
				'}',
			].join('\n'),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-27 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area and from a shipping product. See
			// docs/corpus/cardstack-cloze-deletion.md.
			'ch-cloze-deletion',
			'Cloze cards: one authored note with several blanked spans, each span becoming its own independently scheduled card that edits to the note keep in sync — no op models one row generating and owning a set of sibling rows (off-surface, unexpressible).',
			'card',
			'unexpressible',
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area and deliberately in a shape a block slot cannot reach: it is
			// about *writes*, not rendering. See docs/corpus/cardstack-session-undo.md.
			'ch-session-undo',
			'Undo the last review inside a study session — reverse the scheduling write and the review row it created, repeatedly, back to the start of the session, with the affordance live only while that session is open — no op models a bounded, reversible write history scoped to something the spec cannot see (off-surface, unexpressible).',
			'review',
			'unexpressible',
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the reclassification above removed, in the same product area
			// and deliberately in a shape the shipped importer definitionally cannot
			// reach: it is about writing a file OUT, repeatedly, preserving identity
			// and state on both sides. An importer reads bytes once, in one
			// direction, and writes rows. See docs/corpus/cardstack-apkg-roundtrip.md.
			'ch-apkg-roundtrip',
			'Export back to .apkg and re-import repeatedly without duplicating or resetting anything: carry each card’s scheduling state and review history out with it, keep the note GUIDs and media stable across both directions, and reconcile edits made on either side since the last exchange — no op models a bidirectional, identity-preserving exchange of state with an external file (off-surface, unexpressible).',
			'card',
			'unexpressible',
			// The `import` cluster keeps its representation. It is the same product
			// area and the same file, reached from the other end — which is the
			// direction the shipped primitive definitionally does not go.
			'import',
		),
	],
})
