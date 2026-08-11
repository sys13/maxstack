/**
 * `/p/:key` — a declared collection portal, rendered.
 *
 * **This route contains no filtering, no column selection and no access check,
 * and that is the entire point.** It resolves the credential into a narrowed
 * identity (`portalRequest`) and then calls `opList` — the same `opList` the
 * admin, REST and MCP all call. The projection, the declared bound, the
 * closed-by-default resource check and the ordering refusal all happen below it,
 * inside the permission layer and the ops, because issue #186's finding was that
 * a route-level gate is a gate `/mcp` and the admin loaders never pass.
 *
 * A test asserts this module does not import the store, which is the mechanical
 * version of the paragraph above: a route that cannot reach the store cannot
 * accidentally become a second, weaker read path.
 *
 * Everything visual comes from the app's own theme, so a portal is
 * a themed derived page rather than an ejected one — which is the whole of what
 * blog's "themed public micro-site per author" was reaching for.
 */

import { opList } from '@maxstack/core'
import { portalRequest } from '~/portals.server'
import { humanizeKey, NOINDEX_META, pageMeta } from '~/seo'
import type { Route } from './+types/p.$key'

export async function loader({ request, params }: Route.LoaderArgs) {
	const portal = await portalRequest(request, params.key)
	// One 404 for every reason a portal is unreachable — unknown key, paused,
	// bad token, wrong role. Distinguishing them would tell a stranger which
	// portal keys exist and which tokens used to work.
	if (!portal) throw new Response('Not found', { status: 404 })
	const { ctx, plan } = portal
	// A row-scoped portal has no collection to render; its URL is `/p/:key/:id`.
	if (plan.scope === 'row') throw new Response('Not found', { status: 404 })

	const url = new URL(request.url)
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
	const perPage = 20
	// The ops refuse an `orderBy` naming a column the portal does not expose, so
	// the caller-supplied one is passed straight through rather than validated
	// here — a second check here would be a second thing to keep correct.
	const orderBy = url.searchParams.get('sort') ?? undefined

	const rows = await opList(ctx, plan.resource, {
		limit: perPage,
		offset: (page - 1) * perPage,
		...(orderBy ? { orderBy } : {}),
	})

	return {
		title: plan.description,
		layout: plan.layout,
		fields: plan.readFields,
		rows,
		page,
		hasMore: rows.length === perPage,
		key: plan.key,
		site: portal.site,
		// Only a `public` portal is a thing to index. A `token` portal's URL is a
		// credential minted for one recipient, and a `role` portal is an ordinary
		// signed-in session — neither is a page a crawler should ever hold, so
		// both emit `noindex` even though they render the same way.
		indexable: plan.audience === 'public',
		// Page 2 and beyond are the same collection under a query parameter. They
		// canonicalize to themselves rather than to page 1 — a crawler told that
		// page 4 "really is" page 1 stops discovering the rows only page 4 links
		// to, which for a paginated archive is most of them.
		path: page > 1 ? `/p/${plan.key}?page=${page}` : `/p/${plan.key}`,
	}
}

export function meta({ loaderData }: Route.MetaArgs) {
	// A declared portal is the one surface in this app that is *meant* to be
	// found, and until now it shipped the root title, no description, no
	// canonical and no card.
	if (!loaderData) return NOINDEX_META
	return pageMeta(
		{
			// The key is the label; the declared description is the sentence. Using
			// the description as a title would put a full sentence in a tab and blow
			// the 60-character budget on most portals.
			title: humanizeKey(loaderData.key),
			description: loaderData.title,
			path: loaderData.path,
			noindex: !loaderData.indexable,
		},
		loaderData.site,
	)
}

/** A value as text. Deliberately dumb: a portal is not a second formatter. */
function show(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (value instanceof Date) return value.toISOString().slice(0, 10)
	if (typeof value === 'object') return JSON.stringify(value)
	return String(value)
}

export default function Portal({ loaderData }: Route.ComponentProps) {
	const { title, layout, fields, rows, page, hasMore, key } = loaderData
	return (
		<main className="mx-auto max-w-3xl p-6">
			<h1 className="m-0 text-2xl font-semibold">{title}</h1>
			{rows.length === 0 ? (
				<p className="mt-6 text-foreground/70">Nothing here yet.</p>
			) : layout === 'table' ? (
				<div className="mt-6 overflow-x-auto">
					<table className="w-full border-collapse text-sm">
						<thead>
							<tr className="text-left text-foreground/70">
								{fields.map((f) => (
									<th key={f} className="py-1 pr-4 font-medium">
										{f}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr
									key={String(row.id)}
									className="border-t border-border align-top"
								>
									{fields.map((f) => (
										<td key={f} className="py-1.5 pr-4">
											{show(row[f])}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<ul
					className={
						layout === 'cards'
							? 'mt-6 grid list-none gap-4 p-0 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]'
							: 'mt-6 list-none space-y-6 p-0'
					}
				>
					{rows.map((row) => (
						<li
							key={String(row.id)}
							className={
								layout === 'cards'
									? 'rounded-lg border border-border p-4'
									: 'border-b border-border pb-5'
							}
						>
							{fields.map((f, i) => (
								<p
									key={f}
									className={
										i === 0 ? 'm-0 font-medium' : 'mt-1 text-foreground/80'
									}
								>
									{show(row[f])}
								</p>
							))}
						</li>
					))}
				</ul>
			)}
			<nav className="mt-8 flex gap-4 text-sm">
				{page > 1 ? <a href={`/p/${key}?page=${page - 1}`}>← newer</a> : null}
				{hasMore ? <a href={`/p/${key}?page=${page + 1}`}>older →</a> : null}
			</nav>
		</main>
	)
}
