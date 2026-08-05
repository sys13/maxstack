/**
 * Notifications — an owned-code inbox (Bar-2) over `NotificationService`
 * (task 56). The real event: accepting an invitation on `/team` notifies the
 * inviter here (in-app row + email, each gated by the settings-page channel
 * toggles). Also demos the digest path — "Queue a digest item" stands in for
 * a future scheduled trigger (task 59 owns real cron), and "Send digest now"
 * batches whatever's queued into one email.
 *
 * The demo has no live mail transport, so sent messages are recorded in
 * memory (`notifications.server.ts`'s `demoMailer`) and listed here as an
 * "email outbox" — the same role `billing.tsx`'s "demo mode" banner plays,
 * making delivery observable instead of vanishing into a console log.
 */

import { Alert } from '@maxstack/ui'
import { data, Form, useActionData, useNavigation } from 'react-router'
import {
	getNotificationService,
	resolveNotifications,
} from '~/notifications.server'
import type { Route } from './+types/notifications'

export async function loader({ request }: Route.LoaderArgs) {
	const view = await resolveNotifications(request)
	if (!view) {
		throw data({ error: 'Sign in to view notifications.' }, { status: 401 })
	}
	return view
}

export async function action({ request }: Route.ActionArgs) {
	const view = await resolveNotifications(request)
	if (!view) return data({ error: 'Not signed in.' }, { status: 401 })
	const service = await getNotificationService()
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	switch (intent) {
		case 'markRead': {
			await service.markRead(String(form.get('id') ?? ''), view.userId)
			break
		}
		case 'markAllRead': {
			await service.markAllRead(view.userId)
			break
		}
		case 'queueDigestItem': {
			// No `category` here any more: `demo-digest-item` is a
			// declared type, so whether this batches or mails immediately is the
			// declaration's business and the viewer's preference — not this call
			// site's.
			await service.notify({
				userId: view.userId,
				type: 'demo-digest-item',
				title: 'Queued digest item',
				body: `Queued at ${new Date().toLocaleTimeString()} — batches into your next digest.`,
				email: view.email,
			})
			break
		}
		case 'sendDigest': {
			const result = await service.sendDigest(view.userId, view.email)
			return data({ digest: result })
		}
		default:
			return data({ error: `Unknown action: ${intent}` }, { status: 400 })
	}
	return data({ ok: true })
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
	const view = loaderData
	const actionData = useActionData<typeof action>()
	const nav = useNavigation()
	const busy = nav.state !== 'idle'
	const error = actionData && 'error' in actionData ? actionData.error : null
	const digest = actionData && 'digest' in actionData ? actionData.digest : null

	return (
		<main className="mx-auto max-w-2xl px-6 py-10">
			<h1 className="text-2xl font-semibold">Notifications</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				{view.unreadCount} unread
			</p>

			{error ? (
				<Alert variant="destructive" role="alert" className="mt-4">
					{error}
				</Alert>
			) : null}
			{digest ? (
				<p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
					{digest.sent
						? `Sent a digest email covering ${digest.count} item(s).`
						: 'Nothing pending for a digest.'}
				</p>
			) : null}

			<section className="mt-8">
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-lg font-medium">Inbox</h2>
					<Form method="post">
						<input type="hidden" name="intent" value="markAllRead" />
						<button
							type="submit"
							disabled={busy || view.unreadCount === 0}
							className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
						>
							Mark all read
						</button>
					</Form>
				</div>
				{view.items.length === 0 ? (
					<p className="text-sm text-muted-foreground">No notifications yet.</p>
				) : (
					<ul className="divide-y divide-border rounded-md border border-border">
						{view.items.map((item) => (
							<li
								key={item.id}
								className="flex flex-wrap items-center gap-3 px-4 py-3"
							>
								<span className="min-w-0 flex-1">
									<span className="text-sm font-medium">{item.title}</span>
									{!item.read ? (
										<span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary">
											unread
										</span>
									) : null}
									<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
										{item.category}
									</span>
									<div className="text-xs text-muted-foreground">
										{item.body}
									</div>
								</span>
								{!item.read ? (
									<Form method="post">
										<input type="hidden" name="intent" value="markRead" />
										<input type="hidden" name="id" value={item.id} />
										<button
											type="submit"
											disabled={busy}
											className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
										>
											Mark read
										</button>
									</Form>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">How you receive each type</h2>
				<p className="text-sm text-muted-foreground">
					Declared types, resolved against your preferences — the answer to “why
					didn’t I get that email”. Change any of them in{' '}
					<a className="underline" href="/settings">
						settings
					</a>
					.
				</p>
				<ul className="mt-3 divide-y divide-border rounded-md border border-border">
					{view.delivery.map((type) => (
						<li
							key={type.key}
							className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm"
						>
							<span className="min-w-0 flex-1">
								{type.label}
								<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
									{type.class}
								</span>
							</span>
							<span className="text-xs text-muted-foreground">
								email: {type.email} · inbox: {type.inApp ? 'on' : 'off'}
							</span>
						</li>
					))}
				</ul>
			</section>

			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Digest (demo)</h2>
				<p className="text-sm text-muted-foreground">
					Digest items queue instead of emailing immediately. Queue one, then
					send the digest to batch everything pending into one email.
				</p>
				<div className="mt-3 flex flex-wrap gap-2">
					<Form method="post">
						<input type="hidden" name="intent" value="queueDigestItem" />
						<button
							type="submit"
							disabled={busy}
							className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3 text-xs hover:text-foreground"
						>
							Queue a digest item
						</button>
					</Form>
					<Form method="post">
						<input type="hidden" name="intent" value="sendDigest" />
						<button
							type="submit"
							disabled={busy}
							className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3 text-xs hover:text-foreground"
						>
							Send digest now
						</button>
					</Form>
				</div>
			</section>

			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Email outbox (demo)</h2>
				<p className="text-sm text-muted-foreground">
					No live mail transport is configured; sent messages are recorded here
					instead.
				</p>
				{view.sentEmails.length === 0 ? (
					<p className="mt-2 text-sm text-muted-foreground">
						Nothing sent yet.
					</p>
				) : (
					<ul className="mt-2 space-y-1 text-sm">
						{view.sentEmails.map((m, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: append-only demo log, no stable id
							<li key={i} className="rounded-md border border-border px-3 py-2">
								<span className="font-medium">{m.subject}</span>{' '}
								<span className="text-xs text-muted-foreground">→ {m.to}</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	)
}
