/**
 * "Load demo data" — the onboarding wizard's and empty-state's CTA
 * POSTs here. Runs the same idempotent bundle-seed mechanism boot already
 * applies (`seedDemoData`, `sprout.server.ts`), then redirects back to
 * wherever the form was submitted from so the caller doesn't need its own
 * loader-refresh dance. Static route, so it wins over the `:page` catch-all.
 *
 * `seedDemoData()` is awaited before this action responds, on the server's own
 * (single) store handle — so by the time *any* response leaves, the rows are
 * committed and visible to the very next `/api/<entity>` read. A JSON client
 * (`maxstack demo`, `Accept: application/json`) gets the seed result back
 * instead of a redirect, so the CLI can report exactly what committed rather
 * than treating an opaque redirect as "probably worked".
 */

import { redirect } from 'react-router'
import { seedDemoData } from '~/sprout.server'
import type { Route } from './+types/onboarding.seed'

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		throw new Response('Method not allowed', { status: 405 })
	}
	const result = await seedDemoData()
	// Non-browser callers (the CLI) ask for JSON: hand back the committed result
	// so success is reported only after the rows are provably visible.
	if (request.headers.get('accept')?.includes('application/json')) {
		return Response.json(result)
	}
	const form = await request.formData()
	const back = form.get('redirectTo')
	throw redirect(typeof back === 'string' && back.startsWith('/') ? back : '/')
}
