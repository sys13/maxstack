/**
 * `/p/:key/:id` — one row of a declared portal.
 *
 * Same posture as `/p/:key`: **no filtering, no column selection, no access
 * check.** It calls `opGet`, and every rule lives underneath.
 *
 * The `:id` in the URL is *not* a credential and is *not* trusted. For a
 * `row`-scoped portal the identity carries the row its **token** was minted for,
 * and `opGet` 404s any other id — so pasting somebody else's uuid into this URL
 * reaches nothing, and the check that makes that true is one every caller
 * shares. For a `collection` portal the declared bound applies to a single-row
 * read exactly as it does to the list, or fetching by id would be a way around
 * the filter.
 */

import { NotFoundError, opGet } from '@maxstack/core'
import { portalRequest } from '~/portals.server'
import type { Route } from './+types/p.$key.$id'

export async function loader({ request, params }: Route.LoaderArgs) {
	const portal = await portalRequest(request, params.key)
	if (!portal) throw new Response('Not found', { status: 404 })
	const { ctx, plan } = portal
	try {
		const row = await opGet(ctx, plan.resource, params.id)
		return { title: plan.description, fields: plan.readFields, row }
	} catch (error) {
		// A row outside the bound, and a row this token was not minted for, both
		// arrive here as `NotFoundError` — deliberately indistinguishable from a
		// row that does not exist, so this page is never an existence oracle.
		if (error instanceof NotFoundError)
			throw new Response('Not found', { status: 404 })
		throw new Response('Not found', { status: 404 })
	}
}

function show(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (value instanceof Date) return value.toISOString().slice(0, 10)
	if (typeof value === 'object') return JSON.stringify(value)
	return String(value)
}

export default function PortalRow({ loaderData }: Route.ComponentProps) {
	const { title, fields, row } = loaderData
	return (
		<main className="mx-auto max-w-2xl p-6">
			<h1 className="m-0 text-2xl font-semibold">{title}</h1>
			<dl className="mt-6 grid gap-2 [grid-template-columns:auto_1fr]">
				{fields.map((f) => (
					<div key={f} className="contents">
						<dt className="pr-4 text-foreground/60">{f}</dt>
						<dd className="m-0">{show(row[f])}</dd>
					</div>
				))}
			</dl>
		</main>
	)
}
