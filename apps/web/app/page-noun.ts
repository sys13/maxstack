/**
 * `pageNoun(page)` — what one row of a page's entity is called, for copy
 *.
 *
 * A `ProjectRoute` carries two names and they are not interchangeable: `name`
 * is what the *page* is called, `resourceLabel` is what one *row* is called. A
 * book app can name its root page "Shelf" and a second page "Reading list" over
 * the same `book` entity — three surfaces (the empty-state CTA, the create
 * form, the edit form) all create a book, and every one of them said the page's
 * name because the page's name was the one in scope.
 *
 * So the substitution lives here rather than at any of them: one adapter from
 * the route to `resourceNoun`, which owns the fallbacks (identifier, then the
 * generic `record` for a page backed by no entity at all).
 */

import { resourceNoun } from '@maxstack/ui'
import type { ProjectRoute } from './project-routes'

export function pageNoun(
	page: Pick<ProjectRoute, 'resource' | 'resourceLabel'>,
): string {
	return resourceNoun({ name: page.resource, label: page.resourceLabel })
}
