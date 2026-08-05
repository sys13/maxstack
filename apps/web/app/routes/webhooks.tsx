/**
 * Webhooks — an owned-code page (Bar-2) over `WebhookService` (task 58). The
 * event bus itself lives one layer down: `sprout.server.ts`'s `getAuditSink()`
 * fans every create/update/delete across the whole app out to `emit()`, so
 * subscribing here reaches real mutations with zero extra call sites. This
 * page only manages subscriptions (subscribe/unsubscribe/regenerate) and
 * shows each one's delivery log — the dead-letter view for failed sends.
 *
 * The signing secret is shown exactly once, right after subscribe/regenerate
 * — only the plaintext is needed again at delivery time, so it's never
 * re-displayed once you navigate away.
 */

import { Alert, Button, Timestamp } from '@maxstack/ui'
import { data, Form, useActionData, useNavigation } from 'react-router'
import {
	getWebhookService,
	resolveWebhooks,
	validateSubscriberUrl,
} from '~/webhooks.server'
import type { Route } from './+types/webhooks'

const ACTIONS = ['create', 'update', 'delete'] as const

export async function loader({ request }: Route.LoaderArgs) {
	const view = await resolveWebhooks(request)
	if (!view) {
		throw data({ error: 'Sign in to manage webhooks.' }, { status: 401 })
	}
	return view
}

export async function action({ request }: Route.ActionArgs) {
	const view = await resolveWebhooks(request)
	if (!view) return data({ error: 'Not signed in.' }, { status: 401 })
	const service = await getWebhookService()
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	switch (intent) {
		case 'subscribe': {
			const url = String(form.get('url') ?? '').trim()
			const all = form.get('allEvents') === 'on'
			const resource = String(form.get('resource') ?? '')
			const eventAction = String(form.get('action') ?? '')
			if (!url) return data({ error: 'A URL is required.' }, { status: 400 })
			if (!all && (!resource || !eventAction)) {
				return data(
					{ error: 'Pick a resource + action, or subscribe to all events.' },
					{ status: 400 },
				)
			}
			// Validated here so the refusal reaches the form with a reason a person
			// can act on ("that is an internal address"), rather than as a stack
			// trace after a row has been written.
			const check = await validateSubscriberUrl(url)
			if (!check.ok) return data({ error: check.message }, { status: 400 })

			const events = all ? ['*'] : [`${resource}.${eventAction}`]
			// Default-deny field projection. The form offers the fields of the
			// chosen resource; naming none means the subscriber receives
			// identifiers only, which is the safe default rather than the useless
			// one — it still learns that the event happened and which row it was
			// about.
			const fields = form.getAll('fields').map(String).filter(Boolean)
			const issued = await service.subscribe({
				userId: view.userId,
				url,
				events,
				projections:
					!all && resource && fields.length ? [{ resource, fields }] : [],
			})
			return data({ issued })
		}
		case 'unsubscribe': {
			await service.unsubscribe(String(form.get('id') ?? ''), view.userId)
			return data({ ok: true })
		}
		case 'regenerate': {
			const issued = await service.regenerateSecret(
				String(form.get('id') ?? ''),
				view.userId,
			)
			return data({ issued })
		}
		default:
			return data({ error: `Unknown action: ${intent}` }, { status: 400 })
	}
}

/** A nullable instant. `<Timestamp>` server-renders a runtime-independent string
 * and upgrades to the viewer's locale after mount. */
const Stamp = ({ iso }: { iso: Date | string | null }) =>
	iso ? <Timestamp iso={new Date(iso).toISOString()} /> : <>—</>

export default function Webhooks({ loaderData }: Route.ComponentProps) {
	const view = loaderData
	const actionData = useActionData<typeof action>()
	const nav = useNavigation()
	const busy = nav.state !== 'idle'
	const error = actionData && 'error' in actionData ? actionData.error : null
	const issued = actionData && 'issued' in actionData ? actionData.issued : null

	return (
		<main className="mx-auto max-w-2xl px-6 py-10">
			<h1 className="text-2xl font-semibold">Webhooks</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				Outbound event delivery — every create/update/delete across the app can
				fan out to a subscriber URL, signed with your subscription's secret.
				Delivery now runs as a background job (task 59) — see queue status on
				the{' '}
				<a href="/jobs" className="text-primary underline">
					Jobs
				</a>{' '}
				page.
			</p>

			{error ? (
				<Alert variant="destructive" role="alert" className="mt-4">
					{error}
				</Alert>
			) : null}

			{issued ? (
				<div className="mt-4 rounded-md border border-primary/40 bg-primary/10 px-3 py-3 text-sm">
					<p className="font-medium">
						Copy this secret now — it won't be shown again.
					</p>
					<code className="mt-2 block break-all rounded bg-background px-2 py-1 text-xs">
						{issued.secret}
					</code>
					<p className="mt-2 text-xs text-muted-foreground">
						Verify a delivery by recomputing HMAC-SHA256 of the request body
						with this secret and comparing to the{' '}
						<code>X-Webhook-Signature</code> header.
					</p>
				</div>
			) : null}

			<section className="mt-8">
				<h2 className="mb-3 text-lg font-medium">Subscribe</h2>
				<Form method="post" className="flex flex-col gap-3">
					<input type="hidden" name="intent" value="subscribe" />
					<label className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">
							Subscriber URL
						</span>
						<input
							name="url"
							type="url"
							required
							placeholder="https://example.com/hooks/maxstack"
							disabled={busy}
							className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
						/>
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" name="allEvents" disabled={busy} />
						All events (<code>*</code>)
					</label>
					<div className="flex flex-wrap gap-3">
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">Resource</span>
							<select
								name="resource"
								disabled={busy}
								className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
							>
								{view.resources.map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">Action</span>
							<select
								name="action"
								disabled={busy}
								className="h-9 rounded-md border border-border bg-transparent px-3 text-sm"
							>
								{ACTIONS.map((a) => (
									<option key={a} value={a}>
										{a}
									</option>
								))}
							</select>
						</label>
					</div>
					<button
						type="submit"
						disabled={busy}
						className="h-9 w-fit cursor-pointer rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
					>
						Subscribe
					</button>
				</Form>
			</section>

			<section className="mt-8 border-t border-border pt-6">
				<h2 className="mb-3 text-lg font-medium">Your subscriptions</h2>
				{view.subscriptions.length === 0 ? (
					<p className="text-sm text-muted-foreground">No subscriptions yet.</p>
				) : (
					<ul className="space-y-4">
						{view.subscriptions.map((s) => (
							<li
								key={s.id}
								className="rounded-md border border-border px-4 py-3"
							>
								<div className="flex flex-wrap items-center gap-3">
									<span className="min-w-0 flex-1">
										<span className="break-all text-sm font-medium">
											{s.url}
										</span>
										{!s.active ? (
											<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
												inactive
											</span>
										) : null}
										<div className="text-xs text-muted-foreground">
											{s.events.join(', ')} · created{' '}
											<Stamp iso={s.createdAt} />
										</div>
									</span>
									{s.active ? (
										<div className="flex gap-2">
											<Form method="post">
												<input type="hidden" name="intent" value="regenerate" />
												<input type="hidden" name="id" value={s.id} />
												<button
													type="submit"
													disabled={busy}
													className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
												>
													Regenerate secret
												</button>
											</Form>
											<Form method="post">
												<input
													type="hidden"
													name="intent"
													value="unsubscribe"
												/>
												<input type="hidden" name="id" value={s.id} />
												<Button
													type="submit"
													variant="destructive"
													size="sm"
													disabled={busy}
													className="px-2 text-xs"
												>
													Unsubscribe
												</Button>
											</Form>
										</div>
									) : null}
								</div>
								{(() => {
									const deliveries = view.deliveries[s.id] ?? []
									if (deliveries.length === 0) {
										return (
											<p className="mt-2 text-xs text-muted-foreground">
												No deliveries yet.
											</p>
										)
									}
									return (
										<table className="mt-3 w-full text-left text-xs">
											<thead>
												<tr className="text-muted-foreground">
													<th className="pr-4 py-1 font-normal">Event</th>
													<th className="pr-4 py-1 font-normal">Status</th>
													<th className="pr-4 py-1 font-normal">Attempts</th>
													<th className="py-1 font-normal">When</th>
												</tr>
											</thead>
											<tbody>
												{deliveries.map((d) => (
													<tr key={d.id}>
														<td className="pr-4 py-1 font-mono">
															{d.eventType}
														</td>
														<td
															className={`pr-4 py-1 ${
																d.status === 'failed' ? 'text-destructive' : ''
															}`}
														>
															{d.status}
														</td>
														<td className="pr-4 py-1">{d.attempts}</td>
														<td className="py-1">
															<Stamp iso={d.createdAt} />
														</td>
													</tr>
												))}
											</tbody>
										</table>
									)
								})()}
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	)
}
