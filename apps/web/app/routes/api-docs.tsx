/**
 * API docs — generated from the live registry (task 57), not hand-maintained,
 * so it can never drift from what `/api/:resource` actually serves. Public:
 * viewing the reference doesn't require a key, only calling the API does.
 */

import { getContext, getSprout } from '~/sprout.server'
import type { Route } from './+types/api-docs'

export async function loader({ request }: Route.LoaderArgs) {
	const ctx = await getContext(request)
	const { derived } = await getSprout()
	return {
		resources: ctx.registry.all().map((r) => ({
			name: r.resource.name,
			// Derived accessors come back on every read but appear in
			// no column list, so a REST consumer has no other way to learn a `total`
			// is there. Listed read-only: they are never accepted on a write.
			derived: [
				...(derived?.get(r.resource.name)?.computed ?? []).map((c) => c.name),
				...(derived?.get(r.resource.name)?.rollups ?? []).map((c) => c.name),
			],
		})),
	}
}

export default function ApiDocs({ loaderData }: Route.ComponentProps) {
	const { resources } = loaderData

	return (
		<main className="mx-auto max-w-2xl px-6 py-10">
			<h1 className="text-2xl font-semibold">API reference</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				Authenticate with{' '}
				<code className="rounded bg-muted px-1 py-0.5 text-xs">
					Authorization: Bearer &lt;key&gt;
				</code>{' '}
				— issue a scoped key on{' '}
				<a href="/api-keys" className="underline underline-offset-2">
					API keys
				</a>
				.
			</p>

			<section className="mt-8 space-y-6">
				{resources.map(({ name: resource, derived }) => (
					<div key={resource} className="rounded-md border border-border p-4">
						<h2 className="text-lg font-medium">{resource}</h2>
						<table className="mt-2 w-full text-left text-xs">
							<tbody>
								<tr>
									<td className="pr-4 py-1 font-mono">GET</td>
									<td className="font-mono">/api/{resource}</td>
									<td className="pl-4 text-muted-foreground">list</td>
								</tr>
								<tr>
									<td className="pr-4 py-1 font-mono">POST</td>
									<td className="font-mono">/api/{resource}</td>
									<td className="pl-4 text-muted-foreground">create</td>
								</tr>
								<tr>
									<td className="pr-4 py-1 font-mono">GET</td>
									<td className="font-mono">/api/{resource}/:id</td>
									<td className="pl-4 text-muted-foreground">read one</td>
								</tr>
								<tr>
									<td className="pr-4 py-1 font-mono">PUT/PATCH</td>
									<td className="font-mono">/api/{resource}/:id</td>
									<td className="pl-4 text-muted-foreground">update</td>
								</tr>
								<tr>
									<td className="pr-4 py-1 font-mono">DELETE</td>
									<td className="font-mono">/api/{resource}/:id</td>
									<td className="pl-4 text-muted-foreground">delete</td>
								</tr>
							</tbody>
						</table>
						{derived.length > 0 ? (
							<p className="mt-2 text-xs text-muted-foreground">
								Derived, read-only:{' '}
								{derived.map((name, i) => (
									<span key={name}>
										{i > 0 ? ', ' : ''}
										<code className="rounded bg-muted px-1 py-0.5">{name}</code>
									</span>
								))}
							</p>
						) : null}
						<pre className="mt-3 overflow-x-auto rounded bg-muted px-3 py-2 text-xs">
							{`curl -H "Authorization: Bearer mx_…" $APP_URL/api/${resource}`}
						</pre>
					</div>
				))}
			</section>
		</main>
	)
}
