/**
 * Dispatch a resolved {@link ProjectMatch} to the surface that serves it
 *.
 *
 * #251 put this inline in `routes/project.$.tsx`, because the project splat was
 * the only route that could reach a spec page. #252 added a second: `/admin` is
 * a namespace with its own dynamic children, which outrank the splat, so a page
 * declared at `/admin/posts` never reached it. The admin splat therefore asks
 * the spec first and delegates here on a hit — and *the same* dispatch has to
 * serve both, or a page's behaviour would depend on which prefix it was declared
 * under.
 *
 * Server-only by construction: a route module gets `loader`/`action` stripped
 * from the client bundle and everything only they reach goes with it, which is
 * what keeps `~/sprout.server` out of the browser. A plain module gets no such
 * treatment, so this file is only ever imported *from* a loader or an action.
 */

import { data } from 'react-router'
import type { ProjectMatch } from '~/project-routes'
import {
	action as editAction,
	loader as editLoader,
} from './project.edit.server'
import { action as newAction, loader as newLoader } from './project.new.server'
import { loader as listLoader } from './project.page.server'
import { action as parseAction } from './project.parse.server'

/** What one of the three renderable project surfaces loaded. */
export type ProjectSurfaceData =
	| { kind: 'list'; data: Awaited<ReturnType<typeof listLoader>> }
	| { kind: 'new'; data: Awaited<ReturnType<typeof newLoader>> }
	| { kind: 'edit'; data: Awaited<ReturnType<typeof editLoader>> }

export async function projectSurfaceLoader(
	match: ProjectMatch,
	request: Request,
): Promise<ProjectSurfaceData> {
	const args = { request, params: { page: match.page.slug } }
	switch (match.kind) {
		case 'list':
			return { kind: 'list', data: await listLoader(args) }
		case 'new':
			return { kind: 'new', data: await newLoader(args) }
		case 'edit':
			return {
				kind: 'edit',
				data: await editLoader({
					request,
					params: { page: match.page.slug, id: match.id },
				}),
			}
		case 'parse':
			// `parse` is an action-only endpoint (the AI field-extraction POST). A
			// GET of it is not a page, and rendering the list instead would be a
			// URL that silently means something else.
			throw data({ error: 'Method not allowed' }, { status: 405 })
	}
}

export async function projectSurfaceAction(
	match: ProjectMatch,
	request: Request,
): Promise<unknown> {
	const args = { request, params: { page: match.page.slug } }
	switch (match.kind) {
		case 'new':
			return newAction(args)
		case 'edit':
			return editAction({
				request,
				params: { page: match.page.slug, id: match.id },
			})
		case 'parse':
			return parseAction(args)
		case 'list':
			// The list has no action of its own; writes go to `new` and `:id`.
			throw data({ error: 'Method not allowed' }, { status: 405 })
	}
}
