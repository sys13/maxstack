import { getPlatform } from '~/sprout.server'
import type { Route } from './+types/admin.spec.pages'

export async function loader() {
	const spec = await getPlatform().spec.load()
	const entityNames = new Map(spec.data.entities.map((e) => [e.id, e.name]))
	const pages = spec.pages.pages.map((p) => ({
		id: p.id,
		name: p.name,
		route: p.route,
		entity: p.entityId ? (entityNames.get(p.entityId) ?? p.entityId) : null,
		blocks: p.blocks.map((b) => ({
			id: b.id,
			type: b.type,
			order: b.order ? `${b.order.field} ${b.order.direction ?? 'asc'}` : null,
		})),
		e2eTests: p.e2eTests ?? [],
	}))
	return { pages }
}

export default function SpecPages({ loaderData }: Route.ComponentProps) {
	const { pages } = loaderData
	return (
		<section>
			<h1 className="mb-2 text-2xl font-semibold">Pages</h1>
			<p className="mb-6 max-w-prose text-sm text-muted-foreground">
				The spec's page/UX layer — every page the runtime mounts, its route, the
				entity it's derived from, and the blocks it composes.
			</p>
			{pages.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No pages in the spec yet.
				</p>
			) : (
				<div className="space-y-4">
					{pages.map((p) => (
						<div key={p.id} className="rounded-lg border border-border p-4">
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<span className="font-semibold">{p.name}</span>
								<code className="rounded bg-muted px-1.5 py-0.5 text-xs">
									{p.route}
								</code>
							</div>
							{p.entity ? (
								<div className="mt-1 text-sm text-muted-foreground">
									entity: {p.entity}
								</div>
							) : null}
							{p.blocks.length > 0 ? (
								<div className="mt-3 flex flex-wrap gap-1.5">
									{p.blocks.map((b) => (
										<span
											key={b.id}
											className="rounded-full border border-border px-2 py-0.5 text-xs"
										>
											{b.type}
											{b.order ? ` · ${b.order}` : ''}
										</span>
									))}
								</div>
							) : null}
							{p.e2eTests.length > 0 ? (
								<ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
									{p.e2eTests.map((t) => (
										<li key={t}>{t}</li>
									))}
								</ul>
							) : null}
						</div>
					))}
				</div>
			)}
		</section>
	)
}
