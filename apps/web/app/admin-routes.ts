/**
 * What a URL under `/admin` means.
 *
 * `/admin` is not one route, it is a whole namespace: the generic registry CRUD
 * mounts a list, a create form, a trash can and a record page under it. Those
 * used to be four dynamic children (`:resource`, `:resource/new`,
 * `:resource/trash`, `:resource/:id`), and a dynamic child outranks the project
 * splat, so a *spec-declared* page at `/admin/posts` was swallowed: it matched
 * `:resource` as resource `posts`, the registry has `post`, and the page its own
 * spec declared 404'd. `/admin/posts/new` collided with `:resource/:id` the same
 * way, so creating a record was broken too.
 *
 * The fix is #251's: one splat that resolves the path after the spec is loaded,
 * asking the spec first and falling back to this. So this module holds the
 * *second* half of that question — given a path under `/admin` that no declared
 * page owns, which generic admin surface is it? — as a pure function, because
 * the router can no longer express it and something has to be testable.
 */

import type { ProjectMatch } from './project-routes'

/** Which generic admin surface a path under `/admin` names. */
export type AdminMatch =
	| { kind: 'list'; resource: string }
	| { kind: 'new'; resource: string }
	| { kind: 'trash'; resource: string }
	| { kind: 'parse'; resource: string }
	| { kind: 'edit'; resource: string; id: string }

/**
 * Resolve the path *below* `/admin` to a generic admin surface, or `undefined`
 * when nothing under `/admin` has that shape (which is a 404).
 *
 * `new`, `trash` and `parse` win over a record id, exactly as the static
 * `:resource/trash` child outranked `:resource/:id` before — a record whose
 * primary key is literally `new` was already unreachable and this changes
 * nothing about that. `parse` joins the list on the same terms: it
 * is the admin forms' describe-to-prefill endpoint, and it is POST-only, so the
 * id it shadows was only ever reachable as a page.
 */
export function matchAdminPath(rest: string): AdminMatch | undefined {
	const segments = rest.split('/').filter((s) => s.length > 0)
	const [resource, tail, ...extra] = segments
	if (!resource || extra.length > 0) return undefined
	if (tail === undefined) return { kind: 'list', resource }
	if (tail === 'new') return { kind: 'new', resource }
	if (tail === 'trash') return { kind: 'trash', resource }
	if (tail === 'parse') return { kind: 'parse', resource }
	// Decoded, because a primary key is free-form text in the store and may
	// legitimately arrive percent-encoded — the same rule `matchProjectPath` uses.
	return { kind: 'edit', resource, id: decodeURIComponent(tail) }
}

/**
 * Whether a spec page's claim on a path under `/admin` is honoured.
 *
 * A declared page beats an interpretation of one, with
 * one exception: a page declared at the bare `/admin`. That page's own list is
 * already shadowed by the platform's admin — a static route outranks the splat,
 * so `/admin` renders the registry home and always did. Letting its *record*
 * interpretation win anyway would mean `/admin/post` resolving as "record `post`
 * of the page called admin", i.e. one undeliverable declaration silently
 * swallowing the entire generic admin. A page nobody can reach gets no children
 * either.
 */
export function adminProjectMatchApplies(match: ProjectMatch): boolean {
	return match.page.slug !== 'admin'
}
