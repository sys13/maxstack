/**
 * Example app: bookclub (a reading list + discussion tracker).
 *
 * PRD grounding via the compact `examplePRD` builder. A social,
 * discussion-shaped domain (books → reading lists → discussions) — a different
 * relationship graph than the trackers, so the pipeline stays honest.
 */

import { examplePRD } from './deps.ts'
import {
	addField,
	addPage,
	addSlot,
	belongsTo,
	crudExample,
	declareSource,
	ejectPage,
	entity,
	field,
	fillLiveSlot,
	fillSlot,
	live,
	offSurface,
	page,
	retitle,
	slot,
	source,
	table,
} from './kit.ts'

const entities = [
	entity('e-book', 'Book', 'A book the club might read.', [
		field('fld-book-title', 'title', 'string', true),
		field('fld-book-author', 'author', 'string', true),
		field('fld-book-finished', 'finished', 'boolean'),
		// SPEC EDIT 2026-07-28: a book now carries the ISBN people
		// actually read off the back cover, and somewhere to put the cover art and
		// page count a lookup returns. All three are prerequisites the ISBN-lookup
		// ask presupposed and the spec never modelled — a shelf whose books have no
		// ISBN cannot look one up, which is a different failure from an
		// expressibility gap.
		field('fld-book-isbn', 'isbn', 'string'),
		field('fld-book-cover', 'coverUrl', 'string'),
		field('fld-book-pages', 'pageCount', 'number'),
	]),
	entity(
		'e-discussion',
		'Discussion',
		'A dated discussion thread about a book.',
		[
			field('fld-discussion-topic', 'topic', 'string', true),
			field('fld-discussion-date', 'date', 'date', true),
		],
	),
	entity('e-member', 'Member', 'A member of the reading club.', [
		field('fld-member-name', 'name', 'string', true),
		field('fld-member-email', 'email', 'string'),
	]),
	// SPEC EDIT 2026-07-29: a discussion now has posts. This is the
	// one place this change set models a new row, and it is the crmlite
	// `e-message` case rather than surface invented to fit the op: the frozen ask
	// is a *threaded discussion thread*, and a thread whose messages are not rows
	// cannot be pushed, cannot be gated per message and cannot be threaded. The
	// spec modelled a discussion as a scheduled meeting (topic, date, location)
	// and never modelled what is said at it — which is a gap in the data model,
	// not an expressibility gap, exactly as bookclub's missing ISBN column was in
	// #173. `parent` is the self-reference that makes it threaded; it is a
	// property of the product, not a request somebody made.
	entity('e-post', 'Post', 'A message in a discussion thread.', [
		field('fld-post-body', 'body', 'string', true),
		belongsTo('fld-post-discussion', 'discussion', 'e-discussion'),
		belongsTo('fld-post-author', 'author', 'e-member'),
		belongsTo('fld-post-parent', 'parent', 'e-post'),
		field('fld-post-at', 'postedAt', 'date'),
	]),
]

/**
 * SPEC EDIT 2026-07-29 — the two live channels the app declares.
 *
 * Declared as part of what the app *is*, on the terms sources were in #173: the
 * backlog ask below is what is *asked of it*.
 *
 * Three choices carry the argument:
 *
 *  - The thread channel is `filtered` on `discussion`, not `all`. A reading club
 *    has many threads and a subscriber is in exactly one of them, so the
 *    unfiltered spelling would fan every post in the app out to everybody with
 *    any thread open — the storm the bound exists to prevent, and the shape that
 *    scales is the one where the fan-out set is a fraction of the table.
 *  - `maxSubscribers: 200` at `maxMessagesPerMinute: 60`. A club is not a
 *    stadium, and one post a second is already faster than anybody reads.
 *  - The thread declares `slot: true` and presence declares `slot: false`. A
 *    threaded reader that appends in place and indents by `parent` is genuinely
 *    not a table, which is the whole reason the ask was frozen as an eject; a
 *    list of who is in the room is a list.
 */
const liveChannels = [
	live({
		id: 'lv-thread',
		key: 'discussion-thread',
		description: 'Push new posts to whoever has this discussion open.',
		entityId: 'e-post',
		kind: 'query',
		fields: [
			'fld-post-body',
			'fld-post-discussion',
			'fld-post-author',
			'fld-post-parent',
			'fld-post-at',
		],
		scope: { kind: 'filtered', fieldId: 'fld-post-discussion' },
		maxSubscribers: 200,
		maxMessagesPerMinute: 60,
		slot: true,
		paused: false,
	}),
	live({
		id: 'lv-thread-viewers',
		key: 'discussion-viewers',
		description: 'Who is in this discussion right now.',
		entityId: 'e-discussion',
		kind: 'presence',
		fields: [],
		scope: { kind: 'row' },
		maxSubscribers: 200,
		maxMessagesPerMinute: 30,
		presenceTtlSeconds: 45,
		maxPresent: 25,
		slot: false,
		paused: false,
	}),
]

const booksPage = page({
	id: 'pg-books',
	name: 'Books',
	route: '/app/books',
	entityId: 'e-book',
	blocks: [table('blk-books-table'), slot('blk-books-rating', 'ratingWidget')],
	e2eTests: [
		'A member can add a book to the shelf',
		'Marking a book finished moves it to the read pile',
	],
})

const discussionsPage = page({
	id: 'pg-discussions',
	name: 'Discussions',
	route: '/app/discussions',
	entityId: 'e-discussion',
	blocks: [
		table('blk-discussions-table'),
		slot('blk-discussions-actions', 'discussionActions'),
	],
	e2eTests: [
		'A host can schedule a discussion for a book',
		'An empty schedule shows a prompt to plan the first meeting',
	],
})

const membersPage = page({
	id: 'pg-members',
	name: 'Members',
	route: '/app/members',
	entityId: 'e-member',
	blocks: [table('blk-members-table')],
	e2eTests: [
		'A host can add a member by email',
		'The empty state shows before any members join',
	],
})

export const bookclubExample = crudExample({
	id: 'bookclub',
	title: 'Bookclub — reading lists & discussions',
	prd: examplePRD({
		title: 'Bookclub — a reading list & discussion tracker',
		tldr: 'Pick what to read next and keep the discussion notes in one place.',
		problem:
			'Reading clubs juggle a group chat, a shared doc, and a poll — and lose the thread every month.',
		northStar: 'Books finished together per quarter',
		persona: 'Host of a small reading club',
		differentiation: 'A shelf and a discussion log that know about each other.',
	}),
	entities,
	pages: [booksPage, discussionsPage],
	live: liveChannels,
	changes: [
		addField(
			'ch-book-genre',
			'Add a genre field to books (spec op).',
			'e-book',
			'fld-book-genre',
			'genre',
			'string',
		),
		addPage(
			'ch-add-members',
			'Add the Members roster page (spec op).',
			membersPage,
		),
		retitle(
			'ch-retitle-books',
			'Rename Books to “Shelf” (regeneration-as-diff).',
			'book',
			'Shelf',
		),
		fillSlot(
			'ch-rating-widget-slot',
			'Fill the five-star rating slot on the Books page (slot fill).',
			'book',
			'ratingWidget',
			[
				'// User-owned: a five-star rating control on a book row.',
				'export function ratingWidget() {',
				'\treturn <span aria-label="rating">☆☆☆☆☆</span>',
				'}',
			].join('\n'),
		),
		addField(
			'ch-discussion-location',
			'Add a location field to discussions (spec op).',
			'e-discussion',
			'fld-discussion-location',
			'location',
			'string',
		),
		fillSlot(
			'ch-discussion-actions-slot',
			'Fill the discussion-actions slot with RSVP controls (slot fill).',
			'discussion',
			'discussionActions',
			[
				'// User-owned: RSVP + reschedule controls on a discussion row.',
				'export function discussionActions() {',
				'\treturn <button type="button">RSVP</button>',
				'}',
			].join('\n'),
		),
		addSlot(
			'ch-book-cover-slot',
			'Open a cover-image slot on the Books page (spec op).',
			'pg-books',
			'blk-books-cover',
			'bookCover',
		),
		addField(
			'ch-member-joined',
			'Record when each member joined (spec op).',
			'e-member',
			'fld-member-joined',
			'joinedDate',
			'date',
		),
		ejectPage(
			'ch-eject-members',
			'Eject the Members page for a bespoke roster with avatars (eject).',
			'member',
		),
		declareSource(
			// RECLASSIFIED 2026-07-28 by issue #173, from off-surface/unexpressible.
			// The endpoint, the credential (none — Open Library is public), the paths
			// onto the three columns and the request budget are all declaration; the
			// running app fetches, and generation never does.
			'ch-isbn-lookup',
			'Fetch cover art and metadata from an ISBN lookup service (spec op).',
			source({
				id: 'src-isbn-lookup',
				key: 'isbn.lookup',
				description: 'Fill in a book’s cover art and page count from its ISBN.',
				mode: 'enrich',
				entityId: 'e-book',
				request: { url: 'https://openlibrary.org/isbn/{isbn}.json' },
				mapping: [
					{ from: 'title', to: 'fld-book-title' },
					{ from: 'number_of_pages', to: 'fld-book-pages' },
					{ from: 'covers[0]', to: 'fld-book-cover' },
				],
				limits: {
					requestsPerMinute: 30,
					timeoutMs: 5000,
					maxAttempts: 3,
					backoffMs: 1000,
				},
				triggers: [{ kind: 'create' }, { kind: 'manual' }],
				inputField: 'fld-book-isbn',
			}),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — what a *declared* source is
			// definitionally not: a merge policy with per-field memory.
			'ch-metadata-reconcile',
			'Look a book up in two catalogues at once, keep per-field provenance of which one supplied each value, prefer the more complete answer field by field, and let a host correct one field by hand without the next lookup overwriting it again — no op models a merge policy, per-field provenance, or a hand edit that outranks a later fetch (off-surface, unexpressible).',
			'book',
			'unexpressible',
			'external-data',
		),
		fillLiveSlot(
			// RECLASSIFIED 2026-07-29 by issue #179, from off-surface/eject — and
			// SPLIT rather than claimed whole. The ask says "a threaded, *live-typing*
			// discussion thread". The platform now absorbs the threading and the
			// live: posts are rows with a self-reference, they are pushed to the
			// thread's own subscribers under a declared bound and ceiling, who is in
			// the room is a bounded ephemeral primitive, and the reader has a typed
			// slot the platform promises never to overwrite. What it does NOT absorb
			// is the *typing* — a per-keystroke indicator is a free-form ephemeral
			// payload the presence primitive deliberately has nowhere to put, and the
			// concurrent editing it implies is the co-editing this issue's own
			// decision record (d-live-last-write-wins) excludes. That residue returns
			// at full weight as `ch-post-coediting`.
			'ch-threaded-discussion',
			'A threaded discussion thread that appends replies live: posts arrive as members write them, indent under what they answer, and the thread shows who else is in the room, in the live channel’s bespoke surface slot (slot fill).',
			'post',
			'discussion-thread',
			[
				'// User-owned: the threaded reader. The platform declared the channel',
				'// and never rewrites this; the nesting is ours to know.',
				'export default function Thread(props: { rows: { id: string }[] }) {',
				'\tvoid props',
				'\treturn null',
				'}',
			].join('\n'),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-29 — carries back the residual
			// difficulty the split above did not absorb, in the same product area and
			// deliberately in the shape this issue's own decision record puts out of
			// scope: intention-preserving concurrent editing of one value. What
			// shipped pushes whole rows and resolves by last-write-wins; this is the
			// OT/CRDT problem, plus the per-keystroke ephemeral channel presence
			// definitionally is not.
			'ch-post-coediting',
			'Two members edit one post’s body at the same time and both sets of edits survive: each sees the other’s caret and typing indicator as they go, an insertion in the middle does not clobber a simultaneous deletion at the end, and a member who reconnects after a dropped connection has their offline edits woven in rather than discarded — no op models intention-preserving concurrent edits, a per-keystroke ephemeral channel, or any merge policy beyond last-write-wins (off-surface, unexpressible).',
			'post',
			'unexpressible',
			// The `realtime` cluster keeps a second carrier, so breadth does not rest
			// on one example. Same product area, same surface, and the half the
			// shipped primitive definitionally does not reach: what happens INSIDE
			// one value while two people are in it.
			'realtime',
		),
	],
})
