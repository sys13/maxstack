/**
 * Everything the workbench knows that is *not* about building your app
 *.
 *
 * The page used to be twelve peer panes down a single column: public surfaces,
 * flags, modules, slots, ownership drift, review cost, bulk review, activity —
 * each one a correct and well-tested view, and collectively an answer to a
 * question nobody arrives with. #256's summary was blunt and right: *"I feel
 * like this thing is targeted to the developer of the app or of the maxstack
 * platform."*
 *
 * None of it is deleted. Deleting would be the other failure — several of these
 * are the only browser-side view of a real fold (`portalExposureReport`,
 * `ownershipDrift`, `slotInventory`), and #198's rule is that the most important
 * thing on a surface must not be browser-only. They are simply *behind a
 * disclosure*, closed by default, so the surface leads with the app and the
 * machinery is one click away for whoever wants it.
 *
 * # The disclosure is a link, not a `<details>`
 *
 * It was a `<details>`: no state, no effects, works before hydration. What it also
 * did was render eight panes the loader had already computed on every request —
 * drift, exposure, the bundle catalog, the slot inventory, review cost, telemetry
 * — for a disclosure almost nobody opens. #256's close recorded that as
 * deliberately unfixed, because making it lazy changes what the surface guarantees
 * it can answer without a round trip, and that is a decision rather than a layout
 * tweak.
 *
 * Taken now, in the direction that keeps every property `<details>` had:
 * `?under-the-hood=1` in the URL, a `<Link>` to toggle it, and a server render on
 * both sides. No client state, no fetch-on-open, nothing that can hydrate
 * differently from how it rendered — and, unlike the `<details>`, the open
 * page is a link somebody can send. It costs one navigation. It buys a page about
 * your app that stops computing eight introspection folds in order to throw them
 * away.
 *
 * The closed state lists all eight by name ({@link DIAGNOSTIC_FOLDS}), so it still
 * says what it hides. A disclosure that hides what it hides is how a fold gets
 * forgotten and then reimplemented somewhere worse.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router'

/**
 * What each fold is, in the reader's words — rendered in the closed state so the
 * disclosure says what it hides, and used as the count so "eight" cannot drift
 * from the number of panes actually behind it.
 *
 * Ordered as the panes are, so a reader who opens it after reading this list finds
 * them in the order they were promised. Lives here rather than beside the loader
 * in `diagnostics.server.ts` for the reason `.server.ts` exists at all: this
 * module is in the client bundle, and a shared constant would drag the loader's
 * whole import graph — the bundle catalog, ts-morph, the slot inventory — into the
 * browser with it.
 */
export const DIAGNOSTIC_FOLDS: readonly { title: string; blurb: string }[] = [
	{
		title: 'Clear many at once',
		blurb: 'accept or turn down a whole batch, with the risky ones refused',
	},
	{
		title: 'What the internet can reach',
		blurb: 'every field each declared portal publishes',
	},
	{ title: 'Feature flags', blurb: 'what is gated, how old, and last used' },
	{
		title: 'Installed modules',
		blurb: 'what each one added and what upgrades are waiting',
	},
	{
		title: 'Where custom code can go',
		blurb: 'the slots you can fill without ejecting',
	},
	{
		title: 'Your own code',
		blurb: 'how far the files you own have drifted from the derivation',
	},
	{ title: 'What reviewing costs you', blurb: 'engaged time per proposal' },
	{ title: 'Activity', blurb: 'the raw interaction feed for this surface' },
]

/** The href that opens or closes the disclosure, preserving everything else in
 *  the address — the focused node, the queue view, the open diff. */
export function underTheHoodHref(
	params: URLSearchParams,
	open: boolean,
): string {
	const next = new URLSearchParams(params)
	if (open) next.set('under-the-hood', '1')
	else next.delete('under-the-hood')
	const query = next.toString()
	return query ? `?${query}` : '?'
}

function Heading({ children }: { children: ReactNode }) {
	return (
		<div className="px-4 py-3 text-sm font-semibold">
			Under the hood{' '}
			<span className="font-normal text-muted-foreground">
				— {DIAGNOSTIC_FOLDS.length} views of how this project is put together
			</span>{' '}
			{children}
		</div>
	)
}

/**
 * Closed: the names of what is inside, and the link that loads it.
 *
 * The blurbs are not decoration. Without them the honest reading of a closed
 * disclosure is "some developer stuff", and the one reader who needed the
 * exposure report goes and asks the CLI instead.
 */
function Closed({ params }: { params: URLSearchParams }) {
	return (
		<div className="mt-6 rounded-lg border border-border">
			<Heading>
				<Link to={underTheHoodHref(params, true)} className="font-normal">
					show
				</Link>
			</Heading>
			<ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 border-t border-border p-4">
				{DIAGNOSTIC_FOLDS.map((fold) => (
					<li key={fold.title} className="text-[0.78rem]">
						<span className="font-medium">{fold.title}</span>
						<span className="text-muted-foreground"> — {fold.blurb}</span>
					</li>
				))}
			</ul>
		</div>
	)
}

export function Diagnostics({
	children,
	open,
	params,
}: {
	children: ReactNode
	/** Whether `?under-the-hood=1` is set — i.e. whether the loader loaded any of
	 *  this. `children` is rendered only when it is, and the loader computes it
	 *  only when it is; the two must not disagree. */
	open: boolean
	/** The current search params, so toggling keeps the rest of the address. */
	params: URLSearchParams
}) {
	if (!open) return <Closed params={params} />
	return (
		<div className="mt-6 rounded-lg border border-border">
			<Heading>
				<Link to={underTheHoodHref(params, false)} className="font-normal">
					hide
				</Link>
			</Heading>
			<div className="space-y-5 border-t border-border p-4">{children}</div>
		</div>
	)
}
