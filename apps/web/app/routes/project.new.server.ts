/**
 * The create form's loader and action.
 *
 * Separate from the component because these surfaces stopped being route
 * modules: the router mounts one splat that resolves what a path means and
 * delegates here. A route module gets `loader`/`action` stripped from the client
 * bundle; a plain module does not, so leaving them beside the component would
 * drag `~/sprout.server` and friends into the browser.
 */

import {
	acceptedBodies,
	allowedMethods,
	createHandler,
	pageContract,
	pageCreatePath,
} from '@maxstack/core'
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
	// Same hole as the record surface's, same fix (#376): every non-GET method
	// arrives here, and an unguarded `request.json()` turned a wrong verb or a
	// form-encoded body into a 500 that reads as a platform bug.
	const contract = pageContract(page)
	const path = pageCreatePath(page.route)
	const accepts = acceptedBodies(contract, `POST ${path}`)
	if (request.method !== 'POST')
		return data(
			{ error: `${request.method} is not served here. ${accepts}` },
			{ status: 405, headers: { Allow: allowedMethods(contract, path) } },
		)
	const parsed = await request.json().catch(() => null)
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
		return data(
			{ error: `Body is not a JSON object. ${accepts}` },
			{ status: 400 },
		)
	const input = parsed as Record<string, unknown>
	const res = await createHandler(ctx, page.resource as string, input)
	if (res.status >= 400) return data(res.body, { status: res.status })
	return redirect(pagePath(page.slug))
}
