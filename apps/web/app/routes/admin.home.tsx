import { Link } from 'react-router'
import { LiveDeletePanel } from '~/components/live-delete-panel'
import { getSprout } from '~/sprout.server'
import type { Route } from './+types/admin.home'

export async function loader() {
	const { registry, store } = await getSprout()
	const cards = await Promise.all(
		registry.all().map(async (e) => ({
			name: e.resource.name,
			label: e.label,
			icon: e.config.icon ?? null,
			titleField: e.config.titleField ?? null,
			count: (await store.list(e.resource.name, { limit: 1000 })).length,
		})),
	)
	return { cards }
}

export default function AdminHome({ loaderData }: Route.ComponentProps) {
	// The first non-empty resource drives the client-fetched proof panel below.
	const live = loaderData.cards.find((c) => c.count > 0) ?? loaderData.cards[0]
	return (
		<section>
			<h1 className="mb-2 text-2xl font-semibold">Resources</h1>
			<p className="mb-6 max-w-prose text-sm text-muted-foreground">
				Every card below is derived from a registered Sprout resource — the
				table, form, REST API, and MCP tools all come from one declaration.
			</p>
			<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(12rem,1fr))]">
				{loaderData.cards.map((c) => (
					<Link
						key={c.name}
						to={`/admin/${c.name}`}
						className="block rounded-lg border border-border p-4 no-underline transition-colors hover:bg-accent"
					>
						<div className="text-2xl">{c.icon}</div>
						<div className="font-semibold">{c.label}</div>
						<div className="text-sm text-muted-foreground">
							{c.count} record{c.count === 1 ? '' : 's'}
						</div>
					</Link>
				))}
			</div>
			{live ? (
				<LiveDeletePanel resource={live.name} titleField={live.titleField} />
			) : null}
		</section>
	)
}
