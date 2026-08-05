/**
 * The create form's loader and action.
 *
 * Separate from the component because these surfaces stopped being route
 * modules: the router mounts one splat that resolves what a path means and
 * delegates here. A route module gets `loader`/`action` stripped from the client
 * bundle; a plain module does not, so leaving them beside the component would
 * drag `~/sprout.server` and friends into the browser.
 */

import { createHandler } from '@maxstack/core'
import { isAiConfigured } from '@maxstack/spec-derive'
import { data, redirect } from 'react-router'
import { pagePath } from '~/page-path'
import {
	type ProjectRouteArgs,
	projectChrome,
	resolveProjectResource,
} from '~/project.server'
import { getContext, referenceFieldOptions } from '~/sprout.server'

export async function loader({ request, params }: ProjectRouteArgs) {
	const resolved = await resolveProjectResource(params.page, request)
	return {
		page: resolved.page,
		nav: resolved.nav,
		...(await projectChrome()),
		introspection: resolved.introspection,
		// Whether the describe-to-prefill panel can work at all. It
		// is a function of the env, so it is answerable here instead of by a
		// round-trip the user reaches only after typing a description.
		aiConfigured: isAiConfigured(),
		// FK picker choices, same as the admin form — a name picker instead of a
		// raw-UUID text box.
		referenceOptions: await referenceFieldOptions(
			await getContext(request),
			resolved.introspection,
		),
	}
}

export async function action({ request, params }: ProjectRouteArgs) {
	const { page } = await resolveProjectResource(params.page, request)
	const ctx = await getContext(request)
	const input = (await request.json()) as Record<string, unknown>
	const res = await createHandler(ctx, page.resource as string, input)
	if (res.status >= 400) return data(res.body, { status: res.status })
	return redirect(pagePath(page.slug))
}
