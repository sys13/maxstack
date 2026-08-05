/**
 * GDPR data export download — a plain-navigation resource route,
 * same shape as `billing.export-csv.tsx`: a file download must be a real
 * `Response`, not `useActionData` JSON, so it's split out of `settings.tsx`'s
 * action.
 */

import { exportAccountData } from '~/settings.server'
import type { Route } from './+types/settings.export-data'

export async function loader({ request }: Route.LoaderArgs) {
	const dump = await exportAccountData(request)
	return new Response(JSON.stringify(dump, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': 'attachment; filename="my-data.json"',
		},
	})
}
