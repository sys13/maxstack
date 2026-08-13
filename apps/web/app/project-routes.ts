/**
 * `getRoutes(spec)` — runtime route composition (§3-L2, the maxproject pattern).
 *
 * A generated app is not a *runnable* app until its pages are real navigable
 * routes, not a static preview. Rather than importing the per-file generated
 * route modules (which only carry a heading + slot seam), the live server
 * composes the app's navigable surface from the spec at request time: every
 * accepted page becomes a navigable route whose list/create/edit are served by
 * the same Sprout store the `/admin` CRUD uses (the spec→Sprout bridge). The
 * route *config* is a single splat (`routes/project.$.tsx`); *which* pages exist,
 * *what* they resolve to, and — since issue #251, because a declared route may be
 * more than one segment — *where a page's slug ends and a record id begins*, are
 * all computed here from the spec.
 *
 * Pure + unit-testable: the server wiring (`project.server.ts`) decides *when*
 * to reload the spec; this decides *what* routes it yields. Grounding follows
 * the same accepted-else-all rule as the data bridge (`spec-sprout.ts`), so a
 * page only goes live once it is accepted (or while nothing is decided yet).
 */

import {
	isSlotBlockType,
	pageModuleKeys,
	pageModuleResource,
	slotBlockName,
} from '@maxstack/core/ownership'
import {
	type AggregateSpec,
	type BlockOrder,
	type BlockSpec,
	type BlockVariant,
	type BoardSpec,
	type CalendarSpec,
	type EntitySpec,
	type FieldOption,
	getAcceptedOrAll,
	type PageSpec,
	type SpecSystem,
	type TimelineSpec,
} from '@maxstack/spec'

/** One navigable page of the running app, derived from a spec `PageSpec`. */
export interface ProjectRoute {
	/** URL slug, e.g. `subscriptions` (the route path without its leading `/`). */
	slug: string
	/** The declared route, e.g. `/subscriptions`. */
	route: string
	/** Human page heading, e.g. `Subscriptions`. */
	name: string
	/** The Sprout resource this page's CRUD is backed by, e.g. `subscription`. */
	resource: string | null
	/**
	 * The route *module* this page owns — the manifest entry id `maxstack gen`
	 * wrote it under, and therefore the key an ejected module is mounted by
	 * (`OWNED_ROUTES`). Usually the resource; a second page over the same entity
	 * takes a name of its own (`pageModuleKeys`, #337).
	 *
	 * Not the same question as `resource`, and keying the mount on `resource` was
	 * issue #392: a project with a board at `/` and a calendar at `/due`, both
	 * over `task`, ejecting the board made `/due` render the *board* module. Two
	 * pages share a resource; they never share a module.
	 *
	 * Always present, including for an entity-less page: the generator emits a
	 * module for that page too, named from its page id.
	 */
	moduleKey: string
	/**
	 * The human name for one row of that resource — the *entity's* declared name,
	 * e.g. `Reading item`. `null` for a page backed by no entity.
	 *
	 * Carried beside `resource` because they answer different questions and the
	 * page answers neither: `resource` is the identifier the store and the eject
	 * seams key on, `name` above is what this *page* is called, and two pages can
	 * back one entity (a book app's `Shelf` and `Reading list` both create a
	 * book). Copy that names the thing being created needs this one, and without
	 * it on the route every renderer reached for whichever name was in scope.
	 */
	resourceLabel: string | null
	/** Named extension slots the page declares (block type `slot:<name>`). */
	slots: string[]
	/**
	 * The slot that renders *instead of* the default list, when one declares
	 * `mode: "replace"`. `null` = the list always renders and slots
	 * only append. Naming the slot rather than a boolean lets the page keep the
	 * default list until that specific slot is actually filled.
	 */
	replacesList: string | null
	/**
	 * Row ordering for this page's list, taken from its first `table` block's
	 * `order` (spec-as-data ranking). Undefined = insertion order.
	 */
	order: BlockOrder | null
	/**
	 * How the list presents its rows — the first `table` block's
	 * `variant`, defaulting to the classic admin `table`.
	 */
	variant: BlockVariant
	/**
	 * Which entity fields the list renders, in order — the first
	 * `table` block's `fields`. `null` = the zero-config column picks.
	 */
	fields: string[] | null
	/**
	 * Which of the list's fields edit in place — the first `table`
	 * block's `editable`. `[]` = an ordinary read-only list, which is what every
	 * page that has not declared otherwise gets.
	 *
	 * Not nullable like its siblings: "no field is inline-editable" and "this
	 * block declares nothing" are the same fact, and a capability whose absence
	 * and whose emptiness read differently is one somebody eventually treats as a
	 * tri-state.
	 */
	editable: string[]
	/**
	 * Which fields a row added **from the list** collects — the first `table`
	 * block's `creatable`. `[]` = a list you cannot add to, which is what every
	 * page that has not declared otherwise gets.
	 *
	 * Not nullable, for `editable`'s reason: "no field is collected" and "this
	 * block declares nothing" are the same fact about the page, and a capability
	 * whose absence and whose emptiness read differently is one somebody
	 * eventually treats as a tri-state.
	 */
	creatable: string[]
	/**
	 * The page's arranged view, from its first `calendar`,
	 * `timeline` or `board` block. `null` = an ordinary list page. A view replaces
	 * the list rather than sitting beside it: the block says "these rows, arranged
	 * like this", and rendering both would be two answers to one question.
	 */
	view: PageView | null
}

/** A `calendar` block, resolved for the runtime. */
export interface PageCalendarView extends CalendarSpec {
	kind: 'calendar'
}

/** A `timeline` block, resolved for the runtime. */
export interface PageTimelineView extends TimelineSpec {
	kind: 'timeline'
}

/**
 * A `board` block, resolved for the runtime.
 *
 * `options` is resolved here rather than left to the renderer: the board's
 * columns are the grouping field's *declared* values, and both the drawing side
 * and the write side need them. In particular `boardMoveValues` refuses a
 * destination that is not in this list, so a crafted payload cannot use the
 * board's write path to put an undeclared string in the column.
 */
export interface PageBoardView extends BoardSpec {
	kind: 'board'
	options: FieldOption[]
}

/**
 * An `aggregate` block, resolved for the runtime (#299).
 *
 * The one view that does not arrange rows: it declares a `GROUP BY`, and the
 * loader answers it with `opAggregate` instead of a list read. Nothing is
 * resolved here the way a board's `options` are, and that is the point — every
 * name this carries goes to the *server*, which resolves it against the
 * registry under the read gate. Resolving anything here would put a column name
 * on a path that also carries request data.
 */
export interface PageAggregateView extends AggregateSpec {
	kind: 'aggregate'
	/** The dimension's declared values, when it is an enum — used to label bars. */
	options: FieldOption[] | null
}

/**
 * The date-arranged views — the two a *reschedule* applies to.
 * Named so `rescheduleValues` can take exactly them: a board has no day to move
 * an entry to, and a signature that accepted one would have to answer that.
 */
export type PageDateView = PageCalendarView | PageTimelineView

/**
 * The views whose content is **rows**.
 *
 * Named so `viewListOptions`, `viewLimit` and `anchorDay` can take exactly
 * them. An aggregate reads no rows at all, so a row cap, a date window and an
 * anchor day are all questions it has no answer to — and a signature that
 * accepted one would silently hand it a calendar's defaults, which is how the
 * loader would come to run a windowed list read for a chart that never wanted
 * one. The type is the guard.
 */
export type PageRowView = PageDateView | PageBoardView

/** The page's arranged view, if it declares one. */
export type PageView = PageRowView | PageAggregateView

/**
 * The first view block a page declares, or `null`.
 *
 * A block whose declaration is missing is skipped rather than rendered empty:
 * `page.addCalendar` cannot produce one, but a hand-edited spec file can, and a
 * calendar with no date field is a blank grid nobody can debug.
 */
function viewOf(
	blocks: BlockSpec[],
	entity: EntitySpec | undefined,
): PageView | null {
	for (const block of blocks) {
		if (block.type === 'calendar' && block.calendar)
			return { kind: 'calendar', ...block.calendar }
		if (block.type === 'timeline' && block.timeline)
			return { kind: 'timeline', ...block.timeline }
		if (block.type === 'board' && block.board) {
			const options = entity?.fields.find(
				(f) => f.name === block.board?.groupField,
			)?.options
			// A board whose grouping field lost its options has no columns to draw,
			// so it is skipped rather than rendered as an empty frame — the same rule
			// the date views follow for a missing declaration. `page.addBoard`
			// cannot produce one; a hand-edited spec file can.
			if (options && options.length > 0)
				return { kind: 'board', ...block.board, options }
		}
		if (block.type === 'aggregate' && block.aggregate) {
			// Unlike a board, an aggregate's buckets come from the *data*, not from
			// the declared value list — so a dimension whose options were dropped
			// still draws, and the options are carried only to label and order the
			// bars when they exist.
			const options =
				entity?.fields.find((f) => f.name === block.aggregate?.groupField)
					?.options ?? null
			return { kind: 'aggregate', ...block.aggregate, options }
		}
	}
	return null
}

/** `e-reading-item` → `reading-item` — the derivation the data bridge shares. */
const resourceName = (entityId: string): string => entityId.replace(/^e-/, '')

/**
 * `/subscriptions` → `subscriptions`; a bare `/` collapses to the empty slug,
 * which is how a page declares that it *is* the app's root (see
 * {@link matchProjectPath}). Trailing slashes go too, so `/decks/` and `/decks`
 * are one page rather than two, and `//` is the root rather than a page whose
 * slug is a slash.
 */
const slugOf = (route: string): string =>
	route.replace(/^\/+/, '').replace(/\/+$/, '')

/**
 * Whether a flagged row is composed for this viewer.
 *
 * Two properties, both load-bearing:
 *
 *   - **Ungated rows are unaffected.** No `flag` ⇒ visible, so gating is a pure
 *     narrowing on top of the accepted-else-all grounding rule.
 *   - **An unknown flag is off.** `evaluateFlags` only carries declared keys, so
 *     a gate naming a flag that no longer exists hides the surface rather than
 *     revealing it. The spec validator refuses to *store* such a gate; this is
 *     what happens if one arrives anyway (a hand-edited spec file).
 */
function flagAllows(
	row: Pick<PageSpec, 'flag'> | Pick<BlockSpec, 'flag'>,
	values: Record<string, boolean>,
): boolean {
	return row.flag === undefined ? true : values[row.flag] === true
}

/**
 * The app's navigable routes, one per accepted page. The single entry point the
 * live router and the project landing page both compose from.
 *
 * `flags` is the viewer's evaluated flag values — a page or block
 * gated on a flag that is off for them is not composed at all, so the surface is
 * absent rather than rendered-and-hidden. Defaulting to `{}` means an
 * un-threaded caller sees gated surfaces as *off*, which is the safe direction:
 * a forgotten context hides an unreleased page instead of leaking it.
 */
export function getRoutes(
	spec: SpecSystem,
	flags: Record<string, boolean> = {},
): ProjectRoute[] {
	// Module keys are folded over the WHOLE page list, before any grounding or
	// flag narrowing — the generator wrote the modules from that list, and a key
	// derived from a narrower one would name a file that is not there (#392).
	const keys = pageModuleKeys(spec.pages.pages)
	const moduleKeys = new Map(
		spec.pages.pages.map((page, i) => [page.id, keys[i] ?? '']),
	)
	return getAcceptedOrAll(spec.pages.pages)
		.filter((page) => flagAllows(page, flags))
		.map((page) => {
			const blocks = getAcceptedOrAll(page.blocks).filter((b) =>
				flagAllows(b, flags),
			)
			const entity = spec.data.entities.find((e) => e.id === page.entityId)
			return {
				slug: slugOf(page.route),
				route: page.route,
				name: page.name,
				resource: page.entityId ? resourceName(page.entityId) : null,
				moduleKey: moduleKeys.get(page.id) ?? pageModuleResource(page),
				resourceLabel: entity?.name ?? null,
				slots: blocks
					.filter((b) => isSlotBlockType(b.type))
					.map((b) => slotBlockName(b.type)),
				replacesList:
					blocks
						.filter((b) => isSlotBlockType(b.type) && b.mode === 'replace')
						.map((b) => slotBlockName(b.type))[0] ?? null,
				order: blocks.find((b) => b.type === 'table')?.order ?? null,
				variant: blocks.find((b) => b.type === 'table')?.variant ?? 'table',
				fields: blocks.find((b) => b.type === 'table')?.fields ?? null,
				editable: blocks.find((b) => b.type === 'table')?.editable ?? [],
				creatable: blocks.find((b) => b.type === 'table')?.creatable ?? [],
				view: viewOf(blocks, entity),
			}
		})
}

/**
 * Resolve a URL slug to its page, or `undefined` if no accepted page owns it —
 * or if the page is gated on a flag that is off for this viewer, which 404s
 * exactly like a page that was never declared. Hiding the nav entry alone would
 * be a link nobody can see and everybody can type.
 */
export function resolveRoute(
	spec: SpecSystem,
	slug: string,
	flags: Record<string, boolean> = {},
): ProjectRoute | undefined {
	return getRoutes(spec, flags).find((r) => r.slug === slug)
}

/**
 * Whether a bare segment may be read as a record id *of the root page*.
 *
 * A page declared at `/` claims the whole single-segment URL space, so this is
 * the one place where "record id" competes with every path the app does not
 * declare. Shape is the only available discriminator, and it is enough for the
 * two key shapes a maxstack app actually has: a spec entity's table is always
 * `id uuid primary key` (`tableFromSpecEntity`), and an integer key is the other
 * thing an author might hand-roll. Anything else — `nonsense`, `books`,
 * `pricing` — is a path nobody declared, and 404 is the honest answer.
 *
 * Deliberately a *shape* test rather than a store round-trip: the lookup is what
 * turned the miss into a driver error in the first place, and 404ing before the
 * store also means an undeclared path costs no query.
 */
const looksLikeRecordId = (segment: string): boolean =>
	/^\d+$/.test(segment) ||
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		segment,
	)

/** What a URL under the project surface turned out to mean. */
export type ProjectMatch =
	| { kind: 'list'; page: ProjectRoute }
	| { kind: 'new'; page: ProjectRoute }
	| { kind: 'parse'; page: ProjectRoute }
	| { kind: 'edit'; page: ProjectRoute; id: string }

/**
 * Resolve a whole URL path to a page *and what is being done to it*.
 *
 * This exists because a page's slug can be more than one segment. A spec page
 * declares its own URL — `/app/decks` is as legitimate a declaration as
 * `/decks` — and every page in every benchmark uses two. The router used to
 * mount the project surface as `:page`, `:page/new` and `:page/:id`, which can
 * only ever bind **one** segment to the page, so `/app/decks` matched
 * `:page/:id` as page `app`, record `decks`, and 404'd on a page named `app`
 * that nobody declared. The nav linked to it and the app did not serve it.
 *
 * Splitting the path cannot be done by shape alone: `/app/decks` and
 * `/decks/42` are the same shape, and only the spec knows which is a
 * two-segment page and which is a record on a one-segment page. So the split is
 * decided here, against the declared slugs.
 *
 * **A declared page always wins over an interpretation of one.** If a spec
 * really declares a page at `/app/decks/new`, that is what `/app/decks/new`
 * means — not "create a deck". The author said so in the spec; guessing past
 * that would make a declared route unreachable, which is the whole defect this
 * function exists to fix.
 *
 * The same reasoning reaches the root. A page may declare `/`, which is the
 * empty slug, and its record URLs are then single-segment: `/new` and `/42`.
 * That interpretation is only ever reached when a page actually claims the root,
 * so an app without one keeps 404ing single-segment paths it never declared.
 * Note that the router's static routes still outrank the splat either way, so a
 * root page cannot own a record whose id is `login` or `admin`.
 *
 * **When a root page *is* declared, the trailing segment must still look like a
 * key.** That is the case the paragraph above did not reason about, and it is
 * the shape `maxstack init` scaffolds: with a page at `/`, the split below turns
 * *every* undeclared single-segment path into a record id, so `/nonsense` and
 * `/pricing` became record lookups that reached the store and failed there —
 * every typo on the app was a 500 and the app had no 404 at all. So the root
 * reading is narrowed by {@link looksLikeRecordId}: `/42` and `/<uuid>` still
 * open their record, a word does not. Only the *root* reading is narrowed —
 * under a declared page, `/users/<anything>` is a record space the author asked
 * for, and narrowing it would break text primary keys for no gain.
 */
export function matchProjectPath(
	spec: SpecSystem,
	path: string,
	flags: Record<string, boolean> = {},
): ProjectMatch | undefined {
	const routes = getRoutes(spec, flags)
	const slug = path.replace(/^\/+/, '').replace(/\/+$/, '')

	const declared = routes.find((r) => r.slug === slug)
	if (declared) return { kind: 'list', page: declared }

	// A single-segment path splits into the *root* page plus a trailing segment,
	// which is how `/new` and `/42` reach a page declared at `/`. `head` is then
	// the empty slug, so this only ever finds a page when one actually claims the
	// root — with no root page declared, the lookup misses and the path 404s
	// exactly as it did before.
	const cut = slug.lastIndexOf('/')
	const head = cut === -1 ? '' : slug.slice(0, cut)
	const tail = cut === -1 ? slug : slug.slice(cut + 1)
	if (tail === '') return undefined
	const page = routes.find((r) => r.slug === head)
	if (!page) return undefined

	if (tail === 'new') return { kind: 'new', page }
	if (tail === 'parse') return { kind: 'parse', page }
	// A single-segment path (`cut === -1`) is a record on the root page only when
	// the segment is shaped like a key — otherwise a root page would make every
	// undeclared path a record lookup, and the app would have no 404 at all. See
	// {@link looksLikeRecordId} for why shape is the discriminator, and why this
	// narrowing applies to the root reading alone.
	if (cut === -1 && !looksLikeRecordId(tail)) return undefined
	// Anything else in the trailing position is a record id. Decoded, because a
	// primary key is free-form text in the store and may legitimately arrive
	// percent-encoded.
	return { kind: 'edit', page, id: decodeURIComponent(tail) }
}
