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

import { isSlotBlockType, slotBlockName } from '@maxstack/core/ownership'
import {
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
 * The date-arranged views — the two a *reschedule* applies to.
 * Named so `rescheduleValues` can take exactly them: a board has no day to move
 * an entry to, and a signature that accepted one would have to answer that.
 */
export type PageDateView = PageCalendarView | PageTimelineView

/** The page's arranged view, if it declares one. */
export type PageView = PageDateView | PageBoardView

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
	// Anything else in the trailing position is a record id. Decoded, because a
	// primary key is free-form text in the store and may legitimately arrive
	// percent-encoded.
	return { kind: 'edit', page, id: decodeURIComponent(tail) }
}
