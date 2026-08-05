/**
 * The eight introspection folds behind the "Under the hood" disclosure, loaded
 * only when it is open.
 *
 * # Why this is a decision and not a tidy-up
 *
 * #256 collapsed these eight panes behind a closed `<details>` and deliberately
 * left the loader alone, with the note that *"collapsing a pane is a layout
 * decision; it must not quietly become a 'this surface can no longer answer that'
 * decision"*. That was the right thing to leave, and the wrong thing to keep: a
 * page that computes ownership drift, portal exposure, the bundle catalog, the
 * slot inventory, review cost and the telemetry feed on **every** request, to
 * render them inside an element nobody opened, is paying the cost of eight
 * answers to hand back none of them.
 *
 * So the folds move behind a URL, not behind a client-side event:
 *
 *   - `?under-the-hood=1` is part of the address. The disclosure is a `<Link>`,
 *     the state is in the URL, and the open page is shareable, bookmarkable and
 *     survives a reload. #198's rule is that the important things must not be
 *     terminal-only, and one navigation away in the browser still satisfies it —
 *     "not on this surface" is the failure, "one click and a round trip" is not.
 *   - Nothing became client-only. There is no `useEffect` fetch and no fetcher, so
 *     the closed page and the open page are each a plain server render (issue #138
 *     is about exactly the branch this would otherwise introduce).
 *   - The closed state still **names** all eight things, so a reader can tell that
 *     this surface can answer them without opening it to find out. A disclosure
 *     that hides what it hides is how a fold gets forgotten and then reimplemented.
 *
 * The same shape `loadDiffPreview` has used since it landed: a search param the
 * loader keys on, and `null` when it is absent. This module exists so that shape
 * has one place to live and one docblock, rather than eight `param ? … : null`
 * ternaries in the route.
 */

import { describeCatalog } from '@maxstack/features/bundle'
import { flagReport } from '~/flags.server'
import { installedBundleRecords } from '~/sprout.server'
import { loadBulkReview } from './bulk-review.server'
import { loadOwnershipDrift } from './drift.server'
import { loadPortalExposure } from './portals.server'
import { reviewCostView } from './review-cost.server'
import { loadSlotInventory } from './slots.server'
import { telemetryView } from './telemetry.server'

/** Everything the disclosure renders. Loaded as one unit — it is one click. */
export interface DiagnosticsData {
	bulk: Awaited<ReturnType<typeof loadBulkReview>>
	portals: Awaited<ReturnType<typeof loadPortalExposure>>
	flags: Awaited<ReturnType<typeof flagReport>>
	modules: ReturnType<typeof describeCatalog>
	slots: Awaited<ReturnType<typeof loadSlotInventory>>
	drift: Awaited<ReturnType<typeof loadOwnershipDrift>>
	cost: Awaited<ReturnType<typeof reviewCostView>>
	telemetry: Awaited<ReturnType<typeof telemetryView>>
}

/**
 * Load the eight folds.
 *
 * Concurrent rather than sequential: they share no data and the caller is a person
 * who just clicked, so the wall clock is the slowest one rather than their sum.
 * The route awaited these one after another when they were unconditional, which
 * was invisible while it happened on every request and is not now that it happens
 * on a click.
 */
export async function loadDiagnostics(): Promise<DiagnosticsData> {
	const [bulk, portals, flags, modules, slots, drift, cost, telemetry] =
		await Promise.all([
			loadBulkReview(),
			loadPortalExposure(),
			flagReport(),
			installedBundleRecords().then(describeCatalog),
			loadSlotInventory(),
			loadOwnershipDrift(),
			reviewCostView(),
			telemetryView(),
		])
	return { bulk, portals, flags, modules, slots, drift, cost, telemetry }
}
