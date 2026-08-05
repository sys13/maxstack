/**
 * The spine of the workbench: **the app**, not the review machinery.
 *
 * What this replaces is `tree-pane.tsx`'s "Spec zoom" — a correct name for the
 * thing it did and a meaningless one to arrive at. The complaint that opened
 * #256 was that the surface is "not designed for humans… targeted at the
 * developer of the maxstack platform", and the tree was the clearest instance:
 * it led with a layer called `product` that rendered the literal string "PRD
 * (product layer)" and nothing else, badged every row with a four-value
 * provenance enum, and printed four counts per layer whether or not any of them
 * were actionable.
 *
 * The rebuilt rail answers one question — *what is in my app?* — and carries
 * exactly one piece of review information: a count of things waiting on you,
 * silent at zero. Everything else about a node lives in the node panel you get
 * by clicking it.
 *
 * Server-rendered, no state (a hydration mismatch in the primary
 * navigation would strand the whole surface, and a client-only `render()` can
 * never catch that class).
 */

import { Link } from 'react-router'
import { focusHref, PendingBadge, paneClass } from './shared'
import type { SpecTreeLayer } from './view-model'

/** How each spec layer is named to someone building an app. */
const LAYER_LABEL: Record<SpecTreeLayer['layer'], string> = {
	product: 'Product',
	data: 'Data',
	page: 'Pages',
	pricing: 'Pricing',
	flags: 'Feature flags',
}

/** What the layer holds — shown when it is empty, so an empty section teaches
 *  instead of just saying "empty" (which the tree did, five times, on a fresh
 *  project). */
const LAYER_EMPTY: Record<SpecTreeLayer['layer'], string> = {
	product: '',
	data: 'Nothing stored yet — the things your app keeps go here.',
	page: 'No pages yet — the screens people see go here.',
	pricing: 'No paid tiers.',
	flags: 'No feature flags.',
}

/** Things under this node that are waiting for the reader's decision. */
export function pendingUnder(item: SpecTreeLayer['items'][number]): number {
	return (
		(item.state === 'suggested' ? 1 : 0) +
		item.children.filter((c) => c.state === 'suggested').length
	)
}

export function AppSpine({
	tree,
	focusId,
}: {
	tree: SpecTreeLayer[]
	focusId: string | null
}) {
	return (
		<section className={paneClass}>
			{/* Not the app's name: the page header two lines above already says it,
			    and a product title long enough to wrap ("Taskly — Shared Task
			    Tracking for Small Teams") said it twice in the first screenful. */}
			<h2 className="mt-0 mb-1 text-base font-semibold">What's in it</h2>
			<Link
				to="?"
				className={`mb-3 block text-[0.8rem] no-underline ${
					focusId ? 'text-muted-foreground' : 'font-semibold text-foreground'
				}`}
			>
				Overview
			</Link>
			{tree
				// The product layer never had items — it existed to render a label.
				.filter((layer) => layer.layer !== 'product')
				.map((layer) => (
					<div key={layer.layer} className="mb-3">
						<div className="border-b border-border pb-1 text-[0.68rem] uppercase tracking-wide text-muted-foreground">
							{LAYER_LABEL[layer.layer]}
						</div>
						{layer.items.length === 0 ? (
							<p className="my-1 text-[0.75rem] text-muted-foreground">
								{LAYER_EMPTY[layer.layer]}
							</p>
						) : (
							<ul className="m-0 list-none p-0 py-1">
								{layer.items.map((item) => {
									const pending = pendingUnder(item)
									return (
										<li key={item.id}>
											<Link
												to={focusHref(item.id)}
												className={`flex items-center gap-1.5 rounded px-1 py-1 text-[0.85rem] no-underline hover:bg-muted ${
													item.id === focusId
														? 'bg-muted font-semibold text-foreground'
														: 'text-foreground'
												}`}
											>
												<span className="min-w-0 truncate">{item.label}</span>
												<PendingBadge count={pending} />
											</Link>
										</li>
									)
								})}
							</ul>
						)}
					</div>
				))}
		</section>
	)
}
