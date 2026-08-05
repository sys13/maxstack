/**
 * One-click unsubscribe — the click target every opt-out-able
 * email's footer points at.
 *
 * Deliberately reachable **without a session**: the person clicking is in their
 * mail client, and requiring a login to stop email is how a sender gets reported
 * as spam. Authorization comes from the signed token instead, which carries a
 * user id and a scope and can do nothing else (see
 * `features/notifications/unsubscribe.ts`).
 *
 * Applied on GET, which is the part worth being explicit about. A GET with a
 * side effect is normally a bug — a prefetcher or a scanner can fire it — but
 * here every one of those actors is a mail client, the effect is idempotent, and
 * the alternative (a form the recipient must submit) is the extra click that
 * makes people hit "report spam" instead. Mailbox providers' one-click
 * unsubscribe (RFC 8058) makes the same trade.
 */

import { data } from 'react-router'
import { getNotificationService } from '~/notifications.server'
import type { Route } from './+types/unsubscribe'

export async function loader({ request }: Route.LoaderArgs) {
	const token = new URL(request.url).searchParams.get('token') ?? ''
	if (!token) return data({ ok: false as const, reason: 'invalid-token' })
	const service = await getNotificationService()
	return data(await service.unsubscribe(token))
}

const REASONS: Record<string, string> = {
	'invalid-token':
		'This unsubscribe link is not valid. It may have been truncated by your mail client — try copying the whole link from the email.',
	'unknown-type':
		'This link refers to a kind of notification this app no longer sends, so there is nothing to turn off.',
	'not-optional':
		'That message is a security or account notice, which cannot be turned off individually. You can turn off all email in your notification settings.',
}

export default function Unsubscribe({ loaderData }: Route.ComponentProps) {
	const result = loaderData

	return (
		<main className="mx-auto max-w-lg px-6 py-16">
			<h1 className="text-2xl font-semibold">
				{result.ok ? 'Unsubscribed' : 'Nothing changed'}
			</h1>
			{result.ok ? (
				<>
					<p className="mt-3 text-sm text-muted-foreground">
						You will no longer receive {result.label} by email.
					</p>
					<p className="mt-3 text-sm text-muted-foreground">
						Changed your mind, or want a different frequency instead of nothing
						at all? Every notification type can be set to off, digest, or
						as-it-happens in{' '}
						<a className="underline" href="/settings">
							notification settings
						</a>
						.
					</p>
				</>
			) : (
				<p className="mt-3 text-sm text-muted-foreground">
					{REASONS[result.reason] ?? REASONS['invalid-token']}
				</p>
			)}
		</main>
	)
}
