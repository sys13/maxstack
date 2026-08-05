/**
 * Consent recording endpoint — `<CookieConsentBanner>`'s "Accept"
 * POSTs here, and the settings page's terms checkbox could too. A plain JSON
 * resource action, not folded into `settings.tsx`'s action, since the banner
 * renders on every page (root layout), not just `/settings`.
 */

import { data } from 'react-router'
import { recordConsent } from '~/settings.server'
import type { Route } from './+types/settings.consent'

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return data({ error: 'Method not allowed' }, { status: 405 })
	}
	const body = (await request.json().catch(() => null)) as {
		type?: string
	} | null
	const type = body?.type
	if (type !== 'terms' && type !== 'cookies') {
		return data({ error: 'type must be "terms" or "cookies"' }, { status: 400 })
	}
	await recordConsent(request, type)
	return data({ ok: true })
}
