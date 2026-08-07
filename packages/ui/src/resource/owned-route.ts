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
import type { LinkLike, ResourceListProps } from './ResourceList.tsx'

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
