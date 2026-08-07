/**
 * Where a related-records section's "view all" goes on the project surface
 * (#362).
 *
 * Its own leaf module for two reasons. It is a *client* decision — the panel
 * renders the link — so it may not reach for `~/sprout.server` or
 * `~/project-routes` as values (the `ProjectRoute` import below is `import
 * type` for the reason `page-path.ts` documents: a value import of that module
 * drags `@maxstack/core/ownership` into the browser bundle). And it is a
 * *security* decision, which wants a name and a test rather than an expression
 * inside JSX.
 *
 * The link is `?filter.<fk>=<parent id>` — the same URL the admin's panel has
 * always used — and the reason it could not simply be copied onto the generated
 * app is that #342 confines `?filter.` to the columns a page renders, and a
 * child list is the one list guaranteed not to render its own FK (it holds the
 * same value on every row, so `relatedColumns` strips it, and a six-column cap
 * or a declared `fields` subset drops it again). The filter would have been
 * dropped in silence and the "view all" would have shown *every* row of the
 * child entity while claiming to show this record's — strictly worse than the
 * no link it replaced.
 *
 * The narrowing is not relaxed to fix that. `tableColumns` promotes a filtered
 * relation into the page's rendered columns instead, so the destination honours
 * the filter for the ordinary reason: it shows the column. This function is the
 * near half of that same rule — it emits a link only where the destination will
 * honour it — and `related-link.test.ts` pins the two together by feeding the
 * URL this builds straight into `listControls`. A link whose filter does not
 * survive that round trip is the bug, and it fails there rather than on a page.
 */

import { type IntrospectedColumn, isRelationFilterColumn } from '@maxstack/ui'
import { pagePath } from '~/page-path'
import type { ProjectRoute } from './project-routes'

/** Just enough of a nav entry to route to a child list. */
type NavPage = Pick<ProjectRoute, 'slug' | 'resource' | 'view'>

/** Just enough of a `RelatedGroup` to address its relation. */
interface RelationLike {
	resource: string
	fk: string
	introspection: { columns: readonly IntrospectedColumn[] }
}

/**
 * The child list filtered to this record, or `undefined` when there is no
 * honest link to make. Three ways there is not:
 *
 * - the child entity has **no navigable page** — `nav` is the accepted,
 *   flag-visible page set, so linking anyway is a link at a 404;
 * - that page is a **calendar, board or timeline**, whose rows are a window
 *   chosen by the view rather than a filtered list. `listControls` honours no
 *   filter on one, by design, so a filtered URL would silently show the whole
 *   view;
 * - the FK is **not a promotable relation** (`hidden`, or
 *   `filterable === false`). Those are the two declarations that say "not this
 *   column", and a link that filtered by one would need the destination to
 *   honour a filter it will not render — which is the oracle, not a feature.
 *
 * In every one of those the panel falls back to what it did before: the count
 * as plain text beside the heading. An absent link is a small loss; a link that
 * lies about which rows it is showing is the failure this whole path exists to
 * avoid.
 */
export function relatedListHref(
	nav: readonly NavPage[],
	group: RelationLike,
	id: string,
): string | undefined {
	if (id === '') return undefined
	const page = nav.find((p) => p.resource === group.resource)
	if (!page || page.view) return undefined
	const fk = group.introspection.columns.find((c) => c.name === group.fk)
	if (!fk || !isRelationFilterColumn(fk)) return undefined
	const query = new URLSearchParams({ [`filter.${group.fk}`]: id })
	return `${pagePath(page.slug)}?${query.toString()}`
}
