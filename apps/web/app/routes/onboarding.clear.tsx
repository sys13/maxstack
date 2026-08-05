/**
 * "Remove the demo data" (closes #101) — the mirror of
 * `onboarding.seed`. `maxstack demo --clear` POSTs here, and the in-app demo
 * notice's button submits here.
 *
 * It runs in the server's own process for the same reason seeding does: the
 * project store is single-writer, so a CLI that opened the db
 * itself would delete from a private view this server never sees and report
 * success while the rows stayed on screen.
 *
 * `clearDemoData()` is awaited before this action responds, so by the time any
 * response leaves, the rows are gone from the very next read. A JSON client
 * gets the counts back so the CLI can name what it removed instead of
 * assuming.
 */

import { redirect } from 'react-router'
import { clearDemoData } from '~/sprout.server'
import type { Route } from './+types/onboarding.clear'

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		throw new Response('Method not allowed', { status: 405 })
	}
	const result = await clearDemoData()
	if (request.headers.get('accept')?.includes('application/json')) {
		return Response.json(result)
	}
	const form = await request.formData()
	const back = form.get('redirectTo')
	throw redirect(typeof back === 'string' && back.startsWith('/') ? back : '/')
}
