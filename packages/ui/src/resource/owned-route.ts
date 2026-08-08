/**
 * The contract between the framework's list route and a project's *ejected*
 * page module — the props an owned route is rendered with (issue #349).
 *
 * ## Why this type exists
 *
 * Before it, `OWNED_ROUTES` was typed `Record<string, ComponentType>` and the
 * runtime mounted an ejected page as `<OwnedRoute />` — with **no props at
 * all**. So the file `maxstack eject` handed over could not render the page it
 * had supposedly taken ownership of: it had no rows, no columns, no capability
 * flags and no way to get them, because everything the page needs is resolved
 * server-side by the framework's loader. The emitted module was therefore a
 * heading and a comment, and the real page kept rendering from the spec.
 *
 * Handing the loader's result down as props is what makes a materialized
 * ejected page possible: the module owns the *composition* (which list
 * component, what surrounds it, which props it overrides) while the framework
 * still owns the *derivation* (identity, permissions, introspection, rows).
 *
 * ## What it does NOT mean
 *
 * It does not mean an ejected page is free of the spec. The loader that
 * produces {@link OwnedRouteProps.list} still resolves this page from `spec/`
 * at request time. Owning the loader too — inlining the resource name and
 * ordering so no spec read happens at all — is the remaining half of #349, and
 * the eject banner says so rather than implying otherwise.
 */

import type { ReactNode } from 'react'
import type { BoardDrop } from './BoardView.tsx'
import type { LinkLike, ResourceListProps } from './ResourceList.tsx'
import type { IntrospectedResource, Row } from './resource-types.ts'

export interface OwnedRouteProps {
	/**
	 * Exactly the props the framework's own list would have rendered this page
	 * with: rows (live-merged), the introspected resource shape, resolved FK
	 * titles and signed file URLs, the empty state, demo-row marks, filled field
	 * slots, capabilities, the inline-editable field list and its save handler.
	 *
	 * Spread it and override what you want — `<ResourceList {...list} />` is the
	 * generated body, and `<ResourceList {...list} selectable />` is a one-word
	 * customization that keeps everything else working.
	 *
	 * It is a superset of what `CardGrid` and `FeedList` accept, so spreading it
	 * into either of those is safe too; the extra keys are ignored.
	 */
	list: ResourceListProps
	/**
	 * The *arranged* half of the same handover: what a `board`, `calendar` or
	 * `timeline` page is drawn from (stage 2 of #349).
	 *
	 * Present exactly when the framework would have arranged this page's rows
	 * with a view block, so a generated view module can render the real board
	 * rather than a placeholder. Absent on an ordinary list page — {@link list}
	 * is that page's surface — which is why the emitted view module opens with a
	 * guard rather than assuming it.
	 *
	 * The *declaration* (which column groups the cards, which date column places
	 * an entry, the display and the timezone) is not here: the emitter inlines it
	 * into the owned module as a literal, because that is the spec-derived
	 * decision an ejected page genuinely takes over. What stays here is
	 * everything only the route can produce — the rows, the introspection, the
	 * paging links, and the write handler.
	 */
	view?: OwnedViewProps
	/** Route to this resource's create form, for the page's own "+ New" link. */
	newHref: string
	/**
	 * The list's control bar — search, the derived filter facets, CSV export —
	 * already wired to the URL by the framework's route (`<ListControls>`).
	 *
	 * An element rather than a set of props because the wiring is the part an
	 * owned page must *not* have to reimplement: the filter state lives in the
	 * query string, the loader reads it back with the same codec, and search
	 * upgrades to the ranked index when the resource declares one. An owned page
	 * chooses only *where* the bar goes — `{toolbar}` — and keeps every one of
	 * those capabilities by rendering one identifier (#342).
	 *
	 * Sorting is not here: it is `list.sort`/`list.onSort`, because the control
	 * is the column header inside the list itself.
	 *
	 * Absent when the page has no filterable list surface to control — a page
	 * arranged by a calendar, timeline or board block.
	 */
	toolbar?: ReactNode
	/**
	 * The host router's `<Link>`, so an owned page navigates client-side without
	 * importing the router. Capitalized because that is how it is used in JSX.
	 */
	Link: LinkLike
}

/**
 * What a `<BoardView>` / `<CalendarView>` / `<TimelineView>` on an owned page is
 * handed — the derivation half of an arranged surface.
 *
 * Deliberately one flat bag, spreadable into any of the three exactly as
 * {@link OwnedRouteProps.list} spreads into any of the three list variants. The
 * keys a given component does not accept are ignored, which is the same trade
 * `list` already makes and the reason a materialized page keeps working when
 * the runtime learns to pass something new.
 *
 * The two things a *view* needs that a list does not — where the viewer is in
 * time, and what a drag writes — are here rather than reimplemented in owned
 * code, for the same reason `toolbar` is: they are wiring, not composition.
 */
export interface OwnedViewProps {
	/** The introspected resource — columns, primary key, display name. */
	resource: IntrospectedResource
	/** The window of rows the loader read, live-merged. */
	rows: Row[]
	/** A per-row detail/edit link. */
	rowHref: (row: Row) => string
	/** The host router's link, in the `linkComponent` shape the views take. */
	linkComponent: LinkLike
	/** Shown when the window holds nothing to draw. */
	emptyState: ReactNode
	/** Primary keys created by the demo seeder — marked as sample data. */
	demoIds: readonly string[]
	/**
	 * The day a calendar's grid is drawn around, in the view's declared timezone.
	 * Read from the URL by the loader, so the grid the server renders and the one
	 * the client hydrates are the same grid.
	 */
	anchor: string
	/**
	 * A timeline's axis — the window the loader actually queried, not the extent
	 * of the rows that came back. Derived from {@link anchor} by the route, so an
	 * owned page cannot draw an axis its "Earlier"/"Later" links disagree with.
	 */
	window: { from: string; to: string }
	/**
	 * Period navigation (`← Earlier · Today · Later →`), already pointing at the
	 * URLs this page's loader reads back.
	 *
	 * An element rather than a set of props, for the `toolbar` reason: the step
	 * is view-specific (a week, a month boundary, a year, a timeline's own axis
	 * width) and the links are what make a window bookmarkable. An owned page
	 * chooses only where the bar goes. Empty for a board, which has no time axis.
	 */
	paging: ReactNode
	/**
	 * The truncation notice, when the row cap cut this window short — and `null`
	 * when it did not. A truncated chart looks exactly like a complete one, so
	 * this is not decoration.
	 */
	notice: ReactNode
	/**
	 * A move — a card dropped in another column, or an entry dragged to another
	 * day — as a write. Absent when the block did not declare `move` /
	 * `reschedule`, which is what makes a read-only view read-only.
	 *
	 * One handler for both gestures because there is one write path: it turns the
	 * gesture into the field values that gesture means and submits them to the
	 * record's ordinary edit route, so the update runs the identical validation,
	 * permission check, WIP limit and audit entry as editing that field in the
	 * form. There is no reschedule or board endpoint to secure separately.
	 *
	 * It stays here — framework code — rather than being inlined into the owned
	 * module with the rest of the declaration, and that is the one deliberate
	 * asymmetry in this contract. Deriving a board move needs the grouping
	 * field's *declared* options, and the check that a drop's destination is one
	 * of them is a guard, not a drawing decision. Inlining it would move a
	 * write-side check into a file the user is invited to edit. Drawing is
	 * inlined; the guard is not.
	 */
	onMove?: (row: Row, dest: BoardDrop | string) => void
}
