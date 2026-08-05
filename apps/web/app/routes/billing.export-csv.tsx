/**
 * Usage-CSV download (task 54) — a plain-navigation resource route, not the
 * `billing.tsx` action. A file download must be a real `Response` the browser
 * saves, not data `useActionData` tries to read as JSON — mixing the two broke
 * the page (`'error' in <csv string>` threw) when this was a `billing.tsx`
 * action case, so it's split into its own GET route instead.
 */

import { exportUsageCsv, resolveBillingSubject } from '~/billing.server'
import type { Route } from './+types/billing.export-csv'

export async function loader({ request }: Route.LoaderArgs) {
	const resolved = await resolveBillingSubject(request)
	if (!resolved) throw new Response('Not signed in.', { status: 401 })
	const csv = await exportUsageCsv(resolved.subject)
	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv',
			'Content-Disposition': 'attachment; filename="usage.csv"',
		},
	})
}
